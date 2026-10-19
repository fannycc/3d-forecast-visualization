import type { Volume } from '../engine/types';
import type { Place } from '../render/places';
import { rowAreas } from './area';
import { timeValue } from '../engine/time-labels';

/** Units for the member-split cube: its vertical axis is signed member rank, not time.
 * The gap (in rank steps) left empty on each side of the average plane is part of the
 * units string, so labels can recover the true rank. */
export const MEMBER_RANK = 'member rank';
export const memberRankUnits = (gap: number) => `${MEMBER_RANK} gap=${gap}`;

/** Area-weighted mean of every time layer, ignoring cells without data. */
export function regionalMeans(volume: Pick<Volume, 'data' | 'shape' | 'lat' | 'lon'>) {
  const [nt, ny, nx] = volume.shape;
  const rows = rowAreas(volume.lat, volume.lon);
  const means = new Float64Array(nt);
  for (let t = 0; t < nt; t++) {
    let sum = 0,
      weight = 0;
    for (let y = 0; y < ny; y++) {
      const a = Number.isFinite(rows[y]) ? rows[y] : 1;
      for (let x = 0; x < nx; x++) {
        const v = volume.data[(t * ny + y) * nx + x];
        if (!Number.isFinite(v)) continue;
        sum += v * a;
        weight += a;
      }
    }
    means[t] = weight ? sum / weight : NaN;
  }

  return means;
}

export type MemberSplit = {
  /** A cube whose layers are members at one time: member minus ensemble mean. */
  volume: Volume;
  /** Member indices bottom to top: coldest-below-average first. */
  order: number[];
  /** Area-weighted regional deviation of each member, in source units. */
  deviation: number[];
  above: number;
  below: number;
};

/** Split the members at one time into runs above and below the ensemble mean.
 * Layers are placed at signed ranks: −1, −2 … below the middle, +1, +2 … above it, so
 * runs colder than average hang upside down beneath the mean plane. Deviations are
 * ranked by their area-weighted regional mean. */
export function memberSplit(volume: Volume, t: number): MemberSplit | null {
  const e = volume.ensemble;
  if (!e) return null;
  const [nt, ny, nx] = volume.shape;
  const plane = ny * nx,
    cells = nt * plane;
  const rows = rowAreas(volume.lat, volume.lon);
  const layers = Array.from({ length: e.count }, (_, m) => {
    const out = new Float32Array(plane);
    let sum = 0,
      weight = 0;
    for (let i = 0; i < plane; i++) {
      const v = e.members[m * cells + t * plane + i] - e.stats.mean[t * plane + i];
      out[i] = v;
      if (!Number.isFinite(v)) continue;
      const a = Number.isFinite(rows[Math.floor(i / nx)]) ? rows[Math.floor(i / nx)] : 1;
      sum += v * a;
      weight += a;
    }

    return { m, out, deviation: weight ? sum / weight : NaN };
  }).filter((layer) => Number.isFinite(layer.deviation));

  const below = layers.filter((l) => l.deviation < 0).sort((a, b) => a.deviation - b.deviation);
  const above = layers.filter((l) => l.deviation >= 0).sort((a, b) => a.deviation - b.deviation);
  const ordered = [...below, ...above];
  // A wide empty band around the average plane separates colder from warmer runs.
  const gap = Math.max(4, Math.round(e.count * 0.5));
  // Empty (NaN) layers fill the gap so the cube shows a real opening around the average.
  const gapLayers = 2 * gap - 1;
  const data = new Float32Array((ordered.length + gapLayers) * plane).fill(NaN);
  below.forEach((l, k) => data.set(l.out, k * plane));
  above.forEach((l, k) => data.set(l.out, (below.length + gapLayers + k) * plane));
  let min = Infinity,
    max = -Infinity,
    missing = 0;
  for (const v of data)
    if (Number.isFinite(v)) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    } else missing++;
  missing -= gapLayers * plane;

  return {
    volume: {
      ...volume,
      id: `${volume.id}|members@${t}`,
      data,
      shape: [ordered.length + gapLayers, ny, nx],
      times: [
        ...below.map((_, k) => -(below.length - k) - gap),
        ...Array.from({ length: gapLayers }, (_, k) => k - gap + 1),
        ...above.map((_, k) => k + 1 + gap),
      ],
      timeUnits: memberRankUnits(gap),
      min,
      max,
      missing,
      ensemble: undefined,
    },
    order: ordered.map((l) => l.m),
    deviation: ordered.map((l) => l.deviation),
    above: above.length,
    below: below.length,
  };
}

/** For every cell, the last lead time (hours) before member spread first reaches
 * `threshold`; the final lead when it never does, and NaN when the first step already does
 * or has no data. */
export function reliableHorizon(volume: Volume, threshold: number) {
  const e = volume.ensemble;
  if (!e) return null;
  const [nt, ny, nx] = volume.shape;
  const plane = ny * nx;
  const hours = volume.times.map((v) => timeValue(v, volume.timeUnits));
  const out = new Float32Array(plane).fill(NaN);
  for (let i = 0; i < plane; i++) {
    let last = -1;
    for (let t = 0; t < nt; t++) {
      const s = e.stats.spread[t * plane + i];
      if (!(s < threshold)) break;
      last = t;
    }
    if (last >= 0) out[i] = hours[last];
  }

  return out;
}

/** Mean member spread of each cell over every lead time; breaks ties between horizons. */
export function meanSpread(volume: Volume) {
  const e = volume.ensemble;
  if (!e) return null;
  const [nt, ny, nx] = volume.shape;
  const plane = ny * nx;
  const out = new Float32Array(plane);
  for (let i = 0; i < plane; i++) {
    let sum = 0,
      n = 0;
    for (let t = 0; t < nt; t++) {
      const s = e.stats.spread[t * plane + i];
      if (Number.isFinite(s)) {
        sum += s;
        n++;
      }
    }
    out[i] = n ? sum / n : NaN;
  }

  return out;
}

export type CertainPlace = Place & { x: number; y: number; hours: number; spread: number };

/** Rank named places in the region by how long their forecast stays below the threshold. */
export function certainPlaces(
  places: Place[],
  volume: Pick<Volume, 'lon' | 'lat' | 'shape'>,
  horizon: Float32Array,
  count: number,
  spread?: Float32Array | null,
) {
  const [, ny, nx] = volume.shape;
  const nearest = (values: number[], v: number, longitude: boolean) => {
    let best = -1,
      distance = Infinity;
    values.forEach((c, i) => {
      const d = longitude ? Math.abs(((c - v + 540) % 360) - 180) : Math.abs(c - v);
      if (d < distance) {
        distance = d;
        best = i;
      }
    });
    const step = values.length > 1 ? Math.abs(values[1] - values[0]) : Infinity;

    return distance <= step / 2 + 1e-9 ? best : -1;
  };
  const seen = new Set<number>();
  const ranked: CertainPlace[] = [];
  for (const place of places) {
    const x = nearest(volume.lon, place.lon, true),
      y = nearest(volume.lat, place.lat, false);
    if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
    const cell = y * nx + x;
    if (seen.has(cell) || !Number.isFinite(horizon[cell])) continue;
    seen.add(cell);
    ranked.push({ ...place, x, y, hours: horizon[cell], spread: spread?.[cell] ?? NaN });
  }

  return ranked
    .sort(
      (a, b) =>
        b.hours - a.hours ||
        (Number.isFinite(a.spread) && Number.isFinite(b.spread) ? a.spread - b.spread : 0) ||
        a.rank - b.rank ||
        b.population - a.population,
    )
    .slice(0, count);
}

export type EventSite = { x: number; y: number; from: number; to: number; hours: number };

/** The cells where a matched event lasts longest, at least `spacing` cells apart.
 * `from`/`to` are the first and last matched hours; `hours` is the matched duration summed
 * over consecutive matched samples (valid hours, so irregular steps count correctly). */
export function eventSites(
  volume: Pick<Volume, 'shape' | 'times' | 'timeUnits'>,
  mask: Uint8Array,
  count: number,
  spacing: number,
): EventSite[] {
  const [nt, ny, nx] = volume.shape;
  const plane = ny * nx;
  const hours = volume.times.map((v) => timeValue(v, volume.timeUnits));
  const sites: EventSite[] = [];
  for (let i = 0; i < plane; i++) {
    let first = -1,
      last = -1,
      total = 0;
    for (let t = 0; t < nt; t++) {
      if (!mask[t * plane + i]) continue;
      if (first < 0) first = t;
      if (last >= 0 && last === t - 1) total += hours[t] - hours[t - 1];
      last = t;
    }
    if (first >= 0)
      sites.push({
        x: i % nx,
        y: Math.floor(i / nx),
        from: hours[first],
        to: hours[last],
        hours: total,
      });
  }
  sites.sort((a, b) => b.hours - a.hours || b.to - b.from - (a.to - a.from));
  const picked: EventSite[] = [];
  for (const site of sites) {
    if (picked.some((p) => Math.hypot(p.x - site.x, p.y - site.y) < spacing)) continue;
    picked.push(site);
    if (picked.length >= count) break;
  }

  return picked;
}
