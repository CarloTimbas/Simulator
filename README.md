# MMORS Water Quality (2012-2018) — Node.js Preprocessing Pipeline

Assigned language: **JavaScript (Node.js >= 18)**. Only one dependency: [`xlsx`](https://www.npmjs.com/package/xlsx) (SheetJS) to read the workbook.
Quartiles, medians, skewness, date parsing and CSV writing are hand-written in `src/utils.js` so every line can be explained on video.

## Run it
```bash
npm install                       # installs xlsx
# clean clones must supply the original workbook here:
# data/raw/MMORS_water_quality_results_2012-2018_orig.xlsx
npm start                         # == node src/index.js   (all three modules)
node src/index.js --until=1       # stop after Module 1 (nice for the BEFORE segment of the video)
node src/index.js --until=2       # stop after Module 2
node src/figures.js               # OPTIONAL: SVG charts for the report -> data/processed/figures/
```
Outputs (in `data/processed/`): `MMORS_water_quality_cleaned.csv` (analysis-ready), `MMORS_cleaning_report.json` (every before/after number used in the report).
`reference_output/` holds the output produced by the authors' test run, so you can diff your run against it.

The raw `.xlsx` is intentionally ignored by Git. Anyone cloning this repository must
place a copy in `data/raw/` before running `npm start`.

## Layout
| File | Role | Lead / co-authors (see blueprint) |
|---|---|---|
| `src/config.js` | every tunable decision (thresholds, parameter table, output columns) | all three — change here, justify in report |
| `src/utils.js` | quantile, median, skewness, groupBy, CSV writer | shared |
| `src/module1_inspection.js` | load, inspect, row classification, names, ISO dates, stations, periods | Track A |
| `src/module2_cleaning.js` | text->number, censored values, domain rules, empty rows, duplicates, missing values | Track B |
| `src/module3_outliers_validation.js` | IQR outliers, transformations, validation, CSV export | Track C |
| `src/index.js` | orchestrator (BEFORE / DURING / AFTER banners) | shared |
| `src/figures.js` | dependency-free SVG charts | shared |

## Decisions the team must confirm (all in `src/config.js`)
1. `CONVERT_SUSPECTED_UG_L_PHOSPHATE` — Meycauayan May-2017 phosphate (1578-3103 "mg/L") is set to NULL by default; `true` divides by 1000 instead.
2. `LEFT_CENSOR_FACTOR` (0.5) — values reported as "<0.048*" become 0.024 and are flagged in `censored_fields`.
3. `STRUCTURAL_MISSING_SHARE` (0.5) and `REGIME_CUTOFF` (June 2016, DAO 2016-08) — decide what counts as "not measured" vs "randomly missing".
4. `WET_MONTHS` — the wet/dry season definition is an assumption; cite PAGASA or literature.
5. A date typed `10/17//2016` inside the "CY 2014 OCTOBER" block is corrected to 2014 (flagged `YEAR_CORRECTED_TO_BLOCK`). Verify with the instructor if possible.

## Testing note
The pipeline was executed end-to-end against the real workbook (941 retained records, 13/13 validation checks passed). **Run `npm install && npm start` on your machine once and diff against `reference_output/`.**
