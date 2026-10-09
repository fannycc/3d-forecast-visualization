/** Per-cell ensemble statistics over members with finite values; cells without any are NaN.
 * Members are stored member-major: members[m * cells + cell]. */
export type EnsembleStats = {
  mean: Float32Array;
  spread: Float32Array;
  p10: Float32Array;
  median: Float32Array;
  p90: Float32Array;
  valid: Uint8Array;
};

/** Linear interpolation between order statistics (NumPy's default, Hyndman–Fan type 7). */
export function quantile(sorted: ArrayLike<number>, n: number, q: number) {
  if (!n) return NaN;
  const h = (n - 1) * q,
    lo = Math.floor(h),
    hi = Math.min(n - 1, lo + 1);

  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export function ensembleStats(
  members: Float32Array | Float64Array,
  count: number,
  cells: number,
): EnsembleStats {
  if (members.length !== count * cells) throw Error('Ensemble member layout is inconsistent.');
  const mean = new Float32Array(cells),
    spread = new Float32Array(cells),
    p10 = new Float32Array(cells),
    median = new Float32Array(cells),
    p90 = new Float32Array(cells),
    valid = new Uint8Array(cells);
  const values = new Float64Array(count);

  for (let c = 0; c < cells; c++) {
    let n = 0,
      sum = 0;
    for (let m = 0; m < count; m++) {
      const v = members[m * cells + c];
      if (Number.isFinite(v)) {
        values[n++] = v;
        sum += v;
      }
    }

    valid[c] = n;
    if (!n) {
      mean[c] = spread[c] = p10[c] = median[c] = p90[c] = NaN;
      continue;
    }

    const mu = sum / n;
    let squares = 0;
    for (let i = 0; i < n; i++) squares += (values[i] - mu) ** 2;
    const sorted = values.subarray(0, n).sort();
    mean[c] = mu;
    spread[c] = n > 1 ? Math.sqrt(squares / (n - 1)) : 0;
    p10[c] = quantile(sorted, n, 0.1);
    median[c] = quantile(sorted, n, 0.5);
    p90[c] = quantile(sorted, n, 0.9);
  }

  return { mean, spread, p10, median, p90, valid };
}

/** Share of members with data strictly beyond a threshold; an optional per-cell offset
 * (for example a climatological normal) is subtracted from every member first. */
export function memberShare(
  members: Float32Array | Float64Array,
  count: number,
  cells: number,
  threshold: number,
  direction: 'above' | 'below',
  offset?: ArrayLike<number>,
) {
  const out = new Float32Array(cells);
  for (let c = 0; c < cells; c++) {
    const shift = offset ? offset[c] : 0;
    if (!Number.isFinite(shift)) {
      out[c] = NaN;
      continue;
    }

    let n = 0,
      hits = 0;
    for (let m = 0; m < count; m++) {
      const v = members[m * cells + c] - shift;
      if (!Number.isFinite(v)) continue;
      n++;
      if (direction === 'above' ? v > threshold : v < threshold) hits++;
    }
    out[c] = n ? hits / n : NaN;
  }

  return out;
}
