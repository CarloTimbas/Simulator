'use strict';
/**
 * utils.js — small, dependency-free helpers shared by all three modules.
 * Keeping these here (instead of pulling in lodash / simple-statistics / fast-csv)
 * means every line of the pipeline can be explained on camera.
 */
const fs = require('fs');
const path = require('path');

/** True for null / undefined / '' / whitespace-only strings. */
const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** Collapse runs of whitespace into one space and trim ("Tabing  ilog   Bridge " -> "Tabing ilog Bridge"). */
const collapseWs = (s) => String(s).replace(/\s+/g, ' ').trim();

const pad2 = (n) => String(n).padStart(2, '0');

/** Round to a fixed number of decimals and return a Number (avoids 0.30000000000000004 in the CSV). */
const round = (x, d = 6) => (x === null || x === undefined ? x : Number(x.toFixed(d)));

/**
 * Quantile with linear interpolation (the same "type 7" rule used by NumPy / R default / Excel QUARTILE.INC).
 * @param {number[]} sortedAsc ascending-sorted numbers
 * @param {number} p probability 0..1
 */
function quantile(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sortedAsc[lo] + (h - lo) * (sortedAsc[hi] - sortedAsc[lo]);
}

/** Sample skewness (Fisher-Pearson, g1). > 1 or < -1 means strongly skewed. */
function skewness(arr) {
  const n = arr.length;
  if (n < 3) return NaN;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const m2 = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const m3 = arr.reduce((a, b) => a + (b - mean) ** 3, 0) / n;
  return m3 / Math.pow(m2, 1.5);
}

const median = (arr) => quantile([...arr].sort((a, b) => a - b), 0.5);

/** Group an array into a Map keyed by keyFn(item). */
function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

/** Count occurrences: ['a','b','a'] -> { a: 2, b: 1 } */
function countBy(arr, keyFn = (x) => x) {
  const o = {};
  for (const x of arr) {
    const k = keyFn(x);
    o[k] = (o[k] || 0) + 1;
  }
  return o;
}

/** RFC-4180 CSV escaping. null/undefined -> empty cell. */
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Write an array of plain objects to CSV using an explicit column order. */
function writeCsv(file, columns, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvEscape(r[c])).join(','));
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

/** Pretty console banner so the live demo is easy to follow. */
function banner(title) {
  const line = '='.repeat(78);
  console.log(`\n${line}\n  ${title}\n${line}`);
}

module.exports = { isBlank, collapseWs, pad2, round, quantile, skewness, median, groupBy, countBy, csvEscape, writeCsv, banner };
