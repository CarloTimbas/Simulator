'use strict';
/**
 * figures.js — OPTIONAL helper that turns data/processed/MMORS_cleaning_report.json into report-ready SVG charts.
 * Zero dependencies (plain string templates), so it stays inside the "JavaScript only" rule and runs anywhere.
 * Run:  node src/figures.js      -> data/processed/figures/*.svg   (open in a browser, or paste into Word/Docs)
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Horizontal grouped bar chart. series = [{name, color, values[]}], categories = labels. */
function barChartSVG({ title, categories, series, xLabel, width = 860 }) {
  const rowH = 14 * series.length + 12, left = 190, top = 60, right = 30, bottom = 50;
  const h = top + categories.length * rowH + bottom;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const plotW = width - left - right;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" font-family="Arial, sans-serif" font-size="12">`;
  svg += `<rect width="100%" height="100%" fill="#fff"/><text x="${width / 2}" y="26" text-anchor="middle" font-size="16" font-weight="bold">${esc(title)}</text>`;
  series.forEach((s, i) => { svg += `<rect x="${left + i * 190}" y="38" width="12" height="12" fill="${s.color}"/><text x="${left + i * 190 + 18}" y="48">${esc(s.name)}</text>`; });
  categories.forEach((c, i) => {
    const y = top + i * rowH;
    svg += `<text x="${left - 8}" y="${y + rowH / 2}" text-anchor="end">${esc(c)}</text>`;
    series.forEach((s, j) => {
      const w = (s.values[i] / max) * plotW;
      svg += `<rect x="${left}" y="${y + j * 14}" width="${w}" height="12" fill="${s.color}"/><text x="${left + w + 4}" y="${y + j * 14 + 10}" font-size="11">${s.values[i]}</text>`;
    });
  });
  svg += `<line x1="${left}" y1="${top}" x2="${left}" y2="${h - bottom}" stroke="#333"/><text x="${left + plotW / 2}" y="${h - 12}" text-anchor="middle">${esc(xLabel)}</text></svg>`;
  return svg;
}

function main() {
  const rep = JSON.parse(fs.readFileSync(path.join(cfg.OUTPUT_DIR, cfg.OUTPUT_REPORT), 'utf8'));
  const keys = cfg.PARAMS.map((p) => p.key);
  const outDir = path.join(cfg.OUTPUT_DIR, 'figures');
  fs.mkdirSync(outDir, { recursive: true });

  // Figure 1: missing-value percentage per parameter, raw vs cleaned
  const nBefore = rep.before.raw_station_records;
  const fig1 = barChartSVG({
    title: 'Figure 1. Missing values per parameter: raw vs. cleaned (% of records)',
    categories: keys,
    series: [
      { name: `Raw (n=${nBefore})`, color: '#c0504d', values: keys.map((k) => +((100 * rep.before.raw_missing_by_parameter[k]) / nBefore).toFixed(1)) },
      { name: `Cleaned (n=${rep.after.records})`, color: '#4f81bd', values: keys.map((k) => rep.after.missing_pct_by_parameter[k]) },
    ],
    xLabel: '% of records with no value (remaining gaps are structural: parameter not monitored)',
  });
  fs.writeFileSync(path.join(outDir, 'fig1_missing_before_after.svg'), fig1);

  // Figure 2: IQR outliers flagged per parameter (summed over rivers)
  const hi = keys.map((k) => rep.outliers_iqr.filter((o) => o.parameter === k).reduce((a, o) => a + o.outliers_high, 0));
  const lo = keys.map((k) => rep.outliers_iqr.filter((o) => o.parameter === k).reduce((a, o) => a + o.outliers_low, 0));
  const fig2 = barChartSVG({
    title: 'Figure 2. Potential outliers flagged by the 1.5 x IQR rule (per-river fences)',
    categories: keys,
    series: [{ name: 'High', color: '#e46c0a', values: hi }, { name: 'Low', color: '#4bacc6', values: lo }],
    xLabel: 'Number of flagged values (kept in dataset, marked in outlier_fields)',
  });
  fs.writeFileSync(path.join(outDir, 'fig2_iqr_outliers.svg'), fig2);
  console.log(`Figures written to ${outDir}`);
}

main();
