/** Terrain for the cube's "onion" view: each time layer is bent by the relief beneath it.
 *
 * Height on screen is time plus a small, capped terrain displacement: relief never exceeds
 * the gap between drawn layers, so layers cannot intersect. The exaggeration is stated
 * relative to the north–south ground scale, and the sea is drawn flat at sea level.
 * Elevations come from AWS Terrain Tiles (Terrarium encoding). */

export const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
export const TERRAIN_ATTRIBUTION =
  'Relief: AWS Terrain Tiles (Mapzen; SRTM, GMTED2010, ETOPO1 and others)';

/** Metres per degree of latitude (WGS84 mean). */
const METRES_PER_DEGREE = 111_132;

export type Region = { west: number; south: number; span: number; north: number };

export type ElevationGrid = {
  cols: number;
  rows: number;
  /** Row-major metres, row 0 at the south edge; sea and missing values are 0. */
  heights: Float32Array;
  region: Region;
  /** Highest land in the grid, metres. */
  max: number;
};

/** Terrarium PNG encoding: (R · 256 + G + B / 256) − 32768 metres. */
export const terrarium = (r: number, g: number, b: number) => r * 256 + g + b / 256 - 32768;

/** Zoom level with roughly 400 or more tile pixels across the region. */
export function tileZoom(span: number) {
  return Math.max(2, Math.min(10, Math.ceil(Math.log2((360 / span) * 1.6))));
}

/** Global Web Mercator pixel coordinates at a zoom level (256-pixel tiles). */
export function mercatorPixel(lon: number, lat: number, zoom: number): [number, number] {
  const scale = 256 * 2 ** zoom;
  const phi = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;

  return [
    ((lon + 180) / 360) * scale,
    ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * scale,
  ];
}

/** Tiles covering a region, with longitudes unwrapped across the dateline. */
export function tilesFor(region: Region, zoom: number) {
  const n = 2 ** zoom;
  const [x0, y0] = mercatorPixel(region.west, region.north, zoom);
  const [x1, y1] = mercatorPixel(region.west + region.span, region.south, zoom);
  const tiles: { x: number; y: number; wrapped: number }[] = [];
  for (let ty = Math.floor(y0 / 256); ty <= Math.floor(y1 / 256); ty++)
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor(x1 / 256); tx++)
      if (ty >= 0 && ty < n) tiles.push({ x: tx, y: ty, wrapped: ((tx % n) + n) % n });

  return tiles;
}

/** Resample Mercator tile pixels onto a regular longitude/latitude grid (bilinear). */
export function resample(
  region: Region,
  zoom: number,
  cols: number,
  rows: number,
  pixel: (px: number, py: number) => number,
): ElevationGrid {
  const heights = new Float32Array(cols * rows);
  let max = 0;
  for (let j = 0; j < rows; j++) {
    const lat = region.south + ((region.north - region.south) * j) / (rows - 1);
    for (let i = 0; i < cols; i++) {
      const lon = region.west + (region.span * i) / (cols - 1);
      const [px, py] = mercatorPixel(lon, lat, zoom);
      const x = px - 0.5,
        y = py - 0.5;
      const x0 = Math.floor(x),
        y0 = Math.floor(y),
        fx = x - x0,
        fy = y - y0;
      const v =
        (1 - fx) * (1 - fy) * pixel(x0, y0) +
        fx * (1 - fy) * pixel(x0 + 1, y0) +
        (1 - fx) * fy * pixel(x0, y0 + 1) +
        fx * fy * pixel(x0 + 1, y0 + 1);
      const h = Number.isFinite(v) && v > 0 ? v : 0;
      heights[j * cols + i] = h;
      if (h > max) max = h;
    }
  }

  return { cols, rows, heights, region, max };
}

/** Fetch and decode the tiles for a region; resolves to a regular elevation grid. */
export async function loadElevation(region: Region, cols = 220, rows = 220, signal?: AbortSignal) {
  const zoom = tileZoom(region.span);
  const tiles = tilesFor(region, zoom);
  if (tiles.length > 64) throw Error('This region needs too many relief tiles.');
  const decoded = new Map<string, Float32Array>();
  await Promise.all(
    tiles.map(async ({ x, y, wrapped }) => {
      const response = await fetch(`${TERRAIN_TILES}/${zoom}/${wrapped}/${y}.png`, {
        mode: 'cors',
        signal,
      });
      if (!response.ok) throw Error(`Relief tile ${zoom}/${wrapped}/${y}: HTTP ${response.status}`);
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = new OffscreenCanvas(256, 256);
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, 256, 256);
      const metres = new Float32Array(256 * 256);
      for (let i = 0; i < metres.length; i++)
        metres[i] = terrarium(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
      decoded.set(`${x}/${y}`, metres);
    }),
  );

  return resample(region, zoom, cols, rows, (px, py) => {
    const tile = decoded.get(`${Math.floor(px / 256)}/${Math.floor(py / 256)}`);
    if (!tile) return NaN;

    return tile[(((py % 256) + 256) % 256) * 256 + (((px % 256) + 256) % 256)];
  });
}

/** Bilinear height at a longitude/latitude inside the grid; 0 outside. */
export function heightAt(grid: ElevationGrid, lon: number, lat: number) {
  const { region, cols, rows, heights } = grid;
  const u = (((lon - region.west + 360) % 360) / region.span) * (cols - 1);
  const v = ((lat - region.south) / (region.north - region.south)) * (rows - 1);
  if (!(u >= 0 && u <= cols - 1 && v >= 0 && v <= rows - 1)) return 0;
  const i = Math.min(cols - 2, Math.floor(u)),
    j = Math.min(rows - 2, Math.floor(v));
  const fu = u - i,
    fv = v - j;
  const h = (a: number, b: number) => heights[b * cols + a];

  return (
    (1 - fu) * (1 - fv) * h(i, j) +
    fu * (1 - fv) * h(i + 1, j) +
    (1 - fu) * fv * h(i, j + 1) +
    fu * fv * h(i + 1, j + 1)
  );
}

/** Split long geographic segments so draped lines follow the relief between grid samples. */
export function subdivide(
  source: [number, number],
  target: [number, number],
  step: number,
): [number, number][] {
  const n = Math.max(1, Math.ceil(Math.hypot(target[0] - source[0], target[1] - source[1]) / step));

  return Array.from({ length: n + 1 }, (_, k) => [
    source[0] + ((target[0] - source[0]) * k) / n,
    source[1] + ((target[1] - source[1]) * k) / n,
  ]);
}

/** Choose up to `count` time steps, evenly spread in time, up to the time cut (always
 * included, as the top sheet). Sheets closer than `minGap` cube units to the sheet above
 * are dropped so terrain-bent sheets can never intersect. */
export function onionSheets(
  times: number[],
  cut: number,
  depth: number,
  minGap: number,
  count = 16,
) {
  const t0 = times[0],
    span = times.at(-1)! - t0 || 1;
  const z = (i: number) => ((times[i] - t0) / span) * depth;
  const wanted = new Set<number>([cut]);
  for (let k = 0; k < count; k++) {
    const target = t0 + (span * k) / (count - 1);
    if (target > times[cut]) break;
    let best = 0;
    times.forEach((t, i) => {
      if (i <= cut && Math.abs(t - target) < Math.abs(times[best] - target)) best = i;
    });
    wanted.add(best);
  }
  const kept: number[] = [];
  for (const i of [...wanted].sort((a, b) => b - a))
    if (!kept.length || z(kept.at(-1)!) - z(i) > minGap) kept.push(i);

  return kept.reverse();
}

/** Terrain amplitude for onion sheets: 80 % of the nominal gap between `count` sheets, as
 * cube units per metre, plus the exaggeration of the north–south ground scale it implies. */
export function onionScale(grid: ElevationGrid, cubeHeight: number, cubeDepth: number, count = 16) {
  const amplitude = (0.8 * cubeHeight) / (count - 1);
  const unitsPerMetre = amplitude / Math.max(500, grid.max);
  const ground = cubeDepth / (Math.abs(grid.region.north - grid.region.south) * METRES_PER_DEGREE);

  return { amplitude, unitsPerMetre, exaggeration: Math.round(unitsPerMetre / ground) };
}

/** Cube-space position on a sheet whose sea level sits at height `z`. */
export function sheetPosition(
  grid: ElevationGrid,
  size: [number, number, number],
  z: number,
  unitsPerMetre: number,
  lon: number,
  lat: number,
  lift = 0,
): [number, number, number] {
  const { region } = grid;

  return [
    (((lon - region.west + 360) % 360) / region.span - 0.5) * size[0],
    ((lat - region.south) / (region.north - region.south) - 0.5) * size[1],
    z + heightAt(grid, lon, lat) * unitsPerMetre + lift,
  ];
}
