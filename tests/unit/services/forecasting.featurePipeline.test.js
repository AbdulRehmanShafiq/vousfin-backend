/**
 * tests/unit/services/forecasting.featurePipeline.test.js
 *
 * Feature Engineering Framework — families catalog + engineering pipeline.
 */
'use strict';

const catalog = require('../../../services/forecasting/featureEngineering/catalog');
const { engineer } = require('../../../services/forecasting/featureEngineering/pipeline');

describe('feature families catalog', () => {
  it('declares all five families with features', () => {
    expect(catalog.listFamilies()).toEqual(
      expect.arrayContaining(['financial_health', 'behavioral', 'seasonality', 'risk', 'macro']));
    expect(catalog.count()).toBeGreaterThan(25);
    expect(catalog.flatten().every((f) => f.leakageSafe)).toBe(true);
  });
});

describe('engineering pipeline (leakage-safe)', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    periodKey: `2026-${String(i + 1).padStart(2, '0')}`,
    periodEnd: new Date(2026, i + 1, 1),
    revenue: 1000 + i * 100, expenses: 600 + i * 40,
    profit: 400 + i * 60, netCashFlow: 380 + i * 55,
    arNew: 500, cashInflow: 450, apNew: 300, cashOutflow: 280,
    activeCustomers: 20 + (i % 3),
  }));

  const { features, columns, leakageSafe } = engineer(rows, { anomalyRisk: { riskScore: 0.2 }, periods: [12, 4] });

  it('produces one feature object per period with the family features present', () => {
    expect(features).toHaveLength(10);
    const f = features[5];
    expect(f).toHaveProperty('revenue_growth');
    expect(f).toHaveProperty('profit_margin');
    expect(f).toHaveProperty('volatility');
    expect(f).toHaveProperty('regime_shift');
    expect(f).toHaveProperty('collection_velocity');
    expect(f).toHaveProperty('fourier_sin_12_1');
  });

  it('keeps lags causal (first period has no growth / lag)', () => {
    expect(features[0].revenue_growth).toBeNull();
    expect(features[0].revenue_lag1).toBeNull();
    expect(features[1].revenue_lag1).toBe(1000);
  });

  it('computes financial-health ratios correctly', () => {
    // profit_margin period 0 = 400/1000 = 0.4
    expect(features[0].profit_margin).toBeCloseTo(0.4, 3);
    // revenue_growth period 1 = (1100-1000)/1000 = 10%
    expect(features[1].revenue_growth).toBe(10);
  });

  it('carries fraud influence from the anomaly risk score', () => {
    expect(features[3].fraud_influence).toBe(0.2);
    expect(features[3].anomaly_adjusted_trend).toBeCloseTo((1000 + 3 * 100) * 0.8, 0);
  });

  it('exposes aligned columns for selection (PCA / MI)', () => {
    expect(columns.revenue_growth).toHaveLength(10);
    expect(leakageSafe).toBe(true);
  });
});
