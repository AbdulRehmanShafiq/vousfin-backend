/**
 * tests/unit/services/forecastPlatform.featureStore.test.js
 *
 * Forecast Platform — Foundation (F1). Feature engineering:
 * leakage-safety (period t uses only ≤ t), lag/rolling/momentum math, and the
 * knowledgeDate stamp that powers reproducible historical snapshots.
 */
'use strict';

jest.mock('../../../models/ForecastFeatureSnapshot.model', () => ({ bulkWrite: jest.fn(), find: jest.fn() }));
jest.mock('../../../models/ForecastDatasetRegistry.model', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../../../services/forecasting/platform/datasetBuilder.service', () => ({ buildDataset: jest.fn() }));

const { computeFeatures } = require('../../../services/forecasting/platform/featureStore.service');

const mkRow = (key, start, end, rev, exp, arNew = 0, apNew = 0) => ({
  periodKey: key, periodStart: new Date(start), periodEnd: new Date(end),
  baseCurrency: 'USD', revenue: rev, expenses: exp, netCashFlow: rev - exp, arNew, apNew, entries: 5,
});

const series = [
  mkRow('2026-01', '2026-01-01', '2026-02-01', 100, 60, 120, 50),
  mkRow('2026-02', '2026-02-01', '2026-03-01', 120, 70, 130, 55),
  mkRow('2026-03', '2026-03-01', '2026-04-01', 90,  80, 110, 60),
];

describe('computeFeatures', () => {
  const out = computeFeatures(series);

  it('produces one feature row per period with a leakage-safe knowledgeDate (= period close)', () => {
    expect(out).toHaveLength(3);
    expect(out[1].knowledgeDate.toISOString().slice(0, 10)).toBe('2026-03-01');
  });

  it('computes lags only from prior periods (no future leakage)', () => {
    expect(out[0].features.revenue_lag1).toBeNull();          // nothing before period 0
    expect(out[1].features.revenue_lag1).toBe(100);           // = period 0 revenue
    expect(out[2].features.revenue_lag1).toBe(120);           // = period 1 revenue
  });

  it('computes MoM growth and rolling stats from the trailing window', () => {
    expect(out[1].features.revenue_mom_pct).toBe(20);         // (120-100)/100
    expect(out[2].features.revenue_mom_pct).toBe(-25);        // (90-120)/120
    expect(out[2].features.revenue_roll3_mean).toBe(Math.round(((100 + 120 + 90) / 3) * 100) / 100);
  });

  it('carries AR/AP exposure features and the realized target', () => {
    expect(out[0].features.ar_minus_ap).toBe(70);             // 120 - 50
    expect(out[2].target).toEqual({ revenue: 90, expenses: 80, netCashFlow: 10 });
  });

  it('is deterministic and never reads ahead — last row equals a recompute on the prefix', () => {
    const prefixOut = computeFeatures(series.slice(0, 2));
    // row 1's features must be identical whether or not row 2 exists (no look-ahead)
    expect(out[1].features).toEqual(prefixOut[1].features);
  });
});
