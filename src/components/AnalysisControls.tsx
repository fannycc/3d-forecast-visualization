import { useEffect, useMemo, useRef, useState } from 'react';
import type { DisplayVolume as Volume } from '../engine/derive';
import { eventSQL, type EventRule } from '../analysis/events';
import { areaSummary, formatArea } from '../analysis/area';
import { formatValue } from '../render/value-scale';
import { isWinterTime, timeLabel, timeValue } from '../engine/time-labels';
import { readOnlyQuery, useParamValue, applySQL } from '../analysis/state';
import type { Analysis } from '../analysis/useAnalysis';
import { Button, Popover } from './ui/primitives';
import { Info } from 'lucide-react';

export function AnalysisControls({
  volume,
  analysis,
  onEnable,
  slices,
  onReveal,
  part,
  selectionStyle,
  onSelectionStyle,
}: {
  volume: Volume;
  analysis: Analysis;
  onEnable: () => void;
  slices: [number, number, number];
  onReveal: (cuts: [number, number, number]) => void;
  /** Story sections show either the event builder or the free SQL editor. */
  part: 'events' | 'sql';
  selectionStyle: 'isolate' | 'paint';
  onSelectionStyle: (style: 'isolate' | 'paint') => void;
}) {
  const { state, runtime, matches, status, error } = analysis;
  const unit = volume.quantity.units;
  const last = timeValue(volume.times.at(-1)!, volume.timeUnits);
  const first = timeValue(volume.times[0], volume.timeUnits);
  const query = useParamValue(state.sqlDraft);
  const setQuery = (value: string) => state.sqlDraft.update(value);
  const applied = useParamValue(state.appliedSQL);
  const [queryError, setQueryError] = useState(''),
    [running, setRunning] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    generation.current++;
    setRunning(false);
    setQueryError('');

    return () => {
      generation.current++;
    };
  }, [volume]);

  const reset = () => {
    generation.current++;
    applySQL(state, null);
    setRunning(false);
    setQueryError('');
  };

  const run = async (text = query) => {
    if (!runtime) return;
    const id = ++generation.current;
    setRunning(true);
    setQueryError('');
    try {
      const source = readOnlyQuery(text);

      const schema = (await runtime.coordinator.query(
        `DESCRIBE SELECT * FROM ${source} AS result`,
        { type: 'json', cache: false },
      )) as { column_name: string }[];

      if (id !== generation.current) return;
      const hasIds = schema.some((field) => field.column_name === 'cell_id');
      applySQL(state, hasIds ? text : null);
    } catch (error) {
      if (id === generation.current) setQueryError((error as Error).message);
    } finally {
      if (id === generation.current) setRunning(false);
    }
  };

  const active = applied;
  const cuts = matches?.revealCuts;
  const area = useMemo(
    () => (active && matches && !status && !error ? areaSummary(volume, matches.mask) : null),
    [active, matches, status, error, volume],
  );

  const clipped =
    !status &&
    !error &&
    matches &&
    matches.count > 0 &&
    cuts &&
    (cuts[0] > slices[0] || cuts[1] < slices[1] || cuts[2] > slices[2]);

  useEffect(() => onEnable(), [onEnable]);

  return (
    <div className="analysis-controls">
      {part === 'events' && !isWinterTime(volume.timeUnits) && (
        <EventBuilder
          key={`${volume.variable}|${volume.quantity.label}`}
          volume={volume}
          disabled={!runtime || running}
          reason={
            running
              ? 'Searching…'
              : runtime
                ? ''
                : error && !status
                  ? `The query engine could not start: ${error}`
                  : 'Preparing the query engine for this view…'
          }
          onRetry={!runtime && error && !status ? analysis.retry : undefined}
          onFind={(text) => {
            setQuery(text);
            run(text);
          }}
        />
      )}
      {active && (
        <div className="segmented two" role="radiogroup" aria-label="How matches are drawn">
          {(
            [
              ['isolate', 'Isolate matches', 'Draw only the matching cells'],
              ['paint', 'Paint matches', 'Keep the whole cube; colour only the matches'],
            ] as const
          ).map(([value, label, title]) => (
            <button
              key={value}
              role="radio"
              title={title}
              aria-checked={selectionStyle === value}
              className={selectionStyle === value ? 'selected' : ''}
              onClick={() => onSelectionStyle(value)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {(active || error) && (
        <div className="selection-summary">
          <p
            className={`selection-status ${error ? 'query-error' : ''}`}
            role="status"
            title={
              error ||
              `${matches?.count.toLocaleString() ?? 0} of ${volume.data.length.toLocaleString()} cells in the loaded region`
            }
          >
            {error ||
              (status
                ? 'Updating…'
                : matches
                  ? `${matches.count.toLocaleString()} cells matched`
                  : 'Preparing…')}
          </p>
          {active && (
            <button className="text-button" onClick={reset}>
              Clear
            </button>
          )}
        </div>
      )}
      {area && area.matchedCells > 0 && (
        <AreaResult
          area={area}
          volume={volume}
          time={slices[2]}
          onTime={(t) => onReveal([slices[0], slices[1], t])}
        />
      )}
      {active && clipped && (
        <div className="selection-clipped">
          <p>SQL matches extend beyond the current slices.</p>
          <Button
            onClick={() =>
              onReveal([
                Math.max(slices[0], cuts[0]),
                Math.min(slices[1], cuts[1]),
                Math.max(slices[2], cuts[2]),
              ])
            }
          >
            Reveal all matches
          </Button>
        </div>
      )}
      {part === 'sql' && (
        <div className="sql-disclosure">
          <div className="query-toolbar">
            <code>loaded_forecast</code>
            <Popover
              trigger={
                <Button variant="ghost" className="icon" aria-label="Query reference">
                  <Info size={14} />
                </Button>
              }
            >
              <div className="query-reference">
                <strong>Loaded region</strong>
                <p>
                  {first} to {last} {isWinterTime(volume.timeUnits) ? 'winters' : 'forecast hours'}{' '}
                  · {unit}
                </p>
                <p>
                  Columns: cell_id, longitude, latitude, cell_area_km2,{' '}
                  {isWinterTime(volume.timeUnits) ? 'winter' : 'forecast_hour'}, value
                  {volume.variable === 'temperature_2m' ? ', temperature' : ''}
                  {columnNames(volume).map((c) => `, ${c}`)}.
                </p>
                <p>
                  <code>value</code> is what the cube shows: {volume.quantity.label.toLowerCase()} (
                  {unit}). Weight by <code>cell_area_km2</code> for area statistics; cells shrink
                  toward the poles.
                </p>
                <p>
                  Include cell_id to show matching cells in the cube. Filter values and time
                  coordinates in your WHERE clause.
                </p>
              </div>
            </Popover>
          </div>
          <textarea
            aria-label="SQL query"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button className="run-query" disabled={!runtime || running} onClick={() => run()}>
            {running ? 'Running…' : !runtime ? 'Preparing…' : 'Run query'}
          </Button>
          {queryError && (
            <p className="query-error" role="alert">
              {queryError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function columnNames(volume: Volume) {
  const names = Object.keys(volume.columns);
  if (names.includes('normal') && names.includes('forecast'))
    names.push('anomaly', 'standardized_anomaly');

  return names;
}

const columnLabels: Record<string, string> = {
  value: 'Shown value',
  anomaly: 'Anomaly',
  standardized_anomaly: 'Standardized anomaly (σ)',
  ensemble_mean: 'Ensemble mean',
  ensemble_p10: '10th percentile of members',
  ensemble_p90: '90th percentile of members',
  share: 'Share of members',
  forecast: 'Forecast value',
};

/** Persistence questions as a form that writes inspectable SQL. */
function EventBuilder({
  volume,
  disabled,
  reason,
  onRetry,
  onFind,
}: {
  volume: Volume;
  disabled: boolean;
  /** Why the search cannot run right now, shown beside the button. */
  reason: string;
  onRetry?: () => void;
  onFind: (sql: string) => void;
}) {
  const columns = [
    'value',
    ...columnNames(volume).filter((c) => c in columnLabels && c !== 'forecast'),
  ];
  /** A threshold that some places actually reach: the upper fifth of this region's values. */
  const defaultThreshold = (v: Volume) => {
    if (v.quantity.kind === 'anomaly')
      return Number(formatValue(Math.max(Math.abs(v.min), Math.abs(v.max)) / 3));
    if (v.quantity.kind === 'share') return 0.5;
    const step = Math.max(1, Math.floor(v.data.length / 20000));
    const sample: number[] = [];
    for (let i = 0; i < v.data.length; i += step)
      if (Number.isFinite(v.data[i])) sample.push(v.data[i]);
    sample.sort((a, b) => a - b);

    return sample.length
      ? Number(formatValue(sample[Math.floor(sample.length * 0.8)]))
      : Number(formatValue(v.min + (v.max - v.min) * 0.75));
  };
  const [rule, setRule] = useState<EventRule>(() => ({
    column: 'value',
    direction: 'above',
    threshold: defaultThreshold(volume),
    minHours: 72,
  }));
  // A new region or variable gets a fresh default, until the threshold is edited by hand.
  const edited = useRef(false);
  useEffect(() => {
    if (!edited.current) setRule((r) => ({ ...r, threshold: defaultThreshold(volume) }));
  }, [volume]);
  const [unit, setUnit] = useState<'h' | 'd'>('d');
  const column = columns.includes(rule.column) ? rule.column : 'value';
  const [error, setError] = useState('');

  return (
    <div className="event-builder">
      <div className="section-heading">
        <span>Find persistent events</span>
      </div>
      <div className="event-sentence">
        <span>Cells where</span>
        <select
          aria-label="Event column"
          value={column}
          onChange={(e) => setRule({ ...rule, column: e.target.value })}
        >
          {columns.map((c) => (
            <option key={c} value={c}>
              {c === 'value' ? `${columnLabels.value} (${volume.quantity.units})` : columnLabels[c]}
            </option>
          ))}
        </select>
        <span>stays</span>
        <select
          aria-label="Event direction"
          value={rule.direction}
          onChange={(e) =>
            setRule({ ...rule, direction: e.target.value as EventRule['direction'] })
          }
        >
          <option value="above">above</option>
          <option value="below">below</option>
        </select>
        <input
          aria-label="Event threshold"
          type="number"
          step="any"
          value={rule.threshold}
          onChange={(e) => {
            edited.current = true;
            setRule({ ...rule, threshold: Number(e.target.value) });
          }}
        />
        <span>for at least</span>
        <input
          aria-label="Event duration"
          type="number"
          min={0}
          step="any"
          value={unit === 'd' ? rule.minHours / 24 : rule.minHours}
          onChange={(e) =>
            setRule({ ...rule, minHours: Number(e.target.value) * (unit === 'd' ? 24 : 1) })
          }
        />
        <select
          aria-label="Duration unit"
          value={unit}
          onChange={(e) => setUnit(e.target.value as 'h' | 'd')}
        >
          <option value="d">days</option>
          <option value="h">hours</option>
        </select>
      </div>
      <p className="field-note">
        Every consecutive sample must meet the condition; duration runs from the first to the last
        of them in valid hours, so irregular forecast steps are counted correctly. Missing data ends
        a run.
      </p>
      <Button
        disabled={disabled}
        onClick={() => {
          try {
            setError('');
            onFind(eventSQL({ ...rule, column }));
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        Find events
      </Button>
      {disabled && reason && (
        <p className="field-note" role="status">
          {reason}{' '}
          {onRetry && (
            <button className="text-button" onClick={onRetry}>
              Try again
            </button>
          )}
        </p>
      )}
      {!disabled && rule.minHours === 0 && (
        <p className="field-note">
          A duration of 0 matches single moments; set a duration to find conditions that last.
        </p>
      )}
      {error && (
        <p className="query-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Area, not cell count: how much of the region a selection covers, and when. */
function AreaResult({
  area,
  volume,
  time,
  onTime,
}: {
  area: ReturnType<typeof areaSummary>;
  volume: Volume;
  time: number;
  onTime: (t: number) => void;
}) {
  const peak = area.peakIndex;
  const share = area.withData[peak] ? area.matched[peak] / area.withData[peak] : NaN;
  const max = area.matched[peak] || 1;
  const units = volume.quantity.kind === 'share' ? '' : volume.quantity.units;
  const mean =
    volume.quantity.kind === 'share'
      ? `${Math.round(area.weightedMean * 100)} %`
      : `${formatValue(area.weightedMean)} ${units}`;

  return (
    <div className="area-result">
      <p>
        Peak <b>{formatArea(area.matched[peak])}</b>
        {Number.isFinite(share)
          ? ` · ${(share * 100).toFixed(share < 0.1 ? 1 : 0)} % of the region with data`
          : ''}{' '}
        at {timeLabel(volume.times[peak], volume.timeUnits)}
      </p>
      <p>
        Now <b>{formatArea(area.matched[time])}</b> · area-weighted mean of matches {mean}
      </p>
      <div className="area-bars" role="group" aria-label="Matched area by time">
        {[...area.matched].map((a, t) => (
          <button
            key={t}
            className={t === time ? 'current' : ''}
            style={{ height: `${Math.max(a > 0 ? 6 : 0, (a / max) * 100)}%` }}
            title={`${timeLabel(volume.times[t], volume.timeUnits)}: ${formatArea(a)}`}
            aria-label={`${timeLabel(volume.times[t], volume.timeUnits)}: ${formatArea(a)}`}
            onClick={() => onTime(t)}
          />
        ))}
      </div>
      <p className="field-note">
        Spherical cell areas (R = 6371 km), so high-latitude cells count less than cell totals
        suggest.
      </p>
    </div>
  );
}
