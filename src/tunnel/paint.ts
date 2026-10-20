import type { Volume } from '../engine/types';
import type { DisplayVolume } from '../engine/derive';
import { color, vsupBand, vsupColor, type Palette } from '../render/colors';
import { formatValue } from '../render/value-scale';
import { timeLabel } from '../engine/time-labels';
import { rowAreas } from '../analysis/area';
import { patternLevel } from '../render/patterns';
import { binAngle, directionName, squareWalls, wallValues, type FlatWall } from './wall';
import type { SectionId } from '../story/StoryPanel';

/** A wall ready to draw: n rows (positions across the wall) × steps columns of colour, and
 * a sentence for any texel under the pointer. Rows run west→east or south→north on flat
 * walls, and anticlockwise from east on the round one. */
export type PaintedWall = {
  n: number;
  /** RGBA, row i and step k at (i * steps + k) * 4. */
  pixels: Uint8Array;
  describe: (k: number, i: number) => string;
  /** Patterned theme: the glyph step of every texel (same layout as pixels, one byte each):
   * 0–6 from least to most ink, +8 when muted, 255 where there is no data. */
  levels: Uint8Array;
};

export type TunnelPaint = {
  ceiling: PaintedWall;
  floor: PaintedWall;
  right: PaintedWall;
  left: PaintedWall;
  round: PaintedWall;
};

export type PaintInput = {
  section: SectionId;
  /** Loaded forecast, for the runs. */
  volume: Volume;
  /** What the cube shows for this section (mean, anomaly, …). */
  display: DisplayVolume;
  palette: Palette;
  range: [number, number];
  /** Value-suppressing encoding of member spread (disagreement), or null. */
  uncertainty: { mode: 'off' | 'suppress' | 'hatch'; scale: number } | null;
  /** Cells to highlight (trust horizon, events, SQL); the rest are greyed. */
  mask: Uint8Array | null;
  /** What the mask means, for the readout. */
  maskLabel: string;
  muted: [number, number, number];
  /** Pinned place: flat walls show its exact row and column. */
  place: { x: number; y: number } | null;
  units: string;
};

const BINS = 72;
const edgeName: Record<string, string> = {
  ceiling: 'north edge',
  floor: 'south edge',
  right: 'east edge',
  left: 'west edge',
};
const degrees = (v: number, horizontal: boolean) =>
  `${formatValue(Math.abs(v))}° ${horizontal ? (v >= 0 ? 'E' : 'W') : v >= 0 ? 'N' : 'S'}`;

/** Grey a colour toward the muted tone, by how much of it lies outside the selection. */
const mute = (c: number[], muted: [number, number, number], amount: number) => {
  const g = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const m = muted.map((v) => g + (v * 255 - g) * 0.72);

  return c.slice(0, 3).map((v, i) => v + (m[i] - v) * amount);
};

/** Paint the tunnel for one story section, from the same data the cube shows. */
export function paintTunnel(input: PaintInput): TunnelPaint {
  const { display, volume, palette, range, units } = input;
  const [nt, ny, nx] = display.shape;
  const when = (k: number) => timeLabel(display.times[k], display.timeUnits);
  const grid = (data: ArrayLike<number>) => ({
    data,
    shape: display.shape,
    lat: display.lat,
    lon: display.lon,
  });
  const fill = (n: number, colour: (k: number, i: number) => number[]) => {
    const pixels = new Uint8Array(n * nt * 4);
    for (let i = 0; i < n; i++)
      for (let k = 0; k < nt; k++) {
        const c = colour(k, i);
        pixels.set([c[0], c[1], c[2], 255], (i * nt + k) * 4);
      }

    return pixels;
  };
  /** Glyph steps for the patterned theme: value, its range, and whether it is muted. */
  const ink = (n: number, step: (k: number, i: number) => [number, number, number, boolean]) => {
    const levels = new Uint8Array(n * nt);
    for (let i = 0; i < n; i++)
      for (let k = 0; k < nt; k++) {
        const [v, lo, hi, muted] = step(k, i);
        const level = patternLevel(v, lo, hi);
        levels[i * nt + k] = level < 0 ? 255 : level + (muted ? 8 : 0);
      }

    return levels;
  };

  // How does the region's average change? Every ring is the regional average at that time.
  if (input.section === 'clock') {
    const area = rowAreas(display.lat, display.lon).map((a) => (a > 0 ? a : 1));
    const means = Array.from({ length: nt }, (_, k) => {
      let sum = 0,
        weight = 0;
      for (let i = 0; i < ny * nx; i++) {
        const v = display.data[k * ny * nx + i];
        if (!Number.isFinite(v)) continue;
        sum += v * area[Math.floor(i / nx)];
        weight += area[Math.floor(i / nx)];
      }

      return weight ? sum / weight : NaN;
    });
    const wall: PaintedWall = {
      n: 1,
      pixels: fill(1, (k) => color(means[k], range[0], range[1], palette)),
      levels: ink(1, (k) => [means[k], range[0], range[1], false]),
      describe: (k) => `${when(k)} · regional average ${formatValue(means[k])} ${units}`,
    };

    return { ceiling: wall, floor: wall, right: wall, left: wall, round: wall };
  }

  // Which runs are warmer or colder? Each run is a stripe along the tunnel, coloured by how
  // far its regional average is from the ensemble mean's; runs ordered by where they end
  // up at the last lead time, colder first, so the order stays put while flying.
  const ens = volume.ensemble;
  if (input.section === 'members' && ens) {
    const cells = nt * ny * nx;
    const area = rowAreas(volume.lat, volume.lon).map((a) => (a > 0 ? a : 1));
    const regional = (data: ArrayLike<number>, offset: number, k: number) => {
      let sum = 0,
        weight = 0;
      for (let i = 0; i < ny * nx; i++) {
        const v = data[offset + k * ny * nx + i];
        if (!Number.isFinite(v)) continue;
        sum += v * area[Math.floor(i / nx)];
        weight += area[Math.floor(i / nx)];
      }

      return weight ? sum / weight : NaN;
    };
    const mean = Array.from({ length: nt }, (_, k) => regional(ens.stats.mean, 0, k));
    const runs = Array.from({ length: ens.count }, (_, m) =>
      Array.from({ length: nt }, (_, k) => regional(ens.members, m * cells, k) - mean[k]),
    );
    const order = runs.map((_, m) => m).sort((a, b) => runs[a][nt - 1] - runs[b][nt - 1]);
    const limit = Math.max(1e-9, ...runs.flat().filter(Number.isFinite).map(Math.abs));
    const wall: PaintedWall = {
      n: order.length,
      pixels: fill(order.length, (k, i) => color(runs[order[i]][k], -limit, limit, 'balance')),
      levels: ink(order.length, (k, i) => [runs[order[i]][k], -limit, limit, false]),
      describe: (k, i) => {
        const d = runs[order[i]][k];

        return `${when(k)} · run ${ens.labels[order[i]] ?? order[i]} · regional average ${d >= 0 ? '+' : '−'}${formatValue(Math.abs(d))} ${units} vs the mean`;
      },
    };

    return { ceiling: wall, floor: wall, right: wall, left: wall, round: wall };
  }

  // Everything else: the displayed field, optionally with disagreement or a selection.
  const flat = squareWalls(grid(display.data), input.place ? 'line' : 'edges', input.place);
  const spread =
    input.uncertainty && input.uncertainty.mode !== 'off' && display.uncertainty
      ? squareWalls(grid(display.uncertainty), input.place ? 'line' : 'edges', input.place)
      : null;
  const share = input.mask
    ? squareWalls(grid(input.mask), input.place ? 'line' : 'edges', input.place)
    : null;
  const round = wallValues(grid(display.data), 'directions', BINS);
  const roundSpread = spread ? wallValues(grid(display.uncertainty!), 'directions', BINS) : null;
  const roundShare = input.mask ? wallValues(grid(input.mask), 'directions', BINS) : null;
  const scale = input.uncertainty?.scale ?? 1;

  const colourOf = (v: number, s: number | null, inside: number | null) => {
    let c: number[] = color(v, range[0], range[1], palette);
    if (s !== null && input.uncertainty?.mode === 'suppress')
      c = vsupColor((v - range[0]) / (range[1] - range[0] || 1), vsupBand(s, scale), palette);
    if (s !== null && input.uncertainty?.mode === 'hatch' && !(s < scale))
      c = c.map((x) => x * 0.55);
    if (inside !== null) c = mute(c, input.muted, 1 - Math.min(1, inside));

    return c;
  };
  const extra = (s: number | null, inside: number | null) =>
    `${s !== null ? ` · runs differ by ${formatValue(s)} ${units}` : ''}${
      inside !== null ? ` · ${Math.round(inside * 100)} % ${input.maskLabel}` : ''
    }`;

  const flatWall = (name: 'ceiling' | 'floor' | 'right' | 'left'): PaintedWall => {
    const w: FlatWall = flat[name];
    const s = spread?.[name],
      m = share?.[name];
    const horizontal = name === 'ceiling' || name === 'floor';

    return {
      n: w.n,
      pixels: fill(w.n, (k, i) =>
        colourOf(
          w.values[k * w.n + i],
          s ? s.values[k * w.n + i] : null,
          m ? m.values[k * w.n + i] : null,
        ),
      ),
      levels: ink(w.n, (k, i) => [
        w.values[k * w.n + i],
        range[0],
        range[1],
        m ? m.values[k * w.n + i] < 0.5 : false,
      ]),
      describe: (k, i) => {
        const v = w.values[k * w.n + i];
        const where = degrees(w.coords[i], horizontal);
        const what = input.place
          ? `${horizontal ? 'west–east' : 'south–north'} line through the pinned place · ${where} · ${formatValue(v)} ${units}`
          : `${edgeName[name]} of the region · ${where} · ${formatValue(v)} ${units}`;

        return `${when(k)} · ${what}${extra(
          s ? s.values[k * w.n + i] : null,
          m ? m.values[k * w.n + i] : null,
        )}`;
      },
    };
  };

  return {
    ceiling: flatWall('ceiling'),
    floor: flatWall('floor'),
    right: flatWall('right'),
    left: flatWall('left'),
    round: {
      n: BINS,
      pixels: fill(BINS, (k, b) =>
        colourOf(
          round.values[k * BINS + b],
          roundSpread ? roundSpread.values[k * BINS + b] : null,
          roundShare ? roundShare.values[k * BINS + b] : null,
        ),
      ),
      levels: ink(BINS, (k, b) => [
        round.values[k * BINS + b],
        range[0],
        range[1],
        roundShare ? roundShare.values[k * BINS + b] < 0.5 : false,
      ]),
      describe: (k, b) =>
        `${when(k)} · ${directionName(binAngle(b, BINS))} of the region · average ${formatValue(round.values[k * BINS + b])} ${units}${extra(
          roundSpread ? roundSpread.values[k * BINS + b] : null,
          roundShare ? roundShare.values[k * BINS + b] : null,
        )}`,
    },
  };
}
