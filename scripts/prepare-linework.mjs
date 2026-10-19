// Download Natural Earth (public domain) rivers, drop intermittent lake centerlines, and round
// coordinates to 0.01° (about 1 km), well below the relief model's ~3 km sampling.
// Usage: node scripts/prepare-linework.mjs <download-dir>
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const base = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';
const dir = process.argv[2];
if (!dir) throw Error('Pass a download directory.');

async function source(name) {
  const file = path.join(dir, `${name}.geojson`);
  if (!existsSync(file)) {
    const response = await fetch(base + `${name}.geojson`);
    if (!response.ok) throw Error(`${name}: HTTP ${response.status}`);
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
  }

  return JSON.parse(await readFile(file, 'utf8'));
}

const round = (c) =>
  typeof c[0] === 'number' ? c.slice(0, 2).map((v) => Math.round(v * 100) / 100) : c.map(round);

function lines(features, keep, props) {
  return {
    type: 'FeatureCollection',
    features: features.filter(keep).map((f) => ({
      type: 'Feature',
      properties: props(f.properties),
      geometry: { type: f.geometry.type, coordinates: round(f.geometry.coordinates) },
    })),
  };
}

const rivers = await source('ne_10m_rivers_lake_centerlines');
const europe = await source('ne_10m_rivers_europe');

const out = {
  'rivers.geojson': lines(
    [...rivers.features, ...europe.features],
    (f) => f.geometry && f.properties.featurecla !== 'Lake Centerline (Intermittent)',
    (p) => ({ rank: p.scalerank ?? p.min_zoom ?? 10 }),
  ),
};

for (const [name, data] of Object.entries(out)) {
  const text = JSON.stringify(data);
  await writeFile(path.join('public', name), text);
  console.log(name, data.features.length, 'features', (text.length / 1048576).toFixed(1), 'MiB');
}
