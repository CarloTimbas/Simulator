'use strict';
/**
 * MODULE 3 — OUTLIERS, TRANSFORMATION, VALIDATION & EXPORT
 * ---------------------------------------------------------------------------
 *   1. flagOutliersIQR()      Tukey fences (Q1 - 1.5*IQR, Q3 + 1.5*IQR) per river & parameter.
 *                             Coliforms are tested on log10 values because they span 6+ orders of magnitude.
 *                             Outliers are FLAGGED, not deleted: in river monitoring an extreme value is
 *                             often a real pollution event, so removal would bias the data toward "clean".
 *   2. addDerivedVariables()  year/month/season, regime, log10 coliforms, n_params_measured
 *   3. validateDataset()      schema / type / range / key-uniqueness checks (all must pass)
 *   4. exportCsv()            MMORS_water_quality_cleaned.csv + JSON report with before/after evidence
 */
const path = require('path');
const fs = require('fs');
const cfg = require('./config');
const { quantile, skewness, groupBy, round, writeCsv, countBy } = require('./utils');

const PARAM_KEYS = cfg.PARAMS.map((p) => p.key);

// ------------------------------------------------------------------ 1. IQR outliers
/** Tukey fences from a numeric array. */
function iqrFences(values, k = cfg.IQR_MULTIPLIER) {
  const s = [...values].sort((a, b) => a - b);
  const q1 = quantile(s, 0.25);
  const q3 = quantile(s, 0.75);
  const iqr = q3 - q1;
  return { n: s.length, q1, q3, iqr, lower: q1 - k * iqr, upper: q3 + k * iqr };
}

/** Value used for the IQR test (log10 for coliform counts, raw otherwise). */
const testValue = (p, v) => (p.log ? (v > 0 ? Math.log10(v) : null) : v);

function flagOutliersIQR(records) {
  const summary = [];
  records.forEach((r) => { r.flags.outlier = []; });

  cfg.PARAMS.forEach((p) => {
    const obsAll = records.filter((r) => r.v[p.key] !== null && testValue(p, r.v[p.key]) !== null);
    const pooled = iqrFences(obsAll.map((r) => testValue(p, r.v[p.key])));
    const byRiver = groupBy(obsAll, (r) => r.water_body);

    byRiver.forEach((grp, river) => {
      // Small rivers (e.g. Obando for sparse parameters) borrow the pooled fences.
      const f = grp.length >= cfg.MIN_N_PER_RIVER_FOR_IQR ? iqrFences(grp.map((r) => testValue(p, r.v[p.key]))) : pooled;
      let high = 0;
      let low = 0;
      grp.forEach((r) => {
        const t = testValue(p, r.v[p.key]);
        if (t > f.upper) { r.flags.outlier.push(`${p.key}(high)`); high++; }
        else if (t < f.lower) { r.flags.outlier.push(`${p.key}(low)`); low++; }
      });
      summary.push({
        parameter: p.key, river, scale: p.log ? 'log10' : 'raw', n: grp.length,
        fences_from: grp.length >= cfg.MIN_N_PER_RIVER_FOR_IQR ? 'river' : 'pooled',
        q1: round(f.q1, 4), q3: round(f.q3, 4), lower_fence: round(f.lower, 4), upper_fence: round(f.upper, 4),
        outliers_high: high, outliers_low: low,
      });
    });
  });
  return summary;
}

// ------------------------------------------------------------------ 2. transformations
function addDerivedVariables(records) {
  records.forEach((r) => {
    r.season = r.month ? (cfg.WET_MONTHS.includes(r.month) ? 'wet' : 'dry') : null;
    r.log10_fecal_coliform = r.v.fecal_coliform_mpn_100ml > 0 ? round(Math.log10(r.v.fecal_coliform_mpn_100ml), 4) : null;
    r.log10_total_coliform = r.v.total_coliform_mpn_100ml > 0 ? round(Math.log10(r.v.total_coliform_mpn_100ml), 4) : null;
    r.n_params_measured = PARAM_KEYS.filter((k) => r.v[k] !== null).length;
  });
}

/** Flatten internal record objects into CSV-ready rows. */
function toOutputRows(records) {
  const sorted = [...records].sort((a, b) =>
    a.water_body.localeCompare(b.water_body) || (a.period || '').localeCompare(b.period || '') || a.station_no - b.station_no);
  return sorted.map((r, i) => {
    const row = {
      record_id: i + 1, water_body: r.water_body, station_id: r.station_id, station_no: r.station_no,
      station_name: r.station_name, latitude: r.latitude, longitude: r.longitude,
      sample_date: r.sample_date, sample_time: r.sample_time, period: r.period, year: r.year, month: r.month,
      season: r.season, regime: r.regime,
      log10_fecal_coliform: r.log10_fecal_coliform, log10_total_coliform: r.log10_total_coliform,
      n_params_measured: r.n_params_measured,
      censored_fields: r.flags.censored.join(';'), imputed_fields: r.flags.imputed.join(';'),
      invalid_fields: r.flags.invalid.join(';'), outlier_fields: r.flags.outlier.join(';'),
      date_note: r.date_note, source_sheet: r.source_sheet, source_row: r.source_row,
    };
    PARAM_KEYS.forEach((k) => { row[k] = r.v[k]; });
    return row;
  });
}

// ------------------------------------------------------------------ 3. validation
/**
 * Re-check the FINAL table against the rules a clean dataset must satisfy.
 * Returns a list of {check, passed, detail}; index.js stops with exit code 1 if any check fails.
 */
function validateDataset(rows) {
  const checks = [];
  const add = (check, passed, detail = '') => checks.push({ check, passed, detail });

  add('Has rows', rows.length > 0, `${rows.length} rows`);
  add('All expected columns present', cfg.OUTPUT_COLUMNS.every((c) => rows.length && c in rows[0]));

  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  const badDate = rows.filter((r) => r.sample_date !== null && !isoDate.test(r.sample_date));
  add('sample_date is ISO 8601 (YYYY-MM-DD) or null', badDate.length === 0, `${badDate.length} bad`);
  const badTime = rows.filter((r) => r.sample_time !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.sample_time));
  add('sample_time is HH:MM (24h) or null', badTime.length === 0, `${badTime.length} bad`);
  add('period (YYYY-MM) present for every row', rows.every((r) => /^\d{4}-\d{2}$/.test(r.period || '')));
  add('years within 2012-2018', rows.every((r) => r.year >= 2012 && r.year <= 2018));

  const nonNumeric = [];
  const outOfRange = [];
  rows.forEach((r) => cfg.PARAMS.forEach((p) => {
    const v = r[p.key];
    if (v === null) return;
    if (typeof v !== 'number' || !Number.isFinite(v)) nonNumeric.push(`${p.key}@${r.source_sheet}:${r.source_row}`);
    else if (v < p.hardMin || v > p.hardMax) outOfRange.push(`${p.key}@${r.source_sheet}:${r.source_row}`);
  }));
  add('All 12 parameter columns are numeric or null', nonNumeric.length === 0, `${nonNumeric.length} non-numeric`);
  add('All values inside physical limits', outOfRange.length === 0, `${outOfRange.length} violations`);
  add('Every row has >= 1 measurement', rows.every((r) => r.n_params_measured >= 1));

  // Philippine bounding box around the Bulacan / Valenzuela monitoring area.
  add('Coordinates inside study area', rows.every((r) => r.latitude > 14.5 && r.latitude < 15.0 && r.longitude > 120.8 && r.longitude < 121.1));
  const coordPerStation = groupBy(rows, (r) => r.station_id);
  add('One name + one coordinate pair per station_id', [...coordPerStation.values()].every((g) => new Set(g.map((r) => `${r.station_name}|${r.latitude}|${r.longitude}`)).size === 1), `${coordPerStation.size} stations`);

  const keyCounts = countBy(rows, (r) => `${r.station_id}|${r.period}`);
  add('No duplicate (station, month) keys', Object.values(keyCounts).every((n) => n === 1));
  add('No leftover text markers (<, >, *, _) in numeric columns', rows.every((r) => PARAM_KEYS.every((k) => typeof r[k] !== 'string')));
  return checks;
}

// ------------------------------------------------------------------ 4. export + AFTER metrics
/** Skewness of the coliform counts before vs after the log10 transformation (evidence for "transform when necessary"). */
function skewnessEvidence(rows) {
  const out = {};
  [['fecal_coliform_mpn_100ml', 'log10_fecal_coliform'], ['total_coliform_mpn_100ml', 'log10_total_coliform']].forEach(([raw, lg]) => {
    const a = rows.map((r) => r[raw]).filter((v) => v !== null);
    const b = rows.map((r) => r[lg]).filter((v) => v !== null);
    out[raw] = { n: a.length, skew_raw: round(skewness(a), 2), skew_log10: round(skewness(b), 2) };
  });
  return out;
}

function afterProfile(rows) {
  const n = rows.length;
  return {
    usable_numeric_cells: rows.reduce((a, r) => a + PARAM_KEYS.filter((k) => r[k] !== null).length, 0),
    skewness: skewnessEvidence(rows),
    records: n,
    columns: cfg.OUTPUT_COLUMNS.length,
    missing_by_parameter: Object.fromEntries(PARAM_KEYS.map((k) => [k, rows.filter((r) => r[k] === null).length])),
    missing_pct_by_parameter: Object.fromEntries(PARAM_KEYS.map((k) => [k, round((100 * rows.filter((r) => r[k] === null).length) / n, 1)])),
    censored_cells: rows.reduce((a, r) => a + (r.censored_fields ? r.censored_fields.split(';').length : 0), 0),
    imputed_cells: rows.reduce((a, r) => a + (r.imputed_fields ? r.imputed_fields.split(';').length : 0), 0),
    invalid_cells_nullified: rows.reduce((a, r) => a + (r.invalid_fields ? r.invalid_fields.split(';').length : 0), 0),
    outlier_cells_flagged: rows.reduce((a, r) => a + (r.outlier_fields ? r.outlier_fields.split(';').length : 0), 0),
    records_by_river: countBy(rows, (r) => r.water_body),
    records_by_year: countBy(rows, (r) => r.year),
    records_with_exact_sample_date: rows.filter((r) => r.sample_date).length,
  };
}

function run(records, report) {
  // 1. Outliers (on the cleaned, imputed values)
  const iqr = flagOutliersIQR(records);
  console.log('IQR outlier summary (flagged, NOT removed):');
  console.table(iqr);

  // 2. Transformations
  addDerivedVariables(records);
  const rows = toOutputRows(records);

  // 3. Validate
  const checks = validateDataset(rows);
  console.log('\nValidation of the final dataset:');
  console.table(checks.map((c) => ({ check: c.check, result: c.passed ? 'PASS' : 'FAIL', detail: c.detail })));

  // 4. Export
  fs.mkdirSync(cfg.OUTPUT_DIR, { recursive: true });
  const csvPath = path.join(cfg.OUTPUT_DIR, cfg.OUTPUT_CSV);
  writeCsv(csvPath, cfg.OUTPUT_COLUMNS, rows);

  const after = afterProfile(rows);
  console.log('\nSkewness before/after log10 transform (|skew| > 1 = strongly skewed):');
  console.table(after.skewness);
  report.outliers_iqr = iqr;
  report.validation = checks;
  report.after = after;
  fs.writeFileSync(path.join(cfg.OUTPUT_DIR, cfg.OUTPUT_REPORT), JSON.stringify(report, null, 2));

  console.log(`\nSaved: ${csvPath}`);
  console.log(`Saved: ${path.join(cfg.OUTPUT_DIR, cfg.OUTPUT_REPORT)}`);
  return { rows, checks, after };
}

module.exports = { run, iqrFences, validateDataset };
