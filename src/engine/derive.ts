import { memberShare } from './ensemble';
import type { Normals, Volume } from './types';

export type Statistic = 'mean' | 'median' | 'member' | 'share';
export type Reference = 'forecast' | 'anomaly' | 'standardized';

export type Display = {
  statistic: Statistic;
  /** Zero-based member index for the single-member view. */
  member: number;
  share: { direction: 'above' | 'below'; threshold: number };
  reference: Reference;
};

export const defaultDisplay: Display = {
  statistic: 'mean',
  member: 0,
  share: { direction: 'above', threshold: 0 },
  reference: 'forecast',
};

export type Quantity = {
  /** Short description of what one colour means, for legends and tooltips. */
  label: string;
  units: string;
  kind: 'value' | 'anomaly' | 'share';
  /** Ranges that must not be stretched to the data, such as shares of members. */
  fixedRange?: [number, number];
};

/** A volume as displayed: data holds the shown quantity; columns feed SQL. */
export type DisplayVolume = Volume & {
  quantity: Quantity;
  /** Units of the loaded forecast values, before any anomaly or share is derived. */
  sourceUnits: string;
  /** Ensemble spread in the units of the shown quantity, for uncertainty encodings. */
  uncertainty?: Float32Array;
  /** Additional per-cell SQL columns in [time, y, x] order. */
  columns: Record<string, Float32Array | Float64Array>;
};

const pretty = (u: string) => (u === 'degree_Celsius' ? '°C' : u);

function minMax(data: ArrayLike<number>) {
  let min = Infinity,
    max = -Infinity,
    missing = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    } else missing++;
  }

  return { min, max, missing };
}

/** Normals must describe exactly the loaded cells; anything else is a programming error. */
export function normalsMatch(
  volume: Volume,
  normals: Normals | null | undefined,
): normals is Normals {
  return !!normals && normals.volumeId === volume.id && normals.mean.length === volume.data.length;
}

/** Derive the displayed quantity. Every path is an exact function of loaded members,
 * statistics and normals; nothing is approximated by a fitted distribution. */
export function deriveVolume(
  volume: Volume,
  display: Display,
  normals?: Normals | null,
): DisplayVolume {
  const ensemble = volume.ensemble;
  const cells = volume.data.length;
  const units = pretty(volume.units);
  const reference = normalsMatch(volume, normals) ? display.reference : 'forecast';
  const n = normalsMatch(volume, normals) ? normals : null;
  const columns: DisplayVolume['columns'] = {};

  let base: Float32Array | Float64Array = volume.data;
  let label = 'Forecast';
  if (ensemble) {
    const statistic = display.statistic === 'share' ? 'mean' : display.statistic;
    const member = Math.max(0, Math.min(ensemble.count - 1, display.member));
    base =
      statistic === 'median'
        ? ensemble.stats.median
        : statistic === 'member'
          ? ensemble.members.subarray(member * cells, (member + 1) * cells)
          : ensemble.stats.mean;
    label =
      statistic === 'median'
        ? 'Ensemble median'
        : statistic === 'member'
          ? `Member ${ensemble.labels[member] ?? member}`
          : 'Ensemble mean';
    columns.ensemble_mean = ensemble.stats.mean;
    columns.ensemble_sd = ensemble.stats.spread;
    columns.ensemble_p10 = ensemble.stats.p10;
    columns.ensemble_p90 = ensemble.stats.p90;
  }

  if (n) {
    columns.forecast = base;
    columns.normal = n.mean;
    columns.normal_sd = n.sd;
  }

  if (ensemble && display.statistic === 'share') {
    const { direction, threshold } = display.share;
    let offset: Float32Array | undefined;
    let cut = threshold;
    if (n && reference !== 'forecast') {
      offset = new Float32Array(cells);
      for (let i = 0; i < cells; i++)
        offset[i] = reference === 'standardized' ? n.mean[i] + threshold * n.sd[i] : n.mean[i];
      if (reference === 'standardized') cut = 0;
    }
    const data = memberShare(ensemble.members, ensemble.count, cells, cut, direction, offset);
    const what =
      reference === 'standardized'
        ? `${threshold} σ ${direction === 'above' ? 'above' : 'below'} normal`
        : reference === 'anomaly'
          ? `${Math.abs(threshold)} ${units} ${threshold >= 0 === (direction === 'above') ? 'above' : 'below'} normal`
          : `${direction} ${threshold} ${units}`;

    return {
      ...volume,
      data,
      ...minMax(data),
      units: 'share of members',
      sourceUnits: units,
      quantity: {
        label: `Share of ${ensemble.count} members ${reference === 'forecast' ? '' : 'more than '}${what}`,
        units: 'share of members',
        kind: 'share',
        fixedRange: [0, 1],
      },
      columns: { ...columns, share: data },
    };
  }

  let data: Float32Array | Float64Array = base;
  let kind: Quantity['kind'] = 'value';
  let shownUnits = volume.units;
  let uncertainty = ensemble?.stats.spread;
  if (n && reference !== 'forecast') {
    const out = new Float32Array(cells);
    let spread: Float32Array | undefined;
    if (reference === 'standardized' && uncertainty) spread = new Float32Array(cells);
    for (let i = 0; i < cells; i++) {
      const d = base[i] - n.mean[i];
      if (reference === 'anomaly') out[i] = d;
      else {
        out[i] = n.sd[i] > 0 ? d / n.sd[i] : NaN;
        if (spread) spread[i] = n.sd[i] > 0 ? uncertainty![i] / n.sd[i] : NaN;
      }
    }
    if (spread) uncertainty = spread;
    data = out;
    kind = 'anomaly';
    shownUnits = reference === 'anomaly' ? volume.units : 'σ';
    label = `${label} ${reference === 'anomaly' ? 'minus normal' : 'in standard deviations from normal'}`;
  }

  return {
    ...volume,
    data,
    ...minMax(data),
    units: shownUnits,
    sourceUnits: units,
    quantity: { label, units: pretty(shownUnits), kind },
    uncertainty: display.statistic === 'member' ? undefined : uncertainty,
    columns,
  };
}

/** Every member's time series at one cell, in the units of the shown quantity, or null
 * when the shown quantity has no member-wise equivalent (shares of members). */
export function memberSeries(
  volume: DisplayVolume,
  display: Display,
  normals: Normals | null | undefined,
  x: number,
  y: number,
): number[][] | null {
  const e = volume.ensemble;
  if (!e || display.statistic === 'share') return null;
  const [nt, ny, nx] = volume.shape;
  const cells = nt * ny * nx;
  const n = normalsMatch(volume, normals) ? normals : null;
  const reference = n ? display.reference : 'forecast';

  return Array.from({ length: e.count }, (_, m) =>
    Array.from({ length: nt }, (_, t) => {
      const i = (t * ny + y) * nx + x;
      const v = e.members[m * cells + i];
      if (!n || reference === 'forecast') return v;
      const d = v - n.mean[i];

      return reference === 'anomaly' ? d : n.sd[i] > 0 ? d / n.sd[i] : NaN;
    }),
  );
}
