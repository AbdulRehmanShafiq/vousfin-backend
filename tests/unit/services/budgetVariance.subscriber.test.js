// tests/unit/services/budgetVariance.subscriber.test.js
'use strict';
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../models/JournalEntry.model', () => ({ aggregate: jest.fn() }));
jest.mock('../../../repositories/transaction.repository', () => ({ EFFECTIVE_LINES_STAGE: {}, REPORT_STATUSES: [] }));
jest.mock('../../../repositories/budget.repository', () => ({ findActiveByFiscalYear: jest.fn(), findOwnedById: jest.fn() }));
jest.mock('../../../repositories/fiscalYear.repository', () => ({ findOwnedById: jest.fn(), findContaining: jest.fn() }));
jest.mock('../../../repositories/account.repository', () => ({ findByBusiness: jest.fn() }));
jest.mock('../../../models/FinancialAlert.model', () => ({ updateOne: jest.fn().mockResolvedValue({ upsertedCount: 1 }) }));

const FinancialAlert = require('../../../models/FinancialAlert.model');
const fyRepo = require('../../../repositories/fiscalYear.repository');
const budgetRepo = require('../../../repositories/budget.repository');
const variance = require('../../../services/variance.service');

describe('variance.checkBreaches', () => {
  beforeEach(() => jest.clearAllMocks());

  test('fires a deduped FinancialAlert for a red line among affected accounts', async () => {
    fyRepo.findContaining.mockResolvedValue({ _id: 'fy1', startDate: new Date('2026-07-01'), endDate: new Date('2027-06-30') });
    budgetRepo.findActiveByFiscalYear.mockResolvedValue([{ _id: 'b1', fiscalYearId: 'fy1' }]);
    jest.spyOn(variance, 'computeVariance').mockResolvedValue({
      budgetId: 'b1',
      lines: [
        { accountId: 'a1', accountName: 'Rent', rag: 'red', favorable: false, budget: 100, actual: 200, variance: 100, variancePct: 1, costCenterId: null },
        { accountId: 'a2', accountName: 'Misc', rag: 'green', favorable: true, costCenterId: null },
      ],
    });
    await variance.checkBreaches('biz1', ['a1'], { entryDate: new Date('2026-07-15') });
    expect(FinancialAlert.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, opts] = FinancialAlert.updateOne.mock.calls[0];
    expect(filter.ruleKey).toMatch(/^budget_variance:b1:a1:/);
    expect(opts.upsert).toBe(true);
    expect(update.$setOnInsert.level).toBe('critical');
  });

  test('no alert when no affected account breaches', async () => {
    fyRepo.findContaining.mockResolvedValue({ _id: 'fy1', startDate: new Date('2026-07-01'), endDate: new Date('2027-06-30') });
    budgetRepo.findActiveByFiscalYear.mockResolvedValue([{ _id: 'b1', fiscalYearId: 'fy1' }]);
    jest.spyOn(variance, 'computeVariance').mockResolvedValue({
      budgetId: 'b1', lines: [{ accountId: 'a1', rag: 'green', favorable: true, costCenterId: null }],
    });
    await variance.checkBreaches('biz1', ['a1'], { entryDate: new Date('2026-07-15') });
    expect(FinancialAlert.updateOne).not.toHaveBeenCalled();
  });

  test('no budget covering the entry date → silent', async () => {
    fyRepo.findContaining.mockResolvedValue(null);
    await variance.checkBreaches('biz1', ['a1'], { entryDate: new Date('2020-01-01') });
    expect(FinancialAlert.updateOne).not.toHaveBeenCalled();
  });
});
