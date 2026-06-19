// tests/unit/services/jobCosting.service.test.js
'use strict';
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../repositories/job.repository');
jest.mock('../../../repositories/account.repository', () => ({ findByCode: jest.fn(), findOneByBusinessAndId: jest.fn() }));
jest.mock('../../../services/ledgerPosting.service', () => ({ postBalancedJournal: jest.fn() }));

const repo = require('../../../repositories/job.repository');
const accountRepo = require('../../../repositories/account.repository');
const ledger = require('../../../services/ledgerPosting.service');
const svc = require('../../../services/jobCosting.service');

describe('jobCosting.service — createJob', () => {
  beforeEach(() => jest.clearAllMocks());
  test('creates an open job, dup code → 409', async () => {
    repo.findByCode.mockResolvedValue(null);
    repo.create.mockResolvedValue({ _id: 'j1', status: 'open' });
    const out = await svc.createJob('biz1', { code: 'J1', name: 'Roof', standardCost: { material: 100 } }, { id: 'u1' });
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'biz1', code: 'J1', createdBy: 'u1' }));
    expect(out._id).toBe('j1');
    repo.findByCode.mockResolvedValue({ _id: 'dup' });
    await expect(svc.createJob('biz1', { code: 'J1', name: 'x' }, { id: 'u1' })).rejects.toThrow(/already exists/i);
  });
});

describe('jobCosting.service — addCost', () => {
  beforeEach(() => jest.clearAllMocks());
  test('posts Dr WIP / Cr source, appends cost sheet, flips open→in_progress', async () => {
    const job = { _id: 'j1', businessId: 'biz1', status: 'open', costSheet: [], wipJournalEntryIds: [],
      save: jest.fn().mockResolvedValue(true) };
    repo.findOwnedById.mockResolvedValue(job);
    accountRepo.findByCode.mockResolvedValue({ _id: 'wip169' });
    accountRepo.findOneByBusinessAndId.mockResolvedValue({ _id: 'cash' });
    ledger.postBalancedJournal.mockResolvedValue({ _id: 'je1' });
    const out = await svc.addCost('biz1', 'j1', { category: 'material', amount: 500, sourceAccountId: 'cash', description: 'wood' }, { id: 'u1' });
    expect(ledger.postBalancedJournal).toHaveBeenCalledWith(expect.objectContaining({
      debitAccountId: 'wip169', creditAccountId: 'cash', amount: 500, inputMethod: 'form', createdBy: 'u1',
      transactionType: 'Journal Entry' }));
    expect(job.costSheet).toHaveLength(1);
    expect(job.costSheet[0]).toMatchObject({ category: 'material', amount: 500, journalEntryId: 'je1' });
    expect(job.status).toBe('in_progress');
    expect(out).toBe(job);
  });
  test('rejects adding cost to a completed job', async () => {
    repo.findOwnedById.mockResolvedValue({ _id: 'j1', status: 'completed' });
    await expect(svc.addCost('biz1', 'j1', { category: 'labour', amount: 1, sourceAccountId: 'x' }, { id: 'u1' }))
      .rejects.toThrow(/open|progress/i);
  });
});

describe('jobCosting.service — computeActuals/variance', () => {
  test('actuals sum by category; variance = actual − standard', () => {
    const job = { standardCost: { material: 400, labour: 200, overhead: 100 },
      costSheet: [
        { category: 'material', amount: 300 }, { category: 'material', amount: 150 },
        { category: 'labour', amount: 200 }, { category: 'overhead', amount: 120 },
      ] };
    const a = svc.computeActuals(job);
    expect(a).toMatchObject({ material: 450, labour: 200, overhead: 120, total: 770 });
    const v = svc.computeVariance(job);
    expect(v.material).toMatchObject({ standard: 400, actual: 450, variance: 50, favourable: false });
    expect(v.labour).toMatchObject({ variance: 0, favourable: true });
    expect(v.overhead).toMatchObject({ variance: 20, favourable: false });
  });
});

describe('jobCosting.service — completeJob/cancelJob', () => {
  beforeEach(() => jest.clearAllMocks());
  test('completeJob posts Dr FG / Cr WIP for total actual cost and marks completed', async () => {
    const job = { _id: 'j1', businessId: 'biz1', code: 'J1', status: 'in_progress',
      costSheet: [{ category: 'material', amount: 300 }, { category: 'labour', amount: 200 }],
      wipJournalEntryIds: ['je1'], save: jest.fn().mockResolvedValue(true) };
    repo.findOwnedById.mockResolvedValue(job);
    accountRepo.findByCode.mockImplementation((b, code) => Promise.resolve({ _id: code === '1150' ? 'fg150' : 'wip169' }));
    ledger.postBalancedJournal.mockResolvedValue({ _id: 'jeC' });
    const out = await svc.completeJob('biz1', 'j1', { id: 'u1' });
    expect(ledger.postBalancedJournal).toHaveBeenCalledWith(expect.objectContaining({
      debitAccountId: 'fg150', creditAccountId: 'wip169', amount: 500, createdBy: 'u1' }));
    expect(out.status).toBe('completed');
    expect(out.completionJournalEntryId).toBe('jeC');
  });
  test('completeJob rejects when not in progress', async () => {
    repo.findOwnedById.mockResolvedValue({ _id: 'j1', status: 'open', costSheet: [] });
    await expect(svc.completeJob('biz1', 'j1', { id: 'u1' })).rejects.toThrow(/progress/i);
  });
  test('completeJob rejects with zero cost', async () => {
    repo.findOwnedById.mockResolvedValue({ _id: 'j1', status: 'in_progress', costSheet: [] });
    await expect(svc.completeJob('biz1', 'j1', { id: 'u1' })).rejects.toThrow(/no cost/i);
  });
});
