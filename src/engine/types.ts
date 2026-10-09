import type { EnsembleStats } from './ensemble';

/** Geographic degrees ordered west, south, east, north; west > east crosses the dateline. */
export type Extent = [west: number, south: number, east: number, north: number];

export type Axes = { x: string; y: string; t: string; init?: string; member?: string };

export type OpenRequest = { url: string; variable?: string; axes?: Axes };

export type Variable = { name: string; label: string; units: string; disabledReason?: string };

/** Validated source metadata; source axis order is preserved in shape and chunks. */
export type Metadata = {
  url: string;
  storeUrl: string;
  title: string;
  snapshot: string;
  variables: Variable[];
  variable: string;
  shape: number[];
  chunks: number[];
  dtype: string;
  dimensions: string[];
  axes: Axes;
  lon: number[];
  lat: number[];
  times: number[];
  timeIndices?: number[];
  timeUnits: string;
  initializations: number[];
  initUnits: string;
  /** Ensemble member labels; absent for single forecasts. */
  members?: number[];
  /** Variable attributes needed to judge comparability, such as step_type. */
  stepType?: string;
  complete: number[];
  availability: string;
  units: string;
  codecs: unknown;
};

/** A retained regional block in [time, latitude, longitude] order, longitude varying fastest.
 * Values retain source units and Float32/Float64 precision; missing cells are NaN. */
export type Volume = {
  id: string;
  data: Float32Array | Float64Array;
  shape: [number, number, number];
  /** Inclusive x/y index bounds containing source coordinates; padded cells lie outside. */
  spatialCoverage?: [number, number, number, number];
  lon: number[];
  lat: number[];
  times: number[];
  timeUnits: string;
  init: number;
  extent: Extent;
  min: number;
  max: number;
  missing: number;
  units: string;
  variable: string;
  /** A statement about how the loaded volume differs from the full dataset axes. */
  note?: string;
  /** Present for ensemble forecasts: every member plus per-cell statistics. */
  ensemble?: {
    count: number;
    labels: number[];
    /** Member-major: members[m * cells + cell], cells in [time, y, x] order. */
    members: Float32Array | Float64Array;
    stats: EnsembleStats;
  };
};

/** Climatological normals for every cell of one loaded volume. */
export type Normals = {
  volumeId: string;
  mean: Float32Array;
  sd: Float32Array;
  count: Uint16Array;
  provenance: {
    source: string;
    snapshot: string;
    variable: string;
    years: [number, number];
    windowDays: number;
    interpolatedSteps: number;
    steps: number;
    minSamples: number;
    maxSamples: number;
  };
};

export type BaselineRequest = {
  /** Loaded forecast cells to match: coordinates and absolute valid times (epoch seconds). */
  volumeId: string;
  variable: string;
  stepType?: string;
  lon: number[];
  lat: number[];
  validTimes: number[];
  years: [number, number];
  windowDays: number;
  /** Only estimate the reads needed; do not load any chunks. */
  estimateOnly?: boolean;
};

export type BaselineEstimate = {
  chunks: number;
  /** Fewest and most archive samples behind one normal, before missing values. */
  perNormal: [number, number];
  archive: [string, string];
};

export type Metrics = {
  requests: number;
  responseBytes: number;
  decodedBytes: number;
  byteCacheBytes: number;
  cacheHits: number;
  decodeMs: number;
  openMs: number;
  loadMs: number;
  snapshot: string;
  transferBytes: number;
  cpuDecodeMs: number;
  coalescedRequests: number;
};

/** Main-thread worker protocol; every request carries a monotonically increasing ID. */
export type Request =
  | { id: number; type: 'stats' }
  | { id: number; type: 'open'; options: OpenRequest }
  | { id: number; type: 'load'; variable: string; init: number; extent: Extent }
  | ({ id: number; type: 'baseline' } & BaselineRequest)
  | { id: number; type: 'cancel'; target: number };

/** Worker protocol: progress is nonterminal; every other response completes a request. */
export type Response =
  | { id: number; type: 'stats'; metrics: Metrics }
  | { id: number; type: 'metadata'; metadata: Metadata; metrics: Metrics }
  | { id: number; type: 'volume'; volume: Volume; metrics: Metrics }
  | { id: number; type: 'normals'; normals: Normals; metrics: Metrics }
  | { id: number; type: 'estimate'; estimate: BaselineEstimate }
  | { id: number; type: 'progress'; message: string }
  | { id: number; type: 'error'; message: string };
