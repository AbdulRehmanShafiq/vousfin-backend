// tests/unit/services/budget.service.test.js
'use strict';
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../repositories/budget.repository');
jest.mock('../../../services/costCenter.service', () => ({ validateAssignable: jest.fn().mockResolvedValue(null) }));
jest.mock('../../../services/variance.service', () => ({ actualsByMonth: jest.fn() }));
jest.mock('../../../repositories/fiscalYear.repository', () => ({ findOwnedById: jest.fn(), findPrior: jest.fn() }));
jest.mock('../../../services/approvalEngine.service', () => ({
  buildChain: jest.fn(() => [{ sequence: 1, level: 'FINANCE', status: 'pending' }]),
  approveStep: jest.fn(() => ({ fullyApproved: true })),
  rejectStep: jest.fn(() => ({ rejected: true })),
  summarize: jest.fn(() => ({ complete: true })),
}));

const repo = require('../../../repositories/budget.repository');
const variance = require('../../../services/variance.service');
const fyRepo = require('../../../repositories/fiscalYear.repository');
const approvalEngine = require('../../../services/approvalEngine.service');
const budget = require('../../../services/budget.service');

describe('budget.service — splitEvenly', () => {
  test('splits evenly and absorbs rounding remainder in the last month', () => {
    const r = budget.splitEvenly(1200);
    expect(r).toHaveLength(12);
    expect(r.every((m) => m === 100)).toBe(true);
    expect(r.reduce((a, b) => a + b, 0)).toBe(1200);
  });
  test('remainder preserved so sum === annual (to the cent)', () => {
    const r = budget.splitEvenly(1000);
    expect(r.reduce((a, b) => a + b, 0)).toBeCloseTo(1000, 2);
  });
  test('zero / falsy → all zeros', () => {
    expect(budget.splitEvenly(0)).toEqual(Array(12).fill(0));
  });
});

describe('budget.service — createDraft', () => {
  beforeEach(() => jest.clearAllMocks());
  test('creates a version-1 draft owned by the user', async () => {
    repo.create.mockResolvedValue({ _id: 'b1', status: 'draft', version: 1 });
    const out = await budget.createDraft('biz1',
      { name: 'FY26', fiscalYearId: 'fy1', scenario: 'base',
        lines: [{ accountId: 'a1', monthly: Array(12).fill(50) }] },
      { id: 'u1' });
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
      businessId: 'biz1', name: 'FY26', version: 1, status: 'draft', createdBy: 'u1' }));
    expect(out._id).toBe('b1');
  });
});

describe('budget.service — updateDraft', () => {
  beforeEach(() => jest.clearAllMocks());
  test('rejects editing a non-draft budget', async () => {
    repo.findOwnedById.mockResolvedValue({ _id: 'b1', status: 'active' });
    await expect(budget.updateDraft('biz1', 'b1', { name: 'x' }, { id: 'u1' }))
      .rejects.toThrow(/only.*draft/i);
  });
  test('updates a draft', async () => {
    repo.findOwnedById.mockResolvedValue({ _id: 'b1', status: 'draft' });
    repo.update.mockResolvedValue({ _id: 'b1', name: 'new' });
    const out = await budget.updateDraft('biz1', 'b1', { name: 'new' }, { id: 'u1' });
    expect(out.name).toBe('new');
  });
});

describe('budget.service — seedFromActuals', () => {
  beforeEach(() => jest.clearAllMocks());
  test('builds a line per account from the prior year actuals, split by month', async () => {
    fyRepo.findOwnedById.mockResolvedValue({ _id: 'fy2', startDate: new Date('2026-07-01'), endDate: new Date('2027-06-30') });
    fyRepo.findPrior.mockResolvedValue({ _id: 'fy1', startDate: new Date('2025-07-01'), endDate: new Date('2026-06-30') });
    variance.actualsByMonth.mockResolvedValue([
      { accountId: 'a1', costCenterId: null, monthly: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10] },
    ]);
    const out = await budget.seedFromActuals('biz1', 'fy2', { scenario: 'base' });
    expect(out.fiscalYearId).toBe('fy2');
    expect(out.scenario).toBe('base');
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].accountId).toBe('a1');
    expect(out.lines[0].monthly).toHaveLength(12);
  });
  test('returns empty lines when there is no prior year', async () => {
    fyRepo.findOwnedById.mockResolvedValue({ _id: 'fy2', startDate: new Date('2026-07-01'), endDate: new Date('2027-06-30') });
    fyRepo.findPrior.mockResolvedValue(null);
    const out = await budget.seedFromActuals('biz1', 'fy2', {});
    expect(out.lines).toEqual([]);
  });
});

describe('budget.service — lifecycle', () => {
  beforeEach(() => jest.clearAllMocks());

  test('submitForApproval builds chain and moves draft → pending_approval', async () => {
    repo.findOwnedById.mockResolvedValue({ _id: 'b1', status: 'draft', lines: [{ monthly: Array(12).fill(100) }] });
    repo.update.mockImplementation((id, u) => Promise.resolve({ _id: id, ...u }));
    const out = await budget.submitForApproval('biz1', 'b1', { id: 'u1' });
    expect(approvalEngine.buildChain).toHaveBeenCalled();
    expect(out.status).toBe('pending_approval');
  });

  test('submit rejects when not draft', async () => {
    repo.findOwnedById.mockResolvedValue({ _id: 'b1', status: 'active', lines: [] });
    await expect(budget.submitForApproval('biz1', 'b1', { id: 'u1' })).rejects.toThrow(/draft/i);
  });

  test('approve to completion → active and archives prior active of same fy+scenario', async () => {
    repo.findOwnedById.mockResolvedValue({ _id: 'b2', status: 'pending_approval', approvalChain: [{}],
      fiscalYearId: 'fy1', scenario: 'base', createdBy: 'creator' });
    repo.findActive.mockResolvedValue({ _id: 'bOld' });
    repo.update.mockImplementation((id, u) => Promise.resolve({ _id: id, ...u }));
    const out = await budget.approve('biz1', 'b2', { _id: 'approver', id: 'approver' }, 'ok');
    expect(approvalEngine.approveStep).toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledWith('bOld', { status: 'archived' });
    expect(out.status).toBe('active');
  });

  test('reject → rejected', async () => {
    repo.findOwnedById.mockResolvedValue({ _id: 'b2', status: 'pending_approval', approvalChain: [{}], createdBy: 'creator' });
    repo.update.mockImplementation((id, u) => Promise.resolve({ _id: id, ...u }));
    const out = await budget.reject('biz1', 'b2', { _id: 'approver', id: 'approver' }, 'no');
    expect(out.status).toBe('rejected');
  });

  test('cloneVersion creates draft at version+1 copying lines', async () => {
    repo.findOwnedById.mockResolvedValue({ _id: 'b1', version: 2, name: 'FY26',
      fiscalYearId: 'fy1', scenario: 'base', defaultThresholdPct: 10,
      lines: [{ accountId: 'a1', costCenterId: null, monthly: Array(12).fill(5), thresholdPct: null }] });
    repo.create.mockImplementation((d) => Promise.resolve({ _id: 'bNew', ...d }));
    const out = await budget.cloneVersion('biz1', 'b1', { id: 'u1' });
    expect(out.version).toBe(3);
    expect(out.status).toBe('draft');
    expect(out.lines).toHaveLength(1);
  });
});
