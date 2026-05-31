/**
 * tests/unit/services/domainForecast.service.test.js
 *
 * Forecast Platform — F6. Domain orchestrator wiring (mocked data sources).
 */
'use strict';

jest.mock('../../../models/ChartOfAccount.model', () => ({ aggregate: jest.fn() }));
jest.mock('../../../models/Invoice.model', () => ({ find: jest.fn() }));
jest.mock('../../../models/InventoryItem.model', () => ({ aggregate: jest.fn() }));
jest.mock('../../../models/CurrencyRate.model', () => ({ aggregate: jest.fn() }));
jest.mock('../../../services/forecasting/lstmForecastService', () => ({ fetchMonthlyData: jest.fn() }));
jest.mock('../../../services/forecasting/forecastStore.service', () => ({ recordForecast: jest.fn().mockResolvedValue({}) }));

const svc = require('../../../services/forecasting/domainForecast.service');
const ChartOfAccount = require('../../../models/ChartOfAccount.model');
const Invoice = require('../../../models/Invoice.model');
const InventoryItem = require('../../../models/InventoryItem.model');
const lstm = require('../../../services/forecasting/lstmForecastService');

const BIZ = '507f1f77bcf86cd799439060';
const monthly = Array.from({ length: 12 }, (_, i) => ({
  year: 2025, month: i + 1, revenue: 1000 + i * 50, expenses: 600 + i * 20,
  profit: 340 + i * 25, cashFlow: 400 + i * 30,
}));

beforeEach(() => {
  jest.clearAllMocks();
  lstm.fetchMonthlyData.mockResolvedValue(monthly);
  ChartOfAccount.aggregate.mockResolvedValue([]);
  InventoryItem.aggregate.mockResolvedValue([{ _id: null, stockValue: 5000, items: 10, lowStock: 1 }]);
});

it('profitability returns an ensemble forecast', async () => {
  const r = await svc.profitability(BIZ, 4);
  expect(r.domain).toBe('profitability');
  expect(r.predicted).toHaveLength(4);
  expect(r.modelType).toMatch(/Ensemble/);
});

it('liquidity stress returns VaR + ruin probability + trajectory', async () => {
  ChartOfAccount.aggregate.mockResolvedValue([{ _id: null, cash: 15000 }]); // _currentCash
  const r = await svc.liquidityStress(BIZ, 6);
  expect(r.domain).toBe('liquidity_stress');
  expect(r).toHaveProperty('ruinProbability');
  expect(r).toHaveProperty('valueAtRisk');
  expect(r.expectedCashTrajectory.length).toBe(6);
});

it('debt exposure returns liabilities + coverage ratios', async () => {
  ChartOfAccount.aggregate.mockResolvedValue([{ _id: 'Liability', total: 4000 }, { _id: 'Asset', total: 12000 }]);
  const r = await svc.debtExposure(BIZ, 6);
  expect(r.domain).toBe('debt_exposure');
  expect(r.currentLiabilities).toBe(4000);
  expect(r.debtToAssetRatio).toBeCloseTo(4000 / 12000, 3);
  expect(r.coverageRatio).toBeCloseTo(3, 3);
});

it('AR payment behavior returns a survival-based collection schedule', async () => {
  const now = Date.now();
  const days = (n) => new Date(now - n * 86400000);
  Invoice.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([
    { issueDate: days(40), updatedAt: days(10), state: 'paid', remainingBalance: 0, totalAmount: 500 },
    { issueDate: days(50), updatedAt: days(20), state: 'paid', remainingBalance: 0, totalAmount: 700 },
    { issueDate: days(30), updatedAt: days(5),  state: 'paid', remainingBalance: 0, totalAmount: 400 },
    { issueDate: days(25), updatedAt: days(25), state: 'sent', remainingBalance: 600, totalAmount: 600 },
  ]) }) });
  const r = await svc.arPaymentBehavior(BIZ);
  expect(r.domain).toBe('ar_payment_behavior');
  expect(r.openReceivables).toBe(600);
  expect(r.collectionSchedule).toHaveLength(3);
  expect(r.medianDaysToPay).toBeGreaterThan(0);
});

it('inventory demand returns a forecast + current stock state', async () => {
  const r = await svc.inventoryDemand(BIZ, 5);
  expect(r.domain).toBe('inventory_demand');
  expect(r.demandForecast.length).toBe(5);
  expect(r.currentStockValue).toBe(5000);
  expect(r.lowStockItems).toBe(1);
});

it('macro sensitivity degrades gracefully without aligned FX', async () => {
  const CurrencyRate = require('../../../models/CurrencyRate.model');
  CurrencyRate.aggregate.mockResolvedValue([]);
  const r = await svc.macroSensitivity(BIZ);
  expect(r.domain).toBe('macro_sensitivity');
  expect(r.available).toBe(false);
});

it('forecast() rejects an unknown domain', async () => {
  await expect(svc.forecast(BIZ, 'nonsense', 6)).rejects.toThrow(/Unknown domain/);
});
