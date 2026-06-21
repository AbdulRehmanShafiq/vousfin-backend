/**
 * Regression for audit T3 sweep — editTransaction must reconcile the AR/AP parent
 * atomically with the child payment edit inside ONE withTransaction callback, NOT in
 * a separate swallowing try/catch after the transaction commits.
 *
 * Two assertions:
 *   1. If the parent updateTransaction call REJECTS, the whole editTransaction rejects
 *      (no silent swallow).
 *   2. The parent updateTransaction is called with the session provided by withTransaction
 *      (not undefined / no session), so the writes are truly atomic.
 */
'use strict';

const SESSION = { __sentinel: 'txn-session-edit' };

jest.mock('../../../utils/withTransaction', () => ({
  // Provide a sentinel session so we can assert it is threaded into every write.
  withTransaction: (fn) => fn(SESSION),
}));
jest.mock('../../../repositories/transaction.repository');
jest.mock('../../../repositories/account.repository');
jest.mock('../../../services/audit.service');
jest.mock('../../../models/AccountingPeriod.model', () => ({
  findCoveringPeriod: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../models/InvoiceCounter.model', () => ({
  findOneAndUpdate: jest.fn().mockResolvedValue({ seq: 1 }),
}));

const transactionService    = require('../../../services/transaction.service');
const transactionRepository = require('../../../repositories/transaction.repository');
const accountRepository     = require('../../../repositories/account.repository');
const auditService          = require('../../../services/audit.service');

// ── Fixtures ─────────────────────────────────────────────────────────────────

function buildParent(overrides = {}) {
  return {
    _id: 'parent001',
    businessId: 'biz001',
    amount: 2000,
    partiallyPaidAmount: 1500,
    remainingBalance: 500,
    paymentStatus: 'PARTIALLY_PAID',
    status: 'partially_settled',
    toObject: function () { return { ...this }; },
    ...overrides,
  };
}

function buildChild(overrides = {}) {
  return {
    _id: 'child001',
    businessId: 'biz001',
    amount: 1500,
    debitAccountId: { _id: 'accD' },
    creditAccountId: { _id: 'accC' },
    status: 'posted',
    entryType: 'normal',
    createdAt: new Date(), // within 30 days
    partiallyPaidAmount: 0,
    parentTransactionId: { _id: 'parent001' },
    toObject: function () { return { ...this }; },
    ...overrides,
  };
}

// Minimal "updated" tx returned by updateTransaction for the child.
const UPDATED_CHILD = {
  _id: 'child001',
  businessId: 'biz001',
  amount: 1000,
  toObject: function () { return { ...this }; },
};

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  auditService.logCreate  = jest.fn().mockResolvedValue(undefined);
  auditService.logUpdate  = jest.fn().mockResolvedValue(undefined);
  auditService.logReversal = jest.fn().mockResolvedValue(undefined);
  auditService.getAuditTrail = jest.fn().mockResolvedValue({ data: [] });

  accountRepository.findOneByBusinessAndId = jest.fn().mockResolvedValue({
    _id: 'accD', normalBalance: 'Debit', accountName: 'Test',
  });
  accountRepository.updateRunningBalance = jest.fn().mockResolvedValue(undefined);
  accountRepository.findById = jest.fn().mockResolvedValue({
    _id: 'accD', normalBalance: 'Debit',
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('editTransaction — AR/AP parent reconciliation atomicity (audit T3)', () => {

  test('rejects when parent updateTransaction throws — no silent swallow', async () => {
    const child  = buildChild();
    const parent = buildParent();

    // findByIdWithDetails: first call = child lookup, second call = parent lookup.
    transactionRepository.findByIdWithDetails
      .mockResolvedValueOnce(child)   // child lookup (editTransaction entry)
      .mockResolvedValueOnce(parent); // parent lookup inside reconciliation

    // Child update succeeds; parent update FAILS.
    transactionRepository.updateTransaction
      .mockResolvedValueOnce(UPDATED_CHILD)  // child write
      .mockRejectedValueOnce(new Error('DB error during parent reconciliation'));

    await expect(
      transactionService.editTransaction(
        'child001', 'biz001',
        { amount: 1000 },   // amountChanged → triggers withTransaction + reconciliation
        'user1', '127.0.0.1'
      )
    ).rejects.toThrow('DB error during parent reconciliation');
  });

  test('parent updateTransaction is called with the txn session (atomic write)', async () => {
    const child  = buildChild();
    const parent = buildParent();

    transactionRepository.findByIdWithDetails
      .mockResolvedValueOnce(child)
      .mockResolvedValueOnce(parent);

    transactionRepository.updateTransaction
      .mockResolvedValueOnce(UPDATED_CHILD)  // child write
      .mockResolvedValueOnce({ ...parent }); // parent write

    await transactionService.editTransaction(
      'child001', 'biz001',
      { amount: 1000 },
      'user1', '127.0.0.1'
    );

    // The SECOND updateTransaction call is the parent reconciliation.
    // It must receive the sentinel session as its 4th argument.
    const calls = transactionRepository.updateTransaction.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const parentCall = calls[1]; // [parentId, businessId, data, session]
    expect(parentCall[0]).toBe('parent001');
    expect(parentCall[3]).toBe(SESSION);
  });

  test('reconciliation arithmetic is correct: newRemaining and newPaid match expected values', async () => {
    // child 1500 → 1000 (amountDiff = -500)
    // parent: partiallyPaidAmount=1500, remainingBalance=500
    // expected: newPaid = 1500 + (-500) = 1000, newRemaining = 500 - (-500) = 1000
    const child  = buildChild({ amount: 1500 });
    const parent = buildParent({ partiallyPaidAmount: 1500, remainingBalance: 500 });

    transactionRepository.findByIdWithDetails
      .mockResolvedValueOnce(child)
      .mockResolvedValueOnce(parent);

    transactionRepository.updateTransaction
      .mockResolvedValueOnce(UPDATED_CHILD)
      .mockResolvedValueOnce({ ...parent });

    await transactionService.editTransaction(
      'child001', 'biz001',
      { amount: 1000 },
      'user1', '127.0.0.1'
    );

    const parentCall = transactionRepository.updateTransaction.mock.calls[1];
    expect(parentCall[2]).toMatchObject({
      partiallyPaidAmount: 1000,
      remainingBalance:    1000,
      paymentStatus:       'partially_paid',
    });
  });

  test('does NOT call parent update when there is no parentTransactionId', async () => {
    // A standalone transaction — no parent — should not trigger reconciliation.
    const standalone = buildChild({ parentTransactionId: null });

    transactionRepository.findByIdWithDetails.mockResolvedValueOnce(standalone);
    transactionRepository.updateTransaction.mockResolvedValueOnce(UPDATED_CHILD);

    await transactionService.editTransaction(
      'child001', 'biz001',
      { amount: 1000 },
      'user1', '127.0.0.1'
    );

    // Only one updateTransaction call (the child itself).
    expect(transactionRepository.updateTransaction).toHaveBeenCalledTimes(1);
  });
});
