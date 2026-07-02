/**
 * tests/unit/services/transaction.paymentReversal.test.js
 *
 * Audit 2026-07-02 F4 — reversing a SETTLEMENT CHILD (payment) must restore the
 * parent's open item and the party balance, inside the same transaction.
 *
 * Before this fix, reversing a payment flipped the GL legs (AR/AP control
 * restored) but left the parent invoice/bill marked paid and the customer/
 * vendor balance unchanged — the control account, the open-item subledger and
 * the party balances all disagreed. payment.service._compensate relies on this
 * path, so a failed multi-allocation payment corrupted the subledger too.
 *
 * F5 — recordPartialPayment must persist the parent's new balance through a
 * GUARDED conditional update (match on the remainingBalance it read), so two
 * concurrent payments can't both apply against the same opening balance and
 * over-settle the document.
 */
'use strict';

const SESSION = { __sentinel: 'txn-session' };

jest.mock('../../../utils/withTransaction', () => ({
  withTransaction: jest.fn((fn) => fn({ __sentinel: 'txn-session' })),
}));
jest.mock('../../../repositories/transaction.repository');
jest.mock('../../../repositories/account.repository');
jest.mock('../../../services/audit.service');
jest.mock('../../../services/partyBalance.service', () => ({
  adjustReceivable: jest.fn().mockResolvedValue({}),
  adjustPayable: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../../models/AccountingPeriod.model', () => ({
  findCoveringPeriod: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const transactionService    = require('../../../services/transaction.service');
const transactionRepository = require('../../../repositories/transaction.repository');
const accountRepository     = require('../../../repositories/account.repository');
const partyBalanceService   = require('../../../services/partyBalance.service');
const auditService          = require('../../../services/audit.service');
const { businessEvents } = require('../../../services/businessEventEngine.service');
const { TRANSACTION_TYPES, JOURNAL_STATUS, PAYMENT_STATUS } = require('../../../config/constants');

const BIZ = 'biz1';

const makeParent = (o = {}) => ({
  _id: 'parent1', businessId: BIZ,
  transactionType: TRANSACTION_TYPES.CREDIT_SALE,
  status: JOURNAL_STATUS.PARTIALLY_SETTLED,
  amount: 1000, remainingBalance: 600, partiallyPaidAmount: 400,
  paymentStatus: PAYMENT_STATUS.PARTIALLY_PAID, dueDate: null,
  debitAccountId: { _id: 'AR' }, creditAccountId: { _id: 'SALES' },
  customerId: { _id: 'CUST' }, vendorId: null,
  metadata: {},
  ...o,
});

const makePaymentChild = (o = {}) => ({
  _id: 'child1', businessId: BIZ,
  transactionType: TRANSACTION_TYPES.PAYMENT_RECEIVED,
  transactionMode: 'partial_settlement',
  status: JOURNAL_STATUS.POSTED,
  entryType: 'adjusting', // skip period lookups in this unit harness
  amount: 400, partiallyPaidAmount: 0,
  debitAccountId: { _id: 'CASH' }, creditAccountId: { _id: 'AR' },
  parentTransactionId: { _id: 'parent1' },
  metadata: {},
  ...o,
});

beforeEach(() => {
  jest.clearAllMocks();
  auditService.logReversal = jest.fn().mockResolvedValue(undefined);
  accountRepository.findById.mockResolvedValue({ _id: 'acc', normalBalance: 'Debit' });
  accountRepository.updateRunningBalance.mockResolvedValue({});
  transactionRepository.createTransaction.mockResolvedValue({ _id: 'rev1', debitAccountId: 'AR', creditAccountId: 'CASH' });
  transactionRepository.updateTransaction.mockResolvedValue({});
  jest.spyOn(businessEvents, 'emit').mockReturnValue('evt');
});
afterEach(() => jest.restoreAllMocks());

describe('F4 — reversing a payment child restores the parent open item', () => {
  test('parent balance, status and settlements are restored with the txn session', async () => {
    const parent = makeParent();
    transactionRepository.findByIdWithDetails.mockImplementation((id) =>
      Promise.resolve(id === 'child1' ? makePaymentChild() : parent)
    );

    await transactionService.reverseTransaction('child1', BIZ, { reason: 'wrong amount' }, 'u1', '127.0.0.1');

    // Parent restored: 600 + 400 back to 1000 open, nothing paid.
    expect(transactionRepository.updateTransaction).toHaveBeenCalledWith(
      'parent1', BIZ,
      expect.objectContaining({
        remainingBalance: 1000,
        partiallyPaidAmount: 0,
        paymentStatus: PAYMENT_STATUS.UNPAID,
        status: JOURNAL_STATUS.POSTED,
        $pull: expect.objectContaining({ settlements: { transactionId: 'child1' } }),
      }),
      SESSION
    );

    // Customer owes the money again.
    expect(partyBalanceService.adjustReceivable).toHaveBeenCalledWith(
      BIZ, 'CUST', 400,
      expect.objectContaining({ session: SESSION, reason: 'payment_reversal' })
    );
  });

  test('a partially-restored parent stays partially settled', async () => {
    const parent = makeParent({ remainingBalance: 0, partiallyPaidAmount: 1000, status: JOURNAL_STATUS.SETTLED, paymentStatus: PAYMENT_STATUS.PAID });
    transactionRepository.findByIdWithDetails.mockImplementation((id) =>
      Promise.resolve(id === 'child1' ? makePaymentChild() : parent)
    );

    await transactionService.reverseTransaction('child1', BIZ, {}, 'u1', '127.0.0.1');

    expect(transactionRepository.updateTransaction).toHaveBeenCalledWith(
      'parent1', BIZ,
      expect.objectContaining({
        remainingBalance: 400,
        partiallyPaidAmount: 600,
        paymentStatus: PAYMENT_STATUS.PARTIALLY_PAID,
        status: JOURNAL_STATUS.PARTIALLY_SETTLED,
      }),
      SESSION
    );
  });

  test('an outbound payment (PAYMENT_MADE) restores the vendor payable', async () => {
    const parent = makeParent({
      transactionType: TRANSACTION_TYPES.CREDIT_PURCHASE,
      customerId: null, vendorId: { _id: 'VEND' },
    });
    transactionRepository.findByIdWithDetails.mockImplementation((id) =>
      Promise.resolve(id === 'child1'
        ? makePaymentChild({ transactionType: TRANSACTION_TYPES.PAYMENT_MADE })
        : parent)
    );

    await transactionService.reverseTransaction('child1', BIZ, {}, 'u1', '127.0.0.1');

    expect(partyBalanceService.adjustPayable).toHaveBeenCalledWith(
      BIZ, 'VEND', 400,
      expect.objectContaining({ session: SESSION, reason: 'payment_reversal' })
    );
  });

  test('a FOREIGN payment child restores the parent by its BASE amount (booking rate)', async () => {
    // USD 1,000 child against a USD invoice booked @280 → 280,000 base was relieved.
    const parent = makeParent({
      currencyCode: 'USD', exchangeRate: 280, amount: 1000,
      remainingBalance: 0, partiallyPaidAmount: 280000,
      status: JOURNAL_STATUS.SETTLED, paymentStatus: PAYMENT_STATUS.PAID,
    });
    transactionRepository.findByIdWithDetails.mockImplementation((id) =>
      Promise.resolve(id === 'child1'
        ? makePaymentChild({ amount: 1000, currencyCode: 'USD', exchangeRate: 285 })
        : parent)
    );

    await transactionService.reverseTransaction('child1', BIZ, {}, 'u1', '127.0.0.1');

    expect(transactionRepository.updateTransaction).toHaveBeenCalledWith(
      'parent1', BIZ,
      expect.objectContaining({ remainingBalance: 280000, partiallyPaidAmount: 0 }),
      SESSION
    );
    expect(partyBalanceService.adjustReceivable).toHaveBeenCalledWith(
      BIZ, 'CUST', 280000, expect.anything()
    );
  });

  test('reversing a NON-child entry never touches a parent', async () => {
    transactionRepository.findByIdWithDetails.mockResolvedValue({
      ...makePaymentChild({ transactionType: 'Expense', parentTransactionId: null }),
    });

    await transactionService.reverseTransaction('child1', BIZ, {}, 'u1', '127.0.0.1');

    // Only the original itself is updated (marked reversed) — exactly one update call.
    expect(transactionRepository.updateTransaction).toHaveBeenCalledTimes(1);
    expect(transactionRepository.updateTransaction).toHaveBeenCalledWith('child1', BIZ, expect.any(Object), SESSION);
    expect(partyBalanceService.adjustReceivable).not.toHaveBeenCalled();
  });

  test('a parent that was itself reversed is left untouched', async () => {
    const parent = makeParent({ status: JOURNAL_STATUS.REVERSED });
    transactionRepository.findByIdWithDetails.mockImplementation((id) =>
      Promise.resolve(id === 'child1' ? makePaymentChild() : parent)
    );

    await transactionService.reverseTransaction('child1', BIZ, {}, 'u1', '127.0.0.1');

    expect(transactionRepository.updateTransaction).toHaveBeenCalledTimes(1); // only the child
    expect(partyBalanceService.adjustReceivable).not.toHaveBeenCalled();
  });
});

describe('F5 — settlement writes are guarded against concurrent double-pay', () => {
  beforeEach(() => {
    jest.spyOn(transactionService, 'createTransaction').mockResolvedValue({ _id: 'child1' });
    transactionRepository.findByIdWithDetails.mockResolvedValue({
      ...makeParent(), remainingBalance: 1000, partiallyPaidAmount: 0, status: JOURNAL_STATUS.POSTED,
    });
    transactionRepository.updateTransactionGuarded = jest.fn().mockResolvedValue({ _id: 'parent1' });
  });

  test('the parent update matches on the remainingBalance that was read (optimistic guard)', async () => {
    await transactionService.recordPartialPayment(
      'parent1', BIZ, { amount: 100, paymentAccountId: 'CASH', transactionDate: new Date() }, 'u1', '127.0.0.1'
    );

    expect(transactionRepository.updateTransactionGuarded).toHaveBeenCalledWith(
      'parent1', BIZ,
      { remainingBalance: 1000 },
      expect.objectContaining({ remainingBalance: 900, partiallyPaidAmount: 100 }),
      SESSION
    );
  });

  test('a lost race (guard matches nothing) rejects with 409 instead of silently over-settling', async () => {
    transactionRepository.updateTransactionGuarded.mockResolvedValue(null);

    await expect(
      transactionService.recordPartialPayment(
        'parent1', BIZ, { amount: 100, paymentAccountId: 'CASH', transactionDate: new Date() }, 'u1', '127.0.0.1'
      )
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
