/** Layer colours, cold to warm, as in the temperature palette. */
const LAYERS = ['#3b3f8f', '#3f6fa8', '#3d9aa6', '#5fb48e', '#b9c45a', '#e0a24e', '#d9694a'];

/** The cube building itself floor-up, one forecast layer at a time, inside a dashed outline. */
export function CubeLoader({ size = 96 }: { size?: number }) {
  const w = 80,
    half = 20,
    gap = 8,
    height = gap * (LAYERS.length - 1);
  /** An isometric square at height y above the floor. */
  const face = (y: number) =>
    `40,${60 - y} ${40 + w / 2},${60 + half / 2 - y + half / 2} 40,${60 + half * 2 - y} ${40 - w / 2},${60 + half - y}`;

  return (
    <svg
      className="cube-loader"
      viewBox="-4 2 88 104"
      width={size}
      height={(size * 104) / 88}
      aria-hidden="true"
    >
      <g className="cube-loader-frame">
        <polygon points={face(height)} />
        <path
          d={`M0 ${80 - height} V80 M40 ${100 - height} V100 M80 ${80 - height} V80 M0 80 L40 100 L80 80`}
        />
      </g>
      {LAYERS.map((fill, i) => (
        <polygon
          key={fill}
          className="cube-loader-layer"
          points={face(i * gap)}
          fill={fill}
          style={{ animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </svg>
  );
}
