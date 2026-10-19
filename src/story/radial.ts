import type { DisplayVolume, Reference } from '../engine/derive';
import type { Normals, Volume } from '../engine/types';
import type { Palette } from '../render/colors';
import { formatValue } from '../render/value-scale';
import { timeLabel, timeValue } from '../engine/time-labels';
import { memberSplit, regionalMeans } from '../analysis/story';
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
};

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
    };
  }

  // The clock, or any section without runs: a ring of forecast times.
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
  const tiles: RadialTile[] = split.order.map((m, k) => {
    const dev = split.deviation[k];
    // Members: colder runs on the left half, warmer on the right, with a gap at top and
    // bottom. Otherwise the ring runs coldest to warmest, clockwise from the top.
    const angle =
      section === 'members'
        ? dev < 0
          ? Math.PI * 1.12 + (Math.PI * 0.76 * k) / Math.max(1, below - 1)
          : Math.PI * 0.12 + (Math.PI * 0.76 * (k - below)) / Math.max(1, n - below - 1)
        : (2 * Math.PI * k) / n;

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
      'Distance from the centre is how far a run’s area-weighted regional average is from the ensemble mean. Runs on the inner ring agree with the mean; the further out, the more the run strays.',
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
        : `Each map is one of ${n} runs at ${when}. Distance from the centre is how far the run’s area-weighted regional average strays from the ensemble mean (rings in ${devUnits}); runs close to the centre agree with it.${section === 'certainty' && input.certaintyView === 'trust' ? ' Centre: how many hours ahead each cell stays below the spread threshold.' : ''}`,
  };
}
