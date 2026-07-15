'use strict';
// Phase 1 — postCompoundJournal: one balanced N-line entry, per-line balances, atomic.
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../models/JournalEntry.model', () => ({ create: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../repositories/account.repository', () => ({
  findById: jest.fn(),
  findByIdInSession: jest.fn(), updateRunningBalance: jest.fn(), findAllByBusinessAndIds: jest.fn(),
}));
jest.mock('../../../utils/withTransaction', () => ({ withTransaction: (fn) => fn(null) }));

const JournalEntry = require('../../../models/JournalEntry.model');
const accountRepo = require('../../../repositories/account.repository');
const { postCompoundJournal } = require('../../../services/ledgerPosting.service');

const BIZ = 'biz1';
// normal-balance lookup for the sign rule
const NB = { '6180': 'Debit', '2140': 'Credit', '2141': 'Credit', cash: 'Debit', sales: 'Credit' };

beforeEach(() => {
  jest.clearAllMocks();
  accountRepo.findById.mockImplementation((id) => Promise.resolve({ _id: id, normalBalance: NB[id] || 'Debit' }));
  // The poster reads through findByIdInSession so it can join a caller's
  // transaction; same accounts, same answers.
  accountRepo.findByIdInSession.mockImplementation((id) => Promise.resolve({ _id: id, normalBalance: NB[id] || 'Debit' }));
  accountRepo.findAllByBusinessAndIds.mockImplementation((biz, ids) => Promise.resolve(ids.map((id) => ({ _id: id }))));
  accountRepo.updateRunningBalance.mockResolvedValue({});
  let n = 0;
  JournalEntry.create.mockImplementation((arr) => Promise.resolve([{ _id: `je${++n}`, ...arr[0] }]));
  JournalEntry.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
});

const base = (lines) => ({
  businessId: BIZ, transactionDate: new Date('2026-06-28'), description: 'Payroll June',
  transactionType: 'Salary', inputMethod: 'batch', createdBy: 'u1', lines,
});

describe('postCompoundJournal', () => {
  it('writes one entry with journalLines and a derived debit/credit projection', async () => {
    const je = await postCompoundJournal(base([
      { accountId: '6180', type: 'debit', amount: 150000 },
      { accountId: '2140', type: 'credit', amount: 139350 },
      { accountId: '2141', type: 'credit', amount: 10650 },
    ]));
    expect(JournalEntry.create).toHaveBeenCalledTimes(1);
    const doc = JournalEntry.create.mock.calls[0][0][0];
    expect(doc.journalLines).toHaveLength(3);
    expect(doc.amount).toBe(150000);                 // Σ debits
    expect(doc.debitAccountId).toBe('6180');         // first debit
    expect(doc.creditAccountId).toBe('2140');        // first credit
    expect(je._id).toBe('je1');
  });

  it('updates the running balance for EVERY line (not just two accounts)', async () => {
    await postCompoundJournal(base([
      { accountId: '6180', type: 'debit', amount: 150000 },
      { accountId: '2140', type: 'credit', amount: 139350 },
      { accountId: '2141', type: 'credit', amount: 10650 },
    ]));
    // 6180 debit-normal +150000 ; 2140 credit-normal +139350 ; 2141 credit-normal +10650
    expect(accountRepo.updateRunningBalance).toHaveBeenCalledWith('6180', 150000, null);
    expect(accountRepo.updateRunningBalance).toHaveBeenCalledWith('2140', 139350, null);
    expect(accountRepo.updateRunningBalance).toHaveBeenCalledWith('2141', 10650, null);
    expect(accountRepo.updateRunningBalance).toHaveBeenCalledTimes(3);
  });

  it('rejects an unbalanced journal', async () => {
    await expect(postCompoundJournal(base([
      { accountId: '6180', type: 'debit', amount: 150000 },
      { accountId: '2140', type: 'credit', amount: 100000 },
    ]))).rejects.toThrow(/not balanced/i);
    expect(JournalEntry.create).not.toHaveBeenCalled();
  });

  it('rejects fewer than two lines', async () => {
    await expect(postCompoundJournal(base([{ accountId: '6180', type: 'debit', amount: 10 }])))
      .rejects.toThrow(/at least two lines|two lines/i);
  });

  it('is idempotent on idempotencyKey — returns the existing entry, no double post', async () => {
    JournalEntry.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: 'existing1' }) });
    const je = await postCompoundJournal({ ...base([
      { accountId: 'cash', type: 'debit', amount: 100 },
      { accountId: 'sales', type: 'credit', amount: 100 },
    ]), idempotencyKey: 'pr:run9:1' });
    expect(je._id).toBe('existing1');
    expect(JournalEntry.create).not.toHaveBeenCalled();
    expect(accountRepo.updateRunningBalance).not.toHaveBeenCalled();
  });

  it('stores the idempotency key under metadata when posting', async () => {
    await postCompoundJournal({ ...base([
      { accountId: 'cash', type: 'debit', amount: 100 },
      { accountId: 'sales', type: 'credit', amount: 100 },
    ]), idempotencyKey: 'pr:run9:1' });
    const doc = JournalEntry.create.mock.calls[0][0][0];
    expect(doc.metadata.idempotencyKey).toBe('pr:run9:1');
  });
});
