/**
 * tests/unit/services/forecasting.mlMembers.test.js
 *
 * Forecast Platform — ElasticNet + auto-ETS members and their integration into
 * the ensemble.
 */
'use strict';

const { elasticNetForecaster, fitElasticNet } = require('../../../services/forecasting/elasticNet');
const { etsForecaster, aicc } = require('../../../services/forecasting/ets');
const ensemble = require('../../../services/forecasting/ensemble');

describe('ElasticNet AR member', () => {
  it('tracks a linear trend and returns the right length', () => {
    const trend = [10, 20, 30, 40, 50, 60, 70, 80];
    const f = elasticNetForecaster(trend, 3, { p: 3 });
    expect(f).toHaveLength(3);
    expect(f[0]).toBeGreaterThan(75);
  });
  it('L1 shrinks coefficients toward zero (sparsity) with strong regularization', () => {
    const X = [[1, 0.5], [2, 1], [3, 1.5], [4, 2], [5, 2.5]];
    const y = [1, 2, 3, 4, 5];
    const lo = fitElasticNet(X, y, { alpha: 0.001, l1Ratio: 0.5 });
    const hi = fitElasticNet(X, y, { alpha: 100, l1Ratio: 1.0 });
    const mag = (c) => Math.abs(c[1]) + Math.abs(c[2]);
    expect(mag(hi)).toBeLessThan(mag(lo));     // heavier L1 → smaller coefs
  });
  it('falls back gracefully on a too-short series', () => {
    expect(elasticNetForecaster([5], 2)).toEqual([5, 5]);
  });
});

describe('auto-ETS member', () => {
  it('forecasts a trending series and picks a finite-AICc model', () => {
    const trend = [10, 20, 30, 40, 50, 60, 70, 80];
    const f = etsForecaster(trend, 2, { period: 3 });
    expect(f).toHaveLength(2);
    expect(f[1]).toBeGreaterThanOrEqual(f[0]);
  });
  it('aicc penalizes more parameters', () => {
    expect(aicc(100, 20, 2)).toBeLessThan(aicc(100, 20, 5));
  });
  it('handles a seasonal series', () => {
    const seasonal = [10, 20, 15, 12, 22, 17, 14, 24, 19, 16, 26, 21];
    const f = etsForecaster(seasonal, 3, { period: 3 });
    expect(f).toHaveLength(3);
    f.forEach((v) => expect(v).toBeGreaterThanOrEqual(0));
  });
});

describe('ensemble now runs six members', () => {
  it('includes ElasticNet + ETS and weights still sum to ~1', () => {
    const series = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const { weights, memberEvals } = ensemble.computeWeights(series, ensemble.defaultMembers(3), { horizon: 1, period: 3 });
    expect(Object.keys(memberEvals)).toEqual(expect.arrayContaining(['ets', 'elasticNet', 'holtWinters', 'arRegression']));
    const sum = Object.values(weights).reduce((s, w) => s + w, 0);
    expect(sum).toBeGreaterThan(0.97);
    expect(sum).toBeLessThan(1.03);
  });
});
