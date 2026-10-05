'use strict';
/**
 * index.js — pipeline orchestrator.   Usage:
 *     node src/index.js              run everything
 *     node src/index.js --until=1    stop after Module 1 (inspection)
 *     node src/index.js --until=2    stop after Module 2 (cleaning)
 *
 *  Raw workbook -> Module 1 (inspect/standardize) -> Module 2 (clean/impute)
 *               -> Module 3 (outliers/validate/export) -> MMORS_water_quality_cleaned.csv
 */
const fs = require('fs');
const cfg = require('./config');
const { banner } = require('./utils');
const module1 = require('./module1_inspection');
const module2 = require('./module2_cleaning');
const module3 = require('./module3_outliers_validation');

function main() {
  const untilArg = process.argv.find((a) => a.startsWith('--until='));
  const until = untilArg ? Number(untilArg.split('=')[1]) : 3;

  if (!fs.existsSync(cfg.INPUT_FILE)) {
    console.error(`Input file not found:\n  ${cfg.INPUT_FILE}\nPut the original .xlsx in data/raw/ and re-run.`);
    process.exit(1);
  }
  const report = { generated_at: new Date().toISOString(), input_file: cfg.INPUT_FILE };

  banner('BEFORE  |  MODULE 1 — Load, inspect & standardize');
  let records = module1.run(cfg.INPUT_FILE, report);
  if (until < 2) return;

  banner('DURING  |  MODULE 2 — Clean, de-duplicate & handle missing values');
  records = module2.run(records, report);
  if (until < 3) return;

  banner('AFTER   |  MODULE 3 — Outliers, validation & export');
  const { checks, after } = module3.run(records, report);

  banner('BEFORE vs AFTER (headline numbers)');
  console.table([
    { metric: 'records',             before: report.before.raw_station_records, after: after.records },
    { metric: 'columns (parameters)', before: report.before.raw_parameter_columns, after: `${cfg.PARAMS.length} + derived/flags (${after.columns} total)` },
    { metric: 'text cells in numeric columns', before: Object.values(report.before.cell_type_profile).reduce((a, p) => a + p.text + p.blank_text, 0), after: 0 },
    { metric: 'distinct station spellings', before: report.before.distinct_raw_station_spellings, after: report.before.distinct_clean_station_names },
  ]);

  if (checks.some((c) => !c.passed)) {
    console.error('\nValidation FAILED — see table above.');
    process.exit(1);
  }
  console.log('\nAll validation checks passed. Dataset is analysis-ready.');
}

main();
