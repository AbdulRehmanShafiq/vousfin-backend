// tests/integration/cost.flow.test.js
'use strict';
jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../repositories/job.repository');
jest.mock('../../repositories/account.repository', () => ({ findByCode: jest.fn(), findOneByBusinessAndId: jest.fn() }));
jest.mock('../../services/ledgerPosting.service', () => ({ postBalancedJournal: jest.fn() }));
const repo = require('../../repositories/job.repository');
const accountRepo = require('../../repositories/account.repository');
const ledger = require('../../services/ledgerPosting.service');
const jobCosting = require('../../services/jobCosting.service');

describe('cost flow (service integration)', () => {
  beforeEach(() => jest.clearAllMocks());
  test('create → add 2 costs → complete posts WIP→FG for the total', async () => {
    repo.findByCode.mockResolvedValue(null);
    repo.create.mockResolvedValue({ _id: 'j1', code: 'J1', status: 'open' });
    await jobCosting.createJob('biz1', { code: 'J1', name: 'Build', standardCost: { material: 500 } }, { id: 'u1' });

    const job = { _id: 'j1', businessId: 'biz1', code: 'J1', status: 'open', costSheet: [], wipJournalEntryIds: [], save: jest.fn() };
    repo.findOwnedById.mockResolvedValue(job);
    accountRepo.findByCode.mockImplementation((b, code) => Promise.resolve({ _id: code === '1150' ? 'fg' : 'wip' }));
    accountRepo.findOneByBusinessAndId.mockResolvedValue({ _id: 'cash' });
    let seq = 0; ledger.postBalancedJournal.mockImplementation(() => Promise.resolve({ _id: 'je' + (++seq) }));

    await jobCosting.addCost('biz1', 'j1', { category: 'material', amount: 300, sourceAccountId: 'cash' }, { id: 'u1' });
    await jobCosting.addCost('biz1', 'j1', { category: 'labour', amount: 200, sourceAccountId: 'cash' }, { id: 'u1' });
    expect(job.costSheet).toHaveLength(2);
    expect(job.status).toBe('in_progress');

    const done = await jobCosting.completeJob('biz1', 'j1', { id: 'u1' });
    const completionCall = ledger.postBalancedJournal.mock.calls.at(-1)[0];
    expect(completionCall).toMatchObject({ debitAccountId: 'fg', creditAccountId: 'wip', amount: 500 });
    expect(done.status).toBe('completed');
  });
});
