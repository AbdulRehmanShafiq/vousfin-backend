/**
 * tests/unit/services/payment.atomicity.test.js
 *
 * Audit 2026-07-02 F14 — a multi-allocation payment is ONE atomic unit.
 *
 * Each allocation used to run in its own transaction; a crash (or error)
 * mid-apply left earlier settlements committed with only a best-effort
 * compensation pass to unwind them — and that pass itself relied on the
 * then-broken payment-reversal path (F4). All allocations, the on-account
 * advance and the Payment document update now share one session: they all
 * commit, or none do. Compensation reversals remain only for the standalone-
 * MongoDB fallback where no real transaction was available.
 */
'use strict';

const SESSION = 'PAY-SESSION';

jest.mock('../../../utils/withTransaction', () => ({
  withTransaction: jest.fn((fn) => fn('PAY-SESSION')),
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../models/Payment.model');
jest.mock('../../../models/Invoice.model', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/Bill.model',    () => ({ findOne: jest.fn() }));
jest.mock('../../../models/JournalEntry.model', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/ChartOfAccount.model', () => ({ findOne: jest.fn() }));
jest.mock('../../../repositories/customer.repository', () => ({ findByBusinessAndId: jest.fn().mockResolvedValue({ fullName: 'Acme' }) }));
jest.mock('../../../repositories/vendor.repository',   () => ({ findByBusinessAndId: jest.fn().mockResolvedValue({ vendorName: 'Globex' }) }));
jest.mock('../../../services/ledgerPosting.service', () => ({ postBalancedJournal: jest.fn().mockResolvedValue({ _id: 'adv-je' }) }));
jest.mock('../../../services/audit.service', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../services/transaction.service', () => ({
  recordPartialPayment: jest.fn(),
  deleteTransaction: jest.fn().mockResolvedValue(undefined),
}));

const paymentService = require('../../../services/payment.service');
const Payment        = require('../../../models/Payment.model');
const JournalEntry   = require('../../../models/JournalEntry.model');
const Invoice        = require('../../../models/Invoice.model');
const Bill           = require('../../../models/Bill.model');
const ChartOfAccount = require('../../../models/ChartOfAccount.model');
const ledgerPosting  = require('../../../services/ledgerPosting.service');
const txService      = require('../../../services/transaction.service');
const { businessEvents } = require('../../../services/businessEventEngine.service');
const { TRANSACTION_TYPES } = require('../../../config/constants');

const BIZ = '507f1f77bcf86cd799439060';
const CUST = '507f1f77bcf86cd799439071';
const CASH = '507f1f77bcf86cd799439081';

function fakePaymentDoc(data) {
  const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
  return {
    _id: 'pay1', ...data,
    unappliedJournalEntryId: null, voidReason: null,
    save: jest.fn(function () {
      this.allocatedAmount = r2((this.allocations || []).reduce((s, a) => s + (a.amount || 0), 0));
      this.unappliedAmount = r2((this.amount || 0) - this.allocatedAmount);
      if (this.status !== 'void') this.status = 'completed';
      return Promise.resolve(this);
    }),
  };
}

let JES;
const makeJE = (o) => ({
  _id: o._id, businessId: BIZ, transactionType: TRANSACTION_TYPES.CREDIT_SALE,
  remainingBalance: 1000, customerId: CUST, vendorId: null, invoiceNumber: o._id, ...o,
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(businessEvents, 'emit').mockReturnValue('evt');
  JES = { je1: makeJE({ _id: 'je1' }), je2: makeJE({ _id: 'je2' }) };
  JournalEntry.findOne.mockImplementation((q) => ({ lean: () => Promise.resolve(JES[String(q._id)] || null) }));
  Invoice.findOne.mockImplementation(() => ({ lean: () => Promise.resolve(null) }));
  Bill.findOne.mockImplementation(() => ({ lean: () => Promise.resolve(null) }));
  ChartOfAccount.findOne.mockImplementation((q) => ({
    lean: () => Promise.resolve(q.accountCode ? { _id: 'adv-acc' } : { _id: CASH }),
  }));
  Payment.nextPaymentNumber = jest.fn().mockResolvedValue('PAY-1');
  Payment.create = jest.fn().mockImplementation((data) => Promise.resolve(fakePaymentDoc(data)));
  txService.recordPartialPayment.mockImplementation((parentId) => Promise.resolve({ _id: 'child-' + parentId }));
});
afterEach(() => jest.restoreAllMocks());

const record = (over = {}) => paymentService.recordPayment(BIZ, {
  amount: 300, cashAccountId: CASH, paymentDate: new Date(),
  allocations: [
    { parentTransactionId: 'je1', amount: 100 },
    { parentTransactionId: 'je2', amount: 100 },
  ],
  ...over,
}, 'u1', '127.0.0.1');

describe('F14 — one transaction across the whole payment', () => {
  test('every allocation settles inside the SAME session', async () => {
    await record();

    expect(txService.recordPartialPayment).toHaveBeenCalledTimes(2);
    for (const call of txService.recordPartialPayment.mock.calls) {
      expect(call[5]).toBe(SESSION); // 6th arg = session
    }
  });

  test('the on-account advance and the Payment save join the session too', async () => {
    const payment = await record(); // 100 unapplied → advance JE

    expect(ledgerPosting.postBalancedJournal).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 100 }),
      expect.objectContaining({ session: SESSION })
    );
    expect(payment.save).toHaveBeenCalledWith(expect.objectContaining({ session: SESSION }));
  });

  test('when the unit ran in a REAL transaction, a failure skips compensation reversals (rollback already undid the writes)', async () => {
    txService.recordPartialPayment
      .mockResolvedValueOnce({ _id: 'child-je1' })
      .mockRejectedValueOnce(new Error('allocation 2 failed'));

    await expect(record()).rejects.toThrow('allocation 2 failed');

    // No manual reversal of the first settlement — the transaction rolled it back.
    expect(txService.deleteTransaction).not.toHaveBeenCalled();
  });

  test('a failed payment is still marked void with the reason', async () => {
    txService.recordPartialPayment.mockRejectedValue(new Error('boom'));

    await expect(record()).rejects.toThrow('boom');

    const doc = await Payment.create.mock.results[0].value;
    expect(doc.status).toBe('void');
    expect(doc.voidReason).toMatch(/boom/);
  });
});
