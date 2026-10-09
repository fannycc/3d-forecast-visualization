import { useCallback, useEffect, useRef, useState } from 'react';
import { DataClient } from '../engine/client';
import { dynamicalCatalogUrl } from '../engine/config';
import { coordinateDate, unitSeconds } from '../engine/coordinates';
import { BASELINE_ARCHIVE } from '../engine/dataset-support';
import type { BaselineEstimate, Metadata, Normals, Volume } from '../engine/types';

export type NormalsSettings = { years: [number, number]; windowDays: number };

export const defaultNormalsSettings: NormalsSettings = { years: [2010, 2019], windowDays: 7 };

export type NormalsState =
  | { status: 'idle' }
  | { status: 'opening' | 'estimating' | 'building'; message: string }
  | { status: 'ready'; estimate: BaselineEstimate }
  | { status: 'built' }
  | { status: 'error'; message: string };

const epoch = (value: number, units: string) => Date.parse(coordinateDate(value, units)) / 1000;

/** Absolute valid times (epoch seconds) of every loaded step. */
export function validTimes(meta: Metadata, volume: Volume) {
  if (meta.axes.init) {
    const init = epoch(meta.initializations[volume.init], meta.initUnits);

    return volume.times.map((t) => init + t * unitSeconds(volume.timeUnits));
  }
  if (!volume.timeUnits.includes('since ')) throw Error('This dataset has no calendar times.');

  return volume.times.map((t) => epoch(t, volume.timeUnits));
}

/** Own a second data worker that reads the analysis archive used for normals.
 * Normals belong to one loaded volume; any new volume makes them stale. */
export function useNormals(meta: Metadata | null, volume: Volume | null, active: boolean) {
  const client = useRef<DataClient | null>(null);
  const opened = useRef<Promise<void> | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  const [settings, setSettings] = useState(defaultNormalsSettings);
  const [state, setState] = useState<NormalsState>({ status: 'idle' });
  const [normals, setNormals] = useState<Normals | null>(null);

  const archiveUrl = dynamicalCatalogUrl
    ? new URL(`${BASELINE_ARCHIVE}/collection.json`, dynamicalCatalogUrl).href
    : '';

  const open = useCallback(() => {
    if (opened.current) return opened.current;
    if (!archiveUrl)
      return Promise.reject(Error('Set VITE_DYNAMICAL_CATALOG_URL to build normals.'));
    client.current = new DataClient();
    opened.current = new Promise<void>((resolve, reject) => {
      client.current!.request({ type: 'open', options: { url: archiveUrl } }, (r) => {
        if (r.type === 'metadata') resolve();
        if (r.type === 'error') {
          opened.current = null;
          reject(Error(r.message));
        }
      });
    });

    return opened.current;
  }, [archiveUrl]);

  useEffect(
    () => () => {
      cancel.current?.();
      client.current?.dispose();
    },
    [],
  );

  const request = useCallback(
    async (estimateOnly: boolean) => {
      if (!meta || !volume) return;
      cancel.current?.();
      setState({ status: 'opening', message: 'Opening the NOAA GEFS analysis archive…' });
      try {
        await open();
      } catch (error) {
        setState({ status: 'error', message: (error as Error).message });

        return;
      }
      const times = validTimes(meta, volume);
      setState({
        status: estimateOnly ? 'estimating' : 'building',
        message: estimateOnly ? 'Estimating archive reads…' : 'Building normals…',
      });
      cancel.current = client.current!.request(
        {
          type: 'baseline',
          volumeId: volume.id,
          variable: volume.variable,
          stepType: meta.stepType,
          lon: volume.lon,
          lat: volume.lat,
          validTimes: times,
          years: settings.years,
          windowDays: settings.windowDays,
          estimateOnly,
        },
        (r) => {
          if (r.type === 'progress') setState({ status: 'building', message: r.message });
          if (r.type === 'estimate') setState({ status: 'ready', estimate: r.estimate });
          if (r.type === 'normals') {
            setNormals(r.normals);
            setState({ status: 'built' });
          }
          if (r.type === 'error') setState({ status: 'error', message: r.message });
        },
      );
    },
    [meta, volume, settings, open],
  );

  // Re-estimate whenever the panel is active and the inputs change, unless normals for
  // exactly this volume are already built.
  const current = !!normals && !!volume && normals.volumeId === volume.id;
  useEffect(() => {
    if (!active || !volume || current) return;
    const timer = setTimeout(() => request(true), 250);

    return () => clearTimeout(timer);
  }, [active, volume, settings, current, request]);

  return {
    settings,
    setSettings,
    state: current ? ({ status: 'built' } as NormalsState) : state,
    normals,
    current,
    build: () => request(false),
    cancel: () => {
      cancel.current?.();
      setState({ status: 'idle' });
    },
  };
}

export type NormalsHandle = ReturnType<typeof useNormals>;
