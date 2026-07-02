/**
 * tests/unit/services/recordPartialPayment.atomic.test.js
 *
 * Proves a payment settlement is now ALL-OR-NOTHING: the child settlement entry,
 * the parent's balance update, and the party-balance update all run inside ONE
 * transaction (the same session is threaded through every write), and the
 * PAYMENT_RECORDED event is broadcast only AFTER that unit completes.
 *
 * The real createTransaction body is stubbed (spied) so we assert the wiring,
 * not the full ledger machinery (covered elsewhere).
 */
'use strict';

// Control the transaction boundary: run the work with a sentinel session.
jest.mock('../../../utils/withTransaction', () => ({
  withTransaction: jest.fn((fn) => fn('SESSION')),
}));
jest.mock('../../../repositories/transaction.repository');
jest.mock('../../../repositories/account.repository');
jest.mock('../../../services/audit.service');
jest.mock('../../../services/inventory.service');
jest.mock('../../../services/partyBalance.service', () => ({
  adjustReceivable: jest.fn().mockResolvedValue(null),
  adjustPayable:    jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../models/AccountingPeriod.model', () => ({
  findCoveringPeriod: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const transactionService    = require('../../../services/transaction.service');
const transactionRepository = require('../../../repositories/transaction.repository');
const partyBalanceService   = require('../../../services/partyBalance.service');
const { withTransaction }   = require('../../../utils/withTransaction');
const { businessEvents, EVENTS } = require('../../../services/businessEventEngine.service');
const { TRANSACTION_TYPES, JOURNAL_STATUS } = require('../../../config/constants');

const BIZ = 'biz1';
const CASH = 'CASH';

const makeParent = (o = {}) => ({
  _id: 'parent1', businessId: BIZ,
  transactionType: TRANSACTION_TYPES.CREDIT_SALE,
  status: JOURNAL_STATUS.POSTED,
  remainingBalance: 1000, partiallyPaidAmount: 0, dueDate: null,
  debitAccountId: { _id: 'AR' }, creditAccountId: { _id: 'SALES' },
  customerId: { _id: 'CUST' }, vendorId: null, invoiceNumber: 'INV-1',
  ...o,
});

let emitSpy;
beforeEach(() => {
  jest.clearAllMocks();
  emitSpy = jest.spyOn(businessEvents, 'emit').mockReturnValue('evt');
  jest.spyOn(transactionService, 'createTransaction').mockResolvedValue({ _id: 'child1' });
  transactionRepository.findByIdWithDetails.mockResolvedValue(makeParent());
  transactionRepository.updateTransaction.mockResolvedValue({});
  transactionRepository.updateTransactionGuarded.mockResolvedValue({ _id: 'parent1' });
});
afterEach(() => jest.restoreAllMocks());

test('threads ONE session through child entry, parent update, and party balance', async () => {
  const result = await transactionService.recordPartialPayment(
    'parent1', BIZ, { amount: 100, paymentAccountId: CASH, transactionDate: new Date() }, 'u1', '127.0.0.1'
  );

  // A transaction was opened.
  expect(withTransaction).toHaveBeenCalledTimes(1);

  // Child settlement entry created WITH the session.
  expect(transactionService.createTransaction).toHaveBeenCalledWith(
    expect.objectContaining({ transactionType: TRANSACTION_TYPES.PAYMENT_RECEIVED, amount: 100 }),
    'u1', '127.0.0.1', 'SESSION'
  );

  // Parent updated WITH the session, reflecting the new balance — through the
  // optimistic guard (F5) that matches on the remainingBalance we read.
  expect(transactionRepository.updateTransactionGuarded).toHaveBeenCalledWith(
    'parent1', BIZ,
    { remainingBalance: 1000 },
    expect.objectContaining({ remainingBalance: 900, partiallyPaidAmount: 100 }),
    'SESSION'
  );

  // Party balance decremented WITH the session in its context.
  expect(partyBalanceService.adjustReceivable).toHaveBeenCalledWith(
    BIZ, 'CUST', -100, expect.objectContaining({ session: 'SESSION' })
  );

  expect(result).toEqual({ _id: 'child1' });
});

test('broadcasts PAYMENT_RECORDED only AFTER the unit completes', async () => {
  const order = [];
  withTransaction.mockImplementationOnce(async (fn) => { const r = await fn('SESSION'); order.push('committed'); return r; });
  emitSpy.mockImplementation((name) => { order.push(`emit:${name}`); return 'evt'; });

  await transactionService.recordPartialPayment(
    'parent1', BIZ, { amount: 100, paymentAccountId: CASH, transactionDate: new Date() }, 'u1', '127.0.0.1'
  );

  expect(order).toEqual(['committed', `emit:${EVENTS.PAYMENT_RECORDED}`]);
});

test('reuses a caller-provided session instead of opening a nested transaction', async () => {
  await transactionService.recordPartialPayment(
    'parent1', BIZ, { amount: 100, paymentAccountId: CASH, transactionDate: new Date() }, 'u1', '127.0.0.1', 'OUTER'
  );

  expect(withTransaction).not.toHaveBeenCalled();           // no nested transaction
  expect(transactionService.createTransaction).toHaveBeenCalledWith(
    expect.objectContaining({ transactionType: TRANSACTION_TYPES.PAYMENT_RECEIVED }),
    'u1', '127.0.0.1', 'OUTER'
  );
});
