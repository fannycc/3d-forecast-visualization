/** Copy the selected cells of one decoded chunk into a dense output array.
 * selections[d] lists [source index, output offset] pairs for dimension d; output offsets
 * already include each axis's output stride, so the innermost loop only adds. */
export function scatter(
  chunk: { data: unknown; stride: number[] },
  coords: number[],
  chunks: number[],
  selections: [number, number][][],
  fill: unknown,
  write: (offset: number, value: number) => void,
) {
  const values = chunk.data as ArrayLike<number>;
  const local = selections.map((list, d) =>
    list.flatMap(([source, out]) =>
      Math.floor(source / chunks[d]) === coords[d]
        ? [[(source - coords[d] * chunks[d]) * chunk.stride[d], out] as const]
        : [],
    ),
  );
  const last = local.length - 1;
  const visit = (d: number, inOffset: number, outOffset: number) => {
    if (d === last) {
      for (const [i, o] of local[d]) {
        const v = Number(values[inOffset + i]);
        write(outOffset + o, v === fill ? NaN : v);
      }

      return;
    }
    for (const [i, o] of local[d]) visit(d + 1, inOffset + i, outOffset + o);
  };
  visit(0, 0, 0);
}
