// services/forecasting/platform/dataValidation.js
//
// Forecast Platform — Foundation (F1). DATA VALIDATION FRAMEWORK.
//
// A lightweight, dependency-free "expectations" engine (the JS analogue of Great
// Expectations) that every built dataset must pass before it can be registered
// or fed to a model. Each expectation returns a structured result; the suite
// aggregates into a pass/fail report with severities.
//
// Critical forecasting checks included:
//   • no future-dated rows (leakage guard)
//   • monotonic, gap-classified period axis
//   • required columns present, non-null
//   • non-negative monetary magnitudes (after normalization)
//   • base currency stamped on every row
//
'use strict';

const SEVERITY = { ERROR: 'error', WARN: 'warn' };

function expectColumns(rows, cols) {
  const missing = [];
  if (rows.length) {
    for (const c of cols) if (!(c in rows[0])) missing.push(c);
  }
  return { name: 'columns_present', passed: missing.length === 0, severity: SEVERITY.ERROR, detail: { missing } };
}

function expectNoNulls(rows, cols) {
  const offenders = [];
  rows.forEach((r, i) => cols.forEach((c) => { if (r[c] == null) offenders.push({ row: i, col: c }); }));
  return { name: 'no_nulls', passed: offenders.length === 0, severity: SEVERITY.ERROR, detail: { count: offenders.length, sample: offenders.slice(0, 5) } };
}

function expectNonNegative(rows, cols) {
  const offenders = [];
  rows.forEach((r, i) => cols.forEach((c) => { if (typeof r[c] === 'number' && r[c] < 0) offenders.push({ row: i, col: c, value: r[c] }); }));
  return { name: 'non_negative', passed: offenders.length === 0, severity: SEVERITY.WARN, detail: { count: offenders.length, sample: offenders.slice(0, 5) } };
}

/** No row may be dated after `asOf` (knowledge cutoff) — the core leakage guard. */
function expectNoFutureDates(rows, dateField, asOf = new Date()) {
  const cutoff = new Date(asOf).getTime();
  const offenders = rows.filter((r) => r[dateField] && new Date(r[dateField]).getTime() > cutoff);
  return { name: 'no_future_dates', passed: offenders.length === 0, severity: SEVERITY.ERROR, detail: { count: offenders.length } };
}

/** Period axis must be strictly increasing (deduped, ordered). */
function expectMonotonicPeriods(rows, periodField = 'periodKey') {
  let ok = true; let breaks = 0;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][periodField]) <= String(rows[i - 1][periodField])) { ok = false; breaks++; }
  }
  return { name: 'monotonic_periods', passed: ok, severity: SEVERITY.ERROR, detail: { breaks } };
}

function expectCurrencyStamped(rows, field = 'baseCurrency') {
  const missing = rows.filter((r) => !r[field]).length;
  return { name: 'currency_stamped', passed: missing === 0, severity: SEVERITY.ERROR, detail: { missing } };
}

function expectMinRows(rows, min = 2) {
  return { name: 'min_rows', passed: rows.length >= min, severity: SEVERITY.WARN, detail: { rows: rows.length, min } };
}

/**
 * Run the full forecasting-dataset suite.
 * @returns {{ passed, errors, warnings, results, summary }}
 */
function validateDataset(rows, opts = {}) {
  const {
    requiredColumns = ['periodKey', 'periodStart', 'baseCurrency'],
    nonNullColumns  = ['periodKey', 'baseCurrency'],
    monetaryColumns = ['revenue', 'expenses'],
    dateField       = 'periodStart',
    asOf            = new Date(),
    minRows         = 2,
  } = opts;

  const results = [
    expectMinRows(rows, minRows),
    expectColumns(rows, requiredColumns),
    expectNoNulls(rows, nonNullColumns),
    expectNonNegative(rows, monetaryColumns),
    expectNoFutureDates(rows, dateField, asOf),
    expectMonotonicPeriods(rows, 'periodKey'),
    expectCurrencyStamped(rows, 'baseCurrency'),
  ];

  const errors   = results.filter((r) => !r.passed && r.severity === SEVERITY.ERROR);
  const warnings = results.filter((r) => !r.passed && r.severity === SEVERITY.WARN);
  return {
    passed: errors.length === 0,
    errors: errors.map((e) => e.name),
    warnings: warnings.map((w) => w.name),
    results,
    summary: `${results.filter((r) => r.passed).length}/${results.length} checks passed`,
  };
}

module.exports = {
  SEVERITY, validateDataset,
  expectColumns, expectNoNulls, expectNonNegative,
  expectNoFutureDates, expectMonotonicPeriods, expectCurrencyStamped, expectMinRows,
};
