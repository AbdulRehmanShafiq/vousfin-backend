'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../services/approval.service', () => ({ submitOrPost: jest.fn() }));
jest.mock('../../../models/JournalEntry.model', () => ({ findOne: jest.fn(() => ({ lean: () => Promise.resolve(null) })) }));

const approvalService = require('../../../services/approval.service');
const batchPostingService = require('../../../services/batchPosting.service');

const ACTOR = { id: 'u1', fullName: 'Tester', role: 'accountant' };
const BIZ = '507f1f77bcf86cd799439099';

function item(description, amount = 100) {
  return { description, amount, transactionDate: '2026-06-01', debitAccountId: 'd1', creditAccountId: 'c1', originalRow: description };
}

beforeEach(() => jest.clearAllMocks());

describe('batchPosting.postBatch — recovery pass', () => {
  it('retries a row that fails transiently (WriteConflict) and recovers it — no silent skip', async () => {
    const attempts = {};
    approvalService.submitOrPost.mockImplementation(async (it) => {
      const k = it.description;
      attempts[k] = (attempts[k] || 0) + 1;
      // The middle row fails once (as if a concurrent write-conflict), then succeeds.
      if (k === 'conflict' && attempts[k] === 1) throw new Error('WriteConflict — please retry');
      return { pendingApproval: false, transaction: { _id: `je-${k}` } };
    });

    const items = [item('a'), item('conflict'), item('c')];
    const res = await batchPostingService.postBatch(BIZ, items, ACTOR, '127.0.0.1', { source: 'excel' });

    expect(res.posted).toBe(3);
    expect(res.failed).toHaveLength(0);
    // The recovery retry must carry an idempotency key so a commit-unknown row can't double-post.
    const retryCall = approvalService.submitOrPost.mock.calls.find(
      (c, i) => c[0].description === 'conflict' && approvalService.submitOrPost.mock.calls.filter((x) => x[0].description === 'conflict').length > 1 && i === approvalService.submitOrPost.mock.calls.length - 1
    );
    expect(retryCall[0].idempotencyKey).toBeTruthy();
  });

  it('keeps a permanently-failing row in failed[] with its reason', async () => {
    approvalService.submitOrPost.mockImplementation(async (it) => {
      if (it.description === 'bad') throw new Error('Debit account not found');
      return { pendingApproval: false, transaction: { _id: `je-${it.description}` } };
    });

    const res = await batchPostingService.postBatch(BIZ, [item('ok'), item('bad')], ACTOR, '127.0.0.1', { source: 'excel' });
    expect(res.posted).toBe(1);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].error).toMatch(/Debit account not found/);
    expect(res.failed[0].row).toBe('bad');
  });

  it('counts over-threshold rows as pending, not failed', async () => {
    approvalService.submitOrPost.mockResolvedValue({ pendingApproval: true });
    const res = await batchPostingService.postBatch(BIZ, [item('big', 999999)], ACTOR, '127.0.0.1', { source: 'excel' });
    expect(res.pending).toBe(1);
    expect(res.posted).toBe(0);
    expect(res.failed).toHaveLength(0);
  });
});
