import {
  MAX_VOLUME_BYTES,
  MAX_SELECTION_CHUNKS,
  MAX_ENSEMBLE_BYTES,
  MAX_ENSEMBLE_CHUNKS,
  MAX_BASELINE_CHUNKS,
} from './load-budget';
import { ensembleStats } from './ensemble';
import { scatter } from './scatter';
import { BaselineAccumulator, planBaseline } from './baseline';
import { regionGrid } from './region-grid';
import { exampleOptions, isSnowfallExample, snowfallExample } from './examples';
import { resolveAxes, variableDetails } from './datacube';
import { defaultVariable, assertGeographicCoordinates, variableLabel } from './dataset-support';
import { timeWindow, windowTimeCoordinates } from './time-window';
import { forecastStart } from './forecast-coverage';
import * as z from 'zarrita';
import { BudgetCache, Scheduler, chunkKey } from './cache';
import {
  planChunks,
  validateExtent,
  unitSeconds,
  wrapLongitude,
  coordinateDate,
} from './coordinates';
import { resolveStore } from './resolve';
import type {
  BaselineRequest,
  Metadata,
  Metrics,
  OpenRequest,
  Request,
  Response,
  Volume,
  Extent,
} from './types';
import type { Readable, AbsolutePath, RangeQuery } from '@zarrita/storage';

const MB = 1024 * 1024;

const bytes = new BudgetCache<Uint8Array>(48 * MB),
  decoded = new BudgetCache<z.Chunk<z.DataType>>(128 * MB);

const network = new Scheduler(4),
  decode = new Scheduler(2);

let metadata: Metadata, store: Readable, root: z.Location<Readable>;

const arrays = new Map<string, z.Array<z.DataType>>();

const aborts = new Map<number, AbortController>();

const metrics: Metrics = {
  requests: 0,
  responseBytes: 0,
  decodedBytes: 0,
  byteCacheBytes: 0,
  cacheHits: 0,
  decodeMs: 0,
  openMs: 0,
  loadMs: 0,
  snapshot: '',
  transferBytes: 0,
  cpuDecodeMs: 0,
  coalescedRequests: 0,
};

for (const [name, factory] of z.registry) {
  z.registry.set(name, async () => {
    const entry = await factory();

    return {
      kind: entry.kind,
      fromConfig: (config, meta) => {
        const codec = entry.fromConfig(config, meta);
        const original = codec.decode.bind(codec);

        codec.decode = async (...args: Parameters<typeof original>) => {
          const start = performance.now();
          try {
            return await original(...args);
          } finally {
            metrics.cpuDecodeMs += performance.now() - start;
          }
        };

        return codec;
      },
    };
  });
}

const nativeFetch = self.fetch.bind(self);

self.fetch = async (...args: Parameters<typeof fetch>) => {
  metrics.requests++;
  const response = await nativeFetch(...args);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length)) metrics.responseBytes += length;

  return response;
};

function report(): Metrics {
  metrics.decodedBytes = decoded.bytes;
  metrics.byteCacheBytes = bytes.bytes;
  metrics.cacheHits = decoded.hits + bytes.hits;
  metrics.transferBytes = performance
    .getEntriesByType('resource')
    .reduce((n, e) => n + (e as PerformanceResourceTiming).transferSize, 0);

  return { ...metrics };
}

function send(message: Response, transfer: Transferable[] = []) {
  self.postMessage(message, { transfer });
}

/** Wrap store reads with byte-budgeted caching and request deduplication, preserving ranges. */
function cachedStore(raw: Readable, prefix: string): Readable {
  const get = (key: AbsolutePath, range?: RangeQuery) => {
    const identity = JSON.stringify([prefix, key, range]);
    const hit = bytes.get(identity);
    if (hit) return Promise.resolve(hit);

    return network.run(identity, async () => {
      const value = range && raw.getRange ? await raw.getRange(key, range) : await raw.get(key);
      if (value) bytes.set(identity, value, value.byteLength);

      return value ?? undefined;
    });
  };

  return {
    get: (key) => get(key),
    ...(raw.getRange
      ? { getRange: (key: AbsolutePath, range: RangeQuery) => get(key, range) }
      : {}),
  };
}

async function array(name: string) {
  let a = arrays.get(name);
  if (!a) {
    a = await z.open(root.resolve(name), { kind: 'array' });
    arrays.set(name, a);
  }

  return a;
}

/** Read a one-dimensional coordinate array within the coordinate or recent-history budget. */
async function coord(name: string, recent = false) {
  const a = await array(name);
  if (a.shape.length !== 1) throw Error(`Coordinate ${name} must be one-dimensional.`);
  const window = timeWindow(a.shape[0], !recent);
  if (window.stop - window.start > 100000)
    throw Error(`Coordinate ${name} exceeds the 100,000-value coordinate budget.`);
  const d = await z.get(a, [z.slice(window.start, window.stop)]);

  return {
    values: Array.from(d.data as ArrayLike<number | bigint>, Number),
    units: String(a.attrs.units || ''),
    attrs: a.attrs,
    start: window.start,
    length: a.shape[0],
  };
}

async function open(options: OpenRequest, id: number) {
  options = exampleOptions(options);
  const start = performance.now();
  arrays.clear();
  decoded.clear();
  bytes.clear();
  send({ id, type: 'progress', message: 'Resolving dataset and reading coordinates…' });
  const resolved = await resolveStore(options.url);
  let snapshot = `session-${Date.now()}`;
  let names = isSnowfallExample(options.url) ? snowfallExample.variables : resolved.variables;
  if (resolved.icechunk) {
    if (!self.crossOriginIsolated)
      throw Error(
        'Icechunk requires cross-origin isolation. Serve COOP: same-origin and COEP: credentialless headers over HTTPS or localhost.',
      );

    const [{ Repository }, { createFetchStorage }] = await Promise.all([
      import('@earthmover/icechunk'),
      import('@earthmover/icechunk/fetch-storage'),
    ]);

    const repo = await Repository.open(createFetchStorage(resolved.url), {
      maxConcurrentRequests: 4,
      maxConcurrentDecodes: 2,
      caching: {
        numBytesChunks: 8 * MB,
        numBytesAttributes: 4 * MB,
        numChunkRefs: 200000,
        numSnapshotNodes: 2000,
      },
    });

    const session = await repo.readonlySession({ branch: 'main' });
    snapshot = session.snapshotId;
    const raw = session.store;

    store = cachedStore(
      {
        get: async (key) => (await raw.get(key)) ?? undefined,
        getRange: async (key, range) => (await raw.getRange(key, range)) ?? undefined,
      },
      resolved.url + snapshot,
    );

    if (!names.length) names = (await raw.listDir('')).filter((n) => n !== 'zarr.json');
  } else {
    const raw = new z.FetchStore(resolved.url);
    store = cachedStore(raw, resolved.url + snapshot);
    if (!names.length) {
      const v3 = await store.get('/zarr.json');
      if (v3) {
        const doc = JSON.parse(new TextDecoder().decode(v3));
        names = Object.keys(doc.consolidated_metadata?.metadata || {}).filter(
          (k) => !k.includes('/'),
        );
      }

      if (!names.length) {
        const v2 = await store.get('/.zmetadata');
        if (v2) {
          const doc = JSON.parse(new TextDecoder().decode(v2));
          names = Object.keys(doc.metadata || {})
            .filter((n) => n.endsWith('/.zarray'))
            .map((n) => n.replace('/.zarray', ''));
        }
      }
    }
  }

  const asyncStore = {
    get: async (key: AbsolutePath) => (await store.get(key)) ?? undefined,
    ...(store.getRange
      ? {
          getRange: async (key: AbsolutePath, range: RangeQuery) =>
            (await store.getRange!(key, range)) ?? undefined,
        }
      : {}),
  };

  root = z.root(
    z.withRangeCoalescing(asyncStore, {
      coalesceSize: 16384,
      onFlush: (r) => {
        metrics.coalescedRequests += r.requestCount - r.groupCount;
      },
    }),
  );

  let variable =
    options.variable ||
    defaultVariable(names.filter((name) => resolved.cube.variables[name]?.type !== 'auxiliary'));
  if (!variable)
    throw Error('This store cannot list arrays. Enter an explicit array path under Advanced.');
  const a = await array(variable);
  if (a.shape.length < 3 || a.shape.length > 5)
    throw Error(
      'Supported arrays have longitude, latitude and time axes, optionally plus initialization and ensemble member axes.',
    );

  const dimensions = a.dimensionNames || (a.attrs._ARRAY_DIMENSIONS as string[]);
  const axes = resolveAxes(dimensions, resolved.cube, variable, options.axes);

  const [x, y, t, init, member] = await Promise.all([
    coord(axes.x),
    coord(axes.y),
    coord(axes.t, !axes.init),
    axes.init ? coord(axes.init) : Promise.resolve({ values: [0], units: '' }),
    axes.member ? coord(axes.member) : Promise.resolve(null),
  ]);

  for (const [name, c] of [
    [axes.x, x],
    [axes.y, y],
    [axes.t, t],
  ] as const) {
    if (c.length !== a.shape[dimensions.indexOf(name)] || c.values.some((v) => !Number.isFinite(v)))
      throw Error(`Invalid or missing coordinates for ${name}.`);
  }
  assertGeographicCoordinates(x.attrs, y.attrs);
  let complete: number[] = [];
  let availability =
    'Availability metadata unavailable; each regional block is verified across all lead times.';
  if (axes.init) {
    lengths.clear();
    const [ingested, expected] = await Promise.all([
      runLengths('ingested_forecast_length', axes.init),
      runLengths('expected_forecast_length', axes.init),
    ]);
    if (ingested) {
      const max = Math.max(...t.values) * unitSeconds(t.units);
      complete = ingested.flatMap((v, i) =>
        Number.isFinite(v) && v >= Math.min(max, expected?.[i] ?? max) - 1e-6 ? [i] : [],
      );
      if (complete.length)
        availability =
          'Run lengths verified from ingestion metadata; regional values checked on load.';
    }
  }

  if (t.values.some((v, i) => i > 0 && v <= t.values[i - 1]))
    throw Error('Time coordinates must be strictly increasing; irregular intervals are supported.');
  for (const c of [x, y]) {
    const step = c.values[1] - c.values[0];
    if (c.values.some((v, i) => i > 0 && Math.abs(v - c.values[i - 1] - step) > 1e-6))
      throw Error(
        'Irregular spatial grids are not supported in this milestone. Use a rectilinear, regularly spaced grid.',
      );
  }
  const variables = [];
  for (const name of names) {
    if (resolved.cube.variables[name]?.type === 'auxiliary') continue;
    try {
      const item = await array(name);
      const details = variableDetails(resolved.cube, name, item.attrs);
      if (isSnowfallExample(options.url)) {
        const disabledReason =
          item.shape.length !== 3
            ? `${item.shape.length}D array — the cube currently requires latitude, longitude and winter dimensions.`
            : undefined;

        if (!disabledReason)
          resolveAxes(
            item.dimensionNames || (item.attrs._ARRAY_DIMENSIONS as string[] | undefined),
            resolved.cube,
            name,
            exampleOptions({ url: options.url, variable: name }).axes,
          );

        variables.push({
          name,
          label: variableLabel(name, item.attrs.long_name),
          units: String(item.attrs.units || ''),
          disabledReason,
        });

        continue;
      }

      resolveAxes(
        item.dimensionNames || (item.attrs._ARRAY_DIMENSIONS as string[] | undefined),
        resolved.cube,
        name,
        options.axes,
      );

      if (
        item.shape.length === a.shape.length &&
        JSON.stringify(item.dimensionNames || item.attrs._ARRAY_DIMENSIONS) ===
          JSON.stringify(dimensions)
      )
        variables.push({
          name,
          label: variableLabel(name, details.label),
          units: details.units,
        });
    } catch {}
  }
  if (!variables.some((v) => v.name === variable))
    variables.unshift({
      name: variable,
      label: variableLabel(variable, variableDetails(resolved.cube, variable, a.attrs).label),
      units: variableDetails(resolved.cube, variable, a.attrs).units,
    });

  variables.sort((a, b) =>
    a.name === 'temperature_2m' ? -1 : b.name === 'temperature_2m' ? 1 : 0,
  );
  const timeUnits =
    isSnowfallExample(options.url) && ['winter', 'year'].includes(axes.t) ? 'winter year' : t.units;
  const time = windowTimeCoordinates(t.values, timeUnits, t.start, !!axes.init);
  const raw = await store.get(`/${variable}/zarr.json` as AbsolutePath);

  metadata = {
    url: options.url,
    storeUrl: resolved.url,
    title: isSnowfallExample(options.url) ? snowfallExample.title : resolved.title,
    snapshot,
    variables,
    variable,
    shape: a.shape,
    chunks: a.chunks,
    dtype: a.dtype,
    dimensions,
    axes,
    lon: x.values,
    lat: y.values,
    times: time.values,
    timeIndices: time.indices,
    timeUnits: time.units,
    initializations: init.values,
    initUnits: init.units,
    ...(member ? { members: member.values } : {}),
    stepType: a.attrs.step_type === undefined ? undefined : String(a.attrs.step_type),
    complete,
    availability,
    units: variableDetails(resolved.cube, variable, a.attrs).units,
    codecs: raw ? JSON.parse(new TextDecoder().decode(raw)).codecs : 'Zarr v2',
  };

  metrics.snapshot = snapshot;
  metrics.openMs = performance.now() - start;
  send({ id, type: 'metadata', metadata, metrics: report() });
}

/** Read and cache a decoded source chunk within the allocation budget.
 * Consumer cancellation detaches from shared work without cancelling other readers. */
async function chunk(a: z.Array<z.DataType>, coords: number[], signal: AbortSignal) {
  const key = chunkKey(metadata.storeUrl, metadata.snapshot, a.path, coords);
  const hit = decoded.get(key);
  if (hit) return hit;
  const size = a.chunks.reduce((v, n) => v * n, 1) * (a.dtype === 'float64' ? 8 : 4);
  if (size > 96 * MB)
    throw Error(
      `A source chunk requires ${(size / MB).toFixed(0)} MiB, beyond the 96 MiB safety limit. Use an existing overview or a better-chunked store.`,
    );

  return decode.run(
    key,
    async () => {
      const start = performance.now();
      const value = await a.getChunk(coords);
      metrics.decodeMs += performance.now() - start;
      const n = (value.data as Float32Array).byteLength || size;
      decoded.set(key, value, n);

      return value;
    },
    signal,
  );
}

const lengths = new Map<string, Promise<number[] | null>>();

/** Recorded run lengths in seconds per initialization, from dataset metadata; NaN where a
 * run is not recorded yet. Ensemble rows take the shortest member, so a length covers every
 * member. Null when the array does not exist or is not indexed by initialization. */
function runLengths(name: string, initAxis: string) {
  let pending = lengths.get(name);
  if (!pending) {
    pending = (async () => {
      try {
        const a = await array(name);
        const dims = a.dimensionNames || (a.attrs._ARRAY_DIMENSIONS as string[] | undefined);
        if (!dims || dims[0] !== initAxis || a.shape[0] > 100000) return null;
        const { data } = await z.get(
          a,
          dims.map(() => null),
        );
        const values = Array.from(data as ArrayLike<number | bigint>, Number);
        const per = values.length / a.shape[0];
        const scale = unitSeconds(String(a.attrs.units || 'seconds'));

        const result = Array.from({ length: a.shape[0] }, (_, i) => {
          let min = Infinity;
          for (let j = 0; j < per; j++) {
            const v = values[i * per + j];
            min = Number.isFinite(v) && v >= 0 && v < 2 ** 52 ? Math.min(min, v) : -Infinity;
          }

          return Number.isFinite(min) ? min * scale : NaN;
        });

        // Some stores declare the array but never fill it; that says nothing about runs.
        return result.some(Number.isFinite) ? result : null;
      } catch {
        return null;
      }
    })();
    lengths.set(name, pending);
  }

  return pending;
}

async function load(
  variable: string,
  init: number,
  extent: Extent,
  id: number,
  signal: AbortSignal,
) {
  const start = performance.now();
  validateExtent(extent);
  const a = await array(variable);
  if (!a.is('number')) throw Error(`Unsupported data type ${a.dtype}; select a numeric array.`);
  const dims = a.dimensionNames || (a.attrs._ARRAY_DIMENSIONS as string[]);
  if (JSON.stringify(dims) !== JSON.stringify(metadata.dimensions))
    throw Error('Variable axes differ. Reopen the dataset with this array path.');
  const { axes } = metadata;
  const longitude = regionGrid(metadata.lon, extent[0], extent[2], true);
  const latitude = regionGrid(metadata.lat, extent[1], extent[3]);
  const x = longitude.indices;
  const y = latitude.indices;
  let t = metadata.timeIndices ?? metadata.times.map((_, i) => i);
  let times = metadata.times;
  let note: string | undefined;
  if (axes.init) {
    const [ingested, expected] = await Promise.all([
      runLengths('ingested_forecast_length', axes.init),
      runLengths('expected_forecast_length', axes.init),
    ]);
    const leadSeconds = unitSeconds(metadata.timeUnits);
    const recorded = ingested?.[init];
    const planned = expected?.[init];
    if (ingested && !Number.isFinite(recorded))
      throw Error(
        'This run is still being ingested: its ingested_forecast_length is not recorded yet. Choose an earlier run.',
      );
    const reach = Math.min(
      Number.isFinite(recorded) ? recorded! : Infinity,
      Number.isFinite(planned) ? planned! : Infinity,
    );
    if (Number.isFinite(reach) && metadata.times.at(-1)! * leadSeconds > reach + 1e-6) {
      const keep = metadata.times.filter((v) => v * leadSeconds <= reach + 1e-6).length;
      if (keep < 2)
        throw Error(`This run has no recorded data beyond +${reach / 3600} h. Choose another run.`);
      t = t.slice(0, keep);
      times = times.slice(0, keep);
      note = `This run reaches +${reach / 3600} h (${
        reach === recorded ? 'ingested' : 'expected'
      }_forecast_length); later lead times are not part of it.`;
    }
  }
  const memberCount = axes.member ? (metadata.members?.length ?? 0) : 1;
  if (!x.some((i) => i >= 0) || !y.some((i) => i >= 0))
    throw Error('This region contains no coordinate samples. Choose an extent inside the dataset.');
  const cells = x.length * y.length * t.length;
  const count = cells * memberCount;
  const width = a.dtype === 'float64' ? 8 : 4;
  if (axes.member && count * width > MAX_ENSEMBLE_BYTES)
    throw Error(
      `Keeping all ${memberCount} members of this selection exceeds the ${MAX_ENSEMBLE_BYTES / MB} MiB ensemble budget. Choose a smaller region.`,
    );
  if (!axes.member && count * width > MAX_VOLUME_BYTES)
    throw Error(
      'This selection exceeds the 64 MiB volume budget. Choose a smaller region; source chunk transfer may remain larger.',
    );

  if (!Number.isInteger(init) || init < 0 || init >= metadata.initializations.length)
    throw Error('Initialization is outside available coordinates.');

  const members = Array.from({ length: memberCount }, (_, i) => i);
  const indices = dims.map((d) =>
    d === axes.x
      ? x.filter((i) => i >= 0)
      : d === axes.y
        ? y.filter((i) => i >= 0)
        : d === axes.t
          ? t
          : d === axes.member
            ? members
            : [init],
  );

  const limit = axes.member ? MAX_ENSEMBLE_CHUNKS : MAX_SELECTION_CHUNKS;
  const planned = planChunks(a.shape, a.chunks, indices);
  if (planned.length > limit)
    throw Error(`This selection spans more than ${limit} chunks. Choose a smaller region.`);

  send({
    id,
    type: 'progress',
    message: `Reading ${planned.length} source ${planned.length === 1 ? 'block' : 'blocks'} · checking all ${t.length} time steps${axes.member ? ` × ${memberCount} members` : ''}…`,
  });

  const data = a.dtype === 'float64' ? new Float64Array(count) : new Float32Array(count);
  data.fill(NaN);
  const plane = x.length * y.length;
  const selections = dims.map((d): [number, number][] =>
    d === axes.x
      ? x.flatMap((source, i) => (source >= 0 ? [[source, i]] : []))
      : d === axes.y
        ? y.flatMap((source, i) => (source >= 0 ? [[source, i * x.length]] : []))
        : d === axes.t
          ? t.map((source, i) => [source, i * plane])
          : d === axes.member
            ? members.map((m) => [m, m * cells])
            : [[init, 0]],
  );
  let finished = 0;

  await Promise.all(
    planned.map(async (coords) => {
      const c = await chunk(a, coords, signal);
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      scatter(c, coords, a.chunks, selections, a.fillValue, (o, v) => (data[o] = v));
      send({ id, type: 'progress', message: `Loaded ${++finished} of ${planned.length} blocks…` });
    }),
  );

  const coverage = new Uint32Array(t.length);
  let any = false;
  for (let i = 0; i < data.length; i++)
    if (Number.isFinite(data[i])) {
      coverage[Math.floor((i % cells) / plane)]++;
      any = true;
    }
  if (!any)
    throw Error(
      'No source values exist for this initialization and region. Choose an earlier initialization.',
    );

  const startStep = axes.init ? forecastStart(coverage, times, a.attrs) : 0;
  const kept = cells - startStep * plane;
  const trimmed =
    startStep === 0
      ? data
      : (() => {
          const out = new (data.constructor as Float32ArrayConstructor)(kept * memberCount);
          for (let m = 0; m < memberCount; m++)
            out.set(data.subarray(m * cells + startStep * plane, (m + 1) * cells), m * kept);

          return out;
        })();

  const stats = axes.member ? ensembleStats(trimmed, memberCount, kept) : null;
  const loadedData = stats ? stats.mean : trimmed;
  let min = Infinity,
    max = -Infinity,
    missing = 0;
  for (let i = 0; i < loadedData.length; i++) {
    const v = loadedData[i];
    if (Number.isFinite(v)) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    } else missing++;
  }
  const loadedTimes = times.slice(startStep);

  const volume: Volume = {
    id: chunkKey(metadata.storeUrl, metadata.snapshot, variable, [init, ...extent]),
    data: loadedData,
    shape: [loadedTimes.length, y.length, x.length],
    spatialCoverage: [
      x.findIndex((i) => i >= 0),
      y.findIndex((i) => i >= 0),
      x.length - 1 - [...x].reverse().findIndex((i) => i >= 0),
      y.length - 1 - [...y].reverse().findIndex((i) => i >= 0),
    ],
    lon: longitude.values,
    lat: latitude.values,
    times: loadedTimes,
    timeUnits: metadata.timeUnits,
    init,
    extent,
    min,
    max,
    missing,
    units: String(
      a.attrs.units || metadata.variables.find((v) => v.name === variable)?.units || '',
    ),
    variable,
    ...(note ? { note } : {}),
    ...(stats
      ? {
          ensemble: {
            count: memberCount,
            labels: metadata.members ?? members,
            members: trimmed,
            stats,
          },
        }
      : {}),
  };

  metrics.loadMs = performance.now() - start;
  const transfer = [loadedData.buffer as ArrayBuffer];
  if (stats)
    transfer.push(
      trimmed.buffer as ArrayBuffer,
      ...[stats.spread, stats.p10, stats.median, stats.p90, stats.valid].map(
        (b) => b.buffer as ArrayBuffer,
      ),
    );
  send({ id, type: 'volume', volume, metrics: report() }, transfer);
}

/** Convert a CF time coordinate to epoch seconds. */
function epochSeconds(values: number[], units: string) {
  if (!units.includes('since ')) throw Error('The archive time axis has no reference epoch.');
  const origin = Date.parse(coordinateDate(0, units)) / 1000;

  return values.map((v) => origin + v * unitSeconds(units));
}

/** Build per-cell normals for a loaded forecast from this worker's analysis archive. */
async function baseline(request: BaselineRequest, id: number, signal: AbortSignal) {
  const start = performance.now();
  const { axes } = metadata;
  if (axes.init || axes.member)
    throw Error('A baseline archive must be an analysis dataset with a single time axis.');
  if (!metadata.variables.some((v) => v.name === request.variable))
    throw Error(`The baseline archive has no ${request.variable} variable.`);
  const a = await array(request.variable);
  if (!a.is('number')) throw Error('The baseline variable is not numeric.');
  const stepTypes = [request.stepType, a.attrs.step_type].map((v) =>
    v === undefined ? 'instant' : String(v),
  );
  if (stepTypes.some((v) => v !== 'instant'))
    throw Error(
      `Normals are only built for instantaneous variables; ${request.variable} is ${stepTypes.find((v) => v !== 'instant')}, and its averaging period differs between datasets.`,
    );
  const units = String(a.attrs.units || '');

  const full = await coord(axes.t, false);
  const archive = epochSeconds(full.values, full.units);
  const plan = planBaseline(request.validTimes, archive, {
    years: request.years,
    windowDays: request.windowDays,
  });

  /** Exact coordinate matches; -1 only where the forecast lies outside the archive grid. */
  const match = (wanted: number[], source: number[], longitude: boolean) => {
    const lo = Math.min(...source),
      hi = Math.max(...source);
    const global = longitude && (hi - lo) * (1 + 1 / (source.length - 1)) >= 359.999;

    return wanted.map((w) => {
      const i = source.findIndex((s) => Math.abs(longitude ? wrapLongitude(s - w) : s - w) < 1e-4);
      const inside =
        global ||
        ((longitude ? wrapLongitude(w) : w) >= lo && (longitude ? wrapLongitude(w) : w) <= hi);
      if (i < 0 && inside)
        throw Error(
          'The forecast and baseline grids differ. Normals are not regridded, because interpolation would add error.',
        );

      return i;
    });
  };
  const xs = match(request.lon, metadata.lon, true);
  const ys = match(request.lat, metadata.lat, false);

  const times = [...plan.contributions.keys()].sort((p, q) => p - q);
  const dims = a.dimensionNames || (a.attrs._ARRAY_DIMENSIONS as string[]);
  const indices = dims.map((d) =>
    d === axes.x ? xs.filter((i) => i >= 0) : d === axes.y ? ys.filter((i) => i >= 0) : times,
  );
  const planned = planChunks(a.shape, a.chunks, indices);
  if (request.estimateOnly) {
    send({
      id,
      type: 'estimate',
      estimate: {
        chunks: planned.length,
        perNormal: [Math.min(...plan.expected), Math.max(...plan.expected)],
        archive: [
          new Date(archive[0] * 1000).toISOString(),
          new Date(archive.at(-1)! * 1000).toISOString(),
        ],
      },
    });

    return;
  }
  if (planned.length > MAX_BASELINE_CHUNKS)
    throw Error(
      `This baseline needs ${planned.length} chunk reads, above the ${MAX_BASELINE_CHUNKS}-read limit. Choose fewer years or a smaller region.`,
    );

  const nx = request.lon.length,
    ny = request.lat.length,
    plane = nx * ny;
  const acc = new BaselineAccumulator(plan.targets.length, plane);
  const contributions = plan.contributions;
  // Output offsets encode the forecast cell; time entries carry the archive index so the
  // writer can look up which targets the sample contributes to.
  const selections = dims.map((d): [number, number][] =>
    d === axes.x
      ? xs.flatMap((source, i) => (source >= 0 ? [[source, i]] : []))
      : d === axes.y
        ? ys.flatMap((source, i) => (source >= 0 ? [[source, i * nx]] : []))
        : times.map((source) => [source, source * plane]),
  );
  let finished = 0;
  const queue = [...planned];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const coords = queue.shift()!;
      const c = await chunk(a, coords, signal);
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      scatter(c, coords, a.chunks, selections, a.fillValue, (o, v) => {
        const sample = Math.floor(o / plane),
          cell = o - sample * plane;
        for (const k of contributions.get(sample)!) acc.add(k, cell, v);
      });
      // Baseline chunks are read once; keep the decoded cache for the forecast.
      decoded.clear();
      send({
        id,
        type: 'progress',
        message: `Building normals: ${++finished} of ${planned.length} archive blocks…`,
      });
    }
  });
  await Promise.all(workers);

  const result = acc.result(plan.steps);
  let minSamples = Infinity,
    maxSamples = 0;
  for (const n of result.count) {
    if (!n) continue;
    minSamples = Math.min(minSamples, n);
    maxSamples = Math.max(maxSamples, n);
  }

  metrics.loadMs = performance.now() - start;
  send(
    {
      id,
      type: 'normals',
      normals: {
        volumeId: request.volumeId,
        ...result,
        provenance: {
          source: metadata.title,
          snapshot: metadata.snapshot,
          variable: `${request.variable} (${units})`,
          years: request.years,
          windowDays: request.windowDays,
          interpolatedSteps: plan.interpolatedSteps,
          steps: plan.steps.length,
          minSamples: Number.isFinite(minSamples) ? minSamples : 0,
          maxSamples,
        },
      },
      metrics: report(),
    },
    [result.mean.buffer, result.sd.buffer, result.count.buffer],
  );
}

let opening: Promise<void> | undefined;

let loads = 0;

self.onmessage = (event: MessageEvent<Request>) => {
  const r = event.data;
  if (r.type === 'stats') {
    send({ id: r.id, type: 'stats', metrics: report() });

    return;
  }

  if (r.type === 'cancel') {
    aborts.get(r.target)?.abort();

    return;
  }

  const controller = new AbortController();
  aborts.set(r.id, controller);

  const execute = async () => {
    if (r.type === 'open') {
      opening = open(r.options, r.id);
      await opening;
    } else {
      await opening;
      if (!metadata) throw Error('Open a dataset first.');
      if (r.type === 'baseline') {
        await baseline(r, r.id, controller.signal);

        return;
      }
      if (++loads % 32 === 0) arrays.clear();
      await load(r.variable, r.init, r.extent, r.id, controller.signal);
    }
  };

  execute()
    .catch((e) => {
      if (!controller.signal.aborted)
        send({ id: r.id, type: 'error', message: (e as Error).message || String(e) });
    })
    .finally(() => aborts.delete(r.id));
};
