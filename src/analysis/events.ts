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
