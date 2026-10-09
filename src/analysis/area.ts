import type { Volume } from '../engine/types';

/** IUGG mean Earth radius. A sphere differs from the WGS84 ellipsoid by under 0.5 % in area. */
export const EARTH_RADIUS_KM = 6371.0088;

const rad = Math.PI / 180;

/** Spherical area of each latitude row's cells in km²: R² · Δλ · |sin φ₁ − sin φ₂|.
 * Edges lie halfway between coordinates (outer edges mirror the neighbouring spacing) and
 * are clamped to the poles. Grids are regular in longitude, so Δλ is shared by all cells.
 * Rows are NaN when a one-sample axis leaves the cell size undefined. */
export function rowAreas(lat: number[], lon: number[]) {
  if (lat.length < 2 || lon.length < 2) return lat.map(() => NaN);
  const dLon = Math.abs(((((lon[1] - lon[0]) % 360) + 540) % 360) - 180) * rad;

  return lat.map((phi, i) => {
    const before = i > 0 ? (lat[i - 1] + phi) / 2 : phi - (lat[1] - lat[0]) / 2;
    const after = i < lat.length - 1 ? (phi + lat[i + 1]) / 2 : phi + (phi - lat[i - 1]) / 2;
    const clamp = (v: number) => Math.max(-90, Math.min(90, v)) * rad;

    return EARTH_RADIUS_KM ** 2 * dLon * Math.abs(Math.sin(clamp(after)) - Math.sin(clamp(before)));
  });
}

export type AreaSummary = {
  /** Matched area per time step, km². */
  matched: Float64Array;
  /** Area with finite data per time step, km². */
  withData: Float64Array;
  peakIndex: number;
  /** Area-weighted mean of matched values; NaN when nothing matched. */
  weightedMean: number;
  matchedCells: number;
};

/** Summarize a selection mask by spherical area rather than by cell count. */
export function areaSummary(
  volume: Pick<Volume, 'data' | 'shape' | 'lat' | 'lon'>,
  mask: Uint8Array,
): AreaSummary {
  const [nt, ny, nx] = volume.shape;
  const rows = rowAreas(volume.lat, volume.lon);
  const matched = new Float64Array(nt),
    withData = new Float64Array(nt);
  let weighted = 0,
    weights = 0,
    matchedCells = 0;

  for (let t = 0; t < nt; t++)
    for (let y = 0; y < ny; y++) {
      const a = rows[y];
      for (let x = 0; x < nx; x++) {
        const i = (t * ny + y) * nx + x;
        const v = volume.data[i];
        if (!Number.isFinite(v)) continue;
        withData[t] += a;
        if (!mask[i]) continue;
        matched[t] += a;
        weighted += v * a;
        weights += a;
        matchedCells++;
      }
    }

  let peakIndex = 0;
  matched.forEach((v, i) => {
    if (v > matched[peakIndex]) peakIndex = i;
  });

  return {
    matched,
    withData,
    peakIndex,
    weightedMean: weights ? weighted / weights : NaN,
    matchedCells,
  };
}

export function formatArea(km2: number) {
  if (!Number.isFinite(km2)) return '—';
  if (km2 >= 1e6) return `${(km2 / 1e6).toPrecision(3)} M km²`;
  if (km2 >= 1e3) return `${Math.round(km2 / 1e3).toLocaleString()} k km²`;

  return `${Math.round(km2).toLocaleString()} km²`;
}
