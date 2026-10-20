import { remapSlices } from './render/slice-remap';
import { snowfallExample, isSnowfallExample } from './engine/examples';
import { isWinterTime, timeLabel, timeValue } from './engine/time-labels';
import { squareExtent } from './engine/square-extent';
import { RegionDialog } from './components/RegionDialog';
import { valueRange, formatValue } from './render/value-scale';
import { regularDataset, isAvailableForecast } from './engine/dataset-support';
import { initialRegion } from './engine/initial-region';
import { OnboardingTour } from './components/OnboardingTour';
import { RunPicker } from './components/RunPicker';
import {
  addForecastPoint,
  anchoredCell,
  refreshForecastPoints,
  type ForecastPoint,
} from './analysis/points';
import { useEffect, useRef, useState, useCallback, useMemo, lazy, Suspense } from 'react';
import {
  PanelLeft,
  Plus,
  FolderOpen,
  Play,
  Pause,
  Settings2,
  AlertCircle,
  Search,
  X,
  Sun,
  Moon,
  Hash,
  SkipBack,
  SkipForward,
} from 'lucide-react';
import { Command } from 'cmdk';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';
import { DataClient } from './engine/client';
import { AIFS, readCatalog, type CatalogChoice } from './engine/resolve';
import { coordinateDate, coordinateIndices, validateExtent } from './engine/coordinates';
import type { Extent, Metadata, Metrics, Volume, OpenRequest } from './engine/types';
import { Cube } from './components/Cube';
import { AnalysisControls } from './components/AnalysisControls';
import type { EventRule } from './analysis/events';
import { applySQL, useMosaicState } from './analysis/state';
import { useAnalysis } from './analysis/useAnalysis';
import { TimeSeries } from './components/LinkedViews';
import { Button, Dialog, Popover, Slider, Tip, TooltipProvider } from './components/ui/primitives';
import { gradient, snowfallRange, type Palette } from './render/colors';
import { deriveVolume, defaultDisplay, memberSeries, type Display } from './engine/derive';
import { useNormals } from './analysis/useNormals';
import { EnsembleControls, type UncertaintyMode } from './components/EnsembleControls';
import { NormalsControls } from './components/NormalsControls';
import { isAvailableForecast as isComparableForecast } from './engine/dataset-support';
import { dynamicalCatalogUrl } from './engine/config';
import type { Reference } from './engine/derive';
import type { DisplayVolume } from './engine/derive';
import { rowAreas } from './analysis/area';
import {
  certainPlaces,
  eventSites,
  meanSpread,
  memberSplit,
  regionalMeans,
  reliableHorizon,
} from './analysis/story';
import { loadPlaces, placesInRegion, type Place } from './render/places';
import { Figures, StoryPanel, StoryTicks, type SectionId } from './story/StoryPanel';
import type { Beam, ClockSpec } from './components/Cube';
import { CubeToolbar, type ViewMode } from './components/CubeToolbar';
import { RadialView } from './components/RadialView';
import { RegionPicker } from './components/RegionPicker';
import { CubeLoader } from './components/CubeLoader';
import { patternLegend } from './render/patterns';
import { validTimes as stepTimes } from './analysis/useNormals';

/** The experimental patterned theme ships only where it is switched on. */
const PATTERN_THEME = import.meta.env.DEV || import.meta.env.VITE_PATTERN === 'on';

const TunnelView = lazy(() => import('./tunnel/TunnelView'));
import { radialSpec } from './story/radial';

/** The story opens on an ensemble so every question can be answered. */
const STORY_DATASET = dynamicalCatalogUrl
  ? new URL('noaa-gefs-forecast-35-day/collection.json', dynamicalCatalogUrl).href
  : '';

const pretty = (u: string) => (u === 'degree_Celsius' ? '°C' : u);

/** The clock's answer: the current regional average and the extremes, with their times. */
function clockFigures(
  means: ArrayLike<number>,
  volume: DisplayVolume,
  now: number,
): [string, string][] {
  const show = (v: number) =>
    volume.quantity.kind === 'share'
      ? `${Math.round(v * 100)} %`
      : `${formatValue(v)} ${volume.quantity.units}`;
  let lo = -1,
    hi = -1;
  for (let i = 0; i < means.length; i++) {
    if (!Number.isFinite(means[i])) continue;
    if (lo < 0 || means[i] < means[lo]) lo = i;
    if (hi < 0 || means[i] > means[hi]) hi = i;
  }
  const at = (i: number) => timeLabel(volume.times[i], volume.timeUnits);

  return [
    [show(means[now]), `regional average at ${at(now)}`],
    ...(hi >= 0 ? ([[show(means[hi]), `highest, at ${at(hi)}`]] as [string, string][]) : []),
    ...(lo >= 0 ? ([[show(means[lo]), `lowest, at ${at(lo)}`]] as [string, string][]) : []),
  ];
}

const DEFAULT_EXTENT: Extent = [-25, 34, 45, 72];

const initialParams = new URLSearchParams(location.search);

const initialExtent = (() => {
  try {
    const e = JSON.parse(initialParams.get('extent') || 'null');
    if (!Array.isArray(e) || e.length !== 4) return DEFAULT_EXTENT;
    validateExtent(e as Extent);

    return e as Extent;
  } catch {
    return DEFAULT_EXTENT;
  }
})();

const legendValue = (v: number, kind: string) =>
  kind === 'share' ? `${Math.round(v * 100)}` : formatValue(v);

const legendUnits = (q: { kind: string; units: string }) =>
  q.kind === 'share' ? '% of members' : q.units;

const mb = (n: number) => (n / 1048576).toFixed(1) + ' MiB';

function dateLabel(v: number, units: string) {
  try {
    return coordinateDate(v, units)
      .replace('T', ' · ')
      .replace(/:00\.000Z$/, ' UTC');
  } catch {
    return String(v);
  }
}

export default function App() {
  const sidebarPanel = usePanelRef();
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 650px)').matches);

  useEffect(() => {
    const query = matchMedia('(max-width: 650px)');

    const update = () => {
      setNarrow(query.matches);
      setSidebar(false);
      sidebarPanel.current?.collapse();
    };

    query.addEventListener('change', update);

    return () => query.removeEventListener('change', update);
  }, []);

  const [selectedForecasts, setSelectedForecasts] = useMosaicState<ForecastPoint[]>([]);
  const openStarted = useRef(0),
    [firstPlane, setFirstPlane] = useState<number | null>(null);

  const markReady = useCallback(
    () => setFirstPlane((v) => v ?? performance.now() - openStarted.current),
    [],
  );

  const client = useRef<DataClient | null>(null),
    cancel = useRef<(() => void) | null>(null);
  const [meta, setMeta] = useState<Metadata | null>(null),
    [volume, setVolume] = useState<Volume | null>(null),
    [metrics, setMetrics] = useState<Metrics | null>(null);

  const [url, setUrl] = useState(initialParams.get('dataset') || AIFS),
    [variable, setVariable] = useState(initialParams.get('variable') || 'temperature_2m'),
    [init, setInit] = useState(0),
    [extent, setExtent] = useState<Extent>(initialExtent),
    [slices, setSlices] = useMosaicState<[number, number, number]>([0, 0, 0]);

  const [range, setRange] = useMosaicState<[number, number]>([-10, 35]),
    [palette, setPalette] = useMosaicState<Palette>('thermal');
  const paletteRef = useRef(palette);
  paletteRef.current = palette;

  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [regionDialog, setRegionDialog] = useState(false),
    [commands, setCommands] = useState(false),
    [diagnostics, setDiagnostics] = useState(false),
    [sidebar, setSidebar] = useState(true),
    [linked, setLinked] = useState(false),
    [playing, setPlaying] = useState(false),
    [reset, setReset] = useState(0);

  /** The persistent-event rule last searched for, to apply to every run in the flat view. */
  const [eventRule, setEventRule] = useState<EventRule | null>(null);
  const [regionFailure, setRegionFailure] = useState<{ message: string } | null>(null);

  useEffect(() => {
    if (!regionFailure) return;
    const timer = setTimeout(() => setRegionFailure(null), 5000);

    return () => clearTimeout(timer);
  }, [regionFailure]);

  const [display, setDisplayState] = useState<Display>(defaultDisplay),
    [uncertaintyMode, setUncertaintyMode] = useState<UncertaintyMode>('suppress'),
    [uncertaintyScale, setUncertaintyScale] = useState(1);
  /** light (default), dark, or pattern: ink glyphs on paper instead of colours. The
   * patterned theme is still experimental: local development only unless VITE_PATTERN=on. */
  const [themeMode, setTheme] = useState<'light' | 'dark' | 'pattern'>(() => {
    try {
      const saved = localStorage.getItem('zarr-sql-views-theme');

      return saved === 'dark' || (saved === 'pattern' && PATTERN_THEME) ? saved : 'light';
    } catch {
      return 'light';
    }
  });
  const patterned = themeMode === 'pattern';
  /** Everything except the colour ramp treats the patterned theme as light. */
  const theme: 'light' | 'dark' = themeMode === 'dark' ? 'dark' : 'light';
  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    try {
      localStorage.setItem('zarr-sql-views-theme', themeMode);
    } catch {}
  }, [themeMode]);

  const [section, setSection] = useState<SectionId>('forecast'),
    [jump, setJump] = useState<{ id: SectionId; n: number } | null>(null),
    [normalReference, setNormalReference] = useState<Reference>('anomaly'),
    [selectionStyle, setSelectionStyle] = useState<'isolate' | 'paint'>('paint'),
    [trustThreshold, setTrustThreshold] = useState(2),
    [certaintyView, setCertaintyView] = useState<'disagreement' | 'trust'>('disagreement'),
    [placeCount, setPlaceCount] = useState(6),
    [viewMode, setViewMode] = useState<ViewMode>('cube'),
    [arrangement, setArrangement] = useState<'map' | 'mix'>('map'),
    [pendingExtent, setPendingExtent] = useState<Extent | null>(null);
  const isTrust = section === 'certainty' && certaintyView === 'trust';
  const jumpTo = useCallback((id: SectionId) => setJump((j) => ({ id, n: (j?.n ?? 0) + 1 })), []);
  const normals = useNormals(meta, volume, section === 'normal' && normalReference !== 'forecast');

  /** Each section shows the quantity its question is about. */
  const effectiveDisplay = useMemo<Display>(() => {
    const plain = display.statistic === 'share' ? 'mean' : display.statistic;
    switch (section) {
      case 'certainty':
        return { ...display, reference: 'forecast' };
      case 'normal':
        return { ...display, reference: normalReference };
      case 'persistent':
      case 'sql':
        return {
          ...display,
          statistic: plain,
          reference: normals.current ? normalReference : 'forecast',
        };
      default:
        return { ...display, statistic: 'mean', reference: 'forecast' };
    }
  }, [section, display, normalReference, normals.current]);

  /** The cube, legend, SQL and point panel all read this one derived volume. */
  const displayVolume = useMemo(
    () => (volume ? deriveVolume(volume, effectiveDisplay, normals.normals) : null),
    [volume, effectiveDisplay, normals.normals],
  );

  const setDisplay = (next: Display) => {
    if (next.statistic === 'share' && display.statistic !== 'share' && volume)
      next = {
        ...next,
        share: {
          ...next.share,
          threshold:
            next.reference !== 'forecast' && normals.current
              ? 0
              : Number(formatValue((volume.min + volume.max) / 2)),
        },
      };
    setDisplayState(next);
  };

  const [analysisEnabled, setAnalysisEnabled] = useState(false);
  const analysis = useAnalysis(displayVolume, analysisEnabled);

  // Colour ranges are set when the shown quantity changes and then held while panning or
  // switching runs, so colours stay comparable between regions and forecasts.
  const rangeKey = displayVolume
    ? [url, displayVolume.variable, displayVolume.quantity.kind, displayVolume.quantity.units].join(
        '|',
      )
    : '';
  useEffect(() => {
    if (!displayVolume || !meta) return;
    const q = displayVolume.quantity;
    if (q.fixedRange) {
      setPalette('viridis');
      setRange([...q.fixedRange]);
    } else if (q.kind === 'anomaly') {
      setPalette('balance');
      const limit =
        q.units === 'σ'
          ? 3
          : valueRange(0, Math.max(Math.abs(displayVolume.min), Math.abs(displayVolume.max)))[1];
      setRange([-limit, limit]);
    } else if (
      isSnowfallExample(meta.url) &&
      ['winter_anomaly', 'event_anomaly'].includes(displayVolume.variable)
    ) {
      setPalette('snowfall');
      setRange([...snowfallRange]);
    } else {
      const next = valueRange(displayVolume.min, displayVolume.max);
      if (paletteRef.current === 'snowfall') {
        const limit = Math.max(Math.abs(next[0]), Math.abs(next[1]));
        setRange([-limit, limit]);
      } else {
        if (['viridis', 'balance'].includes(paletteRef.current)) setPalette('thermal');
        setRange(next);
      }
    }
  }, [rangeKey]);

  // The uncertainty scale defaults to the 75th percentile of spread, rounded to one
  // significant figure, and is then held like the colour range.
  const scaleKey = displayVolume?.uncertainty
    ? [url, displayVolume.variable, displayVolume.quantity.units].join('|')
    : '';
  useEffect(() => {
    const u = displayVolume?.uncertainty;
    if (!u) return;
    const finite = Array.from(u)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const p75 = finite[Math.floor(finite.length * 0.75)] ?? 1;
    setUncertaintyScale(p75 > 0 ? Number(p75.toPrecision(1)) : 1);
    if (displayVolume?.quantity.units === displayVolume?.sourceUnits || p75 > 0)
      setTrustThreshold(p75 > 0 ? Number(p75.toPrecision(1)) : 1);
  }, [scaleKey]);

  useEffect(() => {
    if (displayVolume)
      setSelectedForecasts((previous) => refreshForecastPoints(previous, displayVolume));
  }, [displayVolume]);

  const renderError = useCallback((e: Error) => {
    console.error('zarr-sql-views rendering:', e);
    setError(e.message);
  }, []);

  const times = useRef<number[]>([]),
    stalls = useRef(0);
  const [warmStats, setWarmStats] = useState<{ p95: number; count: number } | null>(null);
  const warmStart = useRef<number | null>(null);
  const loadedShape = useRef<[number, number, number] | null>(null);
  const slicesRef = useRef(slices);
  slicesRef.current = slices;

  const [runNotice, setRunNotice] = useState('');

  /** fallback > 0 lets a first open step back past runs the archive holds only in part. */
  const load = useCallback(
    (m: Metadata, v: string, i: number, e: Extent, keepView = false, fallback = 0) => {
      let region: Extent;
      try {
        validateExtent(e);
        region = isSnowfallExample(m.url) ? e : squareExtent(e);
      } catch (error) {
        if (keepView) setRegionFailure({ message: 'Cannot move to this area.' });
        else setError((error as Error).message);
        setBusy(false);

        return;
      }
      cancel.current?.();
      setRegionFailure(null);
      if (
        keepView &&
        (!coordinateIndices(m.lon, region[0], region[2], true).length ||
          !coordinateIndices(m.lat, region[1], region[3]).length)
      ) {
        setBusy(false);
        setRegionFailure({ message: 'No data in this area.' });

        return;
      }

      setBusy(true);
      if (!keepView) {
        setVolume(null);
        setSelectedForecasts([]);
      }

      setError('');
      setPlaying(false);
      setMessage('Preparing regional selection…');

      cancel.current = client.current!.request(
        { type: 'load', variable: v, init: i, extent: region },
        (r) => {
          if (r.type === 'progress') setMessage(r.message);
          if (r.type === 'error') {
            if (
              !keepView &&
              fallback > 0 &&
              i > 0 &&
              /missing source data|still being ingested/.test(r.message)
            ) {
              setRunNotice(
                `The ${dateLabel(m.initializations[i], m.initUnits)} run is incomplete in the archive, so an earlier run is shown.`,
              );
              setInit(i - 1);
              load(m, v, i - 1, e, false, fallback - 1);

              return;
            }
            if (keepView)
              setRegionFailure({
                message: r.message.startsWith('No source values')
                  ? 'No data in this area.'
                  : 'Could not load this area. Keep panning to try another region.',
              });
            else setError(r.message);

            setBusy(false);
          }

          if (r.type === 'volume') {
            setVolume(r.volume);
            setExtent(region);
            setMetrics(r.metrics);
            setBusy(false);

            const shape = r.volume.shape;
            const previousShape = loadedShape.current;
            loadedShape.current = shape;

            const selected: [number, number, number] = [shape[2] - 1, 0, shape[0] - 1];
            setSlices((previous) =>
              keepView && previousShape ? remapSlices(previous, previousShape, shape) : selected,
            );
            setMeta({ ...m, variable: v, units: r.volume.units });
          }
        },
      );
    },
    [],
  );

  const openStore = useCallback(
    (options: OpenRequest, requestedExtent: Extent = DEFAULT_EXTENT) => {
      openStarted.current = performance.now();
      setFirstPlane(null);
      setRegionFailure(null);
      cancel.current?.();
      client.current?.dispose();
      client.current = new DataClient();
      setVolume(null);
      setSelectedForecasts([]);
      setMeta(null);
      setDisplayState(defaultDisplay);
      setBusy(true);
      setError('');
      setPlaying(false);
      setMessage('Connecting to the remote dataset…');
      setUrl(options.url);

      setPalette(
        isSnowfallExample(options.url) &&
          (!options.variable || ['winter_anomaly', 'event_anomaly'].includes(options.variable))
          ? 'snowfall'
          : 'thermal',
      );

      cancel.current = client.current.request({ type: 'open', options }, (r) => {
        if (r.type === 'progress') setMessage(r.message);
        if (r.type === 'error') {
          setError(r.message);
          setBusy(false);
        }

        if (r.type === 'metadata') {
          setMeta(r.metadata);
          setMetrics(r.metrics);
          setVariable(r.metadata.variable);
          const desired = Number(initialParams.get('init'));

          const index =
            initialParams.has('init') &&
            Number.isInteger(desired) &&
            desired >= 0 &&
            desired < r.metadata.initializations.length
              ? desired
              : (r.metadata.complete.at(-1) ?? r.metadata.initializations.length - 1);

          setInit(index);
          try {
            const region = initialRegion(r.metadata, requestedExtent);
            setExtent(region);
            setRunNotice('');
            load(
              r.metadata,
              r.metadata.variable,
              index,
              region,
              false,
              initialParams.has('init') ? 0 : 3,
            );
          } catch (error) {
            setError((error as Error).message);
            setBusy(false);
          }
        }
      });
    },
    [load],
  );

  const [catalog, setCatalog] = useState<{ title: string; choices: CatalogChoice[] } | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  /** The first open runs behind the landing loader, not the dataset dialog. */
  const [booting, setBooting] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const catalogRequest = useRef(0);

  const open = useCallback(
    async (options: OpenRequest, requestedExtent: Extent = DEFAULT_EXTENT) => {
      const request = ++catalogRequest.current;
      setCatalogLoading(true);
      setCatalogError('');
      setCatalog(null);
      try {
        if (!options.url)
          throw Error('Set VITE_DYNAMICAL_CATALOG_URL to enable the dataset catalog.');
        const result = await readCatalog(options.url);
        if (request !== catalogRequest.current) return;
        setCatalogLoading(false);
        setBooting(false);
        if (result)
          setCatalog({
            ...result,
            choices: result.choices.filter((choice) => isAvailableForecast(choice.url)),
          });
        else
          openStore(
            options,
            isSnowfallExample(options.url) && requestedExtent === DEFAULT_EXTENT
              ? snowfallExample.extent
              : requestedExtent,
          );
      } catch (error) {
        if (request !== catalogRequest.current) return;
        setCatalogLoading(false);
        setBooting(false);
        setCatalogError((error as Error).message);
      }
    },
    [openStore],
  );

  useEffect(() => {
    if (initialParams.has('dataset'))
      open({ url, variable: initialParams.get('variable') || undefined }, initialExtent);
    else if (STORY_DATASET) open({ url: STORY_DATASET }, initialExtent);
    else setBooting(false);

    return () => {
      catalogRequest.current++;
      client.current?.dispose();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCommands((v) => !v);
      }

      if (e.key === 'Escape') setPlaying(false);
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    // The tunnel flies continuously and reports its own steps.
    if (!playing || !volume || viewMode === 'tunnel') return;

    const timer = setInterval(
      () => setSlices((s) => [s[0], s[1], (s[2] + 1) % volume.shape[0]]),
      175,
    );

    return () => clearInterval(timer);
  }, [playing, volume, viewMode]);

  useEffect(() => {
    if (!volume) return;

    const params = new URLSearchParams({
      view: '2',
      dataset: url,
      variable,
      init: String(init),
      extent: JSON.stringify(extent),
      slices: JSON.stringify(slices),
    });

    history.replaceState(null, '', '?' + params);
    if (warmStart.current !== null) {
      const started = warmStart.current;

      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          times.current.push(performance.now() - started);
          times.current = times.current.slice(-200);
          const sorted = [...times.current].sort((a, b) => a - b);
          setWarmStats({ count: sorted.length, p95: sorted[Math.floor(sorted.length * 0.95)] });
        }),
      );

      warmStart.current = null;
    }
  }, [slices, volume, url, variable, init, extent]);

  useEffect(() => {
    let id = 0,
      last = performance.now();

    const tick = (now: number) => {
      if (now - last > 50) stalls.current++;
      last = now;
      id = requestAnimationFrame(tick);
    };

    id = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    if (diagnostics && client.current)
      client.current.request({ type: 'stats' }, (r) => {
        if (r.type === 'stats') setMetrics(r.metrics);
      });
  }, [diagnostics]);

  const updateSlices = (v: [number, number, number]) => {
    warmStart.current = performance.now();
    setSlices(v);
  };

  const resetCube = () => {
    setPlaying(false);
    if (volume) updateSlices([volume.shape[2] - 1, 0, volume.shape[0] - 1]);
    setReset((n) => n + 1);
  };

  const changeSlice = (axis: number, value: number) => {
    const s = [...slicesRef.current] as [number, number, number];
    s[axis] = value;
    updateSlices(s);
  };

  const initializationOptions = useMemo(
    () =>
      meta
        ? [...meta.initializations.keys()]
            .reverse()
            .map((i) => ({ value: i, label: dateLabel(meta.initializations[i], meta.initUnits) }))
        : [],
    [meta?.initializations, meta?.initUnits],
  );

  /** An applied SQL filter draws only matching cells; say why the cube is empty. */
  const filterNotice =
    !(section === 'persistent' || section === 'sql') || !analysis.matches
      ? ''
      : analysis.error
        ? `The SQL filter failed, so no cells are drawn: ${analysis.error}`
        : analysis.status || analysis.runtime?.volume !== displayVolume
          ? 'Applying the SQL filter to this view…'
          : analysis.matches.count === 0
            ? 'No cells match the SQL filter in this view, so the cube is empty.'
            : '';

  const plotted = useMemo(
    () =>
      displayVolume
        ? selectedForecasts.map((p) => {
            const { x, y } = anchoredCell(p, displayVolume);

            return { ...p, plume: memberSeries(displayVolume, display, normals.normals, x, y) };
          })
        : [],
    [selectedForecasts, displayVolume, display, normals.normals],
  );

  // ---- Story views -------------------------------------------------------------------
  const split = useMemo(
    () => (section === 'members' && volume?.ensemble ? memberSplit(volume, slices[2]) : null),
    [section, volume, slices[2]],
  );
  const memberVolume = useMemo<DisplayVolume | null>(
    () =>
      split && volume
        ? {
            ...split.volume,
            quantity: {
              label: `Each run minus the ensemble mean at ${timeLabel(volume.times[slices[2]], volume.timeUnits)}`,
              units: pretty(volume.units),
              kind: 'anomaly',
            },
            sourceUnits: pretty(volume.units),
            columns: {},
          }
        : null,
    [split, volume],
  );
  const memberRange = useMemo<[number, number]>(() => {
    if (!split) return [-1, 1];
    const limit = valueRange(
      0,
      Math.max(Math.abs(split.volume.min), Math.abs(split.volume.max)),
    )[1];

    return [-limit, limit];
  }, [split]);

  const clockMeans = useMemo(
    () => (section === 'clock' && displayVolume ? regionalMeans(displayVolume) : null),
    [section, displayVolume],
  );
  const clock = useMemo<ClockSpec | null>(
    () =>
      clockMeans && displayVolume
        ? {
            values: clockMeans,
            current: slices[2],
            range,
            palette,
            format: (v) =>
              displayVolume.quantity.kind === 'share'
                ? `${Math.round(v * 100)} %`
                : `${formatValue(v)} ${displayVolume.quantity.units}`,
          }
        : null,
    [clockMeans, displayVolume, slices[2], range, palette],
  );

  const [places, setPlaces] = useState<Place[]>([]);
  useEffect(() => {
    loadPlaces()
      .then(setPlaces)
      .catch(() => setPlaces([]));
  }, []);
  const horizon = useMemo(
    () => (isTrust && volume?.ensemble ? reliableHorizon(volume, trustThreshold) : null),
    [isTrust, volume, trustThreshold],
  );
  const spreadMean = useMemo(
    () => (isTrust && volume?.ensemble ? meanSpread(volume) : null),
    [isTrust, volume],
  );
  const trust = useMemo(() => {
    if (!horizon || !volume) return null;
    const [nt, ny, nx] = volume.shape;
    const lo = Math.min(volume.lat[0], volume.lat.at(-1)!),
      hi = Math.max(volume.lat[0], volume.lat.at(-1)!);
    const west = volume.lon[0],
      east = west + ((volume.lon.at(-1)! - west + 360) % 360);
    const ranked = certainPlaces(
      placesInRegion(places, [west, lo, east, hi]),
      volume,
      horizon,
      placeCount,
      spreadMean,
    );
    const hours = volume.times.map((v) => timeValue(v, volume.timeUnits));
    const mask = new Uint8Array(nt * ny * nx);
    for (let t = 0; t < nt; t++)
      for (let i = 0; i < ny * nx; i++) if (hours[t] <= horizon[i]) mask[t * ny * nx + i] = 255;
    const rows = rowAreas(volume.lat, volume.lon);
    let total = 0,
      fiveDays = 0;
    const sorted: number[] = [];
    for (let i = 0; i < ny * nx; i++) {
      const a = Number.isFinite(rows[Math.floor(i / nx)]) ? rows[Math.floor(i / nx)] : 1;
      if (!Number.isFinite(volume.data[i])) continue;
      total += a;
      const h = Number.isFinite(horizon[i]) ? horizon[i] : -1;
      if (h >= 120) fiveDays += a;
      sorted.push(h);
    }
    sorted.sort((a, b) => a - b);

    return {
      ranked,
      mask,
      median: sorted[Math.floor(sorted.length / 2)] ?? NaN,
      fiveDayShare: total ? fiveDays / total : NaN,
    };
  }, [horizon, volume, places, placeCount, spreadMean]);
  const beams = useMemo<Beam[]>(
    () =>
      trust?.ranked.map((p) => ({
        x: p.x,
        y: p.y,
        hours: p.hours,
        label: `${p.name} +${p.hours} h`,
      })) ?? [],
    [trust],
  );

  const enableAnalysis = useCallback(() => setAnalysisEnabled(true), []);

  const needsEnsemble = (
    <div className="story-needs">
      <p>This question needs an ensemble: the same forecast run many times.</p>
      <Button variant="primary" onClick={() => open({ url: STORY_DATASET })}>
        Open the NOAA GEFS ensemble
      </Button>
    </div>
  );

  const layerStats = useMemo(() => {
    if (!displayVolume) return null;
    const [, ny, nx] = displayVolume.shape;
    let lo = Infinity,
      hi = -Infinity;
    for (let i = 0; i < ny * nx; i++) {
      const v = displayVolume.data[slices[2] * ny * nx + i];
      if (Number.isFinite(v)) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    const u = displayVolume.quantity.units;

    return {
      when: timeLabel(displayVolume.times[slices[2]], displayVolume.timeUnits),
      range: Number.isFinite(lo) ? `${formatValue(lo)} … ${formatValue(hi)} ${u}` : '—',
    };
  }, [displayVolume, slices[2]]);

  const agreement = useMemo(() => {
    const u = displayVolume?.uncertainty;
    if (!u || !displayVolume) return null;
    const [, ny, nx] = displayVolume.shape;
    const rows = rowAreas(displayVolume.lat, displayVolume.lon);
    let total = 0,
      agree = 0;
    for (let i = 0; i < ny * nx; i++) {
      const s = u[slices[2] * ny * nx + i];
      if (!Number.isFinite(s)) continue;
      const a = Number.isFinite(rows[Math.floor(i / nx)]) ? rows[Math.floor(i / nx)] : 1;
      total += a;
      if (s < uncertaintyScale / 3) agree += a;
    }

    return {
      share: total ? `${Math.round((agree / total) * 100)} %` : '—',
      when: timeLabel(displayVolume.times[slices[2]], displayVolume.timeUnits),
    };
  }, [displayVolume, slices[2], uncertaintyScale]);

  /** Beams through the places where the found event lasts longest; they follow the filter. */
  const eventBeams = useMemo<Beam[]>(() => {
    const mask = analysis.matches?.mask;
    if (section !== 'persistent' || !mask || !analysis.matches?.count || !displayVolume) return [];
    const v = displayVolume;
    const nearestPlace = (x: number, y: number) => {
      let best: Place | null = null,
        distance = Infinity;
      for (const p of places) {
        const d = Math.hypot(((p.lon - v.lon[x] + 540) % 360) - 180, p.lat - v.lat[y]);
        if (d < distance) {
          distance = d;
          best = p;
        }
      }
      const step = Math.abs(v.lat[1] - v.lat[0]) || 0.25;

      return best && distance <= step * 3 ? best.name : null;
    };

    return eventSites(v, mask, 4, Math.max(6, Math.round(v.shape[2] / 3.5))).map((site) => ({
      x: site.x,
      y: site.y,
      from: site.from,
      hours: site.to,
      label: `${nearestPlace(site.x, site.y) ?? `${v.lat[site.y].toFixed(1)}°, ${v.lon[site.x].toFixed(1)}°`} · ${site.hours >= 48 ? `${formatValue(site.hours / 24)} d` : `${site.hours} h`}`,
    }));
  }, [section, analysis.matches, displayVolume, places]);

  /** The flat radial view answers the same question as the cube for every section. */
  const radial = useMemo(
    () =>
      viewMode === 'radial' && volume && displayVolume
        ? radialSpec({
            section,
            certaintyView,
            volume,
            display: displayVolume,
            t: Math.min(slices[2], displayVolume.shape[0] - 1),
            palette,
            range,
            memberRange,
            uncertainty: {
              mode:
                display.statistic === 'mean' || display.statistic === 'median'
                  ? uncertaintyMode
                  : 'off',
              scale: uncertaintyScale,
            },
            normals: normals.current ? normals.normals : null,
            reference: normalReference,
            horizon,
            mask: analysis.matches?.mask ?? null,
            muted: theme === 'dark' ? [0.16, 0.18, 0.21] : [0.86, 0.88, 0.9],
            arrangement,
            eventRule: analysis.matches ? eventRule : null,
          })
        : null,
    [
      viewMode,
      volume,
      displayVolume,
      section,
      certaintyView,
      slices[2],
      palette,
      range,
      memberRange,
      display.statistic,
      uncertaintyMode,
      uncertaintyScale,
      normals.current,
      normals.normals,
      normalReference,
      horizon,
      analysis.matches,
      theme,
      arrangement,
      eventRule,
    ],
  );

  useEffect(() => setPendingExtent(null), [extent, regionFailure]);
  /** Move to a new region from the location widget (both views). */
  const moveTo = (next: Extent) => {
    if (!meta) return;
    try {
      setPendingExtent(squareExtent(next));
    } catch {
      setPendingExtent(null);
    }
    load(meta, variable, init, next, true);
  };
  const blocks = message.match(/Loaded (\d+) of (\d+)/);
  const locationStatus = regionFailure
    ? regionFailure.message
    : pendingExtent && busy
      ? blocks
        ? `Loading new region · ${blocks[1]} of ${blocks[2]} blocks`
        : 'Loading new region…'
      : '';
  /** Valid times of every step, for dates in the tunnel. */
  const tunnelTimes = useMemo(() => {
    if (!meta || !volume) return null;
    try {
      return stepTimes(meta, volume);
    } catch {
      return null;
    }
  }, [meta, volume]);
  /** Where the playhead sits along the timeline, 0–1. */
  const playheadFraction = volume
    ? (volume.times[slices[2]] - volume.times[0]) /
      Math.max(1e-9, volume.times.at(-1)! - volume.times[0])
    : 0;
  /** The date at the playhead, shown above the timeline marker while playing. */
  const playheadDate = (() => {
    const at = tunnelTimes?.[slices[2]];
    if (at === undefined || !volume)
      return volume ? timeLabel(volume.times[slices[2]], volume.timeUnits) : '';

    return `${new Date(at * 1000).toLocaleString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    })} UTC`;
  })();
  /** Pinned points, as cells of the loaded region, for the flat view. */
  const radialPins = useMemo(
    () =>
      displayVolume
        ? selectedForecasts.map((p) => ({ ...anchoredCell(p, displayVolume), color: p.color }))
        : [],
    [selectedForecasts, displayVolume],
  );

  const showsSelection = section === 'persistent' || section === 'sql';
  const cubeMask = isTrust
    ? (trust?.mask ?? null)
    : showsSelection
      ? (analysis.matches?.mask ?? null)
      : null;
  const cubeVolume = memberVolume ?? displayVolume;

  const selectedCells = useMemo(
    () =>
      volume
        ? selectedForecasts.flatMap((p) => {
            const cell = anchoredCell(p, volume);

            return cell
              ? [{ ...cell, t: slices[2], value: NaN, color: p.color, id: p.id, anchor: p.anchor }]
              : [];
          })
        : [],
    [volume, selectedForecasts, slices[2]],
  );

  const prepareTour = useCallback(
    (open: boolean) => {
      setSidebar(open);
      if (open) sidebarPanel.current?.expand();
      else sidebarPanel.current?.collapse();
    },
    [sidebarPanel],
  );

  const toggleSidebar = () => {
    if (narrow) {
      setSidebar((v) => !v);

      return;
    }

    if (sidebarPanel.current?.isCollapsed()) sidebarPanel.current.expand();
    else sidebarPanel.current?.collapse();
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="app-shell">
        {!meta && (
          <header className="app-bar">
            <div className="header-identity">
              <a href="/" className="brand" aria-label="zarr-sql-views home">
                <span>3D Forecast</span>
              </a>
            </div>
            <div className="bar-actions">
              <Tip label={theme === 'dark' ? 'Use the light theme' : 'Use the dark theme'}>
                <Button
                  variant="ghost"
                  className="icon"
                  aria-label={theme === 'dark' ? 'Use the light theme' : 'Use the dark theme'}
                  aria-pressed={theme === 'dark'}
                  onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
                >
                  {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
                </Button>
              </Tip>
              <Button variant="ghost" onClick={() => open({ url: AIFS })}>
                <FolderOpen size={15} />
                <span>Open dataset</span>
              </Button>
            </div>
          </header>
        )}
        <OnboardingTour ready={!!volume && !busy} prepare={prepareTour} />
        {(busy || (booting && catalogLoading)) && !volume && (
          <div className="dataset-loading-overlay">
            <div className="loading-state" role="status">
              <CubeLoader size={104} />
              <div className="loading-caption">
                <span>{meta ? 'Loading the forecast' : 'Connecting to the dataset'}</span>
                <Button
                  variant="ghost"
                  className="icon"
                  aria-label="Cancel loading"
                  onClick={() => {
                    cancel.current?.();
                    setBusy(false);
                    setMessage('');
                  }}
                >
                  <X size={14} />
                </Button>
              </div>
              <progress
                aria-label="Dataset loading progress"
                max={1}
                value={
                  /Loaded (\d+) of (\d+)/.test(message)
                    ? Number(message.match(/Loaded (\d+) of (\d+)/)![1]) /
                      Number(message.match(/Loaded (\d+) of (\d+)/)![2])
                    : undefined
                }
              />
              <small className="loading-step">{message}</small>
            </div>
          </div>
        )}
        <div className="workspace" inert={busy && !volume} aria-busy={busy && !volume}>
          {meta && (
            <nav className="control-rail" aria-label="View controls">
              <Tip label={sidebar ? 'Collapse controls' : 'Expand controls'}>
                <Button
                  className="icon"
                  variant="ghost"
                  aria-label={sidebar ? 'Collapse controls' : 'Expand controls'}
                  aria-expanded={sidebar}
                  onClick={toggleSidebar}
                >
                  <PanelLeft size={19} />
                </Button>
              </Tip>
              <StoryTicks active={section} onJump={jumpTo} />
            </nav>
          )}
          <Group orientation="horizontal" className="workbench">
            {meta && (
              <Panel
                className={`sidebar-panel ${sidebar ? 'expanded' : ''}`}
                panelRef={sidebarPanel}
                collapsible
                collapsedSize="0px"
                defaultSize="380px"
                minSize="320px"
                maxSize="460px"
                onResize={(size) => {
                  if (!narrow) setSidebar(size.inPixels > 0);
                }}
              >
                <aside className="sidebar" inert={!sidebar} aria-hidden={!sidebar}>
                  <StoryPanel
                    active={section}
                    onActive={setSection}
                    jump={jump}
                    topbar={
                      <>
                        <p className="story-brand">3D Forecast</p>
                        <div className="story-actions">
                          <Tip
                            label={theme === 'dark' ? 'Use the light theme' : 'Use the dark theme'}
                          >
                            <Button
                              variant="ghost"
                              className="icon"
                              aria-label={
                                theme === 'dark' ? 'Use the light theme' : 'Use the dark theme'
                              }
                              aria-pressed={theme === 'dark'}
                              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
                            >
                              {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
                            </Button>
                          </Tip>
                          {PATTERN_THEME && (
                            <Tip
                              label={patterned ? 'Use colours' : 'Use patterns instead of colours'}
                            >
                              <Button
                                variant="ghost"
                                className="icon"
                                aria-label={
                                  patterned ? 'Use colours' : 'Use patterns instead of colours'
                                }
                                aria-pressed={patterned}
                                onClick={() =>
                                  setTheme((t) => (t === 'pattern' ? 'light' : 'pattern'))
                                }
                              >
                                <Hash size={15} />
                              </Button>
                            </Tip>
                          )}
                          <Button variant="ghost" onClick={() => open({ url: AIFS })}>
                            <FolderOpen size={15} />
                            <span>Open dataset</span>
                          </Button>
                        </div>
                      </>
                    }
                    header={
                      <>
                        <h1>{meta?.title ?? 'Loading forecast…'}</h1>
                        <p className="story-lede">
                          Scroll through the questions. Each one turns the cube into the view that
                          answers it, with its own controls.
                        </p>
                      </>
                    }
                    footer={
                      <div className="story-footer">
                        <Button variant="ghost" onClick={() => setDiagnostics(true)}>
                          Dataset details
                        </Button>
                      </div>
                    }
                  >
                    {{
                      forecast: (
                        <>
                          <div className="control-section dataset-controls">
                            {meta && !meta.axes.init && !isWinterTime(meta.timeUnits) && (
                              <p className="analysis-window-note">
                                Most recent {meta.times.length} time samples
                              </p>
                            )}
                            <label htmlFor="data-variable">Variable</label>
                            <select
                              id="data-variable"
                              value={variable}
                              disabled={!meta || busy}
                              onChange={(e) => {
                                setVariable(e.target.value);
                                if (meta) {
                                  if (isSnowfallExample(meta.url))
                                    openStore({ url: meta.url, variable: e.target.value }, extent);
                                  else load(meta, e.target.value, init, extent);
                                }
                              }}
                            >
                              {meta?.variables.map((v) => (
                                <option
                                  key={v.name}
                                  value={v.name}
                                  disabled={!!v.disabledReason}
                                  title={v.disabledReason}
                                >
                                  {v.label}
                                </option>
                              ))}
                            </select>
                            {meta?.axes.init && (
                              <>
                                <label htmlFor="initialization">Forecast run</label>
                                <RunPicker
                                  options={initializationOptions}
                                  value={init}
                                  disabled={!meta || busy}
                                  onChange={(i) => {
                                    setRunNotice('');
                                    setInit(i);
                                    if (meta) load(meta, variable, i, extent);
                                  }}
                                />
                              </>
                            )}
                            {runNotice && <p className="field-note run-note">{runNotice}</p>}
                            {volume?.note && <p className="field-note run-note">{volume.note}</p>}
                          </div>
                          {displayVolume ? (
                            <div className="control-section">
                              {' '}
                              <div className="legend">
                                <div>
                                  <span>
                                    Color scale
                                    <small className="legend-quantity">
                                      {displayVolume.quantity.label}
                                    </small>
                                  </span>
                                  <Popover
                                    trigger={
                                      <Button
                                        variant="ghost"
                                        className="icon"
                                        aria-label="Color settings"
                                      >
                                        <Settings2 size={14} />
                                      </Button>
                                    }
                                  >
                                    <label>
                                      Color palette
                                      <select
                                        aria-label="Color palette"
                                        value={palette}
                                        onChange={(e) => {
                                          const next = e.target.value as Palette;
                                          setPalette(next);
                                          if (next === 'snowfall') {
                                            const limit = Math.max(
                                              Math.abs(range[0]),
                                              Math.abs(range[1]),
                                            );

                                            setRange([-limit, limit]);
                                          }
                                        }}
                                      >
                                        <option value="snowfall">
                                          Snowfall anomaly (brown–white–blue)
                                        </option>
                                        <option value="balance">Diverging (blue–white–red)</option>
                                        <option value="viridis">Viridis</option>
                                        <option value="thermal">Thermal</option>
                                        <option value="ocean">Ocean</option>
                                        <option value="ember">Ember</option>
                                      </select>
                                    </label>
                                    <div className="range-fields">
                                      <label>
                                        Minimum
                                        <input
                                          aria-label="Color minimum"
                                          type="number"
                                          value={range[0]}
                                          step="any"
                                          onChange={(e) => {
                                            const n = Number(e.target.value);
                                            if (palette === 'snowfall') {
                                              if (n < 0) setRange([n, -n]);
                                            } else if (n < range[1]) setRange([n, range[1]]);
                                          }}
                                        />
                                      </label>
                                      <label>
                                        Maximum
                                        <input
                                          aria-label="Color maximum"
                                          type="number"
                                          value={range[1]}
                                          step="any"
                                          onChange={(e) => {
                                            const n = Number(e.target.value);
                                            if (palette === 'snowfall') {
                                              if (n > 0) setRange([-n, n]);
                                            } else if (n > range[0]) setRange([range[0], n]);
                                          }}
                                        />
                                      </label>
                                    </div>
                                  </Popover>
                                </div>
                                <div
                                  className="color-bar"
                                  style={
                                    patterned
                                      ? {
                                          background: `url(${patternLegend()}) left / 100% 100% no-repeat`,
                                        }
                                      : { background: gradient(palette) }
                                  }
                                />
                                <div className="legend-numbers">
                                  <span>
                                    {displayVolume.min < range[0] ? '≤ ' : ''}
                                    {legendValue(range[0], displayVolume.quantity.kind)}{' '}
                                    {legendUnits(displayVolume.quantity)}
                                  </span>
                                  <span>
                                    {legendValue(
                                      (range[0] + range[1]) / 2,
                                      displayVolume.quantity.kind,
                                    )}
                                  </span>
                                  <span>
                                    {displayVolume.max > range[1] ? '≥ ' : ''}
                                    {legendValue(range[1], displayVolume.quantity.kind)}{' '}
                                    {legendUnits(displayVolume.quantity)}
                                  </span>
                                </div>
                              </div>
                            </div>
                          ) : null}
                          {layerStats && (
                            <Figures
                              items={[
                                [layerStats.when, 'Top layer'],
                                [layerStats.range, 'Lowest to highest in view'],
                              ]}
                            />
                          )}
                        </>
                      ),
                      certainty: volume?.ensemble ? (
                        <>
                          <div
                            className="segmented two"
                            role="radiogroup"
                            aria-label="Certainty view"
                          >
                            {(
                              [
                                ['disagreement', 'Disagreement'],
                                ['trust', 'Trust horizon'],
                              ] as const
                            ).map(([value, label]) => (
                              <button
                                key={value}
                                role="radio"
                                aria-checked={certaintyView === value}
                                className={certaintyView === value ? 'selected' : ''}
                                onClick={() => setCertaintyView(value)}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                          {certaintyView === 'disagreement' && displayVolume ? (
                            <>
                              <EnsembleControls
                                volume={displayVolume}
                                display={display}
                                onDisplay={setDisplay}
                                mode={uncertaintyMode}
                                onMode={setUncertaintyMode}
                                scale={uncertaintyScale}
                                onScale={setUncertaintyScale}
                                palette={palette}
                                range={range}
                                normalsReady={false}
                              />
                              {agreement && (
                                <Figures
                                  items={[
                                    [agreement.share, 'of the region where runs agree now'],
                                    [agreement.when, 'Top layer'],
                                  ]}
                                />
                              )}
                            </>
                          ) : trust ? (
                            <>
                              <div className="inline-field">
                                <label htmlFor="trust-threshold">
                                  Trust while runs differ by less than
                                </label>
                                <input
                                  id="trust-threshold"
                                  type="number"
                                  min={0}
                                  step="any"
                                  value={trustThreshold}
                                  onChange={(e) => {
                                    const n = Number(e.target.value);
                                    if (Number.isFinite(n) && n > 0) setTrustThreshold(n);
                                  }}
                                />
                                <span className="threshold-units">{pretty(volume.units)}</span>
                              </div>
                              <Figures
                                items={[
                                  [
                                    Number.isFinite(trust.median) && trust.median >= 0
                                      ? `+${trust.median} h`
                                      : '—',
                                    'typical trust horizon',
                                  ],
                                  [
                                    Number.isFinite(trust.fiveDayShare)
                                      ? `${Math.round(trust.fiveDayShare * 100)} %`
                                      : '—',
                                    'of the area trustworthy for 5+ days',
                                  ],
                                ]}
                              />
                              <div className="story-list-heading">
                                <span>Most certain places</span>
                                <select
                                  aria-label="Number of places"
                                  value={placeCount}
                                  onChange={(e) => setPlaceCount(Number(e.target.value))}
                                >
                                  {[3, 6, 10, 15].map((n) => (
                                    <option key={n} value={n}>
                                      Top {n}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <ol className="story-ranking">
                                {trust.ranked.map((p) => (
                                  <li key={`${p.name}-${p.x}-${p.y}`}>
                                    <span>{p.name}</span>
                                    <b>+{p.hours} h</b>
                                  </li>
                                ))}
                                {!trust.ranked.length && (
                                  <li className="field-note">
                                    No named place stays below this spread.
                                  </li>
                                )}
                              </ol>
                              <p className="field-note">
                                Trust horizon = the last lead time before the runs’ standard
                                deviation first reaches the threshold. Beams rise to it; above it
                                the cube turns grey.
                              </p>
                            </>
                          ) : null}
                        </>
                      ) : (
                        needsEnsemble
                      ),
                      members:
                        split && volume ? (
                          <>
                            <p className="field-note">
                              Move the timeline to choose the moment. Layers are ranked by their
                              area-weighted difference from the average.
                            </p>
                            <div className="legend story-legend">
                              <div
                                className="color-bar"
                                style={
                                  patterned
                                    ? {
                                        background: `url(${patternLegend()}) left / 100% 100% no-repeat`,
                                      }
                                    : { background: gradient('balance') }
                                }
                              />
                              <div className="legend-numbers">
                                <span>
                                  {formatValue(memberRange[0])} {pretty(volume.units)}
                                </span>
                                <span>0 = average</span>
                                <span>+{formatValue(memberRange[1])}</span>
                              </div>
                            </div>
                            <Figures
                              items={[
                                [String(split.above), 'runs above average'],
                                [String(split.below), 'runs below average'],
                                [
                                  `${split.deviation.at(-1)! > 0 ? '+' : ''}${formatValue(split.deviation.at(-1)!)}`,
                                  `warmest run (member ${volume.ensemble!.labels[split.order.at(-1)!]})`,
                                ],
                                [
                                  formatValue(split.deviation[0]),
                                  `coldest run (member ${volume.ensemble!.labels[split.order[0]]})`,
                                ],
                              ]}
                            />
                          </>
                        ) : volume?.ensemble ? (
                          <p className="field-note">Scroll here to split the runs.</p>
                        ) : (
                          needsEnsemble
                        ),
                      normal:
                        displayVolume && meta ? (
                          <NormalsControls
                            handle={normals}
                            reference={normalReference}
                            onReference={setNormalReference}
                            units={displayVolume.sourceUnits}
                            canCompare={!!meta.axes.init && isComparableForecast(meta.url)}
                            unavailableReason="Normals are available for the GFS, GEFS and ECMWF IFS ENS forecasts, which share the 0.25° grid of the NOAA GEFS analysis archive."
                          />
                        ) : null,
                      persistent: displayVolume ? (
                        <>
                          {!normals.current && (
                            <p className="field-note">
                              Build normals in the previous section to search on anomalies too.
                            </p>
                          )}
                          <AnalysisControls
                            onRule={setEventRule}
                            part="events"
                            volume={displayVolume}
                            analysis={analysis}
                            slices={slices}
                            onReveal={updateSlices}
                            onEnable={enableAnalysis}
                            selectionStyle={selectionStyle}
                            onSelectionStyle={setSelectionStyle}
                          />
                        </>
                      ) : null,
                      clock:
                        clockMeans && displayVolume ? (
                          <Figures items={clockFigures(clockMeans, displayVolume, slices[2])} />
                        ) : null,
                      sql: displayVolume ? (
                        <AnalysisControls
                          part="sql"
                          volume={displayVolume}
                          analysis={analysis}
                          slices={slices}
                          onReveal={updateSlices}
                          onEnable={enableAnalysis}
                          selectionStyle={selectionStyle}
                          onSelectionStyle={setSelectionStyle}
                        />
                      ) : null,
                    }}
                  </StoryPanel>
                </aside>
              </Panel>
            )}
            {meta && <Separator className="sidebar-resizer" />}
            <Panel minSize="150px">
              <main className="main-view">
                {displayVolume ? (
                  <Group orientation="vertical" className="viewer-panels">
                    <Panel defaultSize={linked ? '70%' : '100%'} minSize="35%">
                      <div className="visualization">
                        {meta && (
                          <RegionPicker
                            extent={extent}
                            onMove={moveTo}
                            pending={pendingExtent}
                            status={locationStatus}
                          />
                        )}
                        {pendingExtent && busy && (
                          <div className="region-loading" role="status">
                            <div className="loading-state">
                              <CubeLoader size={72} />
                              <div className="loading-caption">
                                <span>Loading the new region</span>
                                <Button
                                  variant="ghost"
                                  className="icon"
                                  aria-label="Cancel loading"
                                  onClick={() => {
                                    cancel.current?.();
                                    setBusy(false);
                                    setPendingExtent(null);
                                    setMessage('');
                                  }}
                                >
                                  <X size={14} />
                                </Button>
                              </div>
                              <progress
                                aria-label="Region loading progress"
                                max={1}
                                value={blocks ? Number(blocks[1]) / Number(blocks[2]) : undefined}
                              />
                              <small className="loading-step">{message}</small>
                            </div>
                          </div>
                        )}
                        {filterNotice && (
                          <div className="filter-notice" role="status">
                            <p>{filterNotice}</p>
                            {!analysis.status && (
                              <Button onClick={() => applySQL(analysis.state, null)}>
                                Clear SQL filter
                              </Button>
                            )}
                          </div>
                        )}
                        {viewMode === 'tunnel' && volume && displayVolume ? (
                          <>
                            <CubeToolbar
                              view="tunnel"
                              onView={setViewMode}
                              mode="orbit"
                              onMode={() => {}}
                              onReset={() => {}}
                              onZoom={() => {}}
                              zoom={0}
                              showLabels={false}
                              onLabels={() => {}}
                              showRelief={false}
                              reliefMenu={null}
                            />
                            <Suspense
                              fallback={
                                <div className="region-loading" role="status">
                                  <div className="loading-state">
                                    <CubeLoader size={64} />
                                    <div className="loading-caption">
                                      <span>Opening the tunnel</span>
                                    </div>
                                  </div>
                                </div>
                              }
                            >
                              <TunnelView
                                section={section}
                                forecast={volume}
                                volume={displayVolume}
                                uncertainty={
                                  ((section === 'certainty' && !isTrust) || section === 'normal') &&
                                  (display.statistic === 'mean' || display.statistic === 'median')
                                    ? { mode: uncertaintyMode, scale: uncertaintyScale }
                                    : null
                                }
                                mask={cubeMask}
                                maskLabel={
                                  isTrust
                                    ? 'still within the trust horizon'
                                    : section === 'sql'
                                      ? 'matching the SQL filter'
                                      : 'in the event'
                                }
                                muted={theme === 'dark' ? [0.16, 0.18, 0.21] : [0.86, 0.88, 0.9]}
                                validTimes={tunnelTimes}
                                pattern={patterned}
                                palette={palette}
                                range={range}
                                index={Math.min(slices[2], displayVolume.shape[0] - 1)}
                                onIndex={(i) => changeSlice(2, i)}
                                playing={playing}
                                onPlaying={setPlaying}
                                pins={radialPins}
                                onPick={(x, y) => {
                                  setSelectedForecasts((previous) =>
                                    addForecastPoint(previous, displayVolume, x, y),
                                  );
                                  setLinked(true);
                                }}
                              />
                            </Suspense>
                          </>
                        ) : viewMode === 'radial' && radial ? (
                          <>
                            <CubeToolbar
                              view="radial"
                              onView={setViewMode}
                              mode="orbit"
                              onMode={() => {}}
                              onReset={() => {}}
                              onZoom={() => {}}
                              zoom={0}
                              showLabels={false}
                              onLabels={() => {}}
                              showRelief={false}
                              reliefMenu={null}
                            />
                            <RadialView
                              pattern={patterned}
                              spec={radial}
                              pulse={`${section}|${certaintyView}`}
                              pins={radialPins}
                              onPick={(x, y) => {
                                if (!displayVolume) return;
                                setSelectedForecasts((previous) =>
                                  addForecastPoint(previous, displayVolume, x, y),
                                );
                                setLinked(true);
                              }}
                            />
                            <div
                              className="segmented two radial-arrangement"
                              role="radiogroup"
                              aria-label="How each run is drawn"
                            >
                              {(
                                [
                                  ['map', 'Maps', 'Each run as a map of the region'],
                                  [
                                    'mix',
                                    'Colour mix',
                                    'Each run’s colours sorted from coldest to warmest, each taking its share of the area',
                                  ],
                                ] as const
                              ).map(([value, label, title]) => (
                                <button
                                  key={value}
                                  role="radio"
                                  title={title}
                                  aria-checked={arrangement === value}
                                  className={arrangement === value ? 'selected' : ''}
                                  onClick={() => setArrangement(value)}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                          </>
                        ) : (
                          <Cube
                            selectionMask={cubeMask}
                            selectionStyle={isTrust ? 'paint' : selectionStyle}
                            clock={clock}
                            theme={theme}
                            pattern={patterned}
                            pulse={`${section}|${certaintyView}`}
                            view={viewMode}
                            onView={setViewMode}
                            beams={isTrust ? beams : section === 'persistent' ? eventBeams : []}
                            volume={cubeVolume!}
                            uncertaintyMode={
                              (section === 'certainty' || section === 'normal') &&
                              (display.statistic === 'mean' || display.statistic === 'median')
                                ? uncertaintyMode
                                : 'off'
                            }
                            uncertaintyScale={uncertaintyScale}
                            normals={normals.current ? normals.normals : null}
                            points={selectedCells}
                            slices={
                              memberVolume
                                ? [slices[0], slices[1], memberVolume.shape[0] - 1]
                                : slices
                            }
                            onSlices={(v) =>
                              memberVolume ? updateSlices([v[0], v[1], slices[2]]) : updateSlices(v)
                            }
                            onSliceStart={(axis) => {
                              if (axis === 2) setPlaying(false);
                            }}
                            range={memberVolume ? memberRange : range}
                            palette={memberVolume ? 'balance' : palette}
                            reset={reset}
                            onReset={resetCube}
                            onPoint={(p) => {
                              setSelectedForecasts((previous) =>
                                addForecastPoint(previous, displayVolume, p.x, p.y),
                              );
                              setLinked(true);
                              if (!memberVolume) changeSlice(2, p.t);
                            }}
                            onError={renderError}
                            onReady={markReady}
                            loading={busy}
                            loadError={error}
                            regionFailure={regionFailure}
                            latitudeBounds={[
                              Math.min(...(meta?.lat || [-90])),
                              Math.max(...(meta?.lat || [90])),
                            ]}
                            onRegion={(next) => {
                              if (meta) load(meta, variable, init, next, true);
                            }}
                            minimap={false}
                          />
                        )}
                      </div>
                    </Panel>
                    {linked ? (
                      <>
                        <Separator className="panel-separator" />
                        <Panel defaultSize="30%" minSize="23%" maxSize="48%">
                          <TimeSeries
                            volume={displayVolume}
                            forecasts={plotted}
                            units={
                              displayVolume.quantity.kind === 'share'
                                ? 'share of members (0–1)'
                                : displayVolume.quantity.units
                            }
                            onRemove={(id) => {
                              setSelectedForecasts((previous) =>
                                previous.filter((p) => p.id !== id),
                              );
                              if (selectedForecasts.length === 1) setLinked(false);
                            }}
                            time={slices[2]}
                            onTime={(v) => changeSlice(2, v)}
                          />
                        </Panel>
                      </>
                    ) : null}
                  </Group>
                ) : (
                  <div className="empty-stage">
                    {busy ? null : error ? (
                      <div className="error-state" role="alert">
                        <AlertCircle size={30} />
                        <h2>Unable to load dataset</h2>
                        <p>{error}</p>
                        <div>
                          {regularDataset(url) && (
                            <Button
                              variant="primary"
                              onClick={() => open({ url: regularDataset(url)!.url })}
                            >
                              Open {regularDataset(url)!.title}
                            </Button>
                          )}
                          <Button
                            onClick={() =>
                              meta
                                ? load(meta, variable, init, extent)
                                : open({ url, variable }, extent)
                            }
                          >
                            Retry
                          </Button>
                          <Button variant="primary" onClick={() => open({ url: AIFS })}>
                            Open another dataset
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="welcome">
                        <h2>Explore a data cube</h2>
                        <Button
                          variant="primary"
                          className="example-button"
                          onClick={() => open({ url: AIFS })}
                        >
                          Browse datasets
                        </Button>
                        <button className="open-own" onClick={() => open({ url: AIFS })}>
                          <Plus size={14} />
                          Open another dataset
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {volume ? (
                  <div className="transport">
                    <Button
                      className="icon play"
                      variant="ghost"
                      aria-label={
                        playing
                          ? 'Pause playback'
                          : meta?.axes.init
                            ? 'Play forecast'
                            : 'Play timeline'
                      }
                      onClick={() => setPlaying((v) => !v)}
                    >
                      {playing ? <Pause size={15} /> : <Play size={15} />}
                    </Button>
                    <Button
                      className="icon step"
                      variant="ghost"
                      aria-label="Previous forecast time"
                      disabled={slices[2] <= 0}
                      onClick={() => {
                        setPlaying(false);
                        changeSlice(2, Math.max(0, slices[2] - 1));
                      }}
                    >
                      <SkipBack size={14} />
                    </Button>
                    <Button
                      className="icon step"
                      variant="ghost"
                      aria-label="Next forecast time"
                      disabled={slices[2] >= volume.times.length - 1}
                      onClick={() => {
                        setPlaying(false);
                        changeSlice(2, Math.min(volume.times.length - 1, slices[2] + 1));
                      }}
                    >
                      <SkipForward size={14} />
                    </Button>
                    <span className="lead-label">
                      {timeLabel(volume.times[slices[2]], volume.timeUnits)}
                    </span>
                    <div className="transport-track">
                      <Slider
                        label={
                          isWinterTime(volume.timeUnits) ? 'Winter playback' : 'Forecast playback'
                        }
                        value={volume.times[slices[2]] - volume.times[0]}
                        max={volume.times.at(-1)! - volume.times[0]}
                        step={0.001}
                        onStep={(direction) =>
                          changeSlice(
                            2,
                            Math.max(0, Math.min(volume.times.length - 1, slices[2] + direction)),
                          )
                        }
                        onChange={(v) => {
                          const target = volume.times[0] + v;
                          let closest = 0;

                          volume.times.forEach((t, i) => {
                            if (Math.abs(t - target) < Math.abs(volume.times[closest] - target))
                              closest = i;
                          });

                          changeSlice(2, closest);
                        }}
                      />
                      {playing && (
                        <span
                          className="playhead-tooltip"
                          role="status"
                          style={
                            {
                              left: `${playheadFraction * 100}%`,
                              '--f': playheadFraction,
                            } as React.CSSProperties
                          }
                        >
                          {playheadDate}
                        </span>
                      )}
                    </div>
                    <span className="end-label">
                      {timeLabel(volume.times.at(-1)!, volume.timeUnits)}
                    </span>
                  </div>
                ) : null}
              </main>
            </Panel>
          </Group>
        </div>

        {error && volume ? (
          <div className="render-error" role="alert">
            Rendering error: {error}
            <Button
              onClick={() => {
                setReset((n) => n + 1);
                setError('');
              }}
            >
              Dismiss
            </Button>
          </div>
        ) : null}
        <Dialog
          open={(catalogLoading && !booting) || !!catalog || !!catalogError}
          onOpenChange={(isOpen) => {
            if (!isOpen) {
              ++catalogRequest.current;
              setCatalog(null);
              setCatalogLoading(false);
              setCatalogError('');
            }
          }}
          title="Choose a dataset"
        >
          {catalogLoading && !booting && <p role="status">Loading catalog…</p>}
          {catalogError && (
            <>
              <p role="alert">{catalogError}</p>
              <Button onClick={() => open({ url: AIFS })}>Try again</Button>
            </>
          )}
          <div className="catalog-choices">
            {catalog?.choices.map((choice) => (
              <button key={choice.url} onClick={() => open({ url: choice.url })}>
                <span>{choice.title}</span>
              </button>
            ))}
            <button
              disabled={!snowfallExample.url}
              onClick={() => open({ url: snowfallExample.url }, snowfallExample.extent)}
            >
              <span>{snowfallExample.title}</span>
            </button>
          </div>
          <div className="custom-dataset">
            <div className="custom-dataset-heading">
              <label htmlFor="custom-dataset-url">Paste your own URL (in progress)</label>
            </div>
            <input id="custom-dataset-url" type="url" placeholder="https://…" disabled />
          </div>
        </Dialog>
        <RegionDialog
          open={regionDialog}
          onClose={setRegionDialog}
          extent={extent}
          onApply={(e) => {
            setExtent(e);
            setRegionDialog(false);
            if (meta) load(meta, variable, init, e);
          }}
        />
        <Dialog
          open={commands}
          onOpenChange={setCommands}
          title="Go anywhere"
          description="Search actions and navigate your exploration."
        >
          <Command>
            <div className="command-search">
              <Search size={18} />
              <Command.Input placeholder="Search actions…" autoFocus />
            </div>
            <Command.List>
              <Command.Empty>No matching actions.</Command.Empty>
              {[
                ['Open dataset', () => open({ url: AIFS })],
                ['Reset cube', resetCube],
                ['Toggle controls', toggleSidebar],
                ['Toggle point forecast', () => setLinked((v) => !v)],
                ['Edit region', () => setRegionDialog(true)],

                ['View dataset details', () => setDiagnostics(true)],
              ].map(([label, fn]) => (
                <Command.Item
                  key={String(label)}
                  onSelect={() => {
                    (fn as () => void)();
                    setCommands(false);
                  }}
                >
                  {String(label)}
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </Dialog>
        <Dialog open={diagnostics} onOpenChange={setDiagnostics} title="Dataset details">
          <div className="diagnostic-grid">
            {metrics ? (
              Object.entries({
                'First data-backed plane': firstPlane
                  ? `${firstPlane.toFixed(0)} ms`
                  : 'Not yet rendered',
                'Metadata / open': `${metrics.openMs.toFixed(0)} ms`,
                'Last volume load': `${metrics.loadMs.toFixed(0)} ms`,
                'HTTP requests': metrics.requests,
                'HTTP payload headers': mb(metrics.responseBytes),
                'Observable transfer': metrics.transferBytes
                  ? mb(metrics.transferBytes)
                  : 'Unavailable (TAO)',
                'Decoded chunk cache': mb(metrics.decodedBytes),
                'Byte / range cache': mb(metrics.byteCacheBytes),
                'Cache hits': metrics.cacheHits,
                'Codec decode time': `${metrics.cpuDecodeMs.toFixed(0)} ms`,
                'Coalesced requests saved': metrics.coalescedRequests,
                'Read + decode time': `${metrics.decodeMs.toFixed(0)} ms`,
                'GPU volume allocation': volume ? mb(volume.data.length * 4) : 'Not available',
                'Warm UI p95 (2 frames)': warmStats
                  ? `${warmStats.p95.toFixed(1)} ms / ${warmStats.count} moves`
                  : 'Scrub slices to measure',
                'Frame gaps > 50 ms': stalls.current,
              }).map(([k, v]) => (
                <div key={k}>
                  <span>{k}</span>
                  <b>{v}</b>
                </div>
              ))
            ) : (
              <p>Open a dataset to start measuring.</p>
            )}
          </div>
          {meta ? (
            <>
              <p className="diagnostic-note">{meta.availability}</p>
              <dl>
                <dt>Snapshot</dt>
                <dd>{meta.snapshot}</dd>
                <dt>Source</dt>
                <dd>{meta.storeUrl}</dd>
                <dt>Chunk shape / dtype</dt>
                <dd>
                  {meta.chunks.join(' × ')} / {meta.dtype}
                </dd>
              </dl>
              <details>
                <summary>Codec metadata</summary>
                <pre>{JSON.stringify(meta.codecs, null, 2)}</pre>
              </details>
              <p className="diagnostic-note">
                Application budgets: 48 MiB bytes, 128 MiB decoded, 64 MiB volume / GPU. Icechunk
                WASM has its own memory. Timing includes network and decoding; transfer headers omit
                protocol overhead.
              </p>
            </>
          ) : null}
        </Dialog>
      </div>
    </TooltipProvider>
  );
}
