'use strict';
/**
 * MODULE 2 — CLEANING & IMPUTATION
 * ---------------------------------------------------------------------------
 * Order of operations (the order matters and is justified in the report):
 *   1. sanitizeMeasurements()   text -> numbers; censored / placeholder / typo handling
 *   2. applyDomainRules()       physically impossible values -> invalid
 *   3. removeEmptyRecords()     template rows with no measurements at all
 *   4. removeDuplicates()       exact + subset duplicates
 *   5. handleMissingValues()    structural vs. sporadic; impute ONLY the sporadic ones
 *
 * Each record gets:
 *   rec.v[key]        cleaned numeric value or null
 *   rec.censor[key]   '<' | '>' when the lab reported a detection/upper limit
 *   rec.flags         { censored:[], invalid:[], repaired:[], imputed:[] }
 */
const cfg = require('./config');
const { isBlank, round, median, groupBy, countBy } = require('./utils');

const PARAM_KEYS = cfg.PARAMS.map((p) => p.key);

// ------------------------------------------------------------------ 1. sanitize
/**
 * Interpret ONE raw cell. Cases observed in the file:
 *   26.1                 plain number
 *   '<0.048*' '< 0.048*' '<0.05 ' '<2*'   left-censored (below detection limit; '*' = footnote marker)
 *   '>16000000' '>1600'                   right-censored coliform counts (above the lab's upper limit)
 *   '_'  '- '                             placeholders meaning "no result"
 *   '   '                                 whitespace-only cell
 *   '26. 344 '                            typo: stray space inside the number
 */
function parseMeasurement(raw) {
  if (raw === null || raw === undefined) return { value: null, status: 'empty' };
  if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw, status: 'ok' } : { value: null, status: 'unparseable' };

  if (String(raw).trim() === '') return { value: null, status: 'blank_text' };
  const s = String(raw).replace(/\s+/g, ''); // remove ALL whitespace, including inside the number
  if (/^[-_\u2013\u2014]+$/.test(s)) return { value: null, status: 'placeholder' };

  const cens = s.match(/^([<>])=?(\d+(?:\.\d+)?)\*?$/);
  if (cens) {
    const limit = Number(cens[2]);
    return cens[1] === '<'
      ? { value: limit * cfg.LEFT_CENSOR_FACTOR, status: 'censored', censor: '<', limit }
      : { value: limit, status: 'censored', censor: '>', limit };
  }
  if (/^\d+(?:\.\d+)?\*?$/.test(s)) {
    const repaired = String(raw).trim() !== s; // internal/outer whitespace was removed
    return { value: Number(s.replace('*', '')), status: repaired ? 'whitespace_repaired' : 'numeric_text' };
  }
  return { value: null, status: 'unparseable' };
}

function sanitizeMeasurements(records) {
  const statusByParam = {};
  const statusTotals = {};
  records.forEach((r) => {
    r.v = {};
    r.censor = {};
    r.flags = { censored: [], invalid: [], repaired: [], imputed: [] };
    cfg.PARAMS.forEach((p) => {
      const out = parseMeasurement(r.raw[p.key]);
      r.v[p.key] = out.value;
      if (out.status === 'censored') {
        r.censor[p.key] = out.censor;
        r.flags.censored.push(`${p.key}(${out.censor}${out.limit})`);
      }
      if (out.status === 'whitespace_repaired') r.flags.repaired.push(`${p.key}(${String(r.raw[p.key]).trim()}->${out.value})`);
      if (out.status === 'unparseable') r.flags.invalid.push(`${p.key}(unparseable:${String(r.raw[p.key]).trim()})`);
      statusByParam[p.key] = statusByParam[p.key] || {};
      statusByParam[p.key][out.status] = (statusByParam[p.key][out.status] || 0) + 1;
      statusTotals[out.status] = (statusTotals[out.status] || 0) + 1;
    });
  });
  return { statusTotals, statusByParam };
}

// ------------------------------------------------------------------ 2. domain rules
/** Values outside the physically plausible range are invalid entries -> NULL (or unit-fixed for phosphate if configured). */
function applyDomainRules(records) {
  const log = [];
  records.forEach((r) => {
    cfg.PARAMS.forEach((p) => {
      const v = r.v[p.key];
      if (v === null) return;
      if (v < p.hardMin || v > p.hardMax) {
        if (p.key === 'phosphate_p_mg_l' && cfg.CONVERT_SUSPECTED_UG_L_PHOSPHATE) {
          r.v[p.key] = round(v / 1000, 6);
          r.flags.repaired.push(`${p.key}(${v}ug/L->${r.v[p.key]}mg/L)`);
        } else {
          r.v[p.key] = null;
          r.flags.invalid.push(`${p.key}(out_of_range:${v})`);
        }
        log.push({ sheet: r.source_sheet, row: r.source_row, period: r.period, parameter: p.key, value: v, action: r.v[p.key] === null ? 'set_to_null' : 'unit_converted' });
      }
    });
  });
  return log;
}

// ------------------------------------------------------------------ 3. empty template rows
const nParams = (r) => PARAM_KEYS.filter((k) => r.v[k] !== null).length;

/** A row with zero measurements is a placeholder for a survey that was not done / not yet filled in. */
function removeEmptyRecords(records) {
  const kept = [];
  const dropped = [];
  records.forEach((r) => (nParams(r) === 0 ? dropped : kept).push(r));
  return {
    kept,
    summary: {
      removed: dropped.length,
      of_which_NO_SAMPLING_CONDUCTED_text: dropped.filter((r) => r.date_note.includes('NO_SAMPLING')).length,
      by_river: countBy(dropped, (r) => r.water_body),
    },
  };
}

// ------------------------------------------------------------------ 4. duplicates
const fingerprint = (r) => JSON.stringify([r.water_body, r.station_no, r.sample_date, r.sample_time, ...PARAM_KEYS.map((k) => r.v[k])]);

/**
 * Remove duplicates by key. Of a duplicate group the record with MORE measured parameters is kept
 * (ties -> first in file order). Records whose key part is null are never treated as duplicates.
 */
function dedupe(records, keyFn, label) {
  const groups = groupBy(records, keyFn);
  const drop = new Set();
  const examples = [];
  let duplicateGroups = 0;
  groups.forEach((g, key) => {
    if (key === null || g.length < 2) return;
    duplicateGroups++;
    const sorted = [...g].sort((a, b) => nParams(b) - nParams(a) || a.source_row - b.source_row);
    sorted.slice(1).forEach((r) => drop.add(r));
    if (examples.length < 5) examples.push({ key, kept: `${sorted[0].source_sheet}:${sorted[0].source_row}`, dropped: sorted.slice(1).map((r) => `${r.source_sheet}:${r.source_row}`) });
  });
  return { kept: records.filter((r) => !drop.has(r)), result: { check: label, duplicate_groups: duplicateGroups, removed: drop.size, examples } };
}

function removeDuplicates(records) {
  const steps = [];
  let cur = records;

  // (a) EXACT duplicates: every identifying field and every measurement identical.
  let out = dedupe(cur, (r) => fingerprint(r), 'exact (river, station, date, time, all 12 parameters)');
  steps.push(out.result); cur = out.kept;

  // (b) SUBSET duplicate #1: same river + station + calendar date measured twice.
  out = dedupe(cur, (r) => (r.sample_date ? `${r.water_body}|${r.station_no}|${r.sample_date}` : null), 'subset (river, station, sample_date)');
  steps.push(out.result); cur = out.kept;

  // (c) SUBSET duplicate #2: monitoring is monthly, so one record per river + station + month is expected.
  out = dedupe(cur, (r) => (r.period ? `${r.water_body}|${r.station_no}|${r.period}` : null), 'subset (river, station, year-month)');
  steps.push(out.result); cur = out.kept;

  return { kept: cur, steps };
}

// ------------------------------------------------------------------ 5. missing values
/** Which monitoring regime does this record belong to? (DAO 2016-08 changed the parameter list in June 2016.) */
function regimeOf(r) {
  if (!r.year) return 'unknown';
  const { year, month } = cfg.REGIME_CUTOFF;
  return r.year > year || (r.year === year && r.month >= month) ? 'post_DAO_2016_08' : 'pre_DAO_2016_08';
}

const missingCounts = (records) => Object.fromEntries(PARAM_KEYS.map((k) => [k, records.filter((r) => r.v[k] === null).length]));

/**
 * Missing-value strategy (decision tree — explain this slide-by-slide in the video):
 *
 *   For each parameter, look at its missing share inside each (river, year, regime) group.
 *     >= 50 %  -> STRUCTURAL: the parameter simply was not analysed then (e.g. only DO & BOD in 2012;
 *                 Total Coliform/Ammonia after DAO 2016-08). LEAVE NULL — imputing would fabricate data.
 *     <  50 %  -> SPORADIC candidate. Fill it ONLY IF:
 *                 (a) the whole survey (river + month) did not miss this parameter (otherwise the lab skipped it), and
 *                 (b) >= 3 observed values exist for the same station & year & regime.
 *               Fill value = station-year median (robust to the heavy right skew of water-quality data).
 *               Fallback = river-year-regime median. Every filled cell is listed in `imputed_fields`.
 */
function handleMissingValues(records) {
  records.forEach((r) => { r.regime = regimeOf(r); });
  const before = missingCounts(records);

  const byGroup = groupBy(records, (r) => `${r.water_body}|${r.year}|${r.regime}`);
  const bySurvey = groupBy(records, (r) => `${r.water_body}|${r.period}`);
  const byStationYear = groupBy(records, (r) => `${r.water_body}|${r.station_no}|${r.year}|${r.regime}`);

  const classification = { structural_cells: {}, sporadic_cells: {}, event_level_gap_cells: {}, imputed_cells: {} };
  PARAM_KEYS.forEach((k) => Object.keys(classification).forEach((c) => { classification[c][k] = 0; }));

  // Plan first (so imputed values never feed later medians), then apply.
  const plan = [];
  byGroup.forEach((grp) => {
    PARAM_KEYS.forEach((k) => {
      const missing = grp.filter((r) => r.v[k] === null);
      if (missing.length === 0) return;
      if (missing.length / grp.length >= cfg.STRUCTURAL_MISSING_SHARE) { classification.structural_cells[k] += missing.length; return; }

      missing.forEach((r) => {
        const survey = bySurvey.get(`${r.water_body}|${r.period}`) || [];
        if (survey.every((s) => s.v[k] === null)) { classification.event_level_gap_cells[k]++; return; } // whole survey missed it
        classification.sporadic_cells[k]++;

        let pool = (byStationYear.get(`${r.water_body}|${r.station_no}|${r.year}|${r.regime}`) || []).map((s) => s.v[k]).filter((x) => x !== null);
        if (pool.length < cfg.MIN_OBS_FOR_MEDIAN) pool = grp.map((s) => s.v[k]).filter((x) => x !== null);
        if (pool.length >= cfg.MIN_OBS_FOR_MEDIAN) plan.push({ r, k, value: round(median(pool), 6), n: pool.length });
      });
    });
  });
  plan.forEach(({ r, k, value }) => {
    r.v[k] = value;
    r.flags.imputed.push(k);
    classification.imputed_cells[k]++;
  });

  return { before, after: missingCounts(records), classification, imputed_total: plan.length };
}

// ------------------------------------------------------------------ MAIN ENTRY FOR MODULE 2
function run(records, report) {
  const n0 = records.length;

  const san = sanitizeMeasurements(records);
  console.log('Cell interpretation (all parameter cells):');
  console.table(san.statusTotals);

  const domainLog = applyDomainRules(records);
  console.log(`\nDomain-rule violations (physically impossible values): ${domainLog.length}`);
  if (domainLog.length) console.table(domainLog);

  const emp = removeEmptyRecords(records);
  console.log(`\nEmpty template records removed: ${emp.summary.removed} (of which text "NO SAMPLING CONDUCTED": ${emp.summary.of_which_NO_SAMPLING_CONDUCTED_text})`);
  console.table(emp.summary.by_river);

  const dup = removeDuplicates(emp.kept);
  console.log('\nDuplicate detection:');
  console.table(dup.steps.map(({ examples, ...rest }) => rest));

  const miss = handleMissingValues(dup.kept);
  console.log(`\nMissing values — cells imputed: ${miss.imputed_total}`);
  console.table(PARAM_KEYS.map((k) => ({
    parameter: k, missing_before: miss.before[k], structural: miss.classification.structural_cells[k],
    event_level_gap: miss.classification.event_level_gap_cells[k], sporadic: miss.classification.sporadic_cells[k],
    imputed: miss.classification.imputed_cells[k], missing_after: miss.after[k],
  })));

  report.cleaning = {
    records_in: n0,
    cell_interpretation: san.statusTotals,
    cell_interpretation_by_parameter: san.statusByParam,
    domain_rule_violations: domainLog,
    empty_template_records_removed: emp.summary,
    duplicate_detection: dup.steps,
    missing_values: miss,
    records_out: dup.kept.length,
  };
  return dup.kept;
}

module.exports = { run, parseMeasurement, regimeOf };
