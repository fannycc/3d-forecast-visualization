# Uncertainty, normals and events — design notes

Two additions, designed around one rule: **every mark on screen must be traceable to a
stated computation**. Where a choice is a judgement call, the interface names it instead
of hiding it.

## 1. Showing uncertainty (ensemble forecasts)

### What is loaded

Ensemble datasets (NOAA GEFS, 31 members; ECMWF IFS ENS, 51 members) are now accepted.
All members are retained for the loaded region, so every derived view is computed exactly
from members rather than from approximations such as a normal distribution. Retaining
members costs `members × lead times × cells × 4 B`, so ensemble regions are automatically
smaller (about 18–22° wide at 0.25°) than single-forecast regions. The region shrinks
rather than the data being subsampled.

Per cell, the worker computes over the members with finite values:

| Statistic        | Definition                                                              |
| ---------------- | ----------------------------------------------------------------------- |
| mean             | arithmetic mean                                                         |
| spread           | sample standard deviation (n − 1)                                       |
| p10, median, p90 | linear interpolation between order statistics (NumPy default, "type 7") |
| n                | members with data                                                       |

### What can be shown

_Show_ control, single choice:

- **Ensemble mean.** The default. The colour is the mean; spread is encoded separately (below).
- **Median.** More robust for skewed variables such as precipitation.
- **One member.** A single run, shown with the member number. It is useful for showing that
  the mean is not itself a possible weather state (it is smoother than any member).
- **Chance above / below X.** The fraction of members past a threshold, on a fixed 0–100 %
  scale that is never auto-stretched. The legend states the resolution: with 31 members,
  the possible values move in steps of 1/31 ≈ 3.2 %. It is not a calibrated probability;
  the label says "share of members".

### How uncertainty is encoded

Transparency was considered and rejected for the cube. In a 3D volume, alpha compounds
through stacked cells and depends on the background, so the same spread would look
different depending on depth and view angle. That would break the rule above. Two
alternatives are offered instead:

1. **Value-suppressing palette (default).** After Correll, Moritz & Heer, _Value-Suppressing
   Uncertainty Palettes_, CHI 2018. Spread is cut into four bands. In the most certain band
   the colour scale has 8 distinguishable steps; each band up halves the number of steps
   and moves the colours toward neutral grey. The idea: when the members disagree, the
   picture should _not_ let you read fine value differences. The legend is the 2D wedge
   itself, with the numeric band edges.
2. **Hatching.** Following the IPCC AR6 convention for low agreement. The colour is
   unchanged and diagonal hatching marks cells whose spread is at or above a stated
   threshold. It is useful for screenshots and print, where a viewer may not have the
   wedge legend.

Both use one _spread scale_, stated in data units (e.g. "fully suppressed at ≥ 4 °C").
It is set from the first load and then **held fixed while panning**, so colours stay
comparable across regions. It can be edited.

The point panel shows the full plume when a cell is picked: thin member lines, the
10–90 % band, and the median.

## 2. Better questions

### Compared to normal

There is no browser-accessible, CORS-enabled climatology for these grids, so the "normal" is
**built on demand** from the NOAA GEFS analysis (same 0.25° grid, 3-hourly since 2000):

- For each forecast valid time, the normal is the mean of all analysis samples at the
  **same UTC hour**, within **± W calendar days**, over the **chosen years**.
- With hourly forecast leads (GFS to +120 h), valid times between the 3-hourly analysis
  hours are linearly interpolated between the two neighbouring hourly normals. The legend
  says how many steps were interpolated.
- Per cell and time, it also keeps the baseline standard deviation and sample count. This
  allows a **standardized anomaly** (σ units, "how unusual") alongside the plain
  difference (°C, "how much").
- The grids must match exactly. If the coordinates of the two datasets differ, the
  baseline is refused rather than regridded, because regridding adds interpolation error.
- The variable's step type (instantaneous vs. accumulated/averaged) must match, for the
  same reason.

**Cost is shown before running.** Estimated chunk reads, years and region size are shown,
and building is an explicit button. Fewer years is cheaper and gives a less robust normal.
The interface says so and never quietly reduces the years.

**Caveats shown in the panel:**

- The baseline model (GEFS analysis) differs from the forecast model, so part of any
  anomaly can be model bias, especially at long leads.
- The default period is not a WMO 30-year normal. The period is always printed.

Anomalies use a diverging palette centred on zero with a symmetric range, so equal colour
distance means equal magnitude above or below normal.

### Events that persist

"Cells above 30 °C for 3+ days" is answered by an **event builder** that writes SQL into
the existing editor. The query is visible, editable and teaches the method.

- **Condition:** value / anomaly / chance column, above or below a threshold.
- **Persistence:** the condition holds at **every consecutive sample**, and the time from the
  first to the last of those samples is at least the stated duration. Duration is measured
  in valid hours, not step counts, because forecast steps are irregular (1 h, then 3 h,
  then 6 h). A missing value breaks a run.
- **Matched cells:** every sample within a qualifying run.

### Area-weighted results

On a longitude/latitude grid, a cell at 60° N covers half the area of one at the equator.
Every selection result therefore reports **area**, not just cell counts:

- cell area = R² · Δλ · (sin φₙ − sin φₛ), using cell edges halfway between grid
  coordinates and the mean Earth radius R = 6371.0088 km (a spherical approximation;
  the ellipsoidal difference is under 0.5 %)
- the affected area per time step, its peak and when it peaks
- the share of the region's area _with data_ at that time
- the area-weighted mean of the matched values

`cell_area_km2` is also a column in `loaded_forecast`, so custom SQL can weight its own
statistics.

## Also changed along the way

- **Colour ranges are held while panning and switching runs.** They used to re-stretch to
  every newly loaded region, so the same colour meant different values in two views. A
  range is now set when the shown quantity changes (variable, values vs. anomaly, share)
  and kept until then. Values beyond it are marked ≤ / ≥ on the legend as before.
- **Run lengths come from dataset metadata.** When a store records
  `expected_forecast_length` (for example, GEFS runs that stop at 16 days inside a 35-day
  dataset), lead times beyond it are left out and the sidebar says so. A recorded
  `ingested_forecast_length` that is still empty marks a run as in progress. Stores that
  declare that array but never fill it are treated as having no ingestion metadata.
- **Incomplete newest runs.** On first open, if the newest run is only partly in the
  archive, the previous run is shown with a notice, rather than an error.
- **Hover readout** names the shown quantity and, where available, the member spread,
  10–90 % range and the normal with its sample count. Western and southern coordinates are
  now labelled W/S instead of negative degrees E/N.
