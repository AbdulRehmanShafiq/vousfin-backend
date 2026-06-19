// tests/unit/services/breakEven.service.test.js
'use strict';
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockAggregate = jest.fn();
jest.mock('../../../models/JournalEntry.model', () => ({ aggregate: (...a) => mockAggregate(...a) }));
jest.mock('../../../repositories/transaction.repository', () => ({
  EFFECTIVE_LINES_STAGE: { $addFields: { effectiveLines: '$x' } }, REPORT_STATUSES: ['posted'],
}));
const be = require('../../../services/breakEven.service');
const BIZ = '507f1f77bcf86cd799439011';

describe('breakEven.breakEvenPoint', () => {
  test('BEP units + revenue when price > variable', () => {
    const r = be.breakEvenPoint({ fixedCosts: 300000, pricePerUnit: 500, variableCostPerUnit: 300 });
    expect(r.feasible).toBe(true);
    expect(r.breakEvenUnits).toBe(1500);
    expect(r.breakEvenRevenue).toBe(750000);
    expect(r.cmPerUnit).toBe(200);
  });
  test('infeasible when price <= variable', () => {
    expect(be.breakEvenPoint({ fixedCosts: 1, pricePerUnit: 100, variableCostPerUnit: 100 }).feasible).toBe(false);
  });
});

describe('breakEven.whatIf', () => {
  test('projected profit and units for target profit', () => {
    const r = be.whatIf({ fixedCosts: 300000, pricePerUnit: 500, variableCostPerUnit: 300, expectedUnits: 2000, targetProfit: 100000 });
    expect(r.projectedProfit).toBe(100000);   // 2000*200 - 300000
    expect(r.unitsForTargetProfit).toBe(2000); // (300000+100000)/200
  });
});

describe('breakEven.estimateFromActuals', () => {
  test('splits expenses into variable (Direct Cost) vs fixed', async () => {
    mockAggregate.mockResolvedValue([{ _id: null, revenue: 1000000, variableCosts: 600000, fixedCosts: 250000 }]);
    const r = await be.estimateFromActuals(BIZ, { from: '2026-01-01', to: '2026-12-31' });
    expect(r).toMatchObject({ revenue: 1000000, variableCosts: 600000, fixedCosts: 250000 });
  });
});
