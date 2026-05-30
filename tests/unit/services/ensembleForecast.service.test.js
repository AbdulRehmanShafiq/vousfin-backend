/**
 * tests/unit/services/ensembleForecast.service.test.js
 *
 * Forecast Platform — F4. Ensemble orchestrator: point forecast + conformal
 * intervals from a series, and graceful insufficiency handling.
 */
'use strict';

const svc = require('../../../services/forecasting/ensembleForecast.service');

describe('computeFromSeries', () => {
  it('returns an ensemble point forecast with conformal intervals around it', () => {
    const series = [10, 12, 11, 13, 12, 14, 13, 15, 14, 16, 15, 17];
    const r = svc.computeFromSeries(series, { horizon: 3, period: 3, alpha: 0.1 });
    expect(r).not.toBeNull();
    expect(r.predicted).toHaveLength(3);
    expect(r.lower).toHaveLength(3);
    expect(r.upper).toHaveLength(3);
    // intervals bracket the point forecast
    r.predicted.forEach((v, i) => {
      expect(r.lower[i]).toBeLessThanOrEqual(v);
      expect(r.upper[i]).toBeGreaterThanOrEqual(v);
    });
    expect(r.coverageTarget).toBe(90);
    expect(r.modelType).toMatch(/Ensemble/);
    expect(Object.keys(r.weights).length).toBeGreaterThan(1); // genuinely multi-model
  });

  it('returns null when history is too short (caller falls back)', () => {
    expect(svc.computeFromSeries([1, 2], { horizon: 3 })).toBeNull();
  });
});
