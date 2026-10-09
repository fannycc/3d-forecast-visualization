import { useMemo } from 'react';
import type { Display } from '../engine/derive';
import type { DisplayVolume } from '../engine/derive';
import { formatValue } from '../render/value-scale';
import { VSUP_BANDS, vsupColor, type Palette } from '../render/colors';

export type UncertaintyMode = 'off' | 'suppress' | 'hatch';

/** Choose what an ensemble shows and how member disagreement is drawn. */
export function EnsembleControls({
  volume,
  display,
  onDisplay,
  mode,
  onMode,
  scale,
  onScale,
  palette,
  range,
  normalsReady,
}: {
  volume: DisplayVolume;
  display: Display;
  onDisplay: (d: Display) => void;
  mode: UncertaintyMode;
  onMode: (m: UncertaintyMode) => void;
  scale: number;
  onScale: (n: number) => void;
  palette: Palette;
  range: [number, number];
  normalsReady: boolean;
}) {
  const e = volume.ensemble!;
  const units = display.reference === 'standardized' && normalsReady ? 'σ' : volume.sourceUnits;
  const spreadUnits = volume.uncertainty ? volume.quantity.units : volume.sourceUnits;
  const showsUncertainty = display.statistic === 'mean' || display.statistic === 'median';

  return (
    <div className="control-section ensemble-controls">
      <div className="section-heading">
        <span>Ensemble</span>
        <span className="section-meta">{e.count} members</span>
      </div>

      <label htmlFor="ensemble-show">Show</label>
      <select
        id="ensemble-show"
        value={display.statistic}
        onChange={(ev) =>
          onDisplay({ ...display, statistic: ev.target.value as Display['statistic'] })
        }
      >
        <option value="mean">Ensemble mean</option>
        <option value="median">Ensemble median</option>
        <option value="member">One member</option>
        <option value="share">Share of members past a threshold</option>
      </select>

      {display.statistic === 'member' && (
        <div className="inline-field">
          <label htmlFor="ensemble-member">Member</label>
          <input
            id="ensemble-member"
            type="number"
            min={0}
            max={e.count - 1}
            step={1}
            value={display.member}
            onChange={(ev) =>
              onDisplay({
                ...display,
                member: Math.max(0, Math.min(e.count - 1, Math.round(Number(ev.target.value)))),
              })
            }
          />
          <span className="field-note">
            label {e.labels[display.member] ?? display.member} · one possible outcome, not a
            forecast of the most likely one
          </span>
        </div>
      )}

      {display.statistic === 'share' && (
        <div className="threshold-field">
          <select
            aria-label="Threshold direction"
            value={display.share.direction}
            onChange={(ev) =>
              onDisplay({
                ...display,
                share: { ...display.share, direction: ev.target.value as 'above' | 'below' },
              })
            }
          >
            <option value="above">above</option>
            <option value="below">below</option>
          </select>
          <input
            aria-label="Threshold"
            type="number"
            step="any"
            value={display.share.threshold}
            onChange={(ev) => {
              const n = Number(ev.target.value);
              if (Number.isFinite(n))
                onDisplay({ ...display, share: { ...display.share, threshold: n } });
            }}
          />
          <span className="threshold-units">
            {units}
            {display.reference !== 'forecast' && normalsReady ? ' vs normal' : ''}
          </span>
          <p className="field-note">
            Counted over members with data; with {e.count} members the share moves in steps of{' '}
            {formatValue(100 / e.count)} %. This is a share of model runs, not a calibrated
            probability.
          </p>
        </div>
      )}

      {showsUncertainty && (
        <>
          <label className="spaced-label">Disagreement between members</label>
          <div className="segmented" role="radiogroup" aria-label="Uncertainty encoding">
            {(
              [
                ['suppress', 'Suppress'],
                ['hatch', 'Hatch'],
                ['off', 'Off'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                role="radio"
                aria-checked={mode === value}
                className={mode === value ? 'selected' : ''}
                onClick={() => onMode(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {mode !== 'off' && (
            <div className="inline-field">
              <label htmlFor="uncertainty-scale">
                {mode === 'suppress' ? 'Fully suppressed at spread ≥' : 'Hatch where spread ≥'}
              </label>
              <input
                id="uncertainty-scale"
                type="number"
                min={0}
                step="any"
                value={scale}
                onChange={(ev) => {
                  const n = Number(ev.target.value);
                  if (Number.isFinite(n) && n > 0) onScale(n);
                }}
              />
              <span className="threshold-units">{spreadUnits}</span>
            </div>
          )}
          {mode === 'suppress' && (
            <SuppressionLegend palette={palette} range={range} scale={scale} units={spreadUnits} />
          )}
          {mode === 'hatch' && (
            <p className="field-note">
              <span className="hatch-swatch" aria-hidden /> Hatched cells: member standard deviation
              ≥ {formatValue(scale)} {spreadUnits} (after the IPCC AR6 convention for low
              agreement). Colour still shows the {display.statistic}.
            </p>
          )}
          {mode === 'off' && (
            <p className="field-note">
              Colour shows the {display.statistic} only; members may disagree strongly.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** The value-suppressing palette as a wedge: rows are spread bands, columns value steps. */
function SuppressionLegend({
  palette,
  range,
  scale,
  units,
}: {
  palette: Palette;
  range: [number, number];
  scale: number;
  units: string;
}) {
  const rows = useMemo(
    () =>
      Array.from({ length: VSUP_BANDS }, (_, band) => {
        const bins = 2 ** (VSUP_BANDS - 1 - band);

        return Array.from({ length: bins }, (_, i) => vsupColor((i + 0.5) / bins, band, palette));
      }),
    [palette],
  );
  const edges = [0, scale / 3, (2 * scale) / 3, scale];

  return (
    <figure className="vsup-legend" aria-label="Value-suppressing uncertainty legend">
      <div className="vsup-rows">
        {rows.map((cells, band) => (
          <div key={band} className="vsup-row">
            <span className="vsup-band">
              {band < VSUP_BANDS - 1
                ? `${formatValue(edges[band])}–${formatValue(edges[band + 1])}`
                : `≥ ${formatValue(scale)}`}
            </span>
            <div
              className="vsup-cells"
              style={{ gridTemplateColumns: `repeat(${cells.length}, 1fr)` }}
            >
              {cells.map((c, i) => (
                <span key={i} style={{ background: `rgb(${c.join(',')})` }} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="vsup-axis">
        <span>{formatValue(range[0])}</span>
        <span>value</span>
        <span>{formatValue(range[1])}</span>
      </div>
      <figcaption>
        Rows are member spread ({units}). The more members disagree, the fewer value steps the
        colour can show, until only grey remains (value-suppressing palette, Correll et al., CHI
        2018).
      </figcaption>
    </figure>
  );
}
