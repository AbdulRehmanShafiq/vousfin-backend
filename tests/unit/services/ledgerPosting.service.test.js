/**
 * tests/unit/services/ledgerPosting.service.test.js
 *
 * ERP Integration Refactor — Step 4.
 * Validates the shared balanced-journal poster: it creates the JournalEntry and
 * moves BOTH Chart-of-Accounts running balances with the correct debit/credit
 * sign (so the trial balance never drifts), and honours { updateBalances:false }.
 */
'use strict';

jest.mock('../../../models/JournalEntry.model', () => ({ create: jest.fn() }));
jest.mock('../../../repositories/account.repository', () => ({
  findById: jest.fn(),
  findByIdInSession: jest.fn(),
  updateRunningBalance: jest.fn(),
  findAllByBusinessAndIds: jest.fn(),
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// Simulate the standalone-server fallback: run the unit WITHOUT a session, which
// keeps balance updates best-effort (mirrors local dev). The real atomic path is
// the same code with a real session injected.
jest.mock('../../../utils/withTransaction', () => ({ withTransaction: (fn) => fn(null) }));

const { postBalancedJournal, applyRunningBalance } = require('../../../services/ledgerPosting.service');
const JournalEntry = require('../../../models/JournalEntry.model');
const accountRepository = require('../../../repositories/account.repository');

const ID_DR = 'acc-debit-normal';   // e.g. Accounts Receivable / Inventory (Debit normal)
const ID_CR = 'acc-credit-normal';  // e.g. Accounts Payable / Sales        (Credit normal)

beforeEach(() => {
  jest.clearAllMocks();
  // Account normal-balance map.
  accountRepository.findById.mockImplementation((id) =>
    Promise.resolve({ _id: id, normalBalance: id === ID_DR ? 'Debit' : 'Credit' })
  );
  // The poster reads through findByIdInSession so it can join a caller's
  // transaction; same data, same answers.
  accountRepository.findByIdInSession.mockImplementation(accountRepository.findById.getMockImplementation());
  accountRepository.updateRunningBalance.mockResolvedValue(undefined);
  // F16 tenant guard: resolve every requested account as owned by the business
  // (cross-tenant rejection is covered in ledgerPosting.tenantGuard.test.js).
  accountRepository.findAllByBusinessAndIds.mockImplementation((_biz, ids) =>
    Promise.resolve(ids.map((id) => ({ _id: id }))));
  // create([doc], opts) echoes the payload back in an array with an _id
  // (mirrors Mongoose .create() array form used by the atomic poster).
  JournalEntry.create.mockImplementation((docs) =>
    Promise.resolve([{ _id: 'je-1', ...(Array.isArray(docs) ? docs[0] : docs) }]));
});

describe('ledgerPosting.postBalancedJournal()', () => {
  it('creates the JE and increases both a debit-normal debit and a credit-normal credit', async () => {
    const je = await postBalancedJournal({
      businessId: 'b1', amount: 100, debitAccountId: ID_DR, creditAccountId: ID_CR,
      idempotencyKey: null, // this suite is about balance signs, not idempotency
    });

    expect(JournalEntry.create).toHaveBeenCalledTimes(1);
    expect(je._id).toBe('je-1');

    // Debit side hits a Debit-normal account → +100 (3rd arg = session, null in fallback)
    expect(accountRepository.updateRunningBalance).toHaveBeenCalledWith(ID_DR, 100, null);
    // Credit side hits a Credit-normal account → +100
    expect(accountRepository.updateRunningBalance).toHaveBeenCalledWith(ID_CR, 100, null);
    expect(accountRepository.updateRunningBalance).toHaveBeenCalledTimes(2);
  });

  it('decreases a credit-normal account when it is debited, and vice-versa', async () => {
    // DR the credit-normal account, CR the debit-normal account (a reversal-shaped entry).
    await postBalancedJournal({
      businessId: 'b1', amount: 40, debitAccountId: ID_CR, creditAccountId: ID_DR, idempotencyKey: null,
    });

    // Debit on a Credit-normal account → -40
    expect(accountRepository.updateRunningBalance).toHaveBeenCalledWith(ID_CR, -40, null);
    // Credit on a Debit-normal account → -40
    expect(accountRepository.updateRunningBalance).toHaveBeenCalledWith(ID_DR, -40, null);
  });

  it('skips running-balance updates when updateBalances is false', async () => {
    await postBalancedJournal(
      { businessId: 'b1', amount: 100, debitAccountId: ID_DR, creditAccountId: ID_CR, idempotencyKey: null },
      { updateBalances: false }
    );
    expect(JournalEntry.create).toHaveBeenCalledTimes(1);
    expect(accountRepository.updateRunningBalance).not.toHaveBeenCalled();
  });

  it('never throws when a running-balance update fails — the JE is still returned', async () => {
    accountRepository.updateRunningBalance.mockRejectedValue(new Error('db down'));
    const je = await postBalancedJournal({
      businessId: 'b1', amount: 100, debitAccountId: ID_DR, creditAccountId: ID_CR,
      idempotencyKey: null, // this suite is about balance signs, not idempotency
    });
    expect(je._id).toBe('je-1'); // ledger write survived a balance-cache failure (Rule 3)
  });
});

describe('ledgerPosting.postBalancedJournal() — atomicity', () => {
  it('threads a caller-provided session into the JE insert and both balance updates', async () => {
    await postBalancedJournal(
      { businessId: 'b1', amount: 100, debitAccountId: ID_DR, creditAccountId: ID_CR, idempotencyKey: null },
      { session: 'SESSION' }
    );
    // JE created with the session (array form).
    expect(JournalEntry.create).toHaveBeenCalledWith(
      [expect.objectContaining({ amount: 100 })],
      { session: 'SESSION' }
    );
    // Balances moved with the same session.
    expect(accountRepository.updateRunningBalance).toHaveBeenCalledWith(ID_DR, 100, 'SESSION');
    expect(accountRepository.updateRunningBalance).toHaveBeenCalledWith(ID_CR, 100, 'SESSION');
  });

  it('THROWS (rolls back) when a balance update fails inside a transaction', async () => {
    accountRepository.updateRunningBalance.mockRejectedValue(new Error('write conflict'));
    await expect(
      postBalancedJournal(
        { businessId: 'b1', amount: 100, debitAccountId: ID_DR, creditAccountId: ID_CR, idempotencyKey: null },
        { session: 'SESSION' }   // strict path
      )
    ).rejects.toThrow('write conflict');
  });
});

describe('ledgerPosting.applyRunningBalance()', () => {
  it('is a no-op for a null account id', async () => {
    await applyRunningBalance(null, 100, 'debit');
    expect(accountRepository.updateRunningBalance).not.toHaveBeenCalled();
  });

  it('logs and skips when the account is not found', async () => {
    accountRepository.findByIdInSession.mockResolvedValue(null);
    await applyRunningBalance('missing', 100, 'debit');
    expect(accountRepository.updateRunningBalance).not.toHaveBeenCalled();
  });
});
