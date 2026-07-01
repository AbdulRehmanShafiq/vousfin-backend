// utils/evalMetrics.js — pure metric computation for the AI evaluation harness.
'use strict';

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
const round4 = (n) => Math.round(n * 10000) / 10000;

/** Accuracy of predictions[key] vs goldens[key] (case-insensitive). */
function scoreClassification(predictions = [], goldens = [], key) {
  const total = Math.min(predictions.length, goldens.length);
  if (total === 0) return { total: 0, correct: 0, accuracy: 0 };
  let correct = 0;
  for (let i = 0; i < total; i++) {
    if (norm(predictions[i]?.[key]) === norm(goldens[i]?.[key])) correct++;
  }
  return { total, correct, accuracy: round4(correct / total) };
}

/** Fail if any current metric is below baseline − tolerance. */
function compareToBaseline(current = {}, baseline = {}, { tolerance = 0 } = {}) {
  const regressions = [];
  for (const metric of Object.keys(baseline)) {
    const cur = Number(current[metric]);
    const base = Number(baseline[metric]);
    if (Number.isFinite(cur) && Number.isFinite(base) && cur < base - tolerance) {
      regressions.push({ metric, current: cur, baseline: base });
    }
  }
  return { pass: regressions.length === 0, regressions };
}

module.exports = { scoreClassification, compareToBaseline };
