import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, it } from 'vitest';
import { eventSQL } from '../src/analysis/events';
import { readOnlyQuery } from '../src/analysis/state';
import { forecastViewSQL } from '../src/analysis/forecast-view';

it('finds runs by valid-hour duration, broken by misses and missing data', async () => {
  const require = createRequire(import.meta.url);
  const root = path.dirname(path.dirname(require.resolve('@duckdb/duckdb-wasm')));
  const duck = require(path.join(root, 'dist/duckdb-node-blocking.cjs'));
  const db = await duck.createDuckDB(
    {
      mvp: { mainModule: path.join(root, 'dist/duckdb-mvp.wasm') },
      eh: { mainModule: path.join(root, 'dist/duckdb-eh.wasm') },
    },
    new duck.VoidLogger(),
    duck.NODE_RUNTIME,
  );
  await db.instantiate();
  const connection = db.connect();

  // Two cells (x = 0, 1) over irregular steps: 0, 1, 2, 3, 6, 9, 12 h.
  const times = [0, 1, 2, 3, 6, 9, 12];
  const cell0 = [31, 31, 20, 31, 31, 31, 31]; // run 3–12 h lasts 9 h; run 0–1 h lasts 1 h
  const cell1 = [31, 31, 31, NaN, 31, 31, 31]; // missing value at 3 h splits into 2 h and 6 h runs
  const rows = times.flatMap((_, t) => [
    `(${t * 2}, ${Number.isNaN(cell0[t]) ? "'NaN'::FLOAT" : cell0[t]})`,
    `(${t * 2 + 1}, ${Number.isNaN(cell1[t]) ? "'NaN'::FLOAT" : cell1[t]})`,
  ]);
  connection.query(
    `CREATE TABLE samples AS SELECT * FROM (VALUES ${rows.join(',')}) v(cell_id, value)`,
  );
  connection.query(
    'CREATE TABLE fixed AS SELECT cell_id::INTEGER AS cell_id, value::FLOAT AS value FROM samples',
  );
  connection.query('DROP TABLE samples');
  connection.query('ALTER TABLE fixed RENAME TO samples');
  connection.query(
    forecastViewSQL({
      shape: [times.length, 1, 2],
      lon: [0, 0.25],
      lat: [50],
      times,
      timeUnits: 'hours',
      variable: 'temperature_2m',
    }),
  );

  const query = eventSQL({ column: 'value', direction: 'above', threshold: 30, minHours: 6 });
  expect(() => readOnlyQuery(query)).not.toThrow();
  const result = connection
    .query(`${query} ORDER BY cell_id`)
    .toArray()
    .map((r: { cell_id: number; duration_h: number }) => [Number(r.cell_id), Number(r.duration_h)]);

  // Cell 0: samples at 3, 6, 9, 12 h (ids 6, 8, 10, 12). Cell 1: 6, 9, 12 h (ids 9, 11, 13).
  expect(result).toEqual([
    [6, 9],
    [8, 9],
    [9, 6],
    [10, 9],
    [11, 6],
    [12, 9],
    [13, 6],
  ]);

  expect(() =>
    eventSQL({ column: 'value; DROP', direction: 'above', threshold: 1, minHours: 1 }),
  ).toThrow();
});
