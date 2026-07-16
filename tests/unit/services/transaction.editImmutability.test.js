/**
 * tests/unit/services/transaction.editImmutability.test.js
 *
 * Audit 2026-07-02 F13 — posted journal entries are financially IMMUTABLE.
 *
 * The model layer (checkImmutability) already 403s any amount/account mutation
 * of a posted entry, which made transaction.service.editTransaction's
 * "reverse old balances / apply new balances" path dead code — it could only
 * ever half-run and roll back with a confusing model error. Worse, if that
 * hook were ever relaxed, the service logic would corrupt compound entries
 * (it rebalances only the top-level pair and leaves journalLines stale).
 *
 * The service must therefore reject financial edits UP FRONT with a clear
 * "reverse and recreate" error, before any write is attempted, while
 * non-financial edits (description, reference, tags) keep working.
 */
'use strict';

jest.mock('../../../utils/withTransaction', () => ({
  withTransaction: (fn) => fn('SESSION'),
}));
jest.mock('../../../repositories/transaction.repository');
jest.mock('../../../repositories/account.repository');
jest.mock('../../../services/audit.service');
jest.mock('../../../models/AccountingPeriod.model', () => ({
  findCoveringPeriod: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const transactionService    = require('../../../services/transaction.service');
const transactionRepository = require('../../../repositories/transaction.repository');
const accountRepository     = require('../../../repositories/account.repository');
const auditService          = require('../../../services/audit.service');
const { ApiError } = require('../../../utils/ApiError');

function buildPosted(overrides = {}) {
  return {
    _id: 'je1',
    businessId: 'biz1',
    amount: 1000,
    debitAccountId: { _id: 'accD' },
    creditAccountId: { _id: 'accC' },
    status: 'posted',
    entryType: 'normal',
    transactionType: 'Expense',
    createdAt: new Date(), // within the 30-day window — immutability must win anyway
    partiallyPaidAmount: 0,
    toObject: function () { return { ...this }; },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  auditService.logUpdate = jest.fn().mockResolvedValue(undefined);
  accountRepository.findOneByBusinessAndId = jest.fn().mockResolvedValue({ _id: 'accX', normalBalance: 'Debit' });
  accountRepository.updateRunningBalance = jest.fn().mockResolvedValue(undefined);
  transactionRepository.findByIdWithDetails.mockResolvedValue(buildPosted());
  transactionRepository.updateTransaction.mockResolvedValue({
    _id: 'je1', toObject: function () { return { ...this }; },
  });
});

describe('editTransaction — financial immutability of posted entries (F13)', () => {
  test('rejects an amount change with a clear reverse-and-recreate error, before any write', async () => {
    await expect(
      transactionService.editTransaction('je1', 'biz1', { amount: 500 }, 'u1', '127.0.0.1')
    ).rejects.toThrow(/revers/i);

    expect(transactionRepository.updateTransaction).not.toHaveBeenCalled();
    expect(accountRepository.updateRunningBalance).not.toHaveBeenCalled();
  });

  test('rejects a debit-account change the same way', async () => {
    await expect(
      transactionService.editTransaction('je1', 'biz1', { debitAccountId: 'accNEW' }, 'u1', '127.0.0.1')
    ).rejects.toThrow(ApiError);
    expect(transactionRepository.updateTransaction).not.toHaveBeenCalled();
  });

  test('rejects a credit-account change the same way', async () => {
    await expect(
      transactionService.editTransaction('je1', 'biz1', { creditAccountId: 'accNEW' }, 'u1', '127.0.0.1')
    ).rejects.toThrow(ApiError);
    expect(transactionRepository.updateTransaction).not.toHaveBeenCalled();
  });

  test('still allows non-financial edits (description / reference)', async () => {
    const result = await transactionService.editTransaction(
      'je1', 'biz1', { description: 'clearer memo', transactionReference: 'REF-9' }, 'u1', '127.0.0.1'
    );
    expect(result).toBeDefined();
    expect(transactionRepository.updateTransaction).toHaveBeenCalledWith(
      'je1', 'biz1',
      expect.objectContaining({ description: 'clearer memo', transactionReference: 'REF-9' })
    );
    expect(accountRepository.updateRunningBalance).not.toHaveBeenCalled();
  });

  test('an unchanged amount sent back by the form is NOT treated as a financial edit', async () => {
    // UIs commonly resubmit the whole form; amount identical to the original
    // must not trigger the immutability rejection.
    await expect(
      transactionService.editTransaction('je1', 'biz1', { amount: 1000, description: 'memo' }, 'u1', '127.0.0.1')
    ).resolves.toBeDefined();
    expect(transactionRepository.updateTransaction).toHaveBeenCalled();
  });

  // ── Spec 2026-07-16 I-7 — the DATE of a posted entry is financial state ────
  test('rejects a transactionDate change — moving an entry between months rewrites both months', async () => {
    transactionRepository.findByIdWithDetails.mockResolvedValue(
      buildPosted({ transactionDate: new Date('2026-05-10') })
    );
    await expect(
      transactionService.editTransaction('je1', 'biz1', { transactionDate: '2026-06-10' }, 'u1', '127.0.0.1')
    ).rejects.toThrow(/date of a posted entry/i);
    expect(transactionRepository.updateTransaction).not.toHaveBeenCalled();
  });

  test('an unchanged date resubmitted by the form is NOT treated as a date move', async () => {
    transactionRepository.findByIdWithDetails.mockResolvedValue(
      buildPosted({ transactionDate: new Date('2026-05-10') })
    );
    await expect(
      transactionService.editTransaction(
        'je1', 'biz1', { transactionDate: '2026-05-10', description: 'memo' }, 'u1', '127.0.0.1'
      )
    ).resolves.toBeDefined();
    // and the no-op date is stripped so the model hook stays quiet
    const update = transactionRepository.updateTransaction.mock.calls[0][2];
    expect(update.transactionDate).toBeUndefined();
  });
});
