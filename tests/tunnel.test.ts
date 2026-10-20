import { describe, expect, it } from 'vitest';
import { binQuantile, directionName, squareWalls, wallValues } from '../src/tunnel/wall';
import { paintTunnel } from '../src/tunnel/paint';

/** One step, 3 × 3 cells around (0°, 0°): warm in the north row, cold in the south row. */
const grid = {
  data: Float32Array.from([
    // y = 0 (south, lat −1)
    0, 0, 0,
    // y = 1 (lat 0)
    5, 5, 5,
    // y = 2 (north, lat 1)
    10, 10, 10,
  ]),
  shape: [1, 3, 3] as [number, number, number],
  lat: [-1, 0, 1],
  lon: [-1, 0, 1],
};

describe('tunnel wall', () => {
  it('directions: the top of the wall shows the north of the region, the floor the south', () => {
    const { values, bins } = wallValues(grid, 'directions', 8);
    // Bin 2 covers 90–135° (north), bin 6 covers 270–315° (south).
    expect(values[2]).toBe(10);
    expect(values[6]).toBe(0);
    expect(values.every(Number.isFinite)).toBe(true);
    expect(bins).toBe(8);
  });

  it('mix: coldest at the floor, warmest at the top, symmetric left and right', () => {
    const { values } = wallValues(grid, 'mix', 8);
    const top = values[1],
      bottom = values[5];
    expect(top).toBeGreaterThan(bottom);
    expect(values[1]).toBe(values[2]);
    expect(values[0]).toBe(values[3]);
    expect(binQuantile(1, 8)).toBeCloseTo(binQuantile(2, 8));
  });

  it('names compass directions', () => {
    expect(directionName(Math.PI / 2)).toBe('north');
    expect(directionName(Math.PI)).toBe('west');
    expect(directionName(-Math.PI / 4)).toBe('south-east');
  });
});

describe('square tunnel walls', () => {
  it('halves: ceiling is the north averaged for each longitude, sides the east and west', () => {
    const w = squareWalls(grid, 'halves');
    // North half = rows lat 0 and 1 (the middle row counts in both halves).
    // Area-weighted: rows at 0° and 1° differ in area by a hair.
    for (const v of w.ceiling.values) expect(v).toBeCloseTo(7.5, 2);
    for (const v of w.floor.values) expect(v).toBeCloseTo(2.5, 2);
    // Each latitude row is uniform, so east and west halves both give the row value.
    expect([...w.right.values]).toEqual([0, 5, 10]);
    expect(w.right.coords).toEqual([-1, 0, 1]);
  });

  it('edges: the region’s own border cells, as the sides of the cube', () => {
    const w = squareWalls(grid, 'edges');
    expect([...w.ceiling.values]).toEqual([10, 10, 10]);
    expect([...w.floor.values]).toEqual([0, 0, 0]);
    expect([...w.right.values]).toEqual([0, 5, 10]);
  });

  it('line: the exact row and column through a place', () => {
    const w = squareWalls(grid, 'line', { x: 0, y: 2 });
    expect([...w.ceiling.values]).toEqual([10, 10, 10]);
    expect([...w.left.values]).toEqual([0, 5, 10]);
  });
});

describe('tunnel paint by section', () => {
  const display = {
    ...grid,
    data: Float32Array.from([...grid.data, ...grid.data.map((v) => v + 10)]),
    shape: [2, 3, 3] as [number, number, number],
    times: [0, 6],
    timeUnits: 'hours',
    quantity: { label: 't', units: '°C', kind: 'value' },
  } as unknown as Parameters<typeof paintTunnel>[0]['display'];
  const base = {
    volume: { ...display, units: 'degree_Celsius' } as unknown as Parameters<
      typeof paintTunnel
    >[0]['volume'],
    display,
    palette: 'thermal' as const,
    range: [0, 20] as [number, number],
    uncertainty: null,
    mask: null,
    maskLabel: 'in the event',
    muted: [0.86, 0.88, 0.9] as [number, number, number],
    place: null,
    units: '°C',
  };

  it('clock: every ring is the regional average at that time', () => {
    const p = paintTunnel({ ...base, section: 'clock' });
    expect(p.ceiling.n).toBe(1);
    expect(p.ceiling.describe(1, 0)).toContain('regional average 15');
  });

  it('events: cells outside the selection are greyed', () => {
    const mask = new Uint8Array(18);
    mask[6] = mask[7] = mask[8] = 1; // the north row at the first step
    const plain = paintTunnel({ ...base, section: 'persistent' });
    const painted = paintTunnel({ ...base, section: 'persistent', mask });
    // Floor (south half) at the first step has no matches: its colour changes to grey.
    expect(painted.floor.pixels.slice(0, 3)).not.toEqual(plain.floor.pixels.slice(0, 3));
    expect(painted.ceiling.describe(0, 0)).toContain('% in the event');
  });
});
