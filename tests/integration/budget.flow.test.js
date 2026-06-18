// tests/integration/budget.flow.test.js
'use strict';
jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../repositories/budget.repository');
jest.mock('../../repositories/fiscalYear.repository');
jest.mock('../../repositories/account.repository');
jest.mock('../../services/costCenter.service', () => ({ validateAssignable: jest.fn().mockResolvedValue(null) }));
jest.mock('../../services/approvalEngine.service', () => ({
  buildChain: jest.fn(() => [{ sequence: 1, level: 'FINANCE', status: 'pending' }]),
  approveStep: jest.fn((doc) => { doc.approvalChain[0].status = 'approved'; return { fullyApproved: true }; }),
}));

const budgetRepo = require('../../repositories/budget.repository');
const fyRepo = require('../../repositories/fiscalYear.repository');
const accountRepo = require('../../repositories/account.repository');
const budget = require('../../services/budget.service');
const variance = require('../../services/variance.service');

describe('budget flow (service integration)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('create → submit → approve → variance reflects GL actuals', async () => {
    // create
    budgetRepo.create.mockResolvedValue({ _id: 'b1', status: 'draft', version: 1,
      lines: [{ accountId: 'rent', monthly: [100000, ...Array(11).fill(0)] }] });
    const draft = await budget.createDraft('biz1',
      { name: 'FY26', fiscalYearId: 'fy1', scenario: 'base',
        lines: [{ accountId: 'rent', monthly: [100000, ...Array(11).fill(0)] }] }, { id: 'u1' });
    expect(draft.status).toBe('draft');

    // submit
    budgetRepo.findOwnedById.mockResolvedValue({ _id: 'b1', status: 'draft', lines: draft.lines });
    budgetRepo.update.mockImplementation((id, u) => Promise.resolve({ _id: id, ...u }));
    const submitted = await budget.submitForApproval('biz1', 'b1', { id: 'u1' });
    expect(submitted.status).toBe('pending_approval');

    // approve
    budgetRepo.findOwnedById.mockResolvedValue({ _id: 'b1', status: 'pending_approval',
      approvalChain: [{ status: 'pending' }], fiscalYearId: 'fy1', scenario: 'base', createdBy: 'creator' });
    budgetRepo.findActive.mockResolvedValue(null);
    const approved = await budget.approve('biz1', 'b1', { _id: 'approver', id: 'approver' }, 'ok');
    expect(approved.status).toBe('active');

    // variance
    budgetRepo.findOwnedById.mockResolvedValue({ _id: 'b1', fiscalYearId: 'fy1', scenario: 'base',
      defaultThresholdPct: 10, lines: [{ accountId: 'rent', costCenterId: null, monthly: [100000, ...Array(11).fill(0)], thresholdPct: null }] });
    fyRepo.findOwnedById.mockResolvedValue({ _id: 'fy1', startDate: new Date('2026-07-01'), endDate: new Date('2027-06-30') });
    accountRepo.findByBusiness.mockResolvedValue([{ _id: 'rent', accountName: 'Rent', accountType: 'Expense' }]);
    jest.spyOn(variance, 'actualsByLine').mockResolvedValue({ 'rent|': { debit: 130000, credit: 0 } });
    const v = await variance.computeVariance('biz1', 'b1', { asOf: new Date('2026-07-31') });
    expect(v.lines[0].variance).toBe(30000);
    expect(v.lines[0].rag).toBe('red');
  });
});
