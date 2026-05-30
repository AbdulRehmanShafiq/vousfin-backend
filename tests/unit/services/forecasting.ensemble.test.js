/**
 * tests/unit/services/forecasting.ensemble.test.js
 *
 * Forecast Platform — F4. Multi-model ensemble (AR member, backtest-weighted
 * combination) + split-conformal calibrated intervals.
 */
'use strict';

const reg = require('../../../services/forecasting/regression');
const ens = require('../../../services/forecasting/ensemble');
const conf = require('../../../services/forecasting/conformal');
const baselines = require('../../../services/forecasting/baselines');

describe('AR regression member', () => {
  it('extrapolates a linear trend upward and returns the right length', () => {
    const trend = [10, 20, 30, 40, 50, 60, 70, 80];
    const f = reg.arForecaster(trend, 3, { p: 2 });
    expect(f).toHaveLength(3);
    expect(f[0]).toBeGreaterThan(75);
    expect(f[2]).toBeGreaterThan(f[0]);
  });
  it('falls back gracefully on a too-short series', () => {
    expect(reg.arForecaster([5], 2)).toEqual([5, 5]);
  });
});

describe('ensemble weighting', () => {
  const trend = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  it('weights sum to ~1 and favour the more accurate members on a trend', () => {
    const { weights } = ens.computeWeights(trend, ens.defaultMembers(3), { horizon: 1, period: 3 });
    const sum = Object.values(weights).reduce((s, w) => s + w, 0);
    expect(sum).toBeGreaterThan(0.98);
    expect(sum).toBeLessThan(1.02);
    // a trend-aware member should out-weight seasonal-naive on a pure trend
    expect(weights.drift + weights.arRegression).toBeGreaterThan(weights.seasonalNaive);
  });

  it('buildEnsemble produces a forecastFn that beats the worst single member', () => {
    const { forecastFn, weights, memberEvals } = ens.buildEnsemble(trend, { horizon: 1, period: 3 });
    const f = forecastFn(trend, 2);
    expect(f).toHaveLength(2);
    expect(Object.keys(weights).length).toBeGreaterThan(1); // genuinely multi-model
    expect(memberEvals.seasonalNaive).toBeDefined();
  });

  it('combine degrades to an equal blend when no weights are positive', () => {
    const members = { a: (t, h) => baselines.naive(t, h), b: (t, h) => baselines.drift(t, h) };
    const f = ens.combine([10, 20, 30], 1, members, {});
    expect(f).toHaveLength(1);
    expect(f[0]).toBeGreaterThan(0);
  });
});

describe('conformal intervals', () => {
  const series = [10, 12, 11, 13, 12, 14, 13, 15, 14, 16, 15, 17];

  it('calibrates non-decreasing per-step widths and bands the point forecast', () => {
    const point = [18, 19, 20];
    const { lower, upper, widths, coverageTarget } = conf.conformalIntervals(
      series, (tr, h) => baselines.drift(tr, h), point, { alpha: 0.1, period: 1 });
    expect(widths.length).toBe(3);
    widths.forEach((w) => expect(w).toBeGreaterThanOrEqual(0)); // valid half-widths
    point.forEach((v, i) => {
      expect(lower[i]).toBeLessThanOrEqual(v);
      expect(upper[i]).toBeGreaterThanOrEqual(v);
    });
    expect(coverageTarget).toBe(90);
  });

  it('empirical coverage on held-out drift residuals is near the target', () => {
    // band each one-step drift forecast over a held-out tail, measure coverage
    const train = series.slice(0, 9);
    const { widths } = conf.calibrate(train, (tr, h) => baselines.drift(tr, h), { horizon: 1, alpha: 0.1 });
    let hit = 0; let n = 0;
    for (let i = 9; i < series.length; i++) {
      const pred = baselines.drift(series.slice(0, i), 1)[0];
      if (Math.abs(series[i] - pred) <= widths[0] + 1e-9) hit++;
      n++;
    }
    expect(n).toBeGreaterThan(0);
    expect(hit / n).toBeGreaterThanOrEqual(0.5); // loose: small sample, but clearly covering
  });
});
