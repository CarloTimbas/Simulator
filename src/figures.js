'use strict';
/**
 * figures.js — turn the preprocessing report into paper-ready SVG charts.
 * Run: node src/figures.js -> data/processed/figures/*.svg
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const PARAMETER_LABELS = {
  do_mg_l: 'Dissolved oxygen (mg/L)',
  ph: 'pH',
  temp_c: 'Temperature (°C)',
  bod_mg_l: 'Biochemical oxygen demand (mg/L)',
  tss_mg_l: 'Total suspended solids (mg/L)',
  color_tcu: 'Color (TCU)',
  fecal_coliform_mpn_100ml: 'Fecal coliform (MPN/100 mL)',
  total_coliform_mpn_100ml: 'Total coliform (MPN/100 mL)',
  ammonia_mg_l: 'Ammonia (mg/L)',
  nitrate_n_mg_l: 'Nitrate-N (mg/L)',
  phosphate_p_mg_l: 'Phosphate-P (mg/L)',
  chloride_mg_l: 'Chloride (mg/L)',
};

/** Horizontal grouped bar chart. series = [{name, color, values[]}], categories = labels. */
function barChartSVG({ title, categories, series, xLabel, maxValue, tickStep, valueLabel = (v) => String(v), width = 1040 }) {
  const left = 300, right = 62, top = 78, bottom = 58, rowH = 34;
  const h = top + categories.length * rowH + bottom;
  const max = maxValue || Math.max(1, ...series.flatMap((s) => s.values));
  const step = tickStep || Math.max(1, Math.ceil(max / 5));
  const plotW = width - left - right;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" role="img" aria-label="${esc(title)}" font-family="Arial, sans-serif" font-size="13">`;
  svg += `<rect width="100%" height="100%" fill="#fff"/><text x="${width / 2}" y="30" text-anchor="middle" font-size="17" font-weight="bold">${esc(title)}</text>`;
  series.forEach((s, i) => {
    const x = left + i * 210;
    svg += `<rect x="${x}" y="48" width="13" height="13" fill="${s.color}"/><text x="${x + 20}" y="59">${esc(s.name)}</text>`;
  });
  for (let tick = 0; tick <= max; tick += step) {
    const x = left + (tick / max) * plotW;
    svg += `<line x1="${x}" y1="${top - 5}" x2="${x}" y2="${h - bottom}" stroke="#d9dee5" stroke-width="1"/>`;
    svg += `<text x="${x}" y="${h - bottom + 18}" text-anchor="middle" font-size="11" fill="#444">${tick}</text>`;
  }
  categories.forEach((c, i) => {
    const y = top + i * rowH;
    svg += `<text x="${left - 12}" y="${y + rowH / 2 + 4}" text-anchor="end">${esc(c)}</text>`;
    series.forEach((s, j) => {
      const value = s.values[i];
      const barW = (value / max) * plotW;
      const barY = y + j * 15;
      svg += `<rect x="${left}" y="${barY}" width="${barW}" height="12" fill="${s.color}"/>`;
      svg += `<text x="${left + barW + 5}" y="${barY + 10}" font-size="11">${esc(valueLabel(value))}</text>`;
    });
  });
  svg += `<text x="${left + plotW / 2}" y="${h - 12}" text-anchor="middle">${esc(xLabel)}</text></svg>`;
  return svg;
}

function recordRetentionSVG(rep) {
  const width = 820, height = 290;
  const before = rep.before.raw_station_records;
  const removed = rep.cleaning.empty_template_records_removed.removed;
  const retained = rep.cleaning.records_out;
  const duplicateRemoved = rep.cleaning.duplicate_detection.reduce((n, step) => n + step.removed, 0);
  const noSamplingRemoved = rep.cleaning.empty_template_records_removed.of_which_NO_SAMPLING_CONDUCTED_text;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Record retention during preprocessing" font-family="Arial, sans-serif">
  <rect width="100%" height="100%" fill="#fff"/>
  <text x="410" y="32" text-anchor="middle" font-size="17" font-weight="bold">Figure 3. Record retention during preprocessing</text>
  <rect x="50" y="82" width="205" height="100" rx="8" fill="#e8eef5" stroke="#6b7c93" stroke-width="2"/>
  <text x="152" y="119" text-anchor="middle" font-size="14">Raw station records</text><text x="152" y="153" text-anchor="middle" font-size="24" font-weight="bold">${before.toLocaleString('en-US')}</text>
  <line x1="255" y1="132" x2="360" y2="132" stroke="#607080" stroke-width="3"/><polygon points="360,132 347,124 347,140" fill="#607080"/>
  <rect x="370" y="69" width="205" height="126" rx="8" fill="#f9e8df" stroke="#c47754" stroke-width="2"/>
  <text x="472" y="105" text-anchor="middle" font-size="14">Empty template rows removed</text><text x="472" y="139" text-anchor="middle" font-size="24" font-weight="bold">${removed.toLocaleString('en-US')}</text>
  <text x="472" y="166" text-anchor="middle" font-size="12">${duplicateRemoved} duplicates removed</text>
  <line x1="575" y1="132" x2="640" y2="132" stroke="#607080" stroke-width="3"/><polygon points="640,132 627,124 627,140" fill="#607080"/>
  <rect x="650" y="82" width="145" height="100" rx="8" fill="#e2f0e7" stroke="#5d9270" stroke-width="2"/>
  <text x="722" y="119" text-anchor="middle" font-size="14">Records retained</text><text x="722" y="153" text-anchor="middle" font-size="24" font-weight="bold">${retained.toLocaleString('en-US')}</text>
  <text x="410" y="235" text-anchor="middle" font-size="12" fill="#444">${noSamplingRemoved} of the removed rows were explicitly labeled “NO SAMPLING CONDUCTED.”</text>
  <text x="410" y="257" text-anchor="middle" font-size="12" fill="#444">No duplicate groups were detected; removed rows were empty templates.</text></svg>`;
}

function skewnessSVG(rep) {
  const metrics = [
    { label: 'Fecal coliform', raw: rep.after.skewness.fecal_coliform_mpn_100ml.skew_raw, transformed: rep.after.skewness.fecal_coliform_mpn_100ml.skew_log10 },
    { label: 'Total coliform', raw: rep.after.skewness.total_coliform_mpn_100ml.skew_raw, transformed: rep.after.skewness.total_coliform_mpn_100ml.skew_log10 },
  ];
  const width = 860, height = 280, left = 180, right = 70, top = 76, bottom = 54;
  const xMin = -2, xMax = 16, plotW = width - left - right;
  const x = (v) => left + ((v - xMin) / (xMax - xMin)) * plotW;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Coliform skewness before and after log10 transformation" font-family="Arial, sans-serif" font-size="13">`;
  svg += `<rect width="100%" height="100%" fill="#fff"/><text x="${width / 2}" y="30" text-anchor="middle" font-size="17" font-weight="bold">Figure 4. Coliform skewness before and after log₁₀ transformation</text>`;
  svg += `<rect x="${left}" y="48" width="13" height="13" fill="#c0504d"/><text x="${left + 20}" y="59">Raw values</text><rect x="${left + 155}" y="48" width="13" height="13" fill="#4f81bd"/><text x="${left + 175}" y="59">Log₁₀ values</text>`;
  for (let tick = -2; tick <= 16; tick += 2) {
    const tickX = x(tick);
    svg += `<line x1="${tickX}" y1="${top - 8}" x2="${tickX}" y2="${height - bottom}" stroke="${tick === 0 ? '#555' : '#d9dee5'}" stroke-width="${tick === 0 ? 2 : 1}"/>`;
    svg += `<text x="${tickX}" y="${height - bottom + 18}" text-anchor="middle" font-size="11">${tick}</text>`;
  }
  metrics.forEach((m, i) => {
    const centerY = top + i * 65;
    svg += `<text x="${left - 12}" y="${centerY + 22}" text-anchor="end">${m.label}</text>`;
    [{ value: m.raw, color: '#c0504d', y: centerY }, { value: m.transformed, color: '#4f81bd', y: centerY + 20 }].forEach((d) => {
      const x0 = x(Math.min(0, d.value)), barW = Math.abs(x(d.value) - x(0));
      svg += `<rect x="${x0}" y="${d.y}" width="${barW}" height="12" fill="${d.color}"/><text x="${x(d.value) + (d.value < 0 ? -5 : 5)}" y="${d.y + 10}" text-anchor="${d.value < 0 ? 'end' : 'start'}" font-size="11">${d.value.toFixed(2)}</text>`;
    });
  });
  svg += `<text x="${left + plotW / 2}" y="${height - 12}" text-anchor="middle">Sample skewness (Fisher–Pearson g₁)</text>`;
  svg += `<text x="${width / 2}" y="${height - 34}" text-anchor="middle" font-size="10" fill="#555">Log₁₀ values are defined only for positive coliform counts.</text></svg>`;
  return svg;
}

function main() {
  const rep = JSON.parse(fs.readFileSync(path.join(cfg.OUTPUT_DIR, cfg.OUTPUT_REPORT), 'utf8'));
  const keys = cfg.PARAMS.map((p) => p.key);
  const outDir = path.join(cfg.OUTPUT_DIR, 'figures');
  fs.mkdirSync(outDir, { recursive: true });

  // Percentages use each dataset's own record count as the denominator.
  const nBefore = rep.before.raw_station_records;
  const fig1 = barChartSVG({
    title: 'Figure 1. Missing values by parameter before and after preprocessing',
    categories: keys.map((k) => PARAMETER_LABELS[k]),
    series: [
      { name: `Raw (n=${nBefore})`, color: '#c0504d', values: keys.map((k) => +((100 * rep.before.raw_missing_by_parameter[k]) / nBefore).toFixed(1)) },
      { name: `Preprocessed (n=${rep.after.records})`, color: '#4f81bd', values: keys.map((k) => rep.after.missing_pct_by_parameter[k]) },
    ],
    xLabel: 'Records missing the parameter (%) — denominators differ; residual gaps are largely structural',
    maxValue: 100,
    tickStep: 20,
    valueLabel: (v) => `${v.toFixed(1)}%`,
  });
  fs.writeFileSync(path.join(outDir, 'fig1_missing_before_after.svg'), fig1);

  // IQR fences are calculated per river; flagged observations are retained in the dataset.
  const hi = keys.map((k) => rep.outliers_iqr.filter((o) => o.parameter === k).reduce((a, o) => a + o.outliers_high, 0));
  const lo = keys.map((k) => rep.outliers_iqr.filter((o) => o.parameter === k).reduce((a, o) => a + o.outliers_low, 0));
  const fig2 = barChartSVG({
    title: 'Figure 2. Potential outliers flagged by the 1.5 × IQR rule',
    categories: keys.map((k) => PARAMETER_LABELS[k]),
    series: [{ name: 'High', color: '#e46c0a', values: hi }, { name: 'Low', color: '#4bacc6', values: lo }],
    xLabel: 'Number of flagged observations (per-river fences; flagged values retained)',
  });
  fs.writeFileSync(path.join(outDir, 'fig2_iqr_outliers.svg'), fig2);

  fs.writeFileSync(path.join(outDir, 'fig3_record_retention.svg'), recordRetentionSVG(rep));
  fs.writeFileSync(path.join(outDir, 'fig4_coliform_skewness.svg'), skewnessSVG(rep));
  console.log(`Figures written to ${outDir}`);
}

main();
