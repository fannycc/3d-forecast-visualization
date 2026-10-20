import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { DisplayVolume } from '../engine/derive';
import { color, type Palette } from '../render/colors';
import { formatValue } from '../render/value-scale';
import { timeValue } from '../engine/time-labels';
import { clipSegment, loadCoastlines, type Segment } from '../render/geography';
import type { Volume } from '../engine/types';
import type { SectionId } from '../story/StoryPanel';
import { paintTunnel, type PaintedWall } from './paint';
import { PAPER, drawPatterned, patternAtlas, patternLevel } from '../render/patterns';

/** World units per forecast hour along the tunnel. */
const DEPTH = 3;
/** Tunnel radius, world units. */
const RADIUS = 40;
/** Half the width of the square tunnel. */
const HALF = 36;
/** Side of the map shown when paused: the tunnel's cross-section, so its borders meet the
 * walls, which show the region's edges. */
const SIDE = 2 * HALF;
/** Flight speed, forecast hours per second. */
const SPEED = 24;
const FOV = 70;
/** The camera sits this many hours before the current time, which is marked by a ring. */
const BEHIND = 14;

export type TunnelPin = { x: number; y: number; color: string };

export type TunnelProps = {
  /** The active story section: the walls answer its question. */
  section: SectionId;
  /** The loaded forecast (for the runs). */
  forecast: Volume;
  /** What the cube shows for this section. */
  volume: DisplayVolume;
  palette: Palette;
  range: [number, number];
  /** Disagreement encoding, as in the cube, or null. */
  uncertainty: { mode: 'off' | 'suppress' | 'hatch'; scale: number } | null;
  /** Cells to highlight (trust horizon, events, SQL); the rest are greyed. */
  mask: Uint8Array | null;
  maskLabel: string;
  muted: [number, number, number];
  /** Valid time of every step, epoch seconds, for the daily signs. */
  validTimes: number[] | null;
  /** Draw values as ink glyphs on paper instead of colours. */
  pattern?: boolean;
  index: number;
  onIndex: (index: number) => void;
  playing: boolean;
  onPlaying: (playing: boolean) => void;
  pins: TunnelPin[];
  /** Click on the map (shown when paused): the cell that was clicked. */
  onPick: (x: number, y: number) => void;
};

const nearest = (hours: number[], hour: number) => {
  let best = 0;
  hours.forEach((h, i) => {
    if (Math.abs(h - hour) < Math.abs(hours[best] - hour)) best = i;
  });

  return best;
};

/** The tunnel's centre line: gentle curves, as in the reference animation. */
const pathAt = (hour: number) =>
  new THREE.Vector3(
    26 * Math.sin((hour / 170) * Math.PI * 2),
    16 * Math.sin((hour / 260) * Math.PI * 2 + 1.1),
    -hour * DEPTH,
  );

/** Right and up at a point of the path: right is east, up is north on the wall. */
const frameAt = (hour: number) => {
  const tangent = pathAt(hour + 0.5)
    .sub(pathAt(hour - 0.5))
    .normalize();
  const right = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, tangent).normalize();

  return { tangent, right, up };
};

/** A wall's texture: one texel per position and step, blended smoothly between them. */
function wallTexture(wall: PaintedWall, steps: number) {
  const texture = new THREE.DataTexture(wall.pixels, steps, wall.n, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;

  return texture;
}

/** Patterned theme: a wall drawn as ink glyphs. Each texel's glyph step comes from the
 * painter; glyphs repeat at a fixed size along the wall (world units), so they stay square
 * however long a forecast step is. */
const patternVertex = /* glsl */ `
attribute float along;
varying vec2 vUv;
varying float vAlong;
varying float vDepth;
void main() {
  vUv = uv;
  vAlong = along;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const patternFragment = /* glsl */ `
uniform sampler2D uLevels;
uniform sampler2D uAtlas;
uniform float uAcross;
uniform float uGlyph;
uniform vec3 uFog;
uniform vec2 uFogRange;
varying vec2 vUv;
varying float vAlong;
varying float vDepth;
void main() {
  float code = floor(texture2D(uLevels, vUv).r * 255.0 + 0.5);
  float level = code > 200.0 ? 0.0 : mod(code, 8.0);
  float muted = code > 7.5 && code < 200.0 ? 1.0 : 0.0;
  vec2 f = fract(vec2(vAlong / uGlyph, vUv.y * uAcross));
  vec3 c = texture2D(uAtlas, vec2((level + f.x) / 7.0, (1.0 - muted + f.y) / 2.0)).rgb;
  float fog = smoothstep(uFogRange.x, uFogRange.y, vDepth);
  gl_FragColor = vec4(mix(c, uFog, fog), 1.0);
}`;
let atlasTexture: THREE.CanvasTexture | null = null;
function wallMaterial(wall: PaintedWall, steps: number, width: number, pattern: boolean) {
  if (!pattern)
    return new THREE.MeshBasicMaterial({ map: wallTexture(wall, steps), side: THREE.DoubleSide });
  const levels = new THREE.DataTexture(wall.levels, steps, wall.n, THREE.RedFormat);
  levels.magFilter = levels.minFilter = THREE.NearestFilter;
  levels.wrapT = THREE.RepeatWrapping;
  levels.needsUpdate = true;
  atlasTexture ??= new THREE.CanvasTexture(patternAtlas(32));
  // About one glyph per 2.4 world units across the wall, square along it.
  const across = Math.max(1, Math.round(width / 2.4));

  return new THREE.ShaderMaterial({
    vertexShader: patternVertex,
    fragmentShader: patternFragment,
    uniforms: {
      uLevels: { value: levels },
      uAtlas: { value: atlasTexture },
      uAcross: { value: across },
      uGlyph: { value: width / across },
      uFog: { value: new THREE.Color(PAPER) },
      uFogRange: { value: new THREE.Vector2(40, 460) },
    },
    side: THREE.DoubleSide,
  });
}

/** A small sign for a daily gate: lead time and date. */
function gateSign(lead: string, date: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const g = canvas.getContext('2d')!;
  g.fillStyle = 'rgb(255 255 255 / 0.92)';
  g.beginPath();
  g.roundRect(2, 2, 252, 60, 12);
  g.fill();
  g.fillStyle = '#1f2633';
  g.font = '600 26px ui-monospace, Menlo, monospace';
  g.fillText(lead, 16, 40);
  const after = 16 + g.measureText(lead).width + 14;
  g.fillStyle = '#5d6878';
  g.font = '18px system-ui, sans-serif';
  g.fillText(date, after, 39);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  return texture;
}

const dispose = (group: THREE.Object3D) =>
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const mat = mesh.material as THREE.MeshBasicMaterial | undefined;
    mat?.map?.dispose();
    mat?.dispose?.();
  });

/** Fly inside the forecast. The tunnel's length is lead time and its walls are painted with
 * the data. Square: four flat walls, each a Hovmöller diagram (the north, south, east and
 * west halves of the region, or the row and column through a pinned place). Round: the
 * compass (each direction the average of that sector, north on top) or the colour mix.
 * Pausing shows the map of that time ahead. */
export default function TunnelView({
  section,
  forecast,
  volume,
  uncertainty,
  mask,
  maskLabel,
  muted,
  validTimes,
  pattern = false,
  palette,
  range,
  index,
  onIndex,
  playing,
  onPlaying,
  pins,
  onPick,
}: TunnelProps) {
  const [nt, ny, nx] = volume.shape;
  const hours = useMemo(
    () => volume.times.map((v) => timeValue(v, volume.timeUnits)),
    [volume.times, volume.timeUnits],
  );
  const units = volume.quantity.units === 'degree_Celsius' ? '°C' : volume.quantity.units;
  const ascending = ny > 1 && volume.lat[1] > volume.lat[0];
  const [shape, setShape] = useState<'square' | 'round'>('square');
  const place = pins.at(-1) ?? null;
  const placeKey = place ? `${place.x},${place.y}` : '';
  // The walls answer the section's question; a pinned place gives its exact row and column.
  const paint = useMemo(
    () =>
      paintTunnel({
        section,
        volume: forecast,
        display: volume,
        palette,
        range,
        uncertainty,
        mask,
        maskLabel,
        muted,
        place,
        units,
      }),
    // place is compared by value: a new pins array with the same last pin keeps the walls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      section,
      forecast,
      volume,
      palette,
      range,
      uncertainty?.mode,
      uncertainty?.scale,
      mask,
      maskLabel,
      muted.join(),
      placeKey,
      units,
    ],
  );
  const [coast, setCoast] = useState<Segment[]>([]);
  const [hud, setHud] = useState({ hour: hours[index] ?? 0, resting: true });
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    loadCoastlines()
      .then(setCoast)
      .catch(() => setCoast([]));
  }, []);

  const host = useRef<HTMLDivElement>(null);
  const three = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    tunnel: THREE.Group;
    walls: THREE.Mesh[];
    map: THREE.Mesh;
    now: THREE.Line;
    nowSquare: THREE.Line;
    pins: THREE.Group;
  } | null>(null);
  const motion = useRef({
    hour: hours[index] ?? 0,
    target: null as number | null,
    reported: index,
    pointer: { x: 0, y: 0 },
    look: { x: 0, y: 0 },
    rest: 1,
    playing,
    step: index,
    hoverAt: null as { x: number; y: number } | null,
  });
  motion.current.playing = playing;
  const callbacks = useRef({ onIndex, onPlaying });
  callbacks.current = { onIndex, onPlaying };
  const view = useRef({ shape });
  view.current = { shape };

  // Play at the end starts again from the beginning.
  useEffect(() => {
    const m = motion.current;
    if (playing && m.hour >= hours.at(-1)! - 1e-6) m.hour = hours[0];
  }, [playing, hours]);

  // The timeline (scrubbing, step arrows) moves the tunnel to that time.
  useEffect(() => {
    const m = motion.current;
    if (index === m.reported) return;
    m.reported = index;
    m.target = hours[index];
  }, [index, hours]);

  // Scene, once.
  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.domElement.className = 'tunnel-canvas';
    el.prepend(renderer.domElement);
    const scene = new THREE.Scene();
    const ground = new THREE.Color(
      getComputedStyle(el).getPropertyValue('--ground').trim() || '#f8f9fb',
    );
    scene.background = ground;
    // The far end dissolves into light, as in the reference.
    scene.fog = new THREE.Fog(ground, 40, 460);
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.3, 2000);
    const tunnel = new THREE.Group();
    const map = new THREE.Mesh(
      new THREE.PlaneGeometry(SIDE, SIDE),
      new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, fog: false }),
    );
    map.renderOrder = 5;
    const now = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(
        Array.from({ length: 97 }, (_, i) => {
          const a = (i / 96) * Math.PI * 2;

          return new THREE.Vector3(Math.cos(a), Math.sin(a), 0).multiplyScalar(RADIUS * 0.985);
        }),
      ),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 }),
    );
    const nowSquare = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(
        [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ].map(([x, y]) => new THREE.Vector3(x * HALF * 0.985, y * HALF * 0.985, 0)),
      ),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 }),
    );
    const pinGroup = new THREE.Group();
    map.add(pinGroup);
    scene.add(tunnel, map, now, nowSquare);
    three.current = {
      renderer,
      scene,
      camera,
      tunnel,
      walls: [],
      map,
      now,
      nowSquare,
      pins: pinGroup,
    };

    const resize = () => {
      const w = el.clientWidth,
        h = el.clientHeight;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = `${w}px`;
      renderer.domElement.style.height = `${h}px`;
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();

    return () => {
      observer.disconnect();
      dispose(scene);
      renderer.dispose();
      renderer.domElement.remove();
      three.current = null;
    };
  }, []);

  // The background and haze follow the theme: paper in the patterned theme.
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    const frame = requestAnimationFrame(() => {
      const ground = new THREE.Color(
        pattern
          ? PAPER
          : getComputedStyle(host.current!).getPropertyValue('--ground').trim() || '#f8f9fb',
      );
      t.scene.background = ground;
      (t.scene.fog as THREE.Fog).color = ground;
    });

    return () => cancelAnimationFrame(frame);
  }, [pattern]);

  // The tunnel: a tube whose rings sit at the forecast steps, painted with the wall values,
  // and a grid on top (lines along it every 15°, a ring every day).
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    dispose(t.tunnel);
    t.tunnel.clear();
    t.walls = [];

    const before = [-36, -24, -12].map((h) => h + hours[0]);
    const after = [12, 24, 36, 48].map((h) => h + hours.at(-1)!);
    const ringHours = [...before, ...hours, ...after];
    /** Texture column of a ring: the step's texel centre, clamped beyond the ends. */
    const column = (r: number) => (Math.max(0, Math.min(nt - 1, r - before.length)) + 0.5) / nt;
    const gridMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.32,
    });
    const dailyMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.8,
    });

    // A sign on every daily gate: lead time and date, in the top-left corner of the gate.
    const start = validTimes?.length ? validTimes[0] - hours[0] * 3600 : null;
    for (let h = Math.ceil(hours[0] / 24) * 24; h <= hours.at(-1)!; h += 24) {
      const date =
        start === null
          ? ''
          : new Date((start + h * 3600) * 1000).toLocaleString('en-GB', {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
              timeZone: 'UTC',
            });
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(16, 4),
        new THREE.MeshBasicMaterial({
          map: gateSign(`+${h} h`, date),
          transparent: true,
          depthWrite: false,
        }),
      );
      const { right, up, tangent } = frameAt(h);
      const reach = shape === 'square' ? HALF : RADIUS * 0.72;
      sign.position
        .copy(pathAt(h))
        .addScaledVector(right, -reach + 9.5)
        .addScaledVector(up, reach - 3.5);
      sign.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(right, up, tangent.clone().negate()),
      );
      sign.renderOrder = 4;
      t.tunnel.add(sign);
    }

    if (shape === 'square') {
      // Four flat walls, each a Hovmöller diagram: position across the wall, time along it.
      const sides: [string, PaintedWall, (h: number, s: number) => THREE.Vector3][] = [
        ['ceiling', paint.ceiling, (h, s) => corner(h, -1 + 2 * s, 1)],
        ['floor', paint.floor, (h, s) => corner(h, -1 + 2 * s, -1)],
        ['right', paint.right, (h, s) => corner(h, 1, -1 + 2 * s)],
        ['left', paint.left, (h, s) => corner(h, -1, -1 + 2 * s)],
      ];
      function corner(h: number, x: number, y: number) {
        const { right, up } = frameAt(h);

        return pathAt(h)
          .addScaledVector(right, x * HALF)
          .addScaledVector(up, y * HALF);
      }
      for (const [name, data, at] of sides) {
        const positions: number[] = [];
        const uvs: number[] = [];
        const along: number[] = [];
        const indices: number[] = [];
        ringHours.forEach((h, r) => {
          for (const s of [0, 1]) {
            const p = at(h, s);
            positions.push(p.x, p.y, p.z);
            uvs.push(column(r), s);
            along.push(h * DEPTH);
          }
          if (r > 0) {
            const a = (r - 1) * 2,
              b = r * 2;
            indices.push(a, b, a + 1, b, b + 1, a + 1);
          }
        });
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geometry.setAttribute('along', new THREE.Float32BufferAttribute(along, 1));
        geometry.setIndex(indices);
        geometry.computeBoundingSphere();
        const mesh = new THREE.Mesh(geometry, wallMaterial(data, nt, 2 * HALF, pattern));
        mesh.userData = { name, wall: data };
        t.tunnel.add(mesh);
        t.walls.push(mesh);
      }
      // Grid: lines along each wall at quarters, and square rings every 6 h (bold daily).
      const grid: THREE.Vector3[] = [];
      const daily: THREE.Vector3[] = [];
      const inset = 0.99;
      const outline = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ];
      for (const [, , at] of sides)
        for (const s of [0.25, 0.5, 0.75])
          for (let r = 1; r < ringHours.length; r++)
            grid.push(at(ringHours[r - 1], s), at(ringHours[r], s));
      for (const h of ringHours) {
        const isDay = Math.abs(h % 24) < 1e-6;
        if (!isDay && Math.abs(h % 6) > 1e-6) continue;
        const target = isDay ? daily : grid;
        for (let i = 0; i < 4; i++) {
          const [x1, y1] = outline[i],
            [x2, y2] = outline[(i + 1) % 4];
          target.push(corner(h, x1 * inset, y1 * inset), corner(h, x2 * inset, y2 * inset));
        }
      }
      t.tunnel.add(
        new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(grid), gridMaterial),
        new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(daily), dailyMaterial),
      );

      return;
    }

    const segments = 96;
    const positions: number[] = [];
    const uvs: number[] = [];
    const along: number[] = [];
    const indices: number[] = [];
    ringHours.forEach((h, r) => {
      const centre = pathAt(h);
      const { right, up } = frameAt(h);
      for (let j = 0; j <= segments; j++) {
        const a = (j / segments) * Math.PI * 2;
        const p = centre
          .clone()
          .addScaledVector(right, Math.cos(a) * RADIUS)
          .addScaledVector(up, Math.sin(a) * RADIUS);
        positions.push(p.x, p.y, p.z);
        uvs.push(column(r), j / segments);
        along.push(h * DEPTH);
      }
      if (r > 0)
        for (let j = 0; j < segments; j++) {
          const a = (r - 1) * (segments + 1) + j,
            b = r * (segments + 1) + j;
          indices.push(a, b, a + 1, b, b + 1, a + 1);
        }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();

    geometry.setAttribute('along', new THREE.Float32BufferAttribute(along, 1));
    // Wall colours: one texel per step and sector, blended smoothly between them.
    const surface = new THREE.Mesh(
      geometry,
      wallMaterial(paint.round, nt, 2 * Math.PI * RADIUS, pattern),
    );
    surface.userData = { name: 'round', wall: paint.round };
    t.tunnel.add(surface);
    t.walls.push(surface);

    // The grid, slightly inside the wall.
    const grid: THREE.Vector3[] = [];
    const daily: THREE.Vector3[] = [];
    const inner = RADIUS * 0.992;
    for (let j = 0; j < 24; j++) {
      const a = (j / 24) * Math.PI * 2;
      for (let r = 1; r < ringHours.length; r++) {
        for (const h of [ringHours[r - 1], ringHours[r]]) {
          const { right, up } = frameAt(h);
          grid.push(
            pathAt(h)
              .addScaledVector(right, Math.cos(a) * inner)
              .addScaledVector(up, Math.sin(a) * inner),
          );
        }
      }
    }
    for (const h of ringHours) {
      const isDay = Math.abs(h % 24) < 1e-6;
      const target = isDay ? daily : grid;
      if (!isDay && Math.abs(h % 6) > 1e-6) continue;
      const { right, up } = frameAt(h);
      for (let j = 0; j < 48; j++)
        for (const s of [j, j + 1]) {
          const a = (s / 48) * Math.PI * 2;
          target.push(
            pathAt(h)
              .addScaledVector(right, Math.cos(a) * inner)
              .addScaledVector(up, Math.sin(a) * inner),
          );
        }
    }
    t.tunnel.add(
      new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(grid), gridMaterial),
      new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(daily), dailyMaterial),
    );
  }, [shape, paint, hours, nt, validTimes, pattern]);

  // The map at the current step, shown ahead when paused.
  const step = nearest(hours, hud.hour);
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    const dLon = nx > 1 ? volume.lon[1] - volume.lon[0] : 1;
    const dLat = ny > 1 ? volume.lat[1] - volume.lat[0] : 1;
    const west = Math.min(volume.lon[0], volume.lon[nx - 1]) - Math.abs(dLon) / 2;
    const east = Math.max(volume.lon[0], volume.lon[nx - 1]) + Math.abs(dLon) / 2;
    const south = Math.min(volume.lat[0], volume.lat[ny - 1]) - Math.abs(dLat) / 2;
    const north = Math.max(volume.lat[0], volume.lat[ny - 1]) + Math.abs(dLat) / 2;
    const px = 384;
    const cells = document.createElement('canvas');
    cells.width = nx;
    cells.height = ny;
    const cg = cells.getContext('2d')!;
    const img = cg.createImageData(nx, ny);
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const v = volume.data[(step * ny + y) * nx + x];
        if (!Number.isFinite(v)) continue;
        const c = color(v, range[0], range[1], palette);
        img.data.set([c[0], c[1], c[2], 255], ((ascending ? ny - 1 - y : y) * nx + x) * 4);
      }
    cg.putImageData(img, 0, 0);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = px;
    const g = canvas.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    if (pattern)
      drawPatterned(g, { x: 0, y: 0, w: px, h: px }, 8, (u, v) => {
        const x = Math.min(nx - 1, Math.floor(u * nx));
        const row = Math.min(ny - 1, Math.floor(v * ny));
        const y = ascending ? ny - 1 - row : row;

        return {
          level: patternLevel(volume.data[(step * ny + y) * nx + x], range[0], range[1]),
          muted: !!mask && !mask[(step * ny + y) * nx + x],
        };
      });
    else g.drawImage(cells, 0, 0, px, px);
    g.beginPath();
    for (const s of coast) {
      const c = clipSegment(s, [west, south, east, north]);
      if (!c) continue;
      g.moveTo(
        ((c.source[0] - west) / (east - west)) * px,
        ((north - c.source[1]) / (north - south)) * px,
      );
      g.lineTo(
        ((c.target[0] - west) / (east - west)) * px,
        ((north - c.target[1]) / (north - south)) * px,
      );
    }
    g.strokeStyle = 'rgb(255 255 255 / 0.85)';
    g.lineWidth = 2;
    g.stroke();
    g.strokeStyle = 'rgb(30 36 46 / 0.8)';
    g.lineWidth = 0.9;
    g.stroke();
    const material = t.map.material as THREE.MeshBasicMaterial;
    material.map?.dispose();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    material.map = texture;
    material.needsUpdate = true;
  }, [step, volume, palette, range, coast, nx, ny, ascending, pattern, mask]);

  // Pins on the map.
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    dispose(t.pins);
    t.pins.clear();
    for (const p of pins) {
      const row = ascending ? p.y : ny - 1 - p.y;
      const at = new THREE.Vector3(
        ((p.x + 0.5) / nx - 0.5) * SIDE,
        ((row + 0.5) / ny - 0.5) * SIDE,
        0.05,
      );
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.75, 1.15, 24),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          depthTest: false,
          transparent: true,
          fog: false,
        }),
      );
      const dot = new THREE.Mesh(
        new THREE.CircleGeometry(0.75, 24),
        new THREE.MeshBasicMaterial({
          color: p.color,
          depthTest: false,
          transparent: true,
          fog: false,
        }),
      );
      ring.position.copy(at);
      dot.position.copy(at);
      ring.renderOrder = dot.renderOrder = 10;
      t.pins.add(ring, dot);
    }
  }, [pins, nx, ny, ascending]);

  // Render loop.
  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    let count = 0;
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const t = three.current,
        el = host.current;
      if (!t || !el || el.clientWidth < 10) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const m = motion.current;
      const first = hours[0],
        end = hours.at(-1)!;

      if (m.playing) {
        m.target = null;
        m.hour += SPEED * dt;
        if (m.hour >= end) {
          m.hour = end;
          callbacks.current.onPlaying(false);
        }
      } else if (m.target !== null) {
        m.hour += (m.target - m.hour) * Math.min(1, dt * 6);
        if (Math.abs(m.target - m.hour) < 0.05) {
          m.hour = m.target;
          m.target = null;
        }
      } else {
        const at = hours[nearest(hours, m.hour)];
        if (at !== m.hour) m.target = at;
      }
      m.hour = Math.max(first, Math.min(end, m.hour));
      const resting = !m.playing && m.target === null;
      m.rest += ((resting ? 1 : 0) - m.rest) * Math.min(1, dt * 4);

      const step = nearest(hours, m.hour);
      m.step = step;
      if (step !== m.reported) {
        m.reported = step;
        callbacks.current.onIndex(step);
      }

      // Camera: inside the tunnel, a little behind the current time, looking along it and
      // drifting toward the pointer in flight.
      const drift = 1 - m.rest;
      m.look.x += (m.pointer.x * RADIUS * 0.35 * drift - m.look.x) * Math.min(1, dt * 3);
      m.look.y += (m.pointer.y * RADIUS * 0.25 * drift - m.look.y) * Math.min(1, dt * 3);
      // At rest, back far enough to see the whole cross-section.
      const eyeHour = m.hour - BEHIND - 12 * m.rest;
      const eyeFrame = frameAt(eyeHour);
      t.camera.position
        .copy(pathAt(eyeHour))
        .addScaledVector(eyeFrame.right, m.look.x)
        .addScaledVector(eyeFrame.up, m.look.y);
      t.camera.up.copy(eyeFrame.up);
      t.camera.lookAt(pathAt(m.hour + 40 * drift));

      // The current time: a white ring on the wall, and (at rest) the map in front of it.
      const { right, up, tangent } = frameAt(m.hour);
      const basis = new THREE.Matrix4().makeBasis(right, up, tangent.clone().negate());
      const square = view.current.shape === 'square';
      t.now.visible = !square;
      t.nowSquare.visible = square;
      for (const marker of [t.now, t.nowSquare]) {
        marker.position.copy(pathAt(m.hour));
        marker.quaternion.setFromRotationMatrix(basis);
      }
      t.map.position.copy(pathAt(m.hour));
      t.map.quaternion.setFromRotationMatrix(basis);
      const mapMaterial = t.map.material as THREE.MeshBasicMaterial;
      mapMaterial.opacity = m.rest;
      t.map.visible = m.rest > 0.02;

      t.renderer.render(t.scene, t.camera);

      // Hover: on the map at rest, a place and its value; on the wall, what the wall shows.
      if (m.hoverAt && t.walls.length) {
        const { x, y } = m.hoverAt;
        m.hoverAt = null;
        mouse.set((x / el.clientWidth) * 2 - 1, -(y / el.clientHeight) * 2 + 1);
        raycaster.setFromCamera(mouse, t.camera);
        const onMap = m.rest > 0.9 ? raycaster.intersectObject(t.map, false)[0] : null;
        const onWall = onMap ? null : raycaster.intersectObjects(t.walls, false)[0];
        if (onMap?.uv) {
          const cx = Math.min(nx - 1, Math.floor(onMap.uv.x * nx));
          const row = Math.min(ny - 1, Math.floor(onMap.uv.y * ny));
          const cy = ascending ? row : ny - 1 - row;
          const v = volume.data[(step * ny + cy) * nx + cx];
          setHover({
            x,
            y,
            text: `${formatValue(Math.abs(volume.lat[cy]))}° ${volume.lat[cy] >= 0 ? 'N' : 'S'}, ${formatValue(Math.abs(volume.lon[cx]))}° ${volume.lon[cx] >= 0 ? 'E' : 'W'} · ${Number.isFinite(v) ? `${formatValue(v)} ${units}` : 'no data'} · click to pin`,
          });
        } else if (onWall?.uv) {
          const k = Math.max(0, Math.min(nt - 1, Math.round(onWall.uv.x * nt - 0.5)));
          const side = (onWall.object.userData as { wall: PaintedWall }).wall;
          const i = Math.min(side.n - 1, Math.floor((((onWall.uv.y % 1) + 1) % 1) * side.n));
          setHover({ x, y, text: side.describe(k, i) });
        } else setHover(null);
      }

      // Overlay state: the current time, and whether the view is at rest.
      if (count++ % 3 === 0) {
        setHud((old) =>
          Math.abs(old.hour - m.hour) > 0.4 || old.resting !== resting
            ? { hour: m.hour, resting }
            : old,
        );
      }
    };
    frame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame);
  }, [hours, volume, nx, ny, nt, units, ascending]);

  return (
    <div className="tunnel-view">
      <div
        ref={host}
        className="tunnel-stage"
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - box.left,
            y = e.clientY - box.top;
          motion.current.pointer = { x: (x / box.width) * 2 - 1, y: -((y / box.height) * 2 - 1) };
          motion.current.hoverAt = { x, y };
        }}
        onPointerLeave={() => {
          setHover(null);
          motion.current.pointer = { x: 0, y: 0 };
        }}
        onClick={(e) => {
          // Pick now rather than waiting for the next frame's hover.
          const t = three.current,
            m = motion.current;
          if (!t?.walls.length) return;
          const box = e.currentTarget.getBoundingClientRect();
          const ray = new THREE.Raycaster();
          ray.setFromCamera(
            new THREE.Vector2(
              ((e.clientX - box.left) / box.width) * 2 - 1,
              -((e.clientY - box.top) / box.height) * 2 + 1,
            ),
            t.camera,
          );
          const onMap = m.rest > 0.9 ? ray.intersectObject(t.map, false)[0] : null;
          if (onMap?.uv) {
            const cx = Math.min(nx - 1, Math.floor(onMap.uv.x * nx));
            const row = Math.min(ny - 1, Math.floor(onMap.uv.y * ny));
            onPick(cx, ascending ? row : ny - 1 - row);

            return;
          }
          // A click on the wall travels to that time.
          const onWall = ray.intersectObjects(t.walls, false)[0];
          if (onWall?.uv) {
            const k = Math.max(0, Math.min(nt - 1, Math.round(onWall.uv.x * nt - 0.5)));
            if (m.playing) onPlaying(false);
            m.target = hours[k];
          }
        }}
        onWheel={(e) => {
          const m = motion.current;
          if (m.playing) onPlaying(false);
          m.target = Math.max(
            hours[0],
            Math.min(hours.at(-1)!, (m.target ?? m.hour) + e.deltaY * 0.1),
          );
        }}
        style={{ cursor: hover ? 'pointer' : 'default' }}
      >
        {hover && (
          <div className="radial-tooltip" style={{ left: hover.x + 12, top: hover.y + 12 }}>
            {hover.text}
          </div>
        )}
      </div>
      <div className="tunnel-controls">
        <div
          className="segmented two radial-arrangement tunnel-shape"
          role="radiogroup"
          aria-label="Tunnel shape"
        >
          {(
            [
              ['square', 'Square', 'Four flat walls, one per side of the region'],
              ['round', 'Round', 'A round tunnel: compass directions or the colour mix around it'],
            ] as const
          ).map(([value, label, title]) => (
            <button
              key={value}
              role="radio"
              title={title}
              aria-checked={shape === value}
              className={shape === value ? 'selected' : ''}
              onClick={() => setShape(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="tunnel-hint">
        {hud.resting
          ? 'Click the map to pin a place · click a wall to go to that time'
          : 'Scroll to move in time · pause to see the map'}
      </p>
    </div>
  );
}
