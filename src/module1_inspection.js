'use strict';
/**
 * MODULE 1 — INSPECTION & STANDARDIZATION
 * ---------------------------------------------------------------------------
 * Goal: turn the government-report-style workbook into a flat list of "station
 * sampling records" with clean column names, tidy station names and ISO dates.
 *
 * What the raw file actually looks like (found by inspection):
 *   - 4 sheets: Marilao, Meycauayan, Obando + a junk sheet "Table1 (3)" ("ExternalData_1").
 *   - Each station sheet starts with 6 letterhead rows, a 2-row merged header,
 *     3 "Water Quality Guideline" rows and a "Column1..Column18" Power-Query artifact row.
 *   - Data are grouped in month blocks introduced by a title row such as "CY 2012 JANUARY".
 *   - Each block holds one row per monitoring station (5 for Marilao/Meycauayan, 3 for Obando).
 *   - Marilao has stray scratch values in columns V:Z (Nov 2017) outside the table.
 *   - Footnotes sit at the bottom of the sheet.
 *
 * Exports: run(), plus helpers (parseSampleDate, parseSampleTime ...) for unit demos.
 */
const XLSX = require('xlsx');
const cfg = require('./config');
const { isBlank, collapseWs, pad2, round, countBy } = require('./utils');

const MONTHS = {
  JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6,
  JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
};
const BLOCK_RE = /^CY\s*(\d{4,5})\s+([A-Za-z]+)/i; // "CY 2012 JANUARY"

// ------------------------------------------------------------------ loading
/**
 * Load the workbook. We deliberately do NOT use `cellDates: true`: dates/times then arrive as
 * Excel serial numbers, which we convert ourselves with pure UTC arithmetic. This avoids the
 * well-known time-zone/1900-LMT off-by-minutes quirks of JS Date conversion.
 */
function loadWorkbook(file) {
  return XLSX.readFile(file);
}

/** Sheet -> array of row arrays (row index i === Excel row i+1, column index j === column j+1). */
function sheetRows(wb, name) {
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true });
}

// ------------------------------------------------------------------ date / time parsing
/** Excel serial day number -> 'YYYY-MM-DD' (Excel's day 0 is 1899-12-30 once the 1900 leap-year bug is accounted for). */
function excelSerialToISODate(serial) {
  const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** True if y-m-d is a real calendar date (rejects 2016-02-31 etc.). */
function isRealDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Parse the raw "Date" cell. Observed cases in this dataset:
 *   number              -> normal Excel date
 *   null                -> no date recorded (all of 2012 + some rows)
 *   'NO SAMPLING CONDUCTED' (text in a date column)
 *   '10/17//2016'       -> typo (double slash) inside a "CY 2014 OCTOBER" block
 * @returns {{iso:string|null, note:string}}
 */
function parseSampleDate(raw, blockYear, blockMonth) {
  if (isBlank(raw)) return { iso: null, note: '' };
  if (typeof raw === 'number') return { iso: excelSerialToISODate(raw), note: '' };

  const s = collapseWs(raw);
  if (/no\s+sampling/i.test(s)) return { iso: null, note: 'NO_SAMPLING_CONDUCTED' };

  const m = s.match(/^(\d{1,2})\/+(\d{1,2})\/+(\d{4})$/); // tolerate "//"
  if (m) {
    const mo = Number(m[1]);
    const dd = Number(m[2]);
    let yy = Number(m[3]);
    let note = 'DATE_TEXT_REPAIRED';
    // Same month as the block title but a different year -> most likely a year typo; trust the block year.
    // (An ASSUMPTION: flagged in `date_note` so the team can justify or reverse it in the report.)
    if (blockYear && yy !== blockYear && mo === blockMonth) {
      yy = blockYear;
      note = 'YEAR_CORRECTED_TO_BLOCK';
    }
    if (isRealDate(yy, mo, dd)) return { iso: `${yy}-${pad2(mo)}-${pad2(dd)}`, note };
  }
  return { iso: null, note: 'UNPARSEABLE_DATE' };
}

/**
 * Parse the raw "Time" cell -> 'HH:MM' (24h).
 * Observed: Excel fractions of a day, and text like '11:10 AM' / '12:06PM'.
 */
function parseSampleTime(raw) {
  if (isBlank(raw)) return null;
  if (typeof raw === 'number') {
    const totalMin = Math.round((raw % 1) * 1440) % 1440;
    return `${pad2(Math.floor(totalMin / 60))}:${pad2(totalMin % 60)}`;
  }
  const m = collapseWs(raw).match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'PM') h += 12;
  return `${pad2(h)}:${m[2]}`;
}

// ------------------------------------------------------------------ name standardization
/** "Tabing  ilog Bridge   Brgy. Tabing Ilog   Marilao   Bulacan " -> single-spaced, trimmed. */
const standardizeStationName = (raw) => collapseWs(raw);

/** "Name of Water Body:     Marilao River        " -> "Marilao River" */
function extractWaterBody(cell) {
  const m = String(cell).match(/^Name of Water Body:\s*(.+)$/i);
  return m ? collapseWs(m[1]) : null;
}

/** 'Marilao River' -> 'MAR' (used to build station_id such as MAR-3). */
const riverCode = (waterBody) => waterBody.replace(/\s*River\s*$/i, '').slice(0, 3).toUpperCase();

// ------------------------------------------------------------------ sheet parsing
/**
 * Walk one station sheet row-by-row (a tiny state machine) and extract station records.
 * Every row that is NOT a station record is classified and counted — that count is evidence for the
 * "unnecessary rows/columns" part of the Data Quality Assessment.
 */
function parseStationSheet(sheetName, rows) {
  const stats = {
    sheet: sheetName, totalRows: rows.length, maxCols: Math.max(...rows.map((r) => r.length)),
    blankRows: 0, letterheadRows: 0, headerRows: 0, guidelineRows: 0, powerQueryArtifactRows: 0,
    blockTitleRows: 0, footnoteRows: 0, stationRows: 0, strayCellsOutsideTable: 0,
  };
  const records = [];
  const blockLabels = [];
  let waterBody = null;
  let block = null;
  let headers = null;

  rows.forEach((row, i) => {
    // Count scratch cells to the right of column R (only Marilao Nov-2017 has them).
    for (let j = cfg.LAST_DATA_COL_INDEX + 1; j < row.length; j++) if (!isBlank(row[j])) stats.strayCellsOutsideTable++;

    if (row.every(isBlank)) { stats.blankRows++; return; }
    const c0 = row[0];

    if (typeof c0 === 'string') {
      const wbName = extractWaterBody(c0);
      if (wbName) { waterBody = wbName; stats.headerRows++; return; }
      const blk = c0.match(BLOCK_RE);
      if (blk) {
        const yearRaw = blk[1];
        block = {
          label: collapseWs(c0),
          year: yearRaw.length === 4 ? Number(yearRaw) : null, // 'CY 20178 DECEMBER' is a typo -> null
          yearRaw,
          month: MONTHS[blk[2].toUpperCase()] || null,
        };
        blockLabels.push(block.label);
        stats.blockTitleRows++;
        return;
      }
      if (/^Water Quality Guideline/i.test(c0)) { stats.guidelineRows++; return; }
      if (/^Column\d+$/i.test(c0)) { stats.powerQueryArtifactRows++; return; }
      if (/^(Republic|Department|ENVIRONMENTAL|EMB R3|RESULT OF)/i.test(c0)) { stats.letterheadRows++; return; }
      stats.footnoteRows++; // e.g. "*Effective June 15, 2016 ..." / "0.048 mg/L is the smallest amount ..."
      return;
    }
    if (typeof row[2] === 'string' && /^Latitude/i.test(row[2])) { headers = row; stats.headerRows++; return; }

    // Station row = numeric station number in col A + station description in col B, inside a month block.
    if (typeof c0 === 'number' && typeof row[1] === 'string' && block) {
      const d = parseSampleDate(row[4], block.year, block.month);
      const rec = {
        source_sheet: sheetName,
        source_row: i + 1,
        block_label: block.label,
        block_year: block.year,
        block_month: block.month,
        water_body: waterBody,
        station_no: c0,
        station_name_raw: row[1],
        station_name: standardizeStationName(row[1]),
        latitude: round(row[2], 6),
        longitude: round(row[3], 6),
        sample_date: d.iso,
        sample_time: parseSampleTime(row[5]),
        date_note: d.note,
        raw_date: row[4],
        raw_time: row[5],
        raw: {},                      // untouched parameter cells (audit trail)
      };
      cfg.PARAMS.forEach((p) => { rec.raw[p.key] = row[p.rawIdx]; });
      records.push(rec);
      stats.stationRows++;
    }
  });

  // Verify that the raw headers sit where config expects them (fail loudly if the file layout changed).
  cfg.PARAMS.forEach((p) => {
    const h = headers ? String(headers[p.rawIdx] ?? '') : '';
    if (!p.headerPattern.test(h.replace(/\*/g, '').trim())) {
      throw new Error(`[${sheetName}] column ${p.rawIdx + 1} header "${h}" does not match expected pattern ${p.headerPattern}`);
    }
  });

  return { records, stats, headers, blockLabels, waterBody };
}

// ------------------------------------------------------------------ period / provenance
/**
 * Decide each record's reporting period (YYYY-MM).
 * Rule: the observed sample date wins; the block title is the fallback (needed for all of 2012,
 * where no sample dates were recorded). If both exist and disagree, flag BLOCK_DATE_CONFLICT.
 */
function assignPeriods(records) {
  records.forEach((r) => {
    let y = null;
    let m = null;
    r.period_source = 'none';
    if (r.sample_date) {
      y = Number(r.sample_date.slice(0, 4));
      m = Number(r.sample_date.slice(5, 7));
      r.period_source = 'sample_date';
      if (r.block_year !== y || r.block_month !== m) r.date_note = r.date_note ? `${r.date_note}|BLOCK_DATE_CONFLICT` : 'BLOCK_DATE_CONFLICT';
    } else if (r.block_year && r.block_month) {
      y = r.block_year;
      m = r.block_month;
      r.period_source = 'block_label';
    }
    r.year = y;
    r.month = m;
    r.period = y && m ? `${y}-${pad2(m)}` : null;
  });
}

/** Give every (river, station_no) one canonical name and check coordinates are constant. */
function standardizeStations(records) {
  const canon = new Map();
  const issues = [];
  records.forEach((r) => {
    const key = `${r.water_body}|${r.station_no}`;
    if (!canon.has(key)) canon.set(key, { name: r.station_name, lat: r.latitude, lon: r.longitude });
    const c = canon.get(key);
    if (c.name !== r.station_name || c.lat !== r.latitude || c.lon !== r.longitude) issues.push(`${key} @ ${r.source_sheet}:${r.source_row}`);
    r.station_name = c.name;
    r.station_id = `${riverCode(r.water_body)}-${r.station_no}`;
  });
  return issues;
}

// ------------------------------------------------------------------ BEFORE profile
/** Cell-type census of the parameter columns: exposes "numbers stored as text". */
function rawTypeProfile(records) {
  const out = {};
  cfg.PARAMS.forEach((p) => {
    const t = countBy(records, (r) => {
      const v = r.raw[p.key];
      if (v === null || v === undefined) return 'empty';
      if (typeof v === 'number') return 'number';
      return v.trim() === '' ? 'blank_text' : 'text';
    });
    out[p.key] = { number: t.number || 0, text: t.text || 0, blank_text: t.blank_text || 0, empty: t.empty || 0 };
  });
  return out;
}

// ------------------------------------------------------------------ MAIN ENTRY FOR MODULE 1
function run(file, report) {
  const wb = loadWorkbook(file);

  // --- 1. Raw shapes (log "BEFORE") -----------------------------------------
  const sheetShapes = wb.SheetNames.map((name) => {
    const rows = sheetRows(wb, name);
    return { sheet: name, rows: rows.length, columns: Math.max(...rows.map((r) => r.length)), nonBlankRows: rows.filter((r) => !r.every(isBlank)).length };
  });
  console.log('Sheets found in workbook:');
  console.table(sheetShapes);
  const junk = wb.SheetNames.filter((n) => !cfg.STATION_SHEETS.includes(n));
  console.log(`Unnecessary sheet(s) ignored: ${junk.join(', ') || 'none'}`);

  // --- 2. Parse each station sheet -------------------------------------------
  const parsed = cfg.STATION_SHEETS.map((name) => parseStationSheet(name, sheetRows(wb, name)));
  console.log('\nHow every raw row was classified (non-record rows are removed as structural noise):');
  console.table(parsed.map((p) => p.stats));

  let records = parsed.flatMap((p) => p.records);
  console.log(`\nRaw station-sampling records extracted: ${records.length}  |  raw parameter columns: ${cfg.PARAMS.length}`);

  // --- 3. Column-name standardization ----------------------------------------
  const headerMap = cfg.PARAMS.map((p) => ({
    raw_header_Marilao: String(parsed[0].headers[p.rawIdx]).trim(),
    raw_header_Meycauayan: String(parsed[1].headers[p.rawIdx]).trim(),
    standardized: p.key,
  }));
  console.log('\nColumn standardization (note "Temperature °C*" vs "Temperature °C" across sheets):');
  console.table(headerMap);

  // --- 4. Dates, times, periods, stations -------------------------------------
  assignPeriods(records);
  const stationIssues = standardizeStations(records);

  const rawStationNames = new Set(records.map((r) => `${r.water_body}|${r.station_no}|${r.station_name_raw}`)).size;
  const cleanStationNames = new Set(records.map((r) => `${r.water_body}|${r.station_no}|${r.station_name}`)).size;

  const typeProfile = rawTypeProfile(records);
  console.log('\nRaw cell types per parameter (any "text" in a numeric column = incorrect data type):');
  console.table(typeProfile);

  const dateStatus = {
    valid_excel_date: records.filter((r) => typeof r.raw_date === 'number').length,
    missing_date: records.filter((r) => isBlank(r.raw_date)).length,
    text_no_sampling: records.filter((r) => r.date_note.includes('NO_SAMPLING')).length,
    text_date_repaired: records.filter((r) => r.date_note.includes('DATE_TEXT_REPAIRED') || r.date_note.includes('YEAR_CORRECTED')).length,
    time_as_text: records.filter((r) => typeof r.raw_time === 'string').length,
    block_vs_date_conflicts: records.filter((r) => r.date_note.includes('BLOCK_DATE_CONFLICT')).length,
    period_from_block_label_only: records.filter((r) => r.period_source === 'block_label').length,
  };
  console.log('\nTimestamp quality (BEFORE -> ISO 8601):');
  console.table([dateStatus]);
  console.log(`Distinct raw station spellings: ${rawStationNames} -> after whitespace standardization: ${cleanStationNames}`);
  const badBlocks = [...new Set(parsed.flatMap((p) => p.blockLabels).filter((l) => !/^CY \d{4} [A-Z]+$/.test(l)))];
  if (badBlocks.length) console.log(`Malformed block titles: ${badBlocks.join(', ')}`);

  // --- 5. Save BEFORE metrics -------------------------------------------------
  report.before = {
    sheets: sheetShapes,
    unnecessary_sheets: junk,
    row_classification: parsed.map((p) => p.stats),
    raw_station_records: records.length,
    raw_parameter_columns: cfg.PARAMS.length,
    stray_cells_outside_table: parsed.reduce((a, p) => a + p.stats.strayCellsOutsideTable, 0),
    cell_type_profile: typeProfile,
    usable_numeric_cells: Object.values(typeProfile).reduce((a, t) => a + t.number, 0), // cells that are real numbers BEFORE cleaning
    timestamp_quality: dateStatus,
    distinct_raw_station_spellings: rawStationNames,
    distinct_clean_station_names: cleanStationNames,
    station_name_or_coordinate_conflicts: stationIssues.length,
    malformed_block_titles: badBlocks,
    raw_missing_by_parameter: Object.fromEntries(cfg.PARAMS.map((p) => [p.key, records.filter((r) => isBlank(r.raw[p.key])).length])),
  };

  return records;
}

module.exports = { run, parseSampleDate, parseSampleTime, excelSerialToISODate, standardizeStationName };
