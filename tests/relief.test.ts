import { describe, expect, it } from 'vitest';
import {
  heightAt,
  mercatorPixel,
  onionScale,
  onionSheets,
  sheetPosition,
  resample,
  subdivide,
  terrarium,
  tilesFor,
  type ElevationGrid,
} from '../src/render/relief';

describe('relief', () => {
  it('decodes Terrarium pixels', () => {
    // 0 m is (128, 0, 0); 4808.5 m is 32768 + 4808.5 = 37576.5 → (146, 200, 128).
    expect(terrarium(128, 0, 0)).toBe(0);
    expect(terrarium(146, 200, 128)).toBe(4808.5);
  });

  it('projects to Web Mercator pixels', () => {
    expect(mercatorPixel(0, 0, 0)).toEqual([128, 128]);
    const [x, y] = mercatorPixel(-180, 85.0511, 1);
    expect(x).toBe(0);
    expect(y).toBeCloseTo(0, 2);
  });

  it('lists tiles across the dateline with wrapped indices', () => {
    const tiles = tilesFor({ west: 170, span: 20, south: -5, north: 5 }, 2);
    expect(tiles.map((t) => t.wrapped).sort()).toEqual([0, 0, 3, 3]);
  });

  const region = { west: 0, span: 2, south: 40, north: 42 };
  /** A plane rising 100 m per degree east, sampled through the Mercator resampler. */
  const grid = resample(region, 8, 41, 41, (px) => {
    const lon = (px / (256 * 2 ** 8)) * 360 - 180;

    return lon * 100;
  });

  it('resamples onto a regular grid and interpolates heights', () => {
    expect(heightAt(grid, 1, 41)).toBeCloseTo(100, 0);
    expect(grid.max).toBeCloseTo(200, 0);
    expect(heightAt(grid, 10, 41)).toBe(0);
  });

  it('draws the sea flat and bends sheets by terrain height', () => {
    const sea: ElevationGrid = { ...grid, heights: new Float32Array(41 * 41).fill(0), max: 0 };
    expect(heightAt(sea, 1, 41)).toBe(0);
    const size: [number, number, number] = [350, 350, 250];
    expect(sheetPosition(sea, size, 10, 0.1, 1, 41)[2]).toBe(10);
    expect(sheetPosition(grid, size, 10, 0.1, 1, 41)[2]).toBeCloseTo(20, 0);
  });

  it('caps terrain below the gap between sheets and states the exaggeration', () => {
    const alps: ElevationGrid = {
      ...grid,
      region: { west: 0, span: 19, south: 43.5, north: 62.5 },
      max: 4800,
    };
    const { amplitude, unitsPerMetre, exaggeration } = onionScale(alps, 250, 350, 16);
    expect(alps.max * unitsPerMetre).toBeCloseTo(amplitude);
    expect(amplitude).toBeLessThan(250 / 15);
    expect(exaggeration).toBeGreaterThan(1);
  });

  it('spreads sheets in time up to the cut and drops ones that would collide', () => {
    // Irregular steps: hourly to 6 h, then 6-hourly to 96 h.
    const times = [0, 1, 2, 3, 4, 5, 6, ...Array.from({ length: 15 }, (_, i) => 12 + i * 6)];
    const sheets = onionSheets(times, times.length - 1, 250, 10, 16);
    expect(sheets.at(-1)).toBe(times.length - 1);
    const z = sheets.map((i) => (times[i] / 96) * 250);
    z.slice(1).forEach((v, k) => expect(v - z[k]).toBeGreaterThan(10));
    expect(onionSheets(times, 3, 250, 10, 16)).toEqual([3]);
  });

  it('subdivides long segments', () => {
    expect(subdivide([0, 0], [1, 0], 0.25)).toHaveLength(5);
  });
});
