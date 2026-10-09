export const palettes = {
  snowfall: [
    [140, 81, 10],
    [191, 129, 45],
    [223, 194, 125],
    [246, 232, 195],
    [255, 255, 255],
    [222, 235, 247],
    [158, 202, 225],
    [49, 130, 189],
    [8, 81, 156],
  ],
  thermal: [
    [48, 41, 112],
    [65, 91, 166],
    [54, 160, 172],
    [156, 205, 159],
    [243, 218, 125],
    [235, 140, 86],
    [172, 60, 66],
  ],
  ocean: [
    [19, 38, 75],
    [31, 90, 127],
    [48, 146, 166],
    [142, 207, 190],
    [234, 243, 207],
  ],
  /** ColorBrewer RdBu (11 classes), reversed: blue below, red above a centred zero. */
  balance: [
    [5, 48, 97],
    [33, 102, 172],
    [67, 147, 195],
    [146, 197, 222],
    [209, 229, 240],
    [247, 247, 247],
    [253, 219, 199],
    [244, 165, 130],
    [214, 96, 77],
    [178, 24, 43],
    [103, 0, 31],
  ],
  /** Viridis: perceptually uniform and colour-vision-deficiency safe, for shares 0–100 %. */
  viridis: [
    [68, 1, 84],
    [72, 40, 120],
    [62, 74, 137],
    [49, 104, 142],
    [38, 130, 142],
    [31, 158, 137],
    [53, 183, 121],
    [109, 205, 89],
    [180, 222, 44],
    [253, 231, 37],
  ],
  ember: [
    [35, 26, 58],
    [91, 43, 100],
    [158, 65, 91],
    [216, 111, 79],
    [246, 177, 109],
    [251, 235, 182],
  ],
};

export type Palette = keyof typeof palettes;

export const paletteNames = Object.keys(palettes) as Palette[];

export const snowfallRange: [number, number] = [-100, 100];

export function color(
  value: number,
  min: number,
  max: number,
  palette: Palette = 'thermal',
): [number, number, number, number] {
  if (!Number.isFinite(value)) return [38, 43, 46, 255];

  const stops = palettes[palette],
    u = Math.max(0, Math.min(1, (value - min) / (max - min || 1))) * (stops.length - 1),
    i = Math.min(stops.length - 2, Math.floor(u)),
    f = u - i;

  return [...stops[i].map((v, j) => Math.round(v + (stops[i + 1][j] - v) * f)), 255] as [
    number,
    number,
    number,
    number,
  ];
}

export function colorSprite() {
  const data = new Uint8ClampedArray(256 * paletteNames.length * 4);
  paletteNames.forEach((p, row) => {
    for (let x = 0; x < 256; x++) data.set(color(x, 0, 255, p), (row * 256 + x) * 4);
  });

  return new ImageData(data, 256, paletteNames.length);
}

/** Build the CSS legend gradient from the same stops used by the volume renderer. */
export const gradient = (p: Palette) =>
  `linear-gradient(90deg, ${palettes[p].map((c) => `rgb(${c.join(',')})`).join(',')})`;

/** Value-suppressing uncertainty palette (after Correll, Moritz & Heer, CHI 2018).
 * Spread is cut into four bands at thirds of `scale`; band k keeps 8 / 2^k value steps and
 * moves 0.85 · k / 3 of the way to an approximately lightness-matched grey. The cube's
 * fragment shader mirrors this function exactly. */
export const VSUP_BANDS = 4;

export function vsupBand(spread: number, scale: number) {
  if (!Number.isFinite(spread)) return VSUP_BANDS - 1;

  return Math.min(VSUP_BANDS - 1, Math.floor((3 * spread) / (scale || 1)));
}

export function vsupColor(
  scaled: number,
  band: number,
  palette: Palette,
): [number, number, number] {
  const bins = 2 ** (VSUP_BANDS - 1 - band);
  const q = (Math.min(Math.floor(Math.max(0, Math.min(1, scaled)) * bins), bins - 1) + 0.5) / bins;
  const c = color(Math.round(q * 255), 0, 255, palette);
  const grey = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const f = (0.85 * band) / (VSUP_BANDS - 1);

  return [0, 1, 2].map((i) => Math.round(c[i] + (grey - c[i]) * f)) as [number, number, number];
}
