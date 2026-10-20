import type { DisplayVolume, Reference } from '../engine/derive';
import type { Normals, Volume } from '../engine/types';
import type { Palette } from '../render/colors';
import { formatValue } from '../render/value-scale';
import { timeLabel, timeValue } from '../engine/time-labels';
import { memberSplit, regionalMeans } from '../analysis/story';
import { eventCells, type EventRule } from '../analysis/events';
import { rowAreas } from '../analysis/area';
import type { RadialSpec, RadialTile } from '../components/RadialView';
import type { SectionId } from './StoryPanel';

const pretty = (u: string) => (u === 'degree_Celsius' ? '°C' : u);

/** Everything the flat view needs to answer the active section's question. */
export type RadialInput = {
  section: SectionId;
  certaintyView: 'disagreement' | 'trust';
  volume: Volume;
  display: DisplayVolume;
  t: number;
  palette: Palette;
  range: [number, number];
  memberRange: [number, number];
  uncertainty: { mode: 'off' | 'suppress' | 'hatch'; scale: number };
  normals: Normals | null;
  reference: Reference;
  horizon: Float32Array | null;
  mask: Uint8Array | null;
  muted: [number, number, number];
  arrangement: 'map' | 'mix';
  /** The persistent-event rule last searched for, to find the event in every run. */
  eventRule?: EventRule | null;
};

/** Every run's event cells for the last rule, kept while the timeline moves. */
let eventCache: { key: unknown[]; masks: Uint8Array[] } | null = null;

const plane = (data: ArrayLike<number>, t: number, size: number) =>
  Array.prototype.slice.call(data, t * size, (t + 1) * size) as number[];

/** Area-weighted average of a map, ignoring missing cells. */
function areaMean(grid: ArrayLike<number>, weights: ArrayLike<number>) {
  let sum = 0,
    weight = 0;
  for (let i = 0; i < grid.length; i++)
    if (Number.isFinite(grid[i])) {
      sum += grid[i] * weights[i];
      weight += weights[i];
    }

  return weight > 0 ? sum / weight : NaN;
}

const hoursLabel = (h: number) => (h >= 48 ? `${formatValue(h / 24)} d` : `${formatValue(h)} h`);

/** The bottom scale: the centre value, with the outer values mirrored to both sides. */
const mirror = (centre: string, outward: string[], left = outward) => ({
  centre,
  right: outward,
  left: [...left].reverse(),
});

/** Build the radial layout. With an ensemble, the ring holds runs placed by how far their
 * regional average strays from the ensemble mean; otherwise (and for the clock) the ring
 * holds forecast times, clockwise like a clock. */
export function radialSpec(input: RadialInput): RadialSpec {
  const { volume, display, t, section } = input;
  const [nt, ny, nx] = display.shape;
  const size = ny * nx;
  const northUp = volume.lat.length > 1 && volume.lat.at(-1)! > volume.lat[0];
  const units = display.quantity.units;
  const when = timeLabel(display.times[t], display.timeUnits);
  const ensemble = volume.ensemble;
  const masked = section === 'persistent' || section === 'sql' ? input.mask : null;
  const rows = rowAreas(volume.lat, volume.lon);
  const weights = Float32Array.from({ length: size }, (_, i) => {
    const a = rows[Math.floor(i / nx)];

    return Number.isFinite(a) ? a : 1;
  });
  const base = {
    nx,
    ny,
    weights,
    arrangement: input.arrangement,
    northUp,
    units,
    muted: input.muted,
    uncertainty:
      section === 'certainty' && input.certaintyView === 'disagreement'
        ? input.uncertainty
        : undefined,
  };
  const centerGrid = plane(display.data, t, size);
  const centerMap = {
    label: ensemble ? 'Ensemble mean, regional average' : 'Forecast, regional average',
    headline: `${formatValue(areaMean(centerGrid, weights))} ${pretty(units)} · ${when}`,
    grid: centerGrid,
    mask: masked ? plane(masked, t, size) : null,
    spread: display.uncertainty ? plane(display.uncertainty, t, size) : null,
    palette: input.palette,
    range: input.range,
  };

  // Persistent events (and SQL filters): the centre shows how long each place stays in the
  // event; the ring holds forecast times, further out when more of the region is in it.
  if (masked) {
    const hours = display.times.map((v) => timeValue(v, display.timeUnits));
    const duration = new Array<number>(size).fill(0);
    const ever = new Array<number>(size).fill(0);
    for (let i = 0; i < size; i++)
      for (let k = 0; k < nt; k++) {
        if (!masked[k * size + i]) continue;
        ever[i] = 1;
        if (k > 0 && masked[(k - 1) * size + i]) duration[i] += hours[k] - hours[k - 1];
      }
    const longest = Math.max(0, ...duration);
    const share = (k: number) => {
      let hit = 0,
        all = 0;
      for (let i = 0; i < size; i++) {
        all += weights[i];
        if (masked[k * size + i]) hit += weights[i];
      }

      return all > 0 ? hit / all : 0;
    };
    const count = Math.min(24, nt);
    const picks = [
      ...new Set(
        Array.from({ length: count }, (_, k) =>
          Math.round((k * (nt - 1)) / Math.max(1, count - 1)),
        ),
      ),
    ];
    const shares = picks.map(share);
    // With no match, the scale still runs to the whole region.
    const top = Math.max(...shares) || 1;
    const t0 = hours[0],
      span = hours.at(-1)! - t0 || 1;
    const anyShare = areaMean(ever, weights);
    const pct = (v: number) =>
      `${v * 100 >= 10 ? Math.round(v * 100) : Number((v * 100).toFixed(1))} %`;

    // With an event rule and runs, the ring holds the runs (in number order): each shows how
    // long its own event lasts at every place, by the same rule applied to that run's values.
    // Distance is how differently the run places the event from the ensemble mean:
    // 1 − area-weighted overlap (Jaccard) of the places that ever see the event.
    const rule = input.eventRule;
    const memberValues =
      ensemble && rule && section === 'persistent'
        ? rule.column === 'value' && display.quantity.kind === 'value'
          ? (m: number) => ensemble.members.subarray(m * nt * size, (m + 1) * nt * size)
          : rule.column === 'anomaly' && input.normals
            ? (m: number) => {
                const out = new Float32Array(nt * size);
                const from = m * nt * size;
                for (let i = 0; i < out.length; i++)
                  out[i] = ensemble.members[from + i] - input.normals!.mean[i];

                return out;
              }
            : null
        : null;
    const runTiles = (() => {
      if (!memberValues || !ensemble || !rule) return null;
      const order = Array.from({ length: ensemble.count }, (_, m) => m).sort(
        (a, b) => (ensemble.labels[a] ?? a) - (ensemble.labels[b] ?? b),
      );
      // Finding every run's events is the slow part; it depends only on the runs and the rule,
      // so it is kept while the timeline moves.
      const key = [
        ensemble.members,
        rule.column,
        rule.direction,
        rule.threshold,
        rule.minHours,
        input.normals,
      ];
      if (!eventCache || eventCache.key.some((k, i) => k !== key[i]))
        eventCache = {
          key,
          masks: order.map((m) => eventCells(memberValues(m), display.shape, hours, rule).mask),
        };
      const masks = eventCache.masks;
      // Each run at the current time, in the quantity the view shows.
      const shown = (m: number) => {
        const from = m * nt * size + t * size;
        const anomaly = display.quantity.kind === 'anomaly' && input.normals;

        return Array.from({ length: size }, (_, i) =>
          anomaly
            ? ensemble.members[from + i] - input.normals!.mean[t * size + i]
            : ensemble.members[from + i],
        );
      };
      const centreMask = plane(masked, t, size);
      const mismatch = masks.map((mask) => {
        let both = 0,
          either = 0;
        for (let i = 0; i < size; i++) {
          const a = centreMask[i] > 0,
            b = mask[t * size + i] > 0;
          if (a || b) either += weights[i];
          if (a && b) both += weights[i];
        }

        return either > 0 ? 1 - both / either : 0;
      });
      const shareNow = areaMean(centreMask, weights);

      return {
        center: {
          label: 'Ensemble mean, places in the event in colour',
          headline:
            shareNow > 0
              ? `${pct(shareNow)} of the region in the event · ${when}`
              : `No place in the event · ${when}`,
          grid: plane(display.data, t, size),
          mask: centreMask,
          spread: null,
          palette: input.palette,
          range: input.range,
        },
        tiles: order.map((m, j) => ({
          id: `m${m}`,
          label: `Run ${ensemble.labels[m] ?? m}`,
          grid: shown(m),
          mask: Array.from(masks[j].subarray(t * size, (t + 1) * size)),
          palette: input.palette,
          range: input.range,
          angle: (2 * Math.PI * j) / order.length,
          distance: mismatch[j],
        })),
        rings: [
          { distance: 0, label: 'same places' },
          { distance: 1, label: 'no overlap' },
        ],
        scale: mirror('same places', ['50 % different', 'no overlap']),
        ringMeaning:
          'Runs go in number order, clockwise from the top. Each run is shown at the current time, with the places where its own event is happening (same rule as the search) in colour and the rest greyed. Distance is how differently the run places the event from the ensemble mean at this time: on the inner ring the same places, on the outer ring none in common.',
        ringMeaningShort: 'Distance from centre = how differently a run places the event now',
        caption: `Each map is one run at ${when}, with its own event (same rule as the search) in colour, in number order clockwise from the top. Distance is 1 − the area overlap with the ensemble mean’s event at this time. Play the timeline to watch the events grow, move and fade.`,
      };
    })();

    return {
      ...base,
      uncertainty: undefined,
      center: {
        label: 'How long each place stays in the event',
        headline:
          anyShare > 0
            ? `${pct(anyShare)} of the region · up to ${hoursLabel(longest)}`
            : 'No place matches the event',
        grid: duration,
        mask: ever,
        spread: null,
        palette: 'ember',
        range: [0, Math.max(longest, 1)],
      },
      ...(runTiles ?? {
        tiles: picks.map((k, j) => ({
          id: `t${k}`,
          label: timeLabel(display.times[k], display.timeUnits),
          grid: plane(display.data, k, size),
          mask: plane(masked, k, size),
          palette: input.palette,
          range: input.range,
          angle: (2 * Math.PI * (hours[k] - t0)) / span,
          distance: shares[j] / top,
        })),
        rings: [
          { distance: 0, label: '0 %' },
          { distance: 1, label: pct(top) },
        ],
        scale: mirror('0 %', [pct(top / 2), `${pct(top)} of the area`]),
        ringMeaning:
          'Distance from the centre is the share of the region inside the event at that forecast time. The centre map shows, for each place, how many hours the event lasts there.',
        ringMeaningShort: 'Distance from centre = share of the region in the event',
        caption: `A clock of the event: each map is one forecast time, clockwise from the top, with places outside the event greyed. Distance from the centre is the share of the region in the event (up to ${pct(top)}). Centre: how long each place stays in the event, up to ${hoursLabel(longest)}.`,
      }),
    };
  }

  // How does the region's average change? With runs: each run's regional average through the
  // whole forecast as a strip of colours (time left to right, a gap at the current time),
  // around the ensemble mean's strip. Distance is how far the run's path strays from the
  // mean's, as the root-mean-square difference over all lead times.
  if (ensemble && section === 'clock') {
    const hours = display.times.map((v) => timeValue(v, display.timeUnits));
    const cells = nt * size;
    // Daily means (a centred 24 h window), so the stripes show the weather, not day and night.
    const daily = (path: number[]) =>
      path.map((_, k) => {
        let sum = 0,
          n = 0;
        for (let j = 0; j < nt; j++)
          if (Math.abs(hours[j] - hours[k]) <= 12 && Number.isFinite(path[j])) {
            sum += path[j];
            n++;
          }

        return n ? sum / n : NaN;
      });
    const raw = (data: ArrayLike<number>, offset: number) =>
      Array.from({ length: nt }, (_, k) => {
        let sum = 0,
          weight = 0;
        for (let i = 0; i < size; i++) {
          const v = data[offset + k * size + i];
          if (!Number.isFinite(v)) continue;
          sum += v * weights[i];
          weight += weights[i];
        }

        return weight ? sum / weight : NaN;
      });
    const series = (data: ArrayLike<number>, offset: number) => daily(raw(data, offset));
    const mean = series(ensemble.stats.mean, 0);
    const order = Array.from({ length: ensemble.count }, (_, m) => m).sort(
      (a, b) => (ensemble.labels[a] ?? a) - (ensemble.labels[b] ?? b),
    );
    const runs = order.map((m) => series(ensemble.members, m * cells));
    const all = [...mean, ...runs.flat()].filter(Number.isFinite);
    const lo = Math.min(...all),
      hi = Math.max(...all);
    const h0 = hours[0],
      span = hours.at(-1)! - h0 || 1;
    const nowColumn = Math.round(((hours[t] - h0) / span) * (nx - 1));
    const at = (path: number[], hour: number) => {
      let k = 0;
      while (k < nt - 2 && hours[k + 1] <= hour) k++;
      const f = Math.max(0, Math.min(1, (hour - hours[k]) / (hours[k + 1] - hours[k] || 1)));

      return path[k] + (path[Math.min(nt - 1, k + 1)] - path[k]) * f;
    };
    const strip = (path: number[]) =>
      Array.from({ length: size }, (_, i) => {
        const x = i % nx;

        return x === nowColumn ? NaN : at(path, h0 + (x / Math.max(1, nx - 1)) * span);
      });
    const rms = runs.map((path) => {
      let sum = 0,
        n = 0;
      path.forEach((v, k) => {
        if (Number.isFinite(v) && Number.isFinite(mean[k])) {
          sum += (v - mean[k]) ** 2;
          n++;
        }
      });

      return n ? Math.sqrt(sum / n) : 0;
    });
    const worst = Math.max(...rms, 1e-9);
    const u = pretty(units);

    return {
      ...base,
      arrangement: 'map',
      geographic: false,
      uncertainty: undefined,
      center: {
        label: `Ensemble mean: regional average, ${timeLabel(display.times[0], display.timeUnits)} → ${timeLabel(display.times.at(-1)!, display.timeUnits)}`,
        headline: `${formatValue(mean[t])} ${u} daily average · ${when}`,
        grid: strip(mean),
        mask: null,
        spread: null,
        palette: input.palette,
        range: [lo, hi],
      },
      tiles: runs.map((path, j) => ({
        id: `m${order[j]}`,
        label: `Run ${ensemble.labels[order[j]] ?? order[j]}`,
        grid: strip(path),
        mask: null,
        palette: input.palette,
        range: [lo, hi] as [number, number],
        angle: (2 * Math.PI * j) / runs.length,
        distance: rms[j] / worst,
      })),
      rings: [
        { distance: 0, label: `0 ${u}` },
        { distance: 1, label: `${formatValue(worst)} ${u}` },
      ],
      scale: mirror('0', [formatValue(worst / 2), `${formatValue(worst)} ${u}`]),
      ringMeaning:
        'Each strip is a run’s daily regional average through the whole forecast, time from left to right, with a gap at the current time. Runs go in number order, clockwise from the top. Distance is how far the run’s path strays from the ensemble mean’s, as the root-mean-square difference over all lead times.',
      ringMeaningShort: 'Distance from centre = how far a run’s average path strays',
      caption: `Forecast stripes: each run’s daily area-weighted regional average from ${timeLabel(display.times[0], display.timeUnits)} to ${timeLabel(display.times.at(-1)!, display.timeUnits)}, coloured from ${formatValue(lo)} to ${formatValue(hi)} ${u}. Centre: the ensemble mean’s stripes.`,
    };
  }

  // Any section without runs: a ring of forecast times.
  if (!ensemble || section === 'clock') {
    const means = regionalMeans(display);
    const finite = [...means].filter(Number.isFinite);
    const lo = Math.min(...finite),
      hi = Math.max(...finite);
    const count = Math.min(24, nt);
    const picks = [
      ...new Set(
        Array.from({ length: count }, (_, k) =>
          Math.round((k * (nt - 1)) / Math.max(1, count - 1)),
        ),
      ),
    ];
    const t0 = display.times[0],
      span = display.times.at(-1)! - t0 || 1;
    const tiles: RadialTile[] = picks.map((k) => ({
      id: `t${k}`,
      label: timeLabel(display.times[k], display.timeUnits),
      grid: plane(display.data, k, size),
      mask: masked ? plane(masked, k, size) : null,
      palette: input.palette,
      range: input.range,
      angle: (2 * Math.PI * (display.times[k] - t0)) / span,
      distance: hi > lo ? (means[k] - lo) / (hi - lo) : 0.5,
    }));

    return {
      ...base,
      center: centerMap,
      tiles,
      rings: [
        { distance: 0, label: `${formatValue(lo)} ${units}` },
        { distance: 1, label: `${formatValue(hi)} ${units}` },
      ],
      scale: mirror(`${formatValue(lo)}`, [`${formatValue(hi)} ${units}`]),
      ringMeaning:
        'Distance from the centre is each forecast time’s area-weighted regional average: lowest on the inner ring, highest on the outer ring.',
      ringMeaningShort: 'Distance from centre = regional average',
      caption: `A clock of the forecast: each map is one forecast time, clockwise from the top. Distance from the centre is that time’s area-weighted regional average (inner ring ${formatValue(lo)}, outer ring ${formatValue(hi)} ${units}). Centre: the current time.`,
    };
  }

  // Runs: ranked by their area-weighted difference from the ensemble mean.
  const split = memberSplit(volume, t)!;
  const cells = nt * size;
  const maxDev = Math.max(...split.deviation.map(Math.abs), 1e-9);
  const n = split.order.length;
  const run = (m: number) =>
    Array.prototype.slice.call(
      ensemble.members,
      m * cells + t * size,
      m * cells + (t + 1) * size,
    ) as number[];
  const mean = plane(ensemble.stats.mean, t, size);
  const normal = input.normals ? plane(input.normals.mean, t, size) : null;
  const normalSd = input.normals ? plane(input.normals.sd, t, size) : null;

  let palette = input.palette,
    range = input.range;
  let transform = (grid: number[]) => grid;
  if (section === 'members') {
    palette = 'balance';
    range = input.memberRange;
    transform = (grid) => grid.map((v, i) => v - mean[i]);
  } else if (section === 'normal' && normal && input.reference !== 'forecast') {
    transform = (grid) =>
      grid.map((v, i) =>
        input.reference === 'anomaly'
          ? v - normal[i]
          : normalSd![i] > 0
            ? (v - normal[i]) / normalSd![i]
            : NaN,
      );
  }

  const below = split.deviation.filter((d) => d < 0).length;
  // Outside the members section, runs keep a fixed place in number order, like a clock,
  // so each one can be followed through time; only its distance from the mean changes.
  const runNumber = (m: number) => ensemble.labels[m] ?? m;
  const slot = new Map(
    [...split.order].sort((a, b) => runNumber(a) - runNumber(b)).map((m, i) => [m, i]),
  );
  const tiles: RadialTile[] = split.order.map((m, k) => {
    const dev = split.deviation[k];
    // Members: colder runs on the left half, warmer on the right, with a gap at top and
    // bottom. Otherwise runs in number order, clockwise from the top.
    const angle =
      section === 'members'
        ? dev < 0
          ? Math.PI * 1.12 + (Math.PI * 0.76 * k) / Math.max(1, below - 1)
          : Math.PI * 0.12 + (Math.PI * 0.76 * (k - below)) / Math.max(1, n - below - 1)
        : (2 * Math.PI * slot.get(m)!) / n;

    return {
      id: `m${m}`,
      label: `Run ${ensemble.labels[m] ?? m}`,
      grid: transform(run(m)),
      mask: null,
      palette,
      range,
      angle,
      distance: Math.abs(dev) / maxDev,
    };
  });

  let center = centerMap;
  if (section === 'members')
    center = {
      ...centerMap,
      label: 'Ensemble mean, regional average',
      headline: `${formatValue(areaMean(mean, weights))} ${pretty(units)} · ${when}`,
      grid: mean,
      palette: input.palette,
      range: input.range,
      spread: null,
    };
  if (section === 'certainty' && input.certaintyView === 'trust' && input.horizon) {
    const hours = volume.times.map((v) => timeValue(v, volume.timeUnits));
    center = {
      label: 'Trust horizon: hours each place stays reliable',
      headline: `${hoursLabel(areaMean(input.horizon, weights))} on average`,
      grid: Array.from(input.horizon),
      mask: null,
      spread: null,
      palette: 'viridis',
      range: [hours[0], hours.at(-1)!],
    };
  }

  const devUnits = pretty(volume.units);

  return {
    ...base,
    center,
    tiles,
    ringMeaning:
      section === 'members'
        ? 'Distance from the centre is how far a run’s area-weighted regional average is from the ensemble mean. Runs on the inner ring agree with the mean; the further out, the more the run strays.'
        : 'Runs go in number order, clockwise from the top. Distance is how far a run’s area-weighted regional average is from the ensemble mean, warmer or colder: the inner ring means equal to the mean; the further out, the more the run strays.',
    ringMeaningShort: 'Distance from centre = how far a run strays from the mean',
    rings: [
      { distance: 0, label: `0 ${devUnits}` },
      { distance: 0.5, label: `±${formatValue(maxDev / 2)} ${devUnits}` },
      { distance: 1, label: `±${formatValue(maxDev)} ${devUnits}` },
    ],
    scale:
      section === 'members'
        ? mirror(
            '0',
            [`+${formatValue(maxDev / 2)}`, `+${formatValue(maxDev)} ${devUnits}`],
            [`−${formatValue(maxDev / 2)}`, `−${formatValue(maxDev)} ${devUnits}`],
          )
        : mirror('0', [formatValue(maxDev / 2), `${formatValue(maxDev)} ${devUnits}`]),
    sides:
      section === 'members'
        ? [
            { angle: Math.PI / 2, label: 'Warmer than average' },
            { angle: (3 * Math.PI) / 2, label: 'Colder than average' },
          ]
        : undefined,
    caption:
      section === 'members'
        ? `Each map is one run minus the ensemble mean at ${when}. Warmer runs on the right, colder on the left; distance from the centre is how far the run’s regional average strays from the mean.`
        : `Each map is one of ${n} runs at ${when}, in number order clockwise from the top. Distance from the inner ring is how far the run’s area-weighted regional average strays from the ensemble mean (rings in ${devUnits}); runs close to the centre agree with it.${section === 'certainty' && input.certaintyView === 'trust' ? ' Centre: how many hours ahead each cell stays below the spread threshold.' : ''}`,
  };
}
