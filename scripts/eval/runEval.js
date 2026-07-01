// scripts/eval/runEval.js — offline AI evaluation harness (deterministic, no LLM).
//
// Scores the pure NL type-mapping layer against a golden set and fails on any
// regression versus scripts/eval/baseline.json. This is the seed of the
// Intelligence Roadmap's eval-gated release discipline — extend it with more
// capabilities (account resolution, categorization) over time.
'use strict';
const fs = require('fs');
const path = require('path');
const { mapTransactionTypeForApi } = require('../../utils/nlParserPreview.helper');
const { scoreClassification, compareToBaseline } = require('../../utils/evalMetrics');

function load(rel) { return JSON.parse(fs.readFileSync(path.join(__dirname, rel), 'utf8')); }

function run() {
  const golden = load('golden/nl-parse.golden.json');
  const baseline = load('baseline.json');

  const predictions = golden.map((g) => ({ expectedType: mapTransactionTypeForApi(g.nlType) }));
  const goldens = golden.map((g) => ({ expectedType: g.expectedType }));
  const typeScore = scoreClassification(predictions, goldens, 'expectedType');

  const current = { nlTypeMappingAccuracy: typeScore.accuracy };
  const cmp = compareToBaseline(current, baseline, { tolerance: 0 });

  console.log('── VousFin AI Evaluation ─────────────────────────────');
  console.log(`NL type-mapping accuracy: ${typeScore.correct}/${typeScore.total} = ${typeScore.accuracy}`);
  if (!cmp.pass) {
    console.error('REGRESSION vs baseline:');
    cmp.regressions.forEach((r) => console.error(`  ${r.metric}: ${r.current} < ${r.baseline}`));
    process.exit(1);
  }
  console.log('PASS — no regression vs baseline.');
  process.exit(0);
}

run();
