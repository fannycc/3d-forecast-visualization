export type EventRule = {
  /** A numeric column of loaded_forecast, such as value or anomaly. */
  column: string;
  direction: 'above' | 'below';
  threshold: number;
  /** Minimum time from the first to the last qualifying sample, in hours. */
  minHours: number;
};

const identifier = /^[a-z_][a-z0-9_]*$/;

/** Write a gaps-and-islands query for conditions that persist through consecutive samples.
 * A run is broken by a sample that fails the condition or has no data. Duration is
 * measured in valid hours (last − first sample), never in step counts, because forecast
 * steps are irregular. Every sample inside a qualifying run is returned. */
export function eventSQL(rule: EventRule) {
  if (!identifier.test(rule.column)) throw Error('Choose a column from loaded_forecast.');
  if (!Number.isFinite(rule.threshold)) throw Error('Enter a finite threshold.');
  if (!Number.isFinite(rule.minHours) || rule.minHours < 0)
    throw Error('Enter a duration of zero hours or more.');
  const op = rule.direction === 'above' ? '>' : '<';

  return `WITH hits AS (
  SELECT cell_id, x_index, y_index, time_index, forecast_hour, longitude, latitude, ${rule.column},
    time_index - row_number() OVER (PARTITION BY x_index, y_index ORDER BY time_index) AS run
  FROM loaded_forecast
  WHERE ${rule.column} ${op} ${rule.threshold}
),
runs AS (
  SELECT x_index, y_index, run, max(forecast_hour) - min(forecast_hour) AS duration_h
  FROM hits GROUP BY x_index, y_index, run
)
SELECT hits.cell_id, hits.longitude, hits.latitude, hits.forecast_hour, hits.${rule.column}, runs.duration_h
FROM hits JOIN runs USING (x_index, y_index, run)
WHERE runs.duration_h >= ${rule.minHours}`;
}

/** The same rule as eventSQL, on one array in [time, y, x] order, for checking it against
 * individual runs: runs of consecutive steps that meet the condition (strictly above or
 * below), broken by a failing or missing sample, kept when they last at least minHours from
 * first to last sample. Returns the matching cells and, per place, the longest event's
 * duration in hours (NaN where there is none). */
export function eventCells(
  values: ArrayLike<number>,
  shape: [number, number, number],
  hours: number[],
  rule: Pick<EventRule, 'direction' | 'threshold' | 'minHours'>,
) {
  const [nt, ny, nx] = shape;
  const plane = ny * nx;
  const mask = new Uint8Array(nt * plane);
  const longest = new Float32Array(plane).fill(NaN);
  const hit = (v: number) => (rule.direction === 'above' ? v > rule.threshold : v < rule.threshold);
  for (let i = 0; i < plane; i++) {
    let start = -1;
    const close = (end: number) => {
      const duration = hours[end] - hours[start];
      if (duration >= rule.minHours) {
        for (let t = start; t <= end; t++) mask[t * plane + i] = 1;
        if (!(longest[i] >= duration)) longest[i] = duration;
      }
      start = -1;
    };
    for (let t = 0; t < nt; t++) {
      const v = values[t * plane + i];
      if (Number.isFinite(v) && hit(v)) {
        if (start < 0) start = t;
      } else if (start >= 0) close(t - 1);
    }
    if (start >= 0) close(nt - 1);
  }

  return { mask, longest };
}
