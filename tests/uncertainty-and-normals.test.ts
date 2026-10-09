import { describe, expect, it } from 'vitest';
import { ensembleStats, memberShare, quantile } from '../src/engine/ensemble';
import { rowAreas, areaSummary, EARTH_RADIUS_KM } from '../src/analysis/area';
import { BaselineAccumulator, planBaseline, withYear } from '../src/engine/baseline';

describe('ensemble statistics', () => {
  it('matches NumPy type-7 quantiles and sample standard deviation', () => {
    // Two cells, five members; member-major layout.
    const cell0 = [1, 2, 3, 4, 10];
    const cell1 = [5, NaN, 5, 5, 5];
    const members = new Float32Array(10);
    cell0.forEach((v, m) => (members[m * 2] = v));
    cell1.forEach((v, m) => (members[m * 2 + 1] = v));
    const s = ensembleStats(members, 5, 2);
    expect(s.mean[0]).toBeCloseTo(4);
    // numpy.std([1,2,3,4,10], ddof=1) = 3.5355339
    expect(s.spread[0]).toBeCloseTo(3.5355339, 5);
    // numpy.percentile([1,2,3,4,10], [10,50,90]) = [1.4, 3, 7.6]
    expect([s.p10[0], s.median[0], s.p90[0]].map((v) => +v.toFixed(4))).toEqual([1.4, 3, 7.6]);
    expect(s.valid[1]).toBe(4);
    expect(s.spread[1]).toBe(0);
  });

  it('returns NaN for cells without members and shares over valid members only', () => {
    const members = new Float32Array([NaN, 1, NaN, 3, NaN, 5]);
    const s = ensembleStats(members, 3, 2);
    expect(Number.isNaN(s.mean[0])).toBe(true);
    const share = memberShare(members, 3, 2, 2, 'above');
    expect(Number.isNaN(share[0])).toBe(true);
    expect(share[1]).toBeCloseTo(2 / 3);
    // A normal offset of 2 turns the members into anomalies −1, 1, 3.
    expect(memberShare(members, 3, 2, 0, 'below', [0, 2])[1]).toBeCloseTo(1 / 3);
  });

  it('interpolates quantiles at the extremes', () => {
    expect(quantile([0, 10], 2, 0)).toBe(0);
    expect(quantile([0, 10], 2, 1)).toBe(10);
    expect(quantile([0, 10], 2, 0.25)).toBe(2.5);
  });
});

describe('spherical cell areas', () => {
  it('sums a full 1° global grid to the area of the sphere', () => {
    const lat = Array.from({ length: 181 }, (_, i) => -90 + i);
    const lon = Array.from({ length: 360 }, (_, i) => -180 + i);
    const total = rowAreas(lat, lon).reduce((a, b) => a + b, 0) * 360;
    expect(total / (4 * Math.PI * EARTH_RADIUS_KM ** 2)).toBeCloseTo(1, 10);
  });

  it('shrinks cells with the cosine of latitude, whatever the latitude order', () => {
    const north = rowAreas([60.25, 60, 59.75], [0, 0.25]);
    const equator = rowAreas([-0.25, 0, 0.25], [0, 0.25]);
    expect(north[1] / equator[1]).toBeCloseTo(Math.cos((60 * Math.PI) / 180), 4);
  });

  it('weights selection means and areas by cell area', () => {
    const volume = {
      data: new Float32Array([10, 20, 30, NaN]),
      shape: [1, 2, 2] as [number, number, number],
      lat: [0, 60],
      lon: [0, 1],
    };
    const s = areaSummary(volume, new Uint8Array([255, 0, 255, 255]));
    const [a0, a60] = rowAreas(volume.lat, volume.lon);
    expect(s.matchedCells).toBe(2);
    expect(s.matched[0]).toBeCloseTo(a0 + a60);
    expect(s.withData[0]).toBeCloseTo(2 * a0 + a60);
    expect(s.weightedMean).toBeCloseTo((10 * a0 + 30 * a60) / (a0 + a60));
  });
});

describe('climatological baseline', () => {
  const hour = 3600;
  const start = Date.UTC(2000, 0, 1) / 1000;
  /** A 3-hourly archive spanning 2000–2003. */
  const archive = Array.from({ length: 4 * 366 * 8 }, (_, i) => start + i * 3 * hour);

  it('maps leap days to 28 February', () => {
    expect(new Date(withYear(Date.UTC(2004, 1, 29, 6) / 1000, 2001) * 1000).toISOString()).toBe(
      '2001-02-28T06:00:00.000Z',
    );
  });

  it('collects same-hour samples within the window for each year', () => {
    const valid = [Date.UTC(2025, 5, 15, 12) / 1000];
    const plan = planBaseline(valid, archive, { years: [2001, 2002], windowDays: 3 });
    expect(plan.targets).toHaveLength(1);
    expect(plan.expected[0]).toBe(2 * 7);
    for (const [i, targets] of plan.contributions) {
      expect(targets).toEqual([0]);
      expect(new Date(archive[i] * 1000).getUTCHours()).toBe(12);
    }
    expect(plan.interpolatedSteps).toBe(0);
  });

  it('interpolates hours the archive does not sample', () => {
    const valid = [Date.UTC(2025, 5, 15, 13) / 1000];
    const plan = planBaseline(valid, archive, { years: [2001, 2001], windowDays: 0 });
    expect(plan.interpolatedSteps).toBe(1);
    expect(plan.targets.map((t) => new Date(t * 1000).getUTCHours())).toEqual([12, 15]);
    expect(plan.steps[0].w).toBeCloseTo(2 / 3);
  });

  it('computes mean and sample standard deviation, interpolating between hours', () => {
    const acc = new BaselineAccumulator(2, 1);
    [1000, 1002, 1004].forEach((v) => acc.add(0, 0, v));
    [1010, 1010].forEach((v) => acc.add(1, 0, v));
    acc.add(1, 0, NaN);
    const r = acc.result([
      { a: 0, b: 0, w: 1 },
      { a: 0, b: 1, w: 0.5 },
    ]);
    expect(r.mean[0]).toBeCloseTo(1002);
    expect(r.sd[0]).toBeCloseTo(2);
    expect(r.count[0]).toBe(3);
    expect(r.mean[1]).toBeCloseTo(1006);
    expect(r.count[1]).toBe(2);
  });

  it('refuses a period outside the archive', () => {
    expect(() =>
      planBaseline([Date.UTC(2025, 5, 15) / 1000], archive, { years: [1980, 1990], windowDays: 7 }),
    ).toThrow(/no samples/);
  });
});

describe('derived views', async () => {
  const { deriveVolume, memberSeries, defaultDisplay } = await import('../src/engine/derive');
  const { ensembleStats: stats } = await import('../src/engine/ensemble');
  // 1 time × 1 × 2 cells, 3 members.
  const members = new Float32Array([10, 20, 12, 22, 14, 30]);
  const volume = {
    id: 'v',
    data: new Float32Array(2),
    shape: [1, 1, 2] as [number, number, number],
    lon: [0, 1],
    lat: [50],
    times: [0],
    timeUnits: 'hours',
    init: 0,
    extent: [0, 50, 1, 50] as [number, number, number, number],
    min: 0,
    max: 0,
    missing: 0,
    units: 'degree_Celsius',
    variable: 'temperature_2m',
    ensemble: { count: 3, labels: [0, 1, 2], members, stats: stats(members, 3, 2) },
  };
  const normals = {
    volumeId: 'v',
    mean: new Float32Array([11, 20]),
    sd: new Float32Array([2, 0]),
    count: new Uint16Array([30, 30]),
    provenance: {} as never,
  };

  it('shows the mean with spread as uncertainty', () => {
    const d = deriveVolume(volume, defaultDisplay);
    expect([...d.data]).toEqual([12, 24]);
    expect(d.uncertainty![0]).toBeCloseTo(2);
    expect(d.quantity.units).toBe('°C');
  });

  it('subtracts and standardizes against normals, refusing zero spread', () => {
    const a = deriveVolume(volume, { ...defaultDisplay, reference: 'anomaly' }, normals);
    expect([...a.data]).toEqual([1, 4]);
    const z = deriveVolume(volume, { ...defaultDisplay, reference: 'standardized' }, normals);
    expect(z.data[0]).toBeCloseTo(0.5);
    expect(Number.isNaN(z.data[1])).toBe(true);
    expect(z.uncertainty![0]).toBeCloseTo(1);
    expect(z.quantity.units).toBe('σ');
  });

  it('ignores normals built for another volume', () => {
    const d = deriveVolume(
      volume,
      { ...defaultDisplay, reference: 'anomaly' },
      { ...normals, volumeId: 'other' },
    );
    expect(d.quantity.kind).toBe('value');
  });

  it('counts member shares against anomalies and standardized thresholds', () => {
    const share = { direction: 'above' as const, threshold: 1.5 };
    const raw = deriveVolume(volume, {
      ...defaultDisplay,
      statistic: 'share',
      share: { direction: 'above', threshold: 11 },
    });
    expect(raw.data[0]).toBeCloseTo(2 / 3);
    expect(raw.quantity.fixedRange).toEqual([0, 1]);
    const anomaly = deriveVolume(
      volume,
      { ...defaultDisplay, statistic: 'share', share, reference: 'anomaly' },
      normals,
    );
    expect(anomaly.data[0]).toBeCloseTo(1 / 3); // anomalies −1, 1, 3
    const z = deriveVolume(
      volume,
      {
        ...defaultDisplay,
        statistic: 'share',
        share: { direction: 'above', threshold: 0.4 },
        reference: 'standardized',
      },
      normals,
    );
    expect(z.data[0]).toBeCloseTo(2 / 3); // z = −0.5, 0.5, 1.5: two of three above 0.4
  });

  it('returns member series in the shown units', () => {
    const series = memberSeries(
      deriveVolume(volume, { ...defaultDisplay, reference: 'anomaly' }, normals),
      { ...defaultDisplay, reference: 'anomaly' },
      normals,
      0,
      0,
    );
    expect(series!.map((s) => s[0])).toEqual([-1, 1, 3]);
  });
});
