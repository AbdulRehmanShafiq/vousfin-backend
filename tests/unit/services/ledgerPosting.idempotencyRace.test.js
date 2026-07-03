/**
 * tests/unit/services/ledgerPosting.idempotencyRace.test.js
 *
 * Audit 2026-07-02 F7 — idempotency must be enforced by the DATABASE, not by a
 * check-then-insert read.
 *
 * postCompoundJournal guards on metadata.idempotencyKey with a findOne before
 * the insert. Two concurrent retries (double-click, network retry, serverless
 * double-invoke, cron overlap) both pass the pre-check and both insert →
 * duplicate postings. The fix is a unique partial index on
 * {businessId, metadata.idempotencyKey} plus treating the resulting E11000 as
 * "already posted — return the existing entry".
 */
'use strict';

jest.mock('../../../models/JournalEntry.model', () => ({
  create: jest.fn(),
  findOne: jest.fn(),
}));
jest.mock('../../../repositories/account.repository', () => ({
  findById: jest.fn().mockResolvedValue({ _id: 'a1', normalBalance: 'Debit' }),
  findAllByBusinessAndIds: jest.fn().mockResolvedValue([{ _id: 'a1' }, { _id: 'a2' }]),
  updateRunningBalance: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../utils/withTransaction', () => ({
  withTransaction: jest.fn((fn) => fn('SESSION')),
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
  idempotencyKey: 'key-123',
  lines: [
    { accountId: 'a1', type: 'debit', amount: 100 },
    { accountId: 'a2', type: 'credit', amount: 100 },
  ],
});

const chainableFindOne = (result) => ({ lean: jest.fn().mockResolvedValue(result) });

beforeEach(() => jest.clearAllMocks());

describe('F7 — DB-enforced idempotency', () => {
  test('schema declares a unique partial index on {businessId, metadata.idempotencyKey}', () => {
    jest.unmock('../../../models/JournalEntry.model');
    const RealJournalEntry = jest.requireActual('../../../models/JournalEntry.model');
    const indexes = RealJournalEntry.schema.indexes();
    const idx = indexes.find(
      ([fields]) => fields.businessId === 1 && fields['metadata.idempotencyKey'] === 1
    );
    expect(idx).toBeDefined();
    expect(idx[1].unique).toBe(true);
    // Partial: only entries that actually carry a key are constrained.
    expect(idx[1].partialFilterExpression).toEqual({ 'metadata.idempotencyKey': { $type: 'string' } });
  });

  test('a duplicate-key race on the idempotency index returns the existing entry instead of throwing', async () => {
    // Pre-check sees nothing (the concurrent twin has not committed yet)…
    JournalEntry.findOne
      .mockReturnValueOnce(chainableFindOne(null))            // pre-insert check
      .mockReturnValueOnce(chainableFindOne({ _id: 'jeExisting' })); // post-E11000 re-lookup
    // …then the insert loses the race on the unique index.
    const dup = Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
    JournalEntry.create.mockRejectedValue(dup);

    const result = await postCompoundJournal(payload());

    expect(result._id).toBe('jeExisting');
    // The losing twin must not move any running balance.
    expect(accountRepository.updateRunningBalance).not.toHaveBeenCalled();
  });

  test('an E11000 from a DIFFERENT unique index (no idempotency key) still throws', async () => {
    JournalEntry.findOne.mockReturnValue(chainableFindOne(null));
    const dup = Object.assign(new Error('E11000 duplicate key error idx_je_invoice_number'), { code: 11000 });
    JournalEntry.create.mockRejectedValue(dup);

    const p = { ...payload() };
    delete p.idempotencyKey;

    await expect(postCompoundJournal(p)).rejects.toThrow(/E11000/);
  });

  test('an E11000 with a key but no committed twin (invoice-number collision) rethrows', async () => {
    JournalEntry.findOne
      .mockReturnValueOnce(chainableFindOne(null))  // pre-check
      .mockReturnValueOnce(chainableFindOne(null)); // re-lookup finds nothing → not our index
    const dup = Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
    JournalEntry.create.mockRejectedValue(dup);

    await expect(postCompoundJournal(payload())).rejects.toThrow(/E11000/);
  });
});
