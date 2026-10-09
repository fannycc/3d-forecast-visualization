import { isWinterTime, timeValue } from '../engine/time-labels';
import type { Volume } from '../engine/types';
import { rowAreas } from './area';

/** Row identity already encodes coordinates. Constant-array lookup avoids
 * cardinality estimates and hash joins, and unused coordinates are pruned.
 */
export function forecastViewSQL(
  volume: Pick<Volume, 'shape' | 'lon' | 'lat' | 'times' | 'timeUnits' | 'variable'>,
  /** Extra float columns present in the samples table, such as normal or ensemble_sd. */
  columns: string[] = [],
) {
  const [, ny, nx] = volume.shape;

  const list = (values: number[]) => {
    if (!values.length || values.some((v) => !Number.isFinite(v)))
      throw Error('Invalid analysis coordinates.');

    return `[${values.join(',')}]::DOUBLE[]`;
  };

  const x = `(cell_id % ${nx})`,
    y = `((cell_id // ${nx}) % ${ny})`,
    t = `(cell_id // ${nx * ny})`;
  const timeColumn = isWinterTime(volume.timeUnits)
    ? `NULL::DOUBLE AS forecast_hour, list_extract(${list(volume.times)}, ${t} + 1) AS winter`
    : `list_extract(${list(volume.times.map((v) => timeValue(v, volume.timeUnits)))}, ${t} + 1) AS forecast_hour`;
  const finite = (c: string) => `CASE WHEN isfinite(${c}) THEN ${c} ELSE NULL END`;
  const value = finite('value');
  const extras = columns.map((c) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(c)) throw Error(`Invalid analysis column ${c}.`);

    return `${finite(c)} AS ${c}`;
  });
  if (columns.includes('normal') && columns.includes('forecast'))
    extras.push(
      `${finite('forecast')} - ${finite('normal')} AS anomaly`,
      `(${finite('forecast')} - ${finite('normal')}) / nullif(${finite('normal_sd')}, 0) AS standardized_anomaly`,
    );
  const areas = rowAreas(volume.lat, volume.lon);
  const area = areas.every(Number.isFinite)
    ? `list_extract(${list(areas)}, ${y} + 1) AS cell_area_km2`
    : 'NULL::DOUBLE AS cell_area_km2';

  return `CREATE VIEW loaded_forecast AS SELECT cell_id,
    ${value} AS value, ${x} AS x_index, ${y} AS y_index, ${t} AS time_index,
    list_extract(${list(volume.lon)}, ${x} + 1) AS longitude,
    list_extract(${list(volume.lat)}, ${y} + 1) AS latitude,
    ${area},
    ${timeColumn}${extras
      .map(
        (e) => `,
    ${e}`,
      )
      .join('')}
    ${volume.variable === 'temperature_2m' ? `, ${value} AS temperature` : ''}
    FROM samples`;
}
