import type { Reference } from '../engine/derive';
import type { NormalsHandle } from '../analysis/useNormals';
import { Button } from './ui/primitives';

const thisYear = new Date().getUTCFullYear();

/** "Compared to normal": choose the reference, see its cost, build it, read its provenance. */
export function NormalsControls({
  handle,
  reference,
  onReference,
  units,
  canCompare,
  unavailableReason,
}: {
  handle: NormalsHandle;
  reference: Reference;
  onReference: (r: Reference) => void;
  units: string;
  canCompare: boolean;
  unavailableReason?: string;
}) {
  const { settings, setSettings, state, normals, current } = handle;
  const p = normals?.provenance;
  const years = settings.years[1] - settings.years[0] + 1;
  const busy = state.status === 'opening' || state.status === 'building';

  return (
    <div className="control-section normals-controls">
      <div className="section-heading">
        <span>Compared to normal</span>
        {reference !== 'forecast' && current ? (
          <span className="section-meta">normals built</span>
        ) : null}
      </div>

      {!canCompare ? (
        <p className="field-note">{unavailableReason}</p>
      ) : (
        <>
          <div className="segmented three" role="radiogroup" aria-label="Reference">
            {(
              [
                ['forecast', 'Values', `Forecast values in ${units}`],
                ['anomaly', `± ${units}`, `Difference from normal in ${units}: how much`],
                [
                  'standardized',
                  '± σ',
                  'Difference in standard deviations of the normal: how unusual',
                ],
              ] as const
            ).map(([value, label, title]) => (
              <button
                key={value}
                role="radio"
                title={title}
                aria-checked={reference === value}
                className={reference === value ? 'selected' : ''}
                onClick={() => onReference(value)}
              >
                {label}
              </button>
            ))}
          </div>

          {reference !== 'forecast' && (
            <>
              <div className="baseline-fields">
                <label>
                  From
                  <input
                    type="number"
                    min={2000}
                    max={thisYear - 1}
                    value={settings.years[0]}
                    disabled={busy}
                    onChange={(e) => {
                      const n = Math.round(Number(e.target.value));
                      if (n >= 2000 && n <= settings.years[1])
                        setSettings({ ...settings, years: [n, settings.years[1]] });
                    }}
                  />
                </label>
                <label>
                  To
                  <input
                    type="number"
                    min={2000}
                    max={thisYear - 1}
                    value={settings.years[1]}
                    disabled={busy}
                    onChange={(e) => {
                      const n = Math.round(Number(e.target.value));
                      if (n >= settings.years[0] && n < thisYear)
                        setSettings({ ...settings, years: [settings.years[0], n] });
                    }}
                  />
                </label>
                <label>
                  ± days
                  <input
                    type="number"
                    min={0}
                    max={45}
                    value={settings.windowDays}
                    disabled={busy}
                    onChange={(e) => {
                      const n = Math.round(Number(e.target.value));
                      if (n >= 0 && n <= 45) setSettings({ ...settings, windowDays: n });
                    }}
                  />
                </label>
              </div>
              <p className="field-note">
                Normal at each valid time = mean of NOAA GEFS analysis samples at the same UTC hour,
                within ± {settings.windowDays} days, in {settings.years[0]}–{settings.years[1]} (
                {years} {years === 1 ? 'year' : 'years'}
                {years < 30 ? '; shorter than a WMO 30-year normal' : ''}).
              </p>

              {state.status === 'ready' && (
                <div className="baseline-cost">
                  <p>
                    <b>{state.estimate.chunks.toLocaleString()}</b> archive reads ·{' '}
                    {state.estimate.perNormal[0] === state.estimate.perNormal[1]
                      ? state.estimate.perNormal[0]
                      : state.estimate.perNormal.join('–')}{' '}
                    samples behind each normal
                  </p>
                  <p className="field-note">
                    Each read is one compressed archive block. Fewer years or a smaller region mean
                    fewer reads, and a less robust normal.
                  </p>
                  <Button variant="primary" onClick={handle.build}>
                    {normals && !current ? 'Rebuild normals for this view' : 'Build normals'}
                  </Button>
                  {normals && !current && (
                    <p className="field-note stale-note">
                      The normals you built belong to another region, run or variable. Values are
                      shown until you rebuild.
                    </p>
                  )}
                </div>
              )}

              {(state.status === 'opening' ||
                state.status === 'estimating' ||
                state.status === 'building') && (
                <div className="baseline-progress" role="status">
                  <p>{state.message}</p>
                  {state.status === 'building' && (
                    <button className="text-button" onClick={handle.cancel}>
                      Cancel
                    </button>
                  )}
                </div>
              )}

              {state.status === 'error' && (
                <p className="query-error" role="alert">
                  {state.message}
                </p>
              )}

              {current && p && (
                <dl className="provenance">
                  <dt>Normal from</dt>
                  <dd>
                    {p.source} · {p.variable}
                  </dd>
                  <dt>Period</dt>
                  <dd>
                    {p.years[0]}–{p.years[1]}, ± {p.windowDays} days, same UTC hour
                  </dd>
                  <dt>Samples per cell</dt>
                  <dd>
                    {p.minSamples === p.maxSamples
                      ? p.minSamples
                      : `${p.minSamples}–${p.maxSamples}`}
                  </dd>
                  {p.interpolatedSteps > 0 && (
                    <>
                      <dt>Interpolated</dt>
                      <dd>
                        {p.interpolatedSteps} of {p.steps} steps fall between 3-hourly archive hours
                        and are interpolated linearly
                      </dd>
                    </>
                  )}
                  <dt>Snapshot</dt>
                  <dd>
                    <code>{p.snapshot}</code>
                  </dd>
                </dl>
              )}
              {current && (
                <p className="field-note caveat">
                  The normal comes from a different model than this forecast, so part of an anomaly
                  can be model bias, especially at long lead times.
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
