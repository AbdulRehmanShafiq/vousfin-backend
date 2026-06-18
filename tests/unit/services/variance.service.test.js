// tests/unit/services/variance.service.test.js
'use strict';
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockAggregate = jest.fn();
jest.mock('../../../models/JournalEntry.model', () => ({ aggregate: (...a) => mockAggregate(...a) }));
jest.mock('../../../repositories/transaction.repository', () => ({
  EFFECTIVE_LINES_STAGE: { $addFields: { effectiveLines: '$x' } },
  REPORT_STATUSES: ['posted', 'partially_settled', 'settled'],
}));
jest.mock('../../../repositories/budget.repository', () => ({ findOwnedById: jest.fn() }));
jest.mock('../../../repositories/fiscalYear.repository', () => ({ findOwnedById: jest.fn(), findContaining: jest.fn() }));
jest.mock('../../../repositories/account.repository', () => ({ findByBusiness: jest.fn() }));
jest.mock('../../../models/FinancialAlert.model', () => ({ updateOne: jest.fn().mockResolvedValue({ upsertedCount: 1 }) }));

const variance = require('../../../services/variance.service');
const budgetRepo = require('../../../repositories/budget.repository');
const fyRepo = require('../../../repositories/fiscalYear.repository');
const accountRepo = require('../../../repositories/account.repository');

describe('variance.service — actualsByLine', () => {
  beforeEach(() => jest.clearAllMocks());
  test('returns a map keyed accountId|costCenterId with debit/credit sums', async () => {
    mockAggregate.mockResolvedValue([
      { _id: { accountId: 'a1', cc: null }, debit: 130000, credit: 0 },
      { _id: { accountId: 'rev', cc: null }, debit: 0, credit: 540000 },
    ]);
    const map = await variance.actualsByLine('507f1f77bcf86cd799439011', { from: new Date('2026-07-01'), to: new Date('2026-07-31') });
    expect(map['a1|']).toEqual({ debit: 130000, credit: 0 });
    expect(map['rev|']).toEqual({ debit: 0, credit: 540000 });
  });
});

describe('variance.service — computeVariance', () => {
  beforeEach(() => jest.clearAllMocks());

  function setup(lines, actuals, accounts) {
    budgetRepo.findOwnedById.mockResolvedValue({
      _id: 'b1', fiscalYearId: 'fy1', scenario: 'base', defaultThresholdPct: 10, lines,
    });
    fyRepo.findOwnedById.mockResolvedValue({ _id: 'fy1', startDate: new Date('2026-07-01'), endDate: new Date('2027-06-30') });
    accountRepo.findByBusiness.mockResolvedValue(accounts);
    jest.spyOn(variance, 'actualsByLine').mockResolvedValue(actuals);
  }

  test('expense over budget → unfavorable red, variance = actual − budget', async () => {
    setup(
      [{ accountId: 'a1', costCenterId: null, monthly: [100000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], thresholdPct: null }],
      { 'a1|': { debit: 130000, credit: 0 } },
      [{ _id: 'a1', accountName: 'Rent', accountType: 'Expense' }],
    );
    const r = await variance.computeVariance('biz1', 'b1', { asOf: new Date('2026-07-31') });
    const line = r.lines[0];
    expect(line.actual).toBe(130000);
    expect(line.budget).toBe(100000);
    expect(line.variance).toBe(30000);
    expect(line.favorable).toBe(false);
    expect(line.rag).toBe('red');
  });

  test('revenue above budget → favorable green (reversed sign)', async () => {
    setup(
      [{ accountId: 'rev', costCenterId: null, monthly: [500000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], thresholdPct: null }],
      { 'rev|': { debit: 0, credit: 540000 } },
      [{ _id: 'rev', accountName: 'Sales', accountType: 'Revenue' }],
    );
    const r = await variance.computeVariance('biz1', 'b1', { asOf: new Date('2026-07-31') });
    expect(r.lines[0].actual).toBe(540000);
    expect(r.lines[0].favorable).toBe(true);
    expect(r.lines[0].rag).toBe('green');
  });

  test('budget=0 guard → variancePct null', async () => {
    setup(
      [{ accountId: 'a1', costCenterId: null, monthly: Array(12).fill(0), thresholdPct: null }],
      { 'a1|': { debit: 5000, credit: 0 } },
      [{ _id: 'a1', accountName: 'Misc', accountType: 'Expense' }],
    );
    const r = await variance.computeVariance('biz1', 'b1', { asOf: new Date('2026-07-31') });
    expect(r.lines[0].variancePct).toBeNull();
  });

  test('YTD window sums only elapsed months', async () => {
    setup(
      [{ accountId: 'a1', costCenterId: null, monthly: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100], thresholdPct: null }],
      { 'a1|': { debit: 250, credit: 0 } },
      [{ _id: 'a1', accountName: 'Rent', accountType: 'Expense' }],
    );
    // asOf in fiscal month 3 (Sept for a July-start year) → budget = 300
    const r = await variance.computeVariance('biz1', 'b1', { asOf: new Date('2026-09-15') });
    expect(r.lines[0].budget).toBe(300);
  });
});
