/**
 * tests/unit/services/forecasting.domains.test.js
 *
 * Forecast Platform — F6. Domain science: Monte-Carlo liquidity VaR, Kaplan-Meier
 * payment survival, Croston intermittent demand, OLS macro sensitivity.
 */
'use strict';

const liq = require('../../../services/forecasting/domains/liquidityStress');
const surv = require('../../../services/forecasting/domains/survival');
const { croston } = require('../../../services/forecasting/domains/croston');
const sens = require('../../../services/forecasting/domains/sensitivity');

describe('liquidity stress — Monte-Carlo VaR', () => {
  it('is deterministic for a fixed seed', () => {
    const a = liq.monteCarloVaR(10000, [500, 600, 400, 550], { horizon: 6, sims: 500, seed: 42 });
    const b = liq.monteCarloVaR(10000, [500, 600, 400, 550], { horizon: 6, sims: 500, seed: 42 });
    expect(a.expectedEnding).toBe(b.expectedEnding);
    expect(a.ruinProbability).toBe(b.ruinProbability);
  });
  it('shows low ruin risk for healthy positive cash flow', () => {
    const r = liq.monteCarloVaR(20000, [800, 900, 700, 850, 820], { horizon: 6, sims: 1000, seed: 7 });
    expect(r.ruinProbability).toBeLessThan(0.1);
    expect(r.expectedEnding).toBeGreaterThan(20000);
  });
  it('shows high ruin risk for sustained negative cash flow', () => {
    const r = liq.monteCarloVaR(3000, [-800, -900, -700, -850], { horizon: 6, sims: 1000, seed: 7 });
    expect(r.ruinProbability).toBeGreaterThan(0.7);
    expect(r.valueAtRisk).toBeGreaterThan(0);
  });
});

describe('payment survival — Kaplan-Meier', () => {
  it('produces a non-increasing survival curve', () => {
    const curve = surv.kaplanMeier([10, 20, 20, 30, 45, 60]);
    for (let i = 1; i < curve.length; i++) expect(curve[i].survival).toBeLessThanOrEqual(curve[i - 1].survival);
    expect(curve[curve.length - 1].survival).toBeLessThan(1);
  });
  it('honors right-censoring (still-open invoices are not events)', () => {
    const paid = surv.kaplanMeier([10, 20, 30, 40], [1, 1, 1, 1]);
    const censored = surv.kaplanMeier([10, 20, 30, 40], [1, 1, 0, 0]);
    // censoring keeps survival higher (fewer observed payments)
    expect(censored[censored.length - 1].survival).toBeGreaterThanOrEqual(paid[paid.length - 1].survival);
  });
  it('derives median days-to-pay and a collection schedule', () => {
    const curve = surv.kaplanMeier([10, 20, 30, 40, 50, 60]);
    expect(surv.medianDaysToPay(curve)).toBeGreaterThan(0);
    const sched = surv.collectionSchedule(curve, 9000, { buckets: 3, bucketDays: 30 });
    expect(sched).toHaveLength(3);
    expect(sched.reduce((s, x) => s + x.expectedCollected, 0)).toBeGreaterThan(0);
  });
});

describe('inventory demand — Croston', () => {
  it('produces a positive rate for intermittent demand', () => {
    const r = croston([0, 0, 5, 0, 0, 8, 0, 6], { alpha: 0.2, horizon: 3 });
    expect(r.forecast).toHaveLength(3);
    expect(r.rate).toBeGreaterThan(0);
    expect(r.intermittent).toBe(true);
  });
  it('returns zero for all-zero demand', () => {
    expect(croston([0, 0, 0], { horizon: 2 }).forecast).toEqual([0, 0]);
  });
});

describe('macro sensitivity — OLS', () => {
  it('recovers slope and R² of a clean linear relationship', () => {
    const x = [1, 2, 3, 4, 5];
    const y = x.map((v) => 2 * v + 1);
    const m = sens.regress(x, y);
    expect(m.beta).toBeCloseTo(2, 3);
    expect(m.r2).toBeCloseTo(1, 3);
    expect(sens.project(m, 6)).toBe(13);
  });
  it('is safe on too-few points', () => {
    expect(sens.regress([1, 2], [1, 2]).beta).toBeNull();
  });
});
