import { useEffect, useMemo, useRef, useState } from 'react';
import { color, vsupBand, vsupColor, type Palette } from '../render/colors';
import { formatValue } from '../render/value-scale';

/** One map in the radial view: a grid in [y][x] order, row 0 at the first latitude. */
export type RadialMap = {
  grid: ArrayLike<number>;
  /** Cells outside the selection are muted (events and SQL). */
  mask?: ArrayLike<number> | null;
  /** Member spread per cell, for the value-suppressing or hatched encodings. */
  spread?: ArrayLike<number> | null;
  palette: Palette;
  range: [number, number];
};

export type RadialTile = RadialMap & {
  id: string;
  label: string;
  /** Clockwise from the top, radians. */
  angle: number;
  /** 0 at the inner guide ring, 1 at the outer one. */
  distance: number;
};

export type RadialSpec = {
  nx: number;
  ny: number;
  /** Latitudes increase with row index; drawn flipped so north is up. */
  northUp: boolean;
  /** headline: the centre's regional value and time, drawn under it; label: what it is. */
  center: RadialMap & { label: string; headline: string };
  /** The bottom scale, centred under the view: outer values on both sides of the centre. */
  scale: { centre: string; left: string[]; right: string[] };
  tiles: RadialTile[];
  units: string;
  /** What distance from the centre means, shown on the guide rings and in the key. */
  rings: { distance: number; label: string }[];
  /** One sentence for the key, e.g. "How far each run's regional average is from the mean". */
  ringMeaning: string;
  /** A few words for the slim legend, e.g. "Distance = run vs ensemble mean". */
  ringMeaningShort: string;
  /** Words placed around the circle, such as "Warmer than average". */
  sides?: { angle: number; label: string }[];
  uncertainty?: { mode: 'off' | 'suppress' | 'hatch'; scale: number };
  muted: [number, number, number];
  caption: string;
  /** Ring tiles as geographic maps, or as each run's colours sorted by area ("colour mix"). */
  arrangement: 'map' | 'mix';
  /** Area of each cell in [y][x] order, so a colour mix gives every colour its share of area. */
  weights: ArrayLike<number>;
};

/** For a colour mix: which source cell each pixel shows. Pixels fill from the bottom row
 * upward, coldest first; pixel p shows the value at area quantile (p + 0.5) / pixels. */
function mixLookup(grid: ArrayLike<number>, weights: ArrayLike<number>, pixels: number) {
  const cells = Array.from({ length: grid.length }, (_, i) => i).filter((i) =>
    Number.isFinite(grid[i]),
  );
  cells.sort((a, b) => grid[a] - grid[b]);
  const cumulative = new Float64Array(cells.length);
  let total = 0;
  cells.forEach((c, k) => {
    total += weights[c] > 0 ? weights[c] : 0;
    cumulative[k] = total;
  });
  const lookup = new Int32Array(pixels).fill(-1);
  const share = new Float32Array(pixels);
  if (!cells.length || total <= 0) return { lookup, share };
  for (let p = 0; p < pixels; p++) {
    const target = ((p + 0.5) / pixels) * total;
    let lo = 0,
      hi = cells.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    lookup[p] = cells[lo];
    share[p] = (p + 0.5) / pixels;
  }

  return { lookup, share };
}

/** Paint a map into an offscreen canvas at one pixel per data cell (no smoothing). */
function paint(
  map: RadialMap,
  nx: number,
  ny: number,
  northUp: boolean,
  uncertainty: RadialSpec['uncertainty'],
  muted: [number, number, number],
  mix: { lookup: Int32Array; share: Float32Array } | null = null,
) {
  const canvas = document.createElement('canvas');
  canvas.width = nx;
  canvas.height = ny;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(nx, ny);
  const [lo, hi] = map.range;
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) {
      // A colour mix fills from the bottom row upward, coldest first.
      const i = mix ? mix.lookup[(ny - 1 - y) * nx + x] : y * nx + x;
      const row = mix ? y : northUp ? ny - 1 - y : y;
      if (i < 0) continue;
      const o = (row * nx + x) * 4;
      const v = map.grid[i];
      if (!Number.isFinite(v)) {
        image.data[o + 3] = 0;
        continue;
      }
      let c: number[] = color(v, lo, hi, map.palette);
      const s = map.spread?.[i];
      if (uncertainty && uncertainty.mode === 'suppress' && s !== undefined)
        c = vsupColor((v - lo) / (hi - lo || 1), vsupBand(s, uncertainty.scale), map.palette);
      if (
        uncertainty?.mode === 'hatch' &&
        s !== undefined &&
        !(s < uncertainty.scale) &&
        (x + row) % 3 === 0
      )
        c = c.map((n) => n * 0.45);
      if (map.mask && !map.mask[i]) {
        const g = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        c = muted.map((m) => g + (m * 255 - g) * 0.72);
      }
      image.data[o] = c[0];
      image.data[o + 1] = c[1];
      image.data[o + 2] = c[2];
      image.data[o + 3] = 255;
    }
  context.putImageData(image, 0, 0);

  return { canvas, mix };
}

export type RadialPin = { x: number; y: number; color: string };

/** Room kept clear at the top for the floating toolbar, and at the bottom for the scale. */
const TOP = 64,
  BOTTOM = 40;
/** How much a run's map grows when hovered or chosen. */
const GROW = 2.6;

/** A flat, radial alternative to the cube: maps around a centre, after the Getty donors
 * piece. Hovering a run's map enlarges it; clicking any map pins the place under the
 * pointer, so its forecast appears in the line graph below. */
export function RadialView({
  spec,
  pulse,
  pins = [],
  onPick,
}: {
  spec: RadialSpec;
  pulse: string;
  /** Pinned cells, drawn on the centre map and on every run's map. */
  pins?: RadialPin[];
  /** Click on a map: the cell that was clicked. */
  onPick?: (x: number, y: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [progress, setProgress] = useState(1);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  /** The run under the pointer, and the run last clicked; either is drawn enlarged. */
  const [hovered, setHovered] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const focus = hovered ?? chosen;
  /** Each tile's current growth, eased toward 1 or GROW. */
  const growth = useRef(new Map<string, number>());
  const [, setFrame] = useState(0);

  useEffect(() => {
    const el = host.current!;
    const observer = new ResizeObserver(() =>
      setSize({ width: el.clientWidth, height: el.clientHeight }),
    );
    observer.observe(el);

    return () => observer.disconnect();
  }, []);

  // Section changes: the maps fly out from the centre to their places.
  useEffect(() => {
    setChosen(null);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 460);
      setProgress(1 - (1 - t) ** 3);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    setProgress(0);
    frame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame);
  }, [pulse]);

  // Ease each tile's size toward its target.
  useEffect(() => {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    const tick = () => {
      let moving = false;
      for (const t of spec.tiles) {
        const target = t.id === focus ? GROW : 1;
        const now = growth.current.get(t.id) ?? 1;
        const next = reduce ? target : now + (target - now) * 0.28;
        if (Math.abs(next - target) > 0.01) moving = true;
        growth.current.set(t.id, Math.abs(next - target) > 0.01 ? next : target);
      }
      setFrame((n) => n + 1);
      if (moving) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame);
  }, [focus, spec.tiles]);

  const images = useMemo(
    () => ({
      center: paint(spec.center, spec.nx, spec.ny, spec.northUp, spec.uncertainty, spec.muted),
      tiles: spec.tiles.map((t) =>
        paint(
          t,
          spec.nx,
          spec.ny,
          spec.northUp,
          spec.uncertainty,
          spec.muted,
          spec.arrangement === 'mix' ? mixLookup(t.grid, spec.weights, spec.nx * spec.ny) : null,
        ),
      ),
    }),
    [spec],
  );

  const layout = useMemo(() => {
    const { width, height } = size;
    const room = height - TOP - BOTTOM;
    const short = Math.min(width, room);
    const cx = width / 2,
      cy = TOP + room / 2;
    const aspect = spec.ny / spec.nx;
    const centerSide = short * 0.26;
    const tileSide = Math.max(24, Math.min(60, short * (spec.tiles.length > 24 ? 0.062 : 0.09)));
    // Leave room under the centre map for its value and name.
    const inner = Math.max(
      centerSide * 0.78 + tileSide * 0.8,
      (centerSide * aspect) / 2 + 40 + (tileSide * aspect) / 2,
    );
    const outer = short / 2 - tileSide * 0.75 - 14;

    return { cx, cy, aspect, centerSide, tileSide, inner, outer: Math.max(inner + 10, outer) };
  }, [size, spec.nx, spec.ny, spec.tiles.length]);

  const placed = spec.tiles.map((t, i) => {
    const r = (layout.inner + t.distance * (layout.outer - layout.inner)) * progress;
    const grow = growth.current.get(t.id) ?? 1;

    return {
      ...t,
      index: i,
      grow,
      side: layout.tileSide * grow,
      x: layout.cx + r * Math.sin(t.angle),
      y: layout.cy - r * Math.cos(t.angle),
    };
  });
  /** Drawing order: enlarged tiles last, so they sit on top. */
  const ordered = [...placed].sort((a, b) => a.grow - b.grow);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.width * dpr;
    canvas.height = size.height * dpr;
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size.width, size.height);
    // Nothing to draw until the view has a real size (it starts at 1 × 1 before measuring).
    if (size.width < 80 || size.height < 80 + TOP + BOTTOM) return;
    g.imageSmoothingEnabled = false;
    const style = getComputedStyle(canvas);
    const ink = style.getPropertyValue('--ink').trim() || '#283343';
    const soft = style.getPropertyValue('--ink-soft').trim() || '#5d6878';
    const line = style.getPropertyValue('--line').trim() || '#e4e8ee';
    const panel = style.getPropertyValue('--panel').trim() || '#fff';
    const mono = style.getPropertyValue('--mono').trim() || 'monospace';
    const { cx, cy, aspect, centerSide, inner, outer } = layout;

    // Guide rings; their values are in the scale at the bottom.
    g.strokeStyle = line;
    for (const ring of spec.rings) {
      const r = Math.max(0, (inner + ring.distance * (outer - inner)) * progress);
      g.beginPath();
      g.setLineDash([2, 4]);
      g.arc(cx, cy, r, 0, 2 * Math.PI);
      g.stroke();
      g.setLineDash([]);
    }

    // Spokes, then tiles.
    g.globalAlpha = 0.5 * progress;
    for (const t of placed) {
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(t.x, t.y);
      g.stroke();
    }
    g.globalAlpha = Math.max(0.15, progress);

    const pinAt = (x: number, y: number, side: number, p: RadialPin, radius: number) => {
      const row = spec.northUp ? spec.ny - 1 - p.y : p.y;
      const px = x - side / 2 + ((p.x + 0.5) / spec.nx) * side;
      const py = y - (side * aspect) / 2 + ((row + 0.5) / spec.ny) * side * aspect;
      g.beginPath();
      g.arc(px, py, radius, 0, 2 * Math.PI);
      g.fillStyle = p.color;
      g.fill();
      g.lineWidth = radius > 3 ? 2 : 1;
      g.strokeStyle = '#fff';
      g.stroke();
      g.lineWidth = 1;
    };

    // Ring tiles, then the centre (its text stays readable), then enlarged tiles on top.
    const drawTile = (t: (typeof ordered)[number]) => {
      const tw = t.side,
        th = t.side * aspect;
      const big = t.grow > 1.05;
      if (big) {
        g.save();
        g.shadowColor = 'rgb(0 0 0 / 0.22)';
        g.shadowBlur = 14;
        g.shadowOffsetY = 3;
        g.fillStyle = panel;
        g.fillRect(t.x - tw / 2 - 3, t.y - th / 2 - 3, tw + 6, th + 6);
        g.restore();
      }
      g.drawImage(images.tiles[t.index].canvas, t.x - tw / 2, t.y - th / 2, tw, th);
      g.strokeStyle = big ? ink : line;
      g.strokeRect(t.x - tw / 2 - 0.5, t.y - th / 2 - 0.5, tw + 1, th + 1);
      g.font = big ? `600 11px ${mono}` : `9px ${mono}`;
      g.textAlign = 'center';
      if (big) {
        const label = g.measureText(t.label).width;
        g.fillStyle = panel;
        g.fillRect(t.x - label / 2 - 4, t.y + th / 2 + 4, label + 8, 15);
      }
      g.fillStyle = big ? ink : soft;
      g.fillText(t.label, t.x, t.y + th / 2 + (big ? 15 : 10));
      if (spec.arrangement === 'map') for (const p of pins) pinAt(t.x, t.y, tw, p, big ? 4 : 2.2);
    };
    for (const t of ordered) if (t.grow <= 1.05) drawTile(t);
    g.globalAlpha = 1;
    // Centre map.
    const w = centerSide,
      h = centerSide * aspect;
    g.drawImage(images.center.canvas, cx - w / 2, cy - h / 2, w, h);
    g.strokeStyle = soft;
    g.strokeRect(cx - w / 2 - 0.5, cy - h / 2 - 0.5, w + 1, h + 1);
    g.textAlign = 'center';
    for (const [text, font, colour, dy] of [
      [spec.center.headline, `600 13px ${mono}`, ink, 19],
      [spec.center.label, `10px ${mono}`, soft, 33],
    ] as const) {
      g.font = font;
      const tw = g.measureText(text).width;
      g.fillStyle = panel;
      g.fillRect(cx - tw / 2 - 4, cy + h / 2 + dy - 11, tw + 8, 15);
      g.fillStyle = colour;
      g.fillText(text, cx, cy + h / 2 + dy);
    }
    for (const p of pins) pinAt(cx, cy, centerSide, p, 5);

    for (const t of ordered) if (t.grow > 1.05) drawTile(t);

    // Words around the circle.
    g.font = `11px ${mono}`;
    g.fillStyle = soft;
    for (const side of spec.sides ?? []) {
      const r = outer + layout.tileSide * 0.9;
      const half = g.measureText(side.label).width / 2 + 8;
      const x = Math.max(half, Math.min(size.width - half, cx + r * Math.sin(side.angle)));
      const y = Math.max(TOP + 10, cy - r * Math.cos(side.angle) - layout.tileSide);
      g.fillText(side.label, x, y);
    }
  });

  /** What lies under a point: a map, the cell (for geographic maps) and a description. */
  const pick = (px: number, py: number) => {
    const { cx, cy, aspect, centerSide } = layout;
    const at = (
      x: number,
      y: number,
      side: number,
      map: RadialMap,
      label: string,
      mix: ReturnType<typeof paint>['mix'],
    ) => {
      const w = side,
        h = side * aspect;
      if (Math.abs(px - x) > w / 2 || Math.abs(py - y) > h / 2) return null;
      const col = Math.min(spec.nx - 1, Math.floor(((px - (x - w / 2)) / w) * spec.nx));
      const drawnRow = Math.min(spec.ny - 1, Math.floor(((py - (y - h / 2)) / h) * spec.ny));
      if (mix) {
        const p = (spec.ny - 1 - drawnRow) * spec.nx + col;
        const v = mix.lookup[p] >= 0 ? map.grid[mix.lookup[p]] : NaN;

        return {
          cell: null,
          text: `${label} · ${formatValue(v)} ${spec.units} · ${Math.round(mix.share[p] * 100)} % of the area is colder`,
        };
      }
      const row = spec.northUp ? spec.ny - 1 - drawnRow : drawnRow;
      const v = map.grid[row * spec.nx + col];

      return {
        cell: { x: col, y: row },
        text: `${label} · ${Number.isFinite(v) ? `${formatValue(v)} ${spec.units}` : 'no data'}`,
      };
    };
    // Topmost first: enlarged tiles, then the rest, then the centre.
    for (let k = ordered.length - 1; k >= 0; k--) {
      const t = ordered[k];
      const found = at(t.x, t.y, t.side, t, t.label, images.tiles[t.index].mix);
      if (found) return { ...found, tile: t.id };
    }
    const centre = at(cx, cy, centerSide, spec.center, spec.center.label, null);

    return centre ? { ...centre, tile: null } : null;
  };

  const local = (e: { clientX: number; clientY: number }) => {
    const box = host.current!.getBoundingClientRect();

    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };

  return (
    <div
      className="radial-view"
      ref={host}
      onPointerMove={(e) => {
        const { x, y } = local(e);
        const found = pick(x, y);
        setHovered(found?.tile ?? null);
        setHover(
          found
            ? { x, y, text: found.cell && onPick ? `${found.text} · click to pin` : found.text }
            : null,
        );
      }}
      onPointerLeave={() => {
        setHover(null);
        setHovered(null);
      }}
      onClick={(e) => {
        const { x, y } = local(e);
        const found = pick(x, y);
        setChosen(found?.tile ?? null);
        if (found?.cell) onPick?.(found.cell.x, found.cell.y);
      }}
      style={{ cursor: hover ? 'pointer' : 'default' }}
    >
      <canvas ref={canvasRef} style={{ width: size.width, height: size.height }} />
      {hover && (
        <div className="radial-tooltip" style={{ left: hover.x + 12, top: hover.y + 12 }}>
          {hover.text}
        </div>
      )}
      <div className="radial-scale" title={`${spec.ringMeaning}\n\n${spec.caption}`}>
        <span className="radial-scale-arrow left" aria-hidden="true" />
        {spec.scale.left.map((v, i) => (
          <span key={`l${i}`} className="radial-scale-step">
            <span className="radial-scale-value">{v}</span>
            <span className="radial-scale-line" aria-hidden="true" />
          </span>
        ))}
        <span className="radial-scale-value centre">{spec.scale.centre}</span>
        {spec.scale.right.map((v, i) => (
          <span key={`r${i}`} className="radial-scale-step">
            <span className="radial-scale-line" aria-hidden="true" />
            <span className="radial-scale-value">{v}</span>
          </span>
        ))}
        <span className="radial-scale-arrow right" aria-hidden="true" />
      </div>
    </div>
  );
}
