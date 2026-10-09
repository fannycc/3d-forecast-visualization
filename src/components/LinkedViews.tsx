import { isWinterTime, timeValue, timeLabel } from '../engine/time-labels';
import { formatValue } from '../render/value-scale';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Volume } from '../engine/types';
import { sample } from '../engine/coordinates';
import type { ForecastPoint } from '../analysis/points';
import { X as CloseIcon } from 'lucide-react';

export function TimeSeries({
  volume,
  time,
  forecasts,
  onRemove,
  onTime,
  units,
}: {
  volume: Volume;
  time: number;
  forecasts: (ForecastPoint & { plume?: number[][] | null })[];
  onRemove: (id: string) => void;
  /** Units of the plotted quantity, which may be an anomaly or a share. */
  units?: string;
  onTime: (n: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [axis, setAxis] = useState({ left: 36, right: 624 });
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const [size, setSize] = useState({ width: 640, height: 140 });

  useEffect(() => {
    const node = host.current!;
    const main = node.closest('main');
    const slider = main?.querySelector<HTMLElement>('.transport .slider');
    const thumb = slider?.querySelector<HTMLElement>('.slider-thumb');
    if (!main || !slider || !thumb) return;

    const measure = () => {
      const r = node.getBoundingClientRect(),
        track = slider.getBoundingClientRect();
      const radius = thumb.getBoundingClientRect().width / 2;
      setSize({ width: r.width, height: Math.max(70, r.height) });
      setAxis({ left: track.left - r.left + radius, right: track.right - r.left - radius });
    };

    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observer.observe(slider);
    observer.observe(main);
    measure();

    return () => observer.disconnect();
  }, []);

  const series = useMemo(
    () =>
      forecasts.map((p) => ({
        ...p,
        values: p.volume.times.map((_, t) => sample(p.volume, 0, 0, t)),
      })),
    [forecasts],
  );

  /** Per-time 10th, 50th and 90th percentiles across members (type 7). */
  const bands = useMemo(
    () =>
      series.map((p) =>
        p.plume
          ? p.values.map((_, t) => {
              const v = p
                .plume!.map((m) => m[t])
                .filter(Number.isFinite)
                .sort((a, b) => a - b);
              const q = (f: number) => {
                if (!v.length) return NaN;
                const h = (v.length - 1) * f,
                  lo = Math.floor(h);

                return v[lo] + (h - lo) * ((v[Math.min(v.length - 1, lo + 1)] ?? v[lo]) - v[lo]);
              };

              return [q(0.1), q(0.5), q(0.9)];
            })
          : null,
      ),
    [series],
  );

  const [min, max] = useMemo(() => {
    let low = Infinity,
      high = -Infinity;
    for (const point of series)
      for (const value of [...point.values, ...(point.plume?.flat() ?? [])]) {
        if (!Number.isFinite(value)) continue;
        low = Math.min(low, value);
        high = Math.max(high, value);
      }

    return Number.isFinite(low) ? [low, high] : [0, 1];
  }, [series]);

  const padding = (max - min || 1) * 0.1;
  const lo = min - padding,
    span = max - min + padding * 2;
  const hours = volume.times.map((n) => timeValue(n, volume.timeUnits));
  const timeSpan = hours.at(-1)! - hours[0] || 1;
  const { width, height } = size;
  const X = (i: number) =>
    axis.left + ((hours[i] - hours[0]) / timeSpan) * (axis.right - axis.left);
  const Y = (v: number) => height - 26 - ((v - lo) / span) * (height - 38);

  const line = (values: number[]) => {
    let path = '',
      valid = false;
    values.forEach((v, i) => {
      if (!Number.isFinite(v)) {
        valid = false;

        return;
      }
      path += `${valid ? 'L' : 'M'}${X(i)},${Y(v)} `;
      valid = true;
    });

    return path;
  };

  const area = (low: number[], high: number[]) => {
    const ok = low.map((v, i) => Number.isFinite(v) && Number.isFinite(high[i]));
    let d = '';
    let i = 0;
    while (i < low.length) {
      if (!ok[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < low.length && ok[j + 1]) j++;
      const top = Array.from({ length: j - i + 1 }, (_, k) => `${X(i + k)},${Y(high[i + k])}`);
      const bottom = Array.from({ length: j - i + 1 }, (_, k) => `${X(j - k)},${Y(low[j - k])}`);
      d += `M${top.join(' L')} L${bottom.join(' L')} Z `;
      i = j + 1;
    }

    return d;
  };

  const paths = series.map((series) => {
    let path = '',
      valid = false;

    series.values.forEach((v, i) => {
      if (!Number.isFinite(v)) {
        valid = false;

        return;
      }

      path += `${valid ? 'L' : 'M'}${X(i)},${Y(v)} `;
      valid = true;
    });

    return { ...series, path };
  });

  return (
    <section className="time-series point-series">
      <div className="panel-heading">
        <span>
          {isWinterTime(volume.timeUnits) || volume.timeUnits.includes('since ')
            ? 'Point history'
            : forecasts.length === 1
              ? 'Point forecast'
              : 'Point forecasts'}
        </span>
        <span>
          {timeLabel(volume.times[time], volume.timeUnits)} ·{' '}
          {units ?? (volume.units === 'degree_Celsius' ? '°C' : volume.units)}
          {series.some((p) => p.plume) ? ' · members, 10–90 % band, median' : ''}
        </span>
      </div>
      <div className="forecast-legend">
        {series.map((p) => (
          <div key={p.id} className="forecast-legend-item">
            <span className="forecast-swatch" style={{ background: p.color }} />
            <span>
              {Math.abs(p.volume.lat[0]).toFixed(2)}° {p.volume.lat[0] < 0 ? 'S' : 'N'},{' '}
              {Math.abs(p.volume.lon[0]).toFixed(2)}° {p.volume.lon[0] < 0 ? 'W' : 'E'}
            </span>
            <strong style={{ color: p.color }}>
              {units?.startsWith('share')
                ? Number.isFinite(p.values[time])
                  ? `${Math.round(p.values[time] * 100)} %`
                  : '—'
                : formatValue(p.values[time])}
            </strong>
            <button
              aria-label={`Remove point ${p.id}`}
              title="Remove point"
              onClick={() => onRemove(p.id)}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        ))}
      </div>
      <div ref={host} className="point-chart">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className={keyboardFocus ? 'keyboard-focus' : undefined}
          onPointerDown={(e) => {
            e.preventDefault();
            setKeyboardFocus(false);
          }}
          onFocus={() => setKeyboardFocus(true)}
          onBlur={() => setKeyboardFocus(false)}
          role="slider"
          tabIndex={0}
          aria-label={isWinterTime(volume.timeUnits) ? 'Point winter' : 'Point forecast hour'}
          aria-valuemin={hours[0]}
          aria-valuemax={hours.at(-1)}
          aria-valuenow={hours[time]}
          aria-valuetext={timeLabel(volume.times[time], volume.timeUnits)}
          onKeyDown={(e) => {
            setKeyboardFocus(true);
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
              e.preventDefault();

              onTime(
                e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? hours.length - 1
                    : Math.max(
                        0,
                        Math.min(hours.length - 1, time + (e.key === 'ArrowRight' ? 1 : -1)),
                      ),
              );
            }
          }}
          onClick={(e) => {
            const h =
              hours[0] +
              ((e.clientX - e.currentTarget.getBoundingClientRect().left - axis.left) /
                (axis.right - axis.left)) *
                timeSpan;

            let closest = 0;
            hours.forEach((v, i) => {
              if (Math.abs(v - h) < Math.abs(hours[closest] - h)) closest = i;
            });
            onTime(closest);
          }}
        >
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line
                x1={axis.left}
                x2={axis.right}
                y1={Y(min + f * (max - min))}
                y2={Y(min + f * (max - min))}
              />
              <text x={axis.left - 32} y={Y(min + f * (max - min)) + 3}>
                {formatValue(min + f * (max - min))}
              </text>
            </g>
          ))}
          {series.map((p, k) =>
            p.plume ? (
              <g key={`plume-${p.id}`} className="plume" style={{ color: p.color }}>
                {p.plume.map((m, i) => (
                  <path key={i} d={line(m)} className="plume-member" />
                ))}
                <path
                  d={area(
                    bands[k]!.map((b) => b[0]),
                    bands[k]!.map((b) => b[2]),
                  )}
                  className="plume-band"
                />
                <path d={line(bands[k]!.map((b) => b[1]))} className="plume-median" />
              </g>
            ) : null,
          )}
          {paths.map((p) => (
            <path key={p.id} d={p.path} fill="none" style={{ stroke: p.color }} strokeWidth="1.8" />
          ))}
          <line className="point-cursor" x1={X(time)} x2={X(time)} y1="8" y2={height - 24} />
          {series.map((p) =>
            Number.isFinite(p.values[time]) ? (
              <circle
                key={p.id}
                cx={X(time)}
                cy={Y(p.values[time])}
                r="3"
                style={{ fill: p.color }}
                strokeWidth="2"
              />
            ) : null,
          )}
          {(width < 420 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]).map((f) => (
            <text
              key={f}
              x={axis.left + f * (axis.right - axis.left)}
              y={height - 6}
              textAnchor="middle"
            >
              {Math.round(hours[0] + f * timeSpan)}
              {isWinterTime(volume.timeUnits) ? '' : ' h'}
            </text>
          ))}
        </svg>
      </div>
    </section>
  );
}
