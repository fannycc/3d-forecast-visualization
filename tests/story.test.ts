import { describe, expect, it } from 'vitest';
import { certainPlaces, memberSplit, regionalMeans, reliableHorizon } from '../src/analysis/story';
import { ensembleStats } from '../src/engine/ensemble';
import { timeLabel } from '../src/engine/time-labels';
import type { Volume } from '../src/engine/types';

/** 2 times × 1 × 2 cells, 3 members (member-major). */
function ensembleVolume(): Volume {
  // members[m][t][x]
  const values = [
    [10, 10, 20, 20], // member 0: average at t=0
    [12, 12, 21, 21], // member 1: warmer
    [8, 8, 25, 25], // member 2: colder at t=0, much warmer at t=1
  ];
  const members = Float32Array.from(values.flat());
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
    min: 10,
    max: 22,
    missing: 0,
    units: 'degree_Celsius',
    variable: 'temperature_2m',
    ensemble: { count: 3, labels: [0, 1, 2], members, stats },
  };
}

describe('story analytics', () => {
  it('takes area-weighted regional means per layer', () => {
    const means = regionalMeans(ensembleVolume());
    expect(means[0]).toBeCloseTo(10);
    expect(means[1]).toBeCloseTo(22);
  });

  it('stacks colder runs upside down below the mean and warmer runs above', () => {
    const split = memberSplit(ensembleVolume(), 0)!;
    expect(split.below).toBe(1);
    expect(split.above).toBe(2);
    expect(split.order).toEqual([2, 0, 1]);
    expect(split.volume.times).toEqual([-5, -3, -2, -1, 0, 1, 2, 3, 5, 6]);
    expect(split.volume.data[0]).toBeCloseTo(-2);
    expect(Number.isNaN(split.volume.data[2])).toBe(true);
    expect(timeLabel(0, split.volume.timeUnits)).toBe('average');
    expect(timeLabel(-5, split.volume.timeUnits)).toBe('1 below');
    expect(timeLabel(6, split.volume.timeUnits)).toBe('2 above');
  });

  it('finds how long each cell stays below a spread threshold', () => {
    const v = ensembleVolume();
    // spread at t=0 is 2, at t=1 about 2.65
    expect([...reliableHorizon(v, 2.5)!]).toEqual([0, 0]);
    expect([...reliableHorizon(v, 3)!]).toEqual([6, 6]);
    expect(reliableHorizon(v, 1)!.every(Number.isNaN)).toBe(true);
  });

  it('ranks named places by their reliable horizon, one place per cell', () => {
    const v = ensembleVolume();
    const horizon = Float32Array.from([12, 48]);
    const places = [
      { name: 'A', lon: 0.01, lat: 50, rank: 1, population: 10 },
      { name: 'B', lon: 0.24, lat: 50, rank: 2, population: 5 },
      { name: 'B2', lon: 0.26, lat: 50, rank: 3, population: 5 },
      { name: 'Far', lon: 5, lat: 50, rank: 0, population: 99 },
    ];
    expect(certainPlaces(places, v, horizon, 5).map((p) => [p.name, p.hours])).toEqual([
      ['B', 48],
      ['A', 12],
    ]);
  });
});

it('breaks equal horizons by the lower mean spread', async () => {
  const { certainPlaces: rank } = await import('../src/analysis/story');
  const volume = { lon: [0, 1], lat: [50], shape: [1, 1, 2] as [number, number, number] };
  const places = [
    { name: 'Rough', lon: 0, lat: 50, rank: 1, population: 1 },
    { name: 'Calm', lon: 1, lat: 50, rank: 2, population: 1 },
  ];
  const result = rank(places, volume, Float32Array.from([96, 96]), 2, Float32Array.from([2, 1]));
  expect(result.map((p) => p.name)).toEqual(['Calm', 'Rough']);
});

it('finds the longest event sites, measured in valid hours and spaced apart', async () => {
  const { eventSites } = await import('../src/analysis/story');
  // 4 times (0, 1, 2, 8 h) × 1 × 3 cells.
  const volume = {
    shape: [4, 1, 3] as [number, number, number],
    times: [0, 1, 2, 8],
    timeUnits: 'hours',
  };
  const mask = new Uint8Array(12);
  // cell 0: matched at 0,1,2 h → 2 h; cell 2: matched at 2 and 8 h → 6 h.
  [0, 3, 6].forEach((i) => (mask[i] = 255));
  [8, 11].forEach((i) => (mask[i] = 255));
  const sites = eventSites(volume, mask, 5, 1);
  expect(sites.map((s) => [s.x, s.hours, s.from, s.to])).toEqual([
    [2, 6, 2, 8],
    [0, 2, 0, 2],
  ]);
  expect(eventSites(volume, mask, 5, 3)).toHaveLength(1);
});
