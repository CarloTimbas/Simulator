'use strict';
/**
 * config.js — every tunable decision lives here so the team can discuss / change it in ONE place.
 * (Each constant is explained so it can be cited in the report's Methods section.)
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');

module.exports = {
  // ---------- I/O ----------
  INPUT_FILE: path.join(ROOT, 'data', 'raw', 'MMORS_water_quality_results_2012-2018_orig.xlsx'),
  OUTPUT_DIR: path.join(ROOT, 'data', 'processed'),
  OUTPUT_CSV: 'MMORS_water_quality_cleaned.csv',
  OUTPUT_REPORT: 'MMORS_cleaning_report.json',

  // ---------- Workbook layout (observed in the raw file) ----------
  STATION_SHEETS: ['Marilao', 'Meycauayan', 'Obando'], // one sheet per river
  // 'Table1 (3)' only holds the text "ExternalData_1" (a leftover Power Query connection) -> unnecessary.
  // Station data sit in columns A..R (indexes 0..17); anything further right is scratch work.
  LAST_DATA_COL_INDEX: 17,

  // ---------- Missing-value strategy ----------
  // DAO 2016-08 took effect 15 June 2016 and changed which parameters are monitored
  // (Ammonia & Total Coliform dropped; Fecal Coliform, Temperature, Color, Chloride required).
  // We split the record into two "regimes" at June 2016 so that a parameter that was simply
  // not required in a given regime is NOT treated as a random gap.
  REGIME_CUTOFF: { year: 2016, month: 6 },
  // If a parameter is missing in >= this share of a (river, year, regime) group, it was not
  // measured -> STRUCTURAL missingness -> leave as NULL (never invent data).
  STRUCTURAL_MISSING_SHARE: 0.5,
  // Sporadic gaps (< share above) are filled with a station-level median only if at least
  // this many observed values exist to compute it from.
  MIN_OBS_FOR_MEDIAN: 3,

  // ---------- Censored ("<0.048*", ">16000000") values ----------
  // Left-censored (<DL) -> substitute DL * factor (DL/2 is the common simple-substitution rule).
  // Right-censored (>X)  -> keep X (the lab's upper reporting limit). Both are flagged in the output.
  LEFT_CENSOR_FACTOR: 0.5,

  // Phosphate in Meycauayan (May 2017) is 1578-3103 "mg/L" - almost certainly ug/L entered under a mg/L header
  // (neighbouring rivers report ~2-4 mg/L). false = set to NULL and flag (safe default);
  // true  = divide by 1000 and flag. Decide as a team and justify it in the report.
  CONVERT_SUSPECTED_UG_L_PHOSPHATE: false,

  // ---------- Outlier detection ----------
  IQR_MULTIPLIER: 1.5,
  MIN_N_PER_RIVER_FOR_IQR: 30, // fewer observations than this -> use the pooled (all-river) fences

  // Seasons for the derived `season` variable. ASSUMPTION - confirm against PAGASA/literature in the report.
  WET_MONTHS: [6, 7, 8, 9, 10, 11],

  /**
   * The 12 measured parameters.
   *  rawIdx        : zero-based column index in the raw sheets
   *  headerPattern : regex used to verify the raw header (handles "Temperature °C*" vs "Temperature °C")
   *  key           : standardized snake_case column name (unit is part of the name)
   *  hardMin/Max   : physically plausible range (values outside = invalid entry)
   *  log           : right-skewed count data -> also get a log10 column and IQR is computed on log10
   */
  PARAMS: [
    { key: 'do_mg_l',                  rawIdx: 6,  headerPattern: /dissolved oxygen/i,    hardMin: 0, hardMax: 25 },
    { key: 'ph',                       rawIdx: 7,  headerPattern: /^ph$/i,                hardMin: 0, hardMax: 14 },
    { key: 'temp_c',                   rawIdx: 8,  headerPattern: /^temperature/i,        hardMin: 0, hardMax: 50 },
    { key: 'bod_mg_l',                 rawIdx: 9,  headerPattern: /biochemical oxygen/i,  hardMin: 0, hardMax: 1000 },
    { key: 'tss_mg_l',                 rawIdx: 10, headerPattern: /suspended solids/i,    hardMin: 0, hardMax: 5000 },
    { key: 'color_tcu',                rawIdx: 11, headerPattern: /^color/i,              hardMin: 0, hardMax: 2000 },
    { key: 'fecal_coliform_mpn_100ml', rawIdx: 12, headerPattern: /fecal coliform/i,      hardMin: 0, hardMax: 1e10, log: true },
    { key: 'total_coliform_mpn_100ml', rawIdx: 13, headerPattern: /total coliform/i,      hardMin: 0, hardMax: 1e10, log: true },
    { key: 'ammonia_mg_l',             rawIdx: 14, headerPattern: /ammonia/i,             hardMin: 0, hardMax: 500 },
    { key: 'nitrate_n_mg_l',           rawIdx: 15, headerPattern: /nitrates/i,            hardMin: 0, hardMax: 100 },
    { key: 'phosphate_p_mg_l',         rawIdx: 16, headerPattern: /phosphates/i,          hardMin: 0, hardMax: 100 },
    // Chloride cap is high on purpose: Obando has salt beds/fishponds, brine can be legitimately extreme -> IQR-flag, don't delete.
    { key: 'chloride_mg_l',            rawIdx: 17, headerPattern: /chlorides/i,           hardMin: 0, hardMax: 200000 },
  ],

  // Column order of the final analysis-ready CSV.
  OUTPUT_COLUMNS: [
    'record_id', 'water_body', 'station_id', 'station_no', 'station_name', 'latitude', 'longitude',
    'sample_date', 'sample_time', 'period', 'year', 'month', 'season', 'regime',
    'do_mg_l', 'ph', 'temp_c', 'bod_mg_l', 'tss_mg_l', 'color_tcu',
    'fecal_coliform_mpn_100ml', 'total_coliform_mpn_100ml', 'log10_fecal_coliform', 'log10_total_coliform',
    'ammonia_mg_l', 'nitrate_n_mg_l', 'phosphate_p_mg_l', 'chloride_mg_l',
    'n_params_measured', 'censored_fields', 'imputed_fields', 'invalid_fields', 'outlier_fields',
    'date_note', 'source_sheet', 'source_row',
  ],
};
