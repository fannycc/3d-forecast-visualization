# 3D Forecast Visualization

Live: https://3d-forecast-visualization.netlify.app

Built on [Zarr SQL Views](https://github.com/dzole0311/zarr-sql-views) by dzole0311, an experiment in visualizing Zarr data close to its array model with geographic layers that stack over time to form a 3D cube and SQL queries that filter the loaded data directly in the browser.

This version adds:

- **Ensemble uncertainty.** GEFS and ECMWF ENS forecasts load with every member. Show the mean, median, one member or the share of members past a threshold; member disagreement fades colours toward grey (a value-suppressing palette) or adds hatching.
- **Compared to normal.** Normals built on demand from the NOAA GEFS analysis, with anomalies in degrees or standard deviations and full provenance.
- **Persistent events.** A form that writes SQL for conditions lasting a minimum time, measured in valid hours.
- **Area-weighted results.** Selections report spherical cell areas, not just cell counts.
- **Terrain onion layers.** Each drawn forecast time is bent by AWS Terrain Tiles relief, with rivers, roads, borders and place names on the top layer.

Design notes, including every stated limitation: [docs/design-uncertainty-and-normals.md](docs/design-uncertainty-and-normals.md).

## Run

Requires Node.js 22.13 or newer.

```sh
npm install
cp .env.example .env.local
npm run dev
```

Set the dataset URLs in `.env.local` before starting Vite.

Open the local URL printed in your terminal.

To build and preview:

```sh
npm run build
npm run preview
```
