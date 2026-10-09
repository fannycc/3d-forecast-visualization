/** Climatological normals built from an analysis archive.
 *
 * For a valid time τ the normal is the mean of every archive sample that has the same UTC
 * time of day and lies within ± windowDays of τ's calendar date in each chosen year. The
 * year of a window is the year of its centre date, so a window centred on 3 January also
 * includes late December of the previous year. 29 February maps to 28 February in common
 * years. Valid times whose time of day is absent from the archive (hourly forecast leads
 * against a 3-hourly archive) are linearly interpolated between the two neighbouring
 * normals. */

const DAY = 86400;

export type BaselineOptions = { years: [number, number]; windowDays: number };

export type BaselinePlan = {
  /** Valid times (epoch seconds) whose normals are computed directly from samples. */
  targets: number[];
  /** Archive sample index → targets it contributes to. */
  contributions: Map<number, number[]>;
  /** Expected samples per target before missing values. */
  expected: number[];
  /** Each forecast step is a weighted pair of targets: w·a + (1 − w)·b. */
  steps: { a: number; b: number; w: number }[];
  interpolatedSteps: number;
};

/** Move an epoch time to another calendar year, keeping month, day and time of day. */
export function withYear(seconds: number, year: number) {
  const d = new Date(seconds * 1000);
  let day = d.getUTCDate();
  const month = d.getUTCMonth();
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (month === 1 && day === 29 && !leap) day = 28;

  return Date.UTC(year, month, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000;
}

/** First index whose value is ≥ target in ascending values. */
function lowerBound(values: number[], target: number) {
  let lo = 0,
    hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }

  return lo;
}

const timeOfDay = (seconds: number) => ((seconds % DAY) + DAY) % DAY;

export function planBaseline(
  validTimes: number[],
  archiveTimes: number[],
  { years, windowDays }: BaselineOptions,
): BaselinePlan {
  if (!Number.isInteger(windowDays) || windowDays < 0 || windowDays > 45)
    throw Error('Choose a window between 0 and 45 days.');
  if (!Number.isInteger(years[0]) || !Number.isInteger(years[1]) || years[0] > years[1])
    throw Error('Choose a valid range of baseline years.');
  if (archiveTimes.some((t, i) => i > 0 && t <= archiveTimes[i - 1]))
    throw Error('Archive times must be strictly increasing.');

  const hours = [...new Set(archiveTimes.slice(0, 64).map(timeOfDay))].sort((a, b) => a - b);
  if (!hours.length) throw Error('The archive has no time coordinates.');

  /** Nearest archive times of day at or before / after t. */
  const bracket = (t: number): [number, number] => {
    const tod = timeOfDay(t),
      dayStart = t - tod;
    if (hours.includes(tod)) return [t, t];
    const before = [...hours].reverse().find((h) => h < tod);
    const after = hours.find((h) => h > tod);

    return [
      before === undefined ? dayStart - DAY + hours.at(-1)! : dayStart + before,
      after === undefined ? dayStart + DAY + hours[0] : dayStart + after,
    ];
  };

  const targetIndex = new Map<number, number>();
  const targets: number[] = [];
  const add = (t: number) => {
    if (!targetIndex.has(t)) {
      targetIndex.set(t, targets.length);
      targets.push(t);
    }

    return targetIndex.get(t)!;
  };

  let interpolatedSteps = 0;
  const steps = validTimes.map((t) => {
    const [t0, t1] = bracket(t);
    if (t0 === t1) {
      const i = add(t0);

      return { a: i, b: i, w: 1 };
    }
    interpolatedSteps++;

    return { a: add(t0), b: add(t1), w: (t1 - t) / (t1 - t0) };
  });

  const contributions = new Map<number, number[]>();
  const expected = targets.map(() => 0);
  targets.forEach((target, k) => {
    for (let year = years[0]; year <= years[1]; year++) {
      const centre = withYear(target, year);
      for (let day = -windowDays; day <= windowDays; day++) {
        const t = centre + day * DAY;
        const i = lowerBound(archiveTimes, t);
        if (archiveTimes[i] !== t) continue;
        expected[k]++;
        const list = contributions.get(i);
        if (list) list.push(k);
        else contributions.set(i, [k]);
      }
    }
  });

  if (expected.every((n) => n === 0))
    throw Error('The archive has no samples for these baseline years.');

  return { targets, contributions, expected, steps, interpolatedSteps };
}

/** Running per-target, per-cell sums for mean and sample standard deviation. Values are
 * shifted by a per-cell reference to avoid cancellation in the sum of squares. */
export class BaselineAccumulator {
  readonly sum: Float64Array;
  readonly squares: Float64Array;
  readonly count: Uint16Array;
  private reference: Float64Array;

  constructor(
    readonly targets: number,
    readonly cells: number,
  ) {
    this.sum = new Float64Array(targets * cells);
    this.squares = new Float64Array(targets * cells);
    this.count = new Uint16Array(targets * cells);
    this.reference = new Float64Array(cells).fill(NaN);
  }

  add(target: number, cell: number, value: number) {
    if (!Number.isFinite(value)) return;
    if (Number.isNaN(this.reference[cell])) this.reference[cell] = value;
    const v = value - this.reference[cell],
      i = target * this.cells + cell;
    this.sum[i] += v;
    this.squares[i] += v * v;
    this.count[i]++;
  }

  /** Normals per forecast step in [step][cell] order; cells without samples are NaN. */
  result(steps: BaselinePlan['steps']) {
    const mean = new Float32Array(steps.length * this.cells),
      sd = new Float32Array(steps.length * this.cells),
      count = new Uint16Array(steps.length * this.cells);
    const stats = (k: number, c: number) => {
      const i = k * this.cells + c,
        n = this.count[i];
      if (!n) return [NaN, NaN, 0];
      const m = this.sum[i] / n;
      const variance = n > 1 ? (this.squares[i] - n * m * m) / (n - 1) : NaN;

      return [m + this.reference[c], Math.sqrt(Math.max(0, variance)), n];
    };

    steps.forEach(({ a, b, w }, s) => {
      for (let c = 0; c < this.cells; c++) {
        const [ma, sa, na] = stats(a, c);
        const [mb, sb, nb] = a === b ? [ma, sa, na] : stats(b, c);
        const o = s * this.cells + c;
        mean[o] = w * ma + (1 - w) * mb;
        sd[o] = w * sa + (1 - w) * sb;
        count[o] = Math.min(na, nb);
      }
    });

    return { mean, sd, count };
  }
}
