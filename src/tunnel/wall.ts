import { rowAreas } from '../analysis/area';

export type WallMode = 'directions' | 'mix';

type Grid = {
  data: ArrayLike<number>;
  shape: [number, number, number];
  lat: number[];
  lon: number[];
};

/** Angle of a wall bin's centre: 0 = east, π/2 = north (top of the tunnel), counter-clockwise. */
export const binAngle = (bin: number, bins: number) => ((bin + 0.5) / bins) * Math.PI * 2;

/** Which share of the region a mix bin shows: 0 (coldest) at the floor, 1 (warmest) at the top,
 * the same on the left and right walls so there is no seam. */
export const binQuantile = (bin: number, bins: number) => {
  const fromTop = Math.abs(
    ((binAngle(bin, bins) - Math.PI / 2 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI,
  );

  return 1 - fromTop / Math.PI;
};

/** The values painted on the tunnel wall: one column per forecast step, `bins` around.
 *
 * directions: each bin is the area-weighted mean of the cells whose direction from the
 * region's centre falls in that sector (distances on a local equirectangular plane).
 * mix: each bin is the area-weighted quantile of the step's values given by binQuantile. */
export function wallValues(grid: Grid, mode: WallMode, bins = 72) {
  const [nt, ny, nx] = grid.shape;
  const plane = ny * nx;
  const area = rowAreas(grid.lat, grid.lon).map((a) => (Number.isFinite(a) && a > 0 ? a : 1));
  const values = new Float32Array(nt * bins).fill(NaN);

  if (mode === 'directions') {
    const lon0 = (grid.lon[0] + grid.lon[nx - 1]) / 2,
      lat0 = (grid.lat[0] + grid.lat[ny - 1]) / 2;
    const k = Math.cos((lat0 * Math.PI) / 180);
    const binOf = new Int32Array(plane);
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const a = Math.atan2(grid.lat[y] - lat0, (grid.lon[x] - lon0) * k);
        binOf[y * nx + x] = Math.min(
          bins - 1,
          Math.floor((((a + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI)) * bins),
        );
      }
    const sum = new Float64Array(bins),
      weight = new Float64Array(bins);
    for (let t = 0; t < nt; t++) {
      sum.fill(0);
      weight.fill(0);
      for (let i = 0; i < plane; i++) {
        const v = grid.data[t * plane + i];
        if (!Number.isFinite(v)) continue;
        const w = area[Math.floor(i / nx)];
        sum[binOf[i]] += v * w;
        weight[binOf[i]] += w;
      }
      for (let b = 0; b < bins; b++) if (weight[b] > 0) values[t * bins + b] = sum[b] / weight[b];
      // Sectors with no cell (tiny regions) take their nearest neighbours' mean.
      for (let b = 0; b < bins; b++) {
        if (Number.isFinite(values[t * bins + b])) continue;
        for (let d = 1; d < bins / 2; d++) {
          const l = values[t * bins + ((b - d + bins) % bins)],
            r = values[t * bins + ((b + d) % bins)];
          const found = [l, r].filter(Number.isFinite);
          if (found.length) {
            values[t * bins + b] = found.reduce((a, c) => a + c, 0) / found.length;
            break;
          }
        }
      }
    }
  } else {
    const order = new Int32Array(plane);
    for (let t = 0; t < nt; t++) {
      let n = 0;
      for (let i = 0; i < plane; i++) if (Number.isFinite(grid.data[t * plane + i])) order[n++] = i;
      const cells = Array.from(order.subarray(0, n)).sort(
        (a, b) => grid.data[t * plane + a] - grid.data[t * plane + b],
      );
      const cumulative = new Float64Array(n);
      let total = 0;
      cells.forEach((c, j) => {
        total += area[Math.floor(c / nx)];
        cumulative[j] = total;
      });
      if (!n) continue;
      for (let b = 0; b < bins; b++) {
        const target = Math.min(0.999999, Math.max(1e-6, binQuantile(b, bins))) * total;
        let lo = 0,
          hi = n - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (cumulative[mid] < target) lo = mid + 1;
          else hi = mid;
        }
        values[t * bins + b] = grid.data[t * plane + cells[lo]];
      }
    }
  }

  return { values, bins, steps: nt };
}

const names = [
  'east',
  'north-east',
  'north',
  'north-west',
  'west',
  'south-west',
  'south',
  'south-east',
];

/** A compass word for a wall angle (0 = east, counter-clockwise). */
export const directionName = (angle: number) =>
  names[Math.round((((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 4)) % 8];

export type SquareMode = 'edges' | 'halves' | 'line';

/** One flat wall: values for every step and position along the wall (west→east or
 * south→north), with the coordinate of each position. */
export type FlatWall = { values: Float32Array; n: number; coords: number[] };

/** The four walls of the square tunnel, each a Hovmöller diagram (position × lead time).
 *
 * edges: the region's own borders, exact cells: the ceiling is the northernmost row, the
 * floor the southernmost, the right wall the easternmost column, the left the westernmost —
 * the sides of the cube, so a map of any time fits the tunnel as its cross-section.
 * halves: the ceiling is the northern half of the region averaged north–south, for every
 * longitude; the floor the southern half; the right wall the eastern half averaged
 * west–east, for every latitude; the left wall the western half.
 * line: the ceiling and floor are the exact row of cells through `at`, the side walls the
 * exact column through it. */
export function squareWalls(grid: Grid, mode: SquareMode, at?: { x: number; y: number } | null) {
  const [nt, ny, nx] = grid.shape;
  const area = rowAreas(grid.lat, grid.lon).map((a) => (Number.isFinite(a) && a > 0 ? a : 1));
  const xs = Array.from({ length: nx }, (_, i) => i).sort((a, b) => grid.lon[a] - grid.lon[b]);
  const ys = Array.from({ length: ny }, (_, i) => i).sort((a, b) => grid.lat[a] - grid.lat[b]);
  const value = (t: number, y: number, x: number) => grid.data[(t * ny + y) * nx + x];

  /** Mean over a set of rows for each column (area-weighted), or over columns for each row. */
  const along = (positions: number[], across: number[], horizontal: boolean): FlatWall => {
    const values = new Float32Array(nt * positions.length).fill(NaN);
    for (let t = 0; t < nt; t++)
      positions.forEach((p, i) => {
        let sum = 0,
          weight = 0;
        for (const q of across) {
          const v = horizontal ? value(t, q, p) : value(t, p, q);
          if (!Number.isFinite(v)) continue;
          const w = horizontal ? area[q] : 1;
          sum += v * w;
          weight += w;
        }
        if (weight > 0) values[t * positions.length + i] = sum / weight;
      });

    return {
      values,
      n: positions.length,
      coords: positions.map((p) => (horizontal ? grid.lon[p] : grid.lat[p])),
    };
  };

  if (mode === 'line' && at) {
    const row = along(xs, [at.y], true);
    const column = along(ys, [at.x], false);

    return { ceiling: row, floor: row, right: column, left: column };
  }
  if (mode === 'edges')
    return {
      ceiling: along(xs, [ys.at(-1)!], true),
      floor: along(xs, [ys[0]], true),
      right: along(ys, [xs.at(-1)!], false),
      left: along(ys, [xs[0]], false),
    };
  // Odd counts: the middle row or column belongs to both halves.
  const north = ys.slice(Math.floor(ny / 2)),
    south = ys.slice(0, Math.ceil(ny / 2));
  const east = xs.slice(Math.floor(nx / 2)),
    west = xs.slice(0, Math.ceil(nx / 2));

  return {
    ceiling: along(xs, north, true),
    floor: along(xs, south, true),
    right: along(ys, east, false),
    left: along(ys, west, false),
  };
}
