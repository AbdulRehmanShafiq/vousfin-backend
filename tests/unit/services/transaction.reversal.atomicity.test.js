/**
 * Regression for audit finding A9/A3 — reverseTransaction must perform its writes
 * (reversal entry, running-balance updates, mark-original-reversed) inside ONE
 * transaction, so a mid-sequence failure can't leave the ledger drifted or the
 * position double-counted. We verify every write receives the SAME session that
 * withTransaction provides.
 */
'use strict';

const SESSION = { __sentinel: 'txn-session' };

jest.mock('../../../utils/withTransaction', () => ({
  // Run the unit with our sentinel session so we can assert it is threaded through.
  withTransaction: (fn) => fn(SESSION),
}));
jest.mock('../../../repositories/transaction.repository');
jest.mock('../../../repositories/account.repository');
jest.mock('../../../services/audit.service');
jest.mock('../../../services/partyBalance.service');

const transactionService    = require('../../../services/transaction.service');
const transactionRepository = require('../../../repositories/transaction.repository');
const accountRepository     = require('../../../repositories/account.repository');

// Helper to build a minimal "original" transaction fixture for reversal tests.
function buildOriginal(overrides = {}) {
  return {
    _id: 'orig1',
    businessId: 'biz1',
    status: 'posted',
    partiallyPaidAmount: 0,
    entryType: 'adjusting', // non-'normal' → skips period-lock lookups
    amount: 100,
    transactionType: 'Journal Entry',
    description: 'Test entry',
    inputMethod: 'form',
    debitAccountId: { _id: 'accD' },
    creditAccountId: { _id: 'accC' },
    // no customerId/vendorId/installmentPlanId
    metadata: {},
    ...overrides,
  };
}

describe('reverseTransaction atomicity (audit A9/A3)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('all writes run inside one transaction session', async () => {
    const original = buildOriginal();
    transactionRepository.findByIdWithDetails.mockResolvedValue(original);
    transactionRepository.createTransaction.mockResolvedValue({ _id: 'rev1', debitAccountId: 'accC', creditAccountId: 'accD' });
    transactionRepository.updateTransaction.mockResolvedValue({});
    accountRepository.findById.mockResolvedValue({ _id: 'accD', normalBalance: 'Debit' });
    accountRepository.updateRunningBalance.mockResolvedValue({});

    await transactionService.reverseTransaction('orig1', 'biz1', { reason: 'test' }, 'user1', '127.0.0.1');

    // The reversal entry is created with the transaction session.
    expect(transactionRepository.createTransaction).toHaveBeenCalledWith(expect.any(Object), SESSION);
    // The running-balance updates run with the transaction session.
    expect(accountRepository.updateRunningBalance).toHaveBeenCalledWith(expect.anything(), expect.anything(), SESSION);
    // Marking the original reversed runs with the transaction session.
    expect(transactionRepository.updateTransaction).toHaveBeenCalledWith('orig1', 'biz1', expect.any(Object), SESSION);
  });

  test('reverseTransaction joins a caller-supplied session instead of opening its own', async () => {
    // withTransaction must NOT be called when an external session is passed.
    const withTxModule = require('../../../utils/withTransaction');
    const spy = jest.spyOn(withTxModule, 'withTransaction');
    const fakeSession = { id: 'caller-session' };

    const original = buildOriginal({ journalLines: [] });
    transactionRepository.findByIdWithDetails.mockResolvedValue(original);
    transactionRepository.createTransaction.mockResolvedValue({ _id: 'rev1', debitAccountId: 'accC', creditAccountId: 'accD' });
    transactionRepository.updateTransaction.mockResolvedValue({});
    accountRepository.findById.mockResolvedValue({ _id: 'accD', normalBalance: 'Debit' });
    accountRepository.updateRunningBalance.mockResolvedValue({});

    await transactionService.reverseTransaction(
      original._id, original.businessId,
      { reason: 'test', session: fakeSession },
      'user1', '0.0.0.0'
    );

    expect(spy).not.toHaveBeenCalled();
    // The reversal entry was created on the caller's session.
    expect(transactionRepository.createTransaction).toHaveBeenCalledWith(expect.any(Object), fakeSession);

    spy.mockRestore();
  });
});
