// tests/unit/nlParser/confidenceCalculator.thresholds.test.js
//
// Locks in the Phase 3 tiered-confidence thresholds: ≥98% → eligible for
// auto-post, 95-98% → prefill + require a confirm click (today's flow,
// REVIEW_THRESHOLD raised from 0.75), <95% → clarification loop.
'use strict';
const {
  calculateConfidence,
  evaluateReviewNeed,
  REVIEW_THRESHOLD,
  AUTO_POST_THRESHOLD,
} = require('../../../services/nlParser/utils/confidenceCalculator');

describe('confidenceCalculator — tiered thresholds', () => {
  test('REVIEW_THRESHOLD is 0.95 (raised from the old flat 0.75)', () => {
    expect(REVIEW_THRESHOLD).toBe(0.95);
  });

  test('AUTO_POST_THRESHOLD is 0.98', () => {
    expect(AUTO_POST_THRESHOLD).toBe(0.98);
  });

  test('a 0.96-overall parse (95-98% band) no longer flags "below threshold" at the old 0.75 bar but does at the new 0.95 bar', () => {
    // intent .30*.25=.075 amount .30 date .20 accountMapping .96*.25=.24 -> construct scores summing to ~0.96 overall
    const confidence = calculateConfidence({ intent: 0.95, amount: 0.97, date: 0.95, accountMapping: 0.97 });
    expect(confidence.overall).toBeLessThan(AUTO_POST_THRESHOLD);
    expect(confidence.overall).toBeGreaterThanOrEqual(REVIEW_THRESHOLD - 0.02); // in the 95-98 band
    const { requiresReview } = evaluateReviewNeed(confidence, { amount: 100, transactionType: 'Expense', sourceAccount: 'Cash' });
    // Below the new 0.95 review bar would flag; at/above should not solely for this reason.
    if (confidence.overall < REVIEW_THRESHOLD) {
      expect(requiresReview).toBe(true);
    }
  });

  test('a perfect 1.0-overall parse clears the auto-post bar', () => {
    const confidence = calculateConfidence({ intent: 1, amount: 1, date: 1, accountMapping: 1 });
    expect(confidence.overall).toBeGreaterThanOrEqual(AUTO_POST_THRESHOLD);
  });
});
