/**
 * tests/unit/services/ledgerPosting.tenantGuard.test.js
 *
 * Audit 2026-07-02 F16 — the canonical poster must verify that EVERY journal
 * line's account belongs to the posting business. createTransaction validates
 * this for human input, but postCompoundJournal trusted its callers — a buggy
 * caller could post lines against another tenant's accounts AND move that
 * tenant's running balances. Defense-in-depth: one bulk ownership check.
 */
'use strict';

jest.mock('../../../models/JournalEntry.model', () => ({
  create: jest.fn().mockResolvedValue([{ _id: 'je1' }]),
  findOne: jest.fn().mockReturnValue({ lean: () => Promise.resolve(null) }),
}));
jest.mock('../../../repositories/account.repository', () => ({
  findById: jest.fn().mockResolvedValue({ _id: 'a1', normalBalance: 'Debit' }),
  // The poster reads through findByIdInSession so it can join a caller's txn.
  findByIdInSession: jest.fn().mockResolvedValue({ _id: 'a1', normalBalance: 'Debit' }),
  findAllByBusinessAndIds: jest.fn(),
  updateRunningBalance: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../utils/withTransaction', () => ({
  withTransaction: jest.fn((fn) => fn(null)),
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const JournalEntry = require('../../../models/JournalEntry.model');
const accountRepository = require('../../../repositories/account.repository');
const { postCompoundJournal } = require('../../../services/ledgerPosting.service');

const payload = () => ({
  businessId: 'biz1',
  transactionDate: new Date('2026-06-01'),
  description: 'test',
  transactionType: 'Expense',
  createdBy: 'u1',
  lines: [
    { accountId: 'a1', type: 'debit', amount: 100 },
    { accountId: 'a2', type: 'credit', amount: 100 },
  ],
  // The poster requires an explicit idempotency decision; this suite is about
  // the tenant guard.
  idempotencyKey: null,
});

beforeEach(() => jest.clearAllMocks());

describe('F16 — poster tenant-ownership guard', () => {
  test('rejects when a line account does not belong to the business — nothing posts', async () => {
    // Only a1 resolves for biz1; a2 belongs to someone else.
    accountRepository.findAllByBusinessAndIds.mockResolvedValue([{ _id: 'a1' }]);

    await expect(postCompoundJournal(payload())).rejects.toMatchObject({ statusCode: 400 });
    expect(JournalEntry.create).not.toHaveBeenCalled();
    expect(accountRepository.updateRunningBalance).not.toHaveBeenCalled();
  });

  test('posts normally when every line account belongs to the business', async () => {
    accountRepository.findAllByBusinessAndIds.mockResolvedValue([{ _id: 'a1' }, { _id: 'a2' }]);

    const je = await postCompoundJournal(payload());

    expect(je._id).toBe('je1');
    // The session is threaded through so the guard can see an account the
    // caller created earlier in this same transaction (a healed default).
    expect(accountRepository.findAllByBusinessAndIds).toHaveBeenCalledWith(
      'biz1', ['a1', 'a2'], { session: null }
    );
  });
});
