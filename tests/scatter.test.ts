import { expect, it } from 'vitest';
import { scatter } from '../src/engine/scatter';

it('places chunk values by member, time, latitude and longitude', () => {
  // Source dims [init, member, lead, lat, lon] = [1, 2, 2, 2, 3], one chunk, C order.
  const shape = [1, 2, 2, 2, 3];
  const stride = [24, 12, 6, 3, 1];
  const data = Float32Array.from({ length: 24 }, (_, i) => i);
  data[23] = -999; // fill value
  // Output [member][time][y][x] with x reversed and only y = 1 kept.
  const nx = 3,
    ny = 1,
    nt = 2,
    cells = nx * ny * nt;
  const out = new Float32Array(2 * cells).fill(NaN);
  scatter(
    { data, stride },
    [0, 0, 0, 0, 0],
    shape,
    [
      [[0, 0]],
      [0, 1].map((m) => [m, m * cells]),
      [0, 1].map((t) => [t, t * nx * ny]),
      [[1, 0]],
      [0, 1, 2].map((x) => [x, nx - 1 - x]),
    ],
    -999,
    (o, v) => (out[o] = v),
  );
  const at = (m: number, t: number, x: number) => out[m * cells + t * nx + x];
  // Source (member 1, lead 1, lat 1, lon 0) = 12 + 6 + 3 + 0 = 21 lands at reversed x = 2.
  expect(at(1, 1, 2)).toBe(21);
  expect(at(0, 0, 0)).toBe(5);
  expect(Number.isNaN(at(1, 1, 0))).toBe(true);
});
