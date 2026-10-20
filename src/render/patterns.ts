/** The patterned theme: values drawn as ink glyphs on paper instead of colours, after
 * typewriter/ASCII halftones. Every glyph sits on a ruled baseline, so empty or low values
 * read as plain lines; ink increases step by step up the ramp. */

export const PAPER = '#f1ede2';
export const INK = '#151515';
/** Ink for muted cells (outside a selection, beyond the trust horizon). */
export const FAINT = '#b9b4a6';

/** Levels from the least to the most ink. */
export const PATTERN_LEVELS = 7;

/** Which ramp step a value falls in (0 = least ink). */
export function patternLevel(value: number, lo: number, hi: number) {
  if (!Number.isFinite(value)) return -1;
  const t = (value - lo) / (hi - lo || 1);

  return Math.max(0, Math.min(PATTERN_LEVELS - 1, Math.floor(t * PATTERN_LEVELS)));
}

/** Draw one glyph in a size × size cell whose top-left is (x, y). Level −1 draws only the
 * ruled line (missing data). */
export function drawGlyph(
  g: CanvasRenderingContext2D,
  level: number,
  x: number,
  y: number,
  size: number,
  ink = INK,
) {
  const base = y + size - Math.max(0.6, size * 0.08);
  g.fillStyle = ink;
  g.strokeStyle = ink;
  // The ruled line every glyph sits on.
  g.fillRect(x, base, size, Math.max(0.5, size * 0.07));
  if (level < 1) return;
  const font = (scale: number, weight = 600) =>
    `${weight} ${size * scale}px ui-monospace, Menlo, monospace`;
  const centre = x + size / 2;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  switch (level) {
    case 1:
      g.font = font(0.62, 400);
      g.fillText('3', centre, base - size * 0.02);
      break;
    case 2:
      g.font = font(0.86, 600);
      g.fillText('3', centre, base - size * 0.02);
      break;
    case 3:
      g.font = font(0.9, 700);
      g.fillText('4', centre, base - size * 0.02);
      break;
    case 4: {
      // A right-angled wedge, as in the reference.
      g.beginPath();
      g.moveTo(x + size * 0.12, base);
      g.lineTo(x + size * 0.88, base);
      g.lineTo(x + size * 0.88, y + size * 0.18);
      g.closePath();
      g.fill();
      break;
    }
    case 5: {
      g.beginPath();
      g.moveTo(x, base);
      g.lineTo(x + size, base);
      g.lineTo(x + size, y);
      g.lineTo(x + size * 0.45, y);
      g.closePath();
      g.fill();
      break;
    }
    default: {
      g.beginPath();
      g.arc(centre, y + size * 0.48, size * 0.47, 0, Math.PI * 2);
      g.fill();
    }
  }
}

/** A strip of every glyph, least to most ink: `PATTERN_LEVELS` cells of size × size on paper.
 * The muted row (second) repeats them in faint ink. Used as a texture by the 3D views. */
export function patternAtlas(size = 32) {
  const canvas = document.createElement('canvas');
  canvas.width = size * PATTERN_LEVELS;
  canvas.height = size * 2;
  const g = canvas.getContext('2d')!;
  g.fillStyle = PAPER;
  g.fillRect(0, 0, canvas.width, canvas.height);
  for (let level = 0; level < PATTERN_LEVELS; level++) {
    drawGlyph(g, level, level * size, 0, size, INK);
    drawGlyph(g, level, level * size, size, size, FAINT);
  }

  return canvas;
}

/** Fill a rectangle with glyphs sampled from a grid of values: each glyph shows the value
 * under its centre. `sample(u, v)` takes 0–1 coordinates across the rectangle (v from the
 * top) and returns the level and whether the cell is muted. */
export function drawPatterned(
  g: CanvasRenderingContext2D,
  rect: { x: number; y: number; w: number; h: number },
  glyph: number,
  sample: (u: number, v: number) => { level: number; muted: boolean },
) {
  g.save();
  g.beginPath();
  g.rect(rect.x, rect.y, rect.w, rect.h);
  g.clip();
  g.fillStyle = PAPER;
  g.fillRect(rect.x, rect.y, rect.w, rect.h);
  const cols = Math.max(1, Math.round(rect.w / glyph));
  const rows = Math.max(1, Math.round(rect.h / glyph));
  const cw = rect.w / cols,
    ch = rect.h / rows;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const { level, muted } = sample((c + 0.5) / cols, (r + 0.5) / rows);
      drawGlyph(
        g,
        muted ? Math.min(level, 1) : level,
        rect.x + c * cw,
        rect.y + r * ch,
        Math.min(cw, ch),
        muted ? FAINT : INK,
      );
    }
  g.restore();
}

/** A CSS background showing the ramp, for legends. */
let legendUrl = '';
export function patternLegend() {
  if (legendUrl) return legendUrl;
  const size = 18;
  const canvas = document.createElement('canvas');
  canvas.width = size * PATTERN_LEVELS * 2;
  canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = PAPER;
  g.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < PATTERN_LEVELS * 2; i++) drawGlyph(g, Math.floor(i / 2), i * size, 0, size);
  legendUrl = canvas.toDataURL();

  return legendUrl;
}

/** The glyph atlas as RGBA pixels, for GPU textures: width × height, rows top to bottom. */
let atlasPixels: { data: Uint8Array; width: number; height: number } | null = null;
export function patternAtlasPixels() {
  if (atlasPixels) return atlasPixels;
  const canvas = patternAtlas(32);
  const image = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
  atlasPixels = {
    data: new Uint8Array(image.data.buffer),
    width: canvas.width,
    height: canvas.height,
  };

  return atlasPixels;
}
