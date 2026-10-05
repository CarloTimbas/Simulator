'use strict';
/**
 * verify.js — independent check of the EXPORTED csv (re-reads the file from disk; does not reuse pipeline objects).
 * Ideal for the AFTER segment of the video:   npm run verify
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const file = path.join(cfg.OUTPUT_DIR, cfg.OUTPUT_CSV);
const [headerLine, ...lines] = fs.readFileSync(file, 'utf8').trim().split('\n');
const cols = headerLine.split(',');

/** Minimal RFC-4180 line parser (handles quoted fields, e.g. the station name "Expressway Bridge Brgy. Patubig Marilao, Bulacan"). */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
const rows = lines.map((l) => Object.fromEntries(parseCsvLine(l).map((v, i) => [cols[i], v])));
if (rows.some((r) => Object.keys(r).length !== cols.length)) throw new Error('Column count mismatch while re-reading CSV');

console.log(`File: ${file}`);
console.log(`Rows: ${rows.length}   Columns: ${cols.length}`);
console.log('\nNon-missing count and range per parameter:');
console.table(cfg.PARAMS.map((p) => {
  const v = rows.map((r) => r[p.key]).filter((x) => x !== '').map(Number);
  return { parameter: p.key, non_missing: v.length, pct_missing: +(100 * (1 - v.length / rows.length)).toFixed(1), min: Math.min(...v), max: Math.max(...v), any_NaN: v.some(Number.isNaN) };
}));
console.log('\nRecords per river:', rows.reduce((o, r) => ((o[r.water_body] = (o[r.water_body] || 0) + 1), o), {}));
console.log('Duplicate (station_id, period) keys:', rows.length - new Set(rows.map((r) => `${r.station_id}|${r.period}`)).size);
console.log('Rows with flags -> censored:', rows.filter((r) => r.censored_fields).length, '| imputed:', rows.filter((r) => r.imputed_fields).length, '| outlier:', rows.filter((r) => r.outlier_fields).length);
