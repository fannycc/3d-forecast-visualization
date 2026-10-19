import { expect, it } from 'vitest';
import { radialSpec } from '../src/story/radial';
import { deriveVolume, defaultDisplay } from '../src/engine/derive';
import { ensembleStats } from '../src/engine/ensemble';
import type { Volume } from '../src/engine/types';

function volume(withEnsemble: boolean): Volume {
  // 2 times × 1 × 2 cells; 3 members, member-major.
  const members = Float32Array.from([10, 10, 20, 20, 12, 12, 21, 21, 8, 8, 25, 25]);
  const stats = ensembleStats(members, 3, 4);

  return {
    id: 'v',
    data: stats.mean,
    shape: [2, 1, 2],
    lon: [0, 0.25],
    lat: [50],
    times: [0, 6],
    timeUnits: 'hours',
    init: 0,
    extent: [0, 50, 0.25, 50],
    min: 0,
    max: 30,
    missing: 0,
    units: 'degree_Celsius',
    variable: 'temperature_2m',
    ...(withEnsemble ? { ensemble: { count: 3, labels: [0, 1, 2], members, stats } } : {}),
  };
}

const base = {
  certaintyView: 'disagreement' as const,
  t: 0,
  palette: 'thermal' as const,
  range: [0, 30] as [number, number],
  memberRange: [-5, 5] as [number, number],
  uncertainty: { mode: 'off' as const, scale: 3 },
  normals: null,
  reference: 'forecast' as const,
  horizon: null,
  mask: null,
  muted: [0.9, 0.9, 0.9] as [number, number, number],
};

it('places runs by how far their regional average strays from the mean', () => {
  const v = volume(true);
  const spec = radialSpec({
    ...base,
    section: 'forecast',
    volume: v,
    display: deriveVolume(v, defaultDisplay),
  });
  expect(spec.tiles).toHaveLength(3);
  // Member 0 equals the mean at t = 0: it sits on the inner ring.
  const byLabel = Object.fromEntries(spec.tiles.map((t) => [t.label, t]));
  expect(byLabel['Run 0'].distance).toBeCloseTo(0);
  expect(Math.max(...spec.tiles.map((t) => t.distance))).toBeCloseTo(1);
});

it('splits warmer runs to the right half and colder runs to the left in the runs section', () => {
  const v = volume(true);
  const spec = radialSpec({
    ...base,
    section: 'members',
    volume: v,
    display: deriveVolume(v, defaultDisplay),
  });
  const byLabel = Object.fromEntries(spec.tiles.map((t) => [t.label, t]));
  expect(byLabel['Run 1'].angle).toBeLessThan(Math.PI); // warmer: right
  expect(byLabel['Run 2'].angle).toBeGreaterThan(Math.PI); // colder: left
  expect(byLabel['Run 1'].grid[0]).toBeCloseTo(2); // shown as run minus mean
});

it('becomes a clock of forecast times without an ensemble', () => {
  const v = volume(false);
  const spec = radialSpec({
    ...base,
    section: 'forecast',
    volume: v,
    display: deriveVolume(v, defaultDisplay),
  });
  expect(spec.tiles.map((t) => t.label)).toEqual(['+0 h', '+6 h']);
  expect(spec.tiles[0].angle).toBe(0);
});

it('moves a region by its centre, keeping its size and staying inside the poles', async () => {
  const { movedExtent } = await import('../src/components/RegionPicker');
  expect(movedExtent([0, 40, 20, 60], 30, 0)).toEqual([20, -10, 40, 10]);
  expect(movedExtent([0, 40, 20, 60], 10, 89)).toEqual([0, 70, 20, 90]);
  expect(movedExtent([170, 0, -170, 20], 180, 10)).toEqual([170, 0, -170, 20]);
});
