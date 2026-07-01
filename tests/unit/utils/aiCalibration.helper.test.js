'use strict';
const { computeRates, effectiveAutoPostThreshold } = require('../../../utils/aiCalibration.helper');

describe('computeRates', () => {
  it('computes acceptance/correction/reversal over resolved decisions', () => {
    const r = computeRates({ pending: 10, accepted: 70, corrected: 20, reversed: 10 });
    expect(r.total).toBe(110);
    expect(r.resolved).toBe(100);
    expect(r.acceptanceRate).toBe(0.7);
    expect(r.correctionRate).toBe(0.2);
    expect(r.reversalRate).toBe(0.1);
  });

  it('returns zero rates when nothing is resolved (no divide-by-zero)', () => {
    const r = computeRates({ pending: 5, accepted: 0, corrected: 0, reversed: 0 });
    expect(r.resolved).toBe(0);
    expect(r.acceptanceRate).toBe(0);
    expect(r.reversalRate).toBe(0);
  });
});

describe('effectiveAutoPostThreshold', () => {
  const base = 0.98;

  it('returns the base threshold when there is too little signal', () => {
    const rates = computeRates({ pending: 0, accepted: 5, corrected: 0, reversed: 0 });
    expect(effectiveAutoPostThreshold(base, rates, { minSamples: 20 })).toBe(base);
  });

  it('never lowers the threshold below base even with a perfect record', () => {
    const rates = computeRates({ pending: 0, accepted: 100, corrected: 0, reversed: 0 });
    expect(effectiveAutoPostThreshold(base, rates)).toBe(base);
  });

  it('raises the threshold (more conservative) when reversals occur', () => {
    const rates = computeRates({ pending: 0, accepted: 80, corrected: 10, reversed: 10 });
    const t = effectiveAutoPostThreshold(base, rates);
    expect(t).toBeGreaterThan(base);
    expect(t).toBeLessThanOrEqual(0.995);
  });

  it('caps the tightening at 0.995 no matter how bad the record', () => {
    const rates = computeRates({ pending: 0, accepted: 0, corrected: 0, reversed: 100 });
    expect(effectiveAutoPostThreshold(base, rates)).toBe(0.995);
  });
});
