import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Search, X } from 'lucide-react';
import { loadPlaces, type Place } from '../render/places';
import type { Extent } from '../engine/types';
import { minimapRegions } from '../render/minimap';
import { wrapLongitude } from '../engine/coordinates';

/** Keep the region's size and move its centre; latitude stays inside ±90°. */
export function movedExtent([west, south, east, north]: Extent, lon: number, lat: number): Extent {
  const width = (east - west + 360) % 360 || 360;
  const height = north - south;
  const s = Math.max(-90, Math.min(90 - height, lat - height / 2));

  return [wrapLongitude(lon - width / 2), s, wrapLongitude(lon + width / 2), s + height];
}

/** The location widget shared by the cube and the flat view: a small world thumbnail that
 * expands, on click, into place search, map clicks and nudges. While a new region loads,
 * the thumbnail already shows where it is going. */
export function RegionPicker({
  extent,
  onMove,
  pending,
  status,
}: {
  extent: Extent;
  onMove: (e: Extent) => void;
  /** The region being loaded, drawn dashed until it arrives. */
  pending?: Extent | null;
  /** Loading progress or a failure message. */
  status?: string;
}) {
  const [open, setOpen] = useState(false);
  // Close once the new region has arrived.
  const key = extent.join(',');
  useEffect(() => setOpen(false), [key]);
  const [west, south, east, north] = extent;
  const width = (east - west + 360) % 360 || 360;
  const height = north - south;
  const lon = west + width / 2,
    lat = south + height / 2;
  const nudge = (dx: number, dy: number) =>
    onMove(movedExtent(extent, lon + (dx * width) / 2, lat + (dy * height) / 2));

  const [places, setPlaces] = useState<Place[]>([]);
  const [query, setQuery] = useState('');
  useEffect(() => {
    loadPlaces()
      .then(setPlaces)
      .catch(() => setPlaces([]));
  }, []);
  /** Best-known places first: prefix matches, then by cartographic rank and population. */
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];

    return places
      .filter((p) => p.name.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          Number(!a.name.toLowerCase().startsWith(q)) -
            Number(!b.name.toLowerCase().startsWith(q)) ||
          a.rank - b.rank ||
          b.population - a.population,
      )
      .slice(0, 6);
  }, [places, query]);
  const go = (p: Place) => {
    onMove(movedExtent(extent, p.lon, p.lat));
    setQuery('');
  };

  const thumbnail = (interactive: boolean) => (
    <svg
      viewBox="0 0 360 180"
      role={interactive ? 'button' : 'img'}
      aria-label={interactive ? 'Click the map to move the region there' : 'Current region'}
      onClick={
        interactive
          ? (e) => {
              const box = e.currentTarget.getBoundingClientRect();
              const x = ((e.clientX - box.left) / box.width) * 360,
                y = ((e.clientY - box.top) / box.height) * 180;
              onMove(movedExtent(extent, x - 180, 90 - y));
            }
          : undefined
      }
    >
      <image href="/world-overview.svg" width="360" height="180" />
      {minimapRegions(extent).map((rect, i) => (
        <rect
          key={i}
          {...rect}
          className="world-minimap-region"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {pending &&
        minimapRegions(pending).map((rect, i) => (
          <rect
            key={`p${i}`}
            {...rect}
            className="region-pending"
            vectorEffect="non-scaling-stroke"
          />
        ))}
    </svg>
  );

  if (!open)
    return (
      <button
        className="region-picker collapsed"
        onClick={() => setOpen(true)}
        aria-label="Change location: search for a place or pick it on the map"
        title="Change location"
      >
        {thumbnail(false)}
        <span className="region-collapsed-label">
          <Search size={11} aria-hidden="true" />
          {status || 'Change location'}
        </span>
      </button>
    );

  return (
    <div className="region-picker">
      <div className="region-head">
        <p className="region-title">Location</p>
        <button className="region-close" aria-label="Close location" onClick={() => setOpen(false)}>
          <X size={13} />
        </button>
      </div>
      <div className="region-search">
        <Search size={13} aria-hidden="true" />
        <input
          type="search"
          placeholder="Find a place…"
          aria-label="Find a place"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches[0]) go(matches[0]);
          }}
        />
      </div>
      {matches.length > 0 && (
        <ul className="region-results" role="listbox" aria-label="Places">
          {matches.map((p) => (
            <li key={`${p.name}-${p.lon}-${p.lat}`}>
              <button role="option" aria-selected={false} onClick={() => go(p)}>
                {p.name}
                <span>
                  {Math.abs(p.lat).toFixed(1)}° {p.lat < 0 ? 'S' : 'N'},{' '}
                  {Math.abs(p.lon).toFixed(1)}° {p.lon < 0 ? 'W' : 'E'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {thumbnail(true)}
      <div className="region-nudges">
        <button aria-label="Move region west" onClick={() => nudge(-1, 0)}>
          <ArrowLeft size={13} />
        </button>
        <button aria-label="Move region north" onClick={() => nudge(0, 1)}>
          <ArrowUp size={13} />
        </button>
        <button aria-label="Move region south" onClick={() => nudge(0, -1)}>
          <ArrowDown size={13} />
        </button>
        <button aria-label="Move region east" onClick={() => nudge(1, 0)}>
          <ArrowRight size={13} />
        </button>
      </div>
      <p>{status || 'Search, click the map, or nudge with the arrows'}</p>
    </div>
  );
}
