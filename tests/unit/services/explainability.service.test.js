/**
 * tests/unit/services/explainability.service.test.js
 *
 * Forecast Platform — F7. Explainability orchestrator: member + driver
 * attribution with a narrative, and the what-if scenario path.
 */
'use strict';

jest.mock('../../../services/forecasting/lstmForecastService', () => ({ fetchMonthlyData: jest.fn() }));

const svc = require('../../../services/forecasting/explainability.service');
const lstm = require('../../../services/forecasting/lstmForecastService');

const BIZ = '507f1f77bcf86cd799439060';
const monthly = Array.from({ length: 12 }, (_, i) => ({ revenue: 1000 + i * 80, expenses: 500 + i * 30, profit: 500 + i * 50 }));

beforeEach(() => { jest.clearAllMocks(); lstm.fetchMonthlyData.mockResolvedValue(monthly); });

it('explains a forecast with member contributions, drivers and a narrative', async () => {
  const r = await svc.explain(BIZ, 'Revenue', 6);
  expect(r.memberContributions.length).toBeGreaterThan(1);   // multi-model
  expect(r.drivers.length).toBeGreaterThanOrEqual(1);
  expect(typeof r.narrative).toBe('string');
  expect(r.narrative).toMatch(/revenue/i);
  // member pct shares are sensible
  expect(r.memberContributions[0]).toHaveProperty('pct');
});

it('returns insufficient on too-short history', async () => {
  lstm.fetchMonthlyData.mockResolvedValue([{ revenue: 100 }, { revenue: 110 }]);
  expect((await svc.explain(BIZ, 'Revenue', 6)).insufficient).toBe(true);
});

it('runs a +20% revenue scenario and compares to the base', async () => {
  const r = await svc.scenario(BIZ, 'Revenue', 4, { revenueMultiplier: 1.2 });
  expect(r.base).toHaveLength(4);
  expect(r.scenario).toHaveLength(4);
  expect(r.comparison).toHaveLength(4);
  expect(r.scenario[0]).toBeGreaterThan(r.base[0]);          // +20% lifts the path
  expect(r.shocks.multiplier).toBe(1.2);
});
