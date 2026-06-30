/**
 * tests/unit/services/payment.service.test.js
 *
 * AR/AP Domain Refactor — Milestone M2 (first-class Payment).
 * Validates multi-document allocation, partial + overpayment handling, and
 * rollback safety. Persistence + the settlement primitive are mocked; the
 * orchestration logic is exercised for real.
 */
'use strict';

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
jest.mock('../../../services/transaction.service', () => ({ recordPartialPayment: jest.fn(), deleteTransaction: jest.fn().mockResolvedValue(undefined) }));

const paymentService   = require('../../../services/payment.service');
const Payment          = require('../../../models/Payment.model');
const JournalEntry     = require('../../../models/JournalEntry.model');
const Invoice          = require('../../../models/Invoice.model');
const Bill             = require('../../../models/Bill.model');
const ChartOfAccount   = require('../../../models/ChartOfAccount.model');
const ledgerPosting    = require('../../../services/ledgerPosting.service');
const txService        = require('../../../services/transaction.service');
const { businessEvents, EVENTS } = require('../../../services/businessEventEngine.service');
const { TRANSACTION_TYPES } = require('../../../config/constants');

const BIZ = '507f1f77bcf86cd799439060';
const CUST = '507f1f77bcf86cd799439071';
const VEND = '507f1f77bcf86cd799439072';
const CASH = '507f1f77bcf86cd799439081';

// Stateful fake Payment document whose save() replicates the model's pre-save totals.
function fakePaymentDoc(data) {
  const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
  return {
    _id: 'pay1', ...data,
    allocations: data.allocations,
    unappliedJournalEntryId: null,
    voidReason: null,
    save: jest.fn(function () {
      this.allocatedAmount = r2((this.allocations || []).reduce((s, a) => s + (a.amount || 0), 0));
      this.unappliedAmount = r2((this.amount || 0) - this.allocatedAmount);
      if (this.status !== 'void') {
        this.status = this.allocatedAmount <= 0 ? 'unallocated'
          : this.unappliedAmount > 0.009 ? 'partially_allocated' : 'completed';
      }
      return Promise.resolve(this);
    }),
  };
}

// JE registry keyed by id. Each defaults to an AR credit-sale with plenty of balance.
let JES;
const makeJE = (o) => ({
  _id: o._id, businessId: BIZ, transactionType: TRANSACTION_TYPES.CREDIT_SALE,
  remainingBalance: 1000, customerId: CUST, vendorId: null, invoiceNumber: o._id, ...o,
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(businessEvents, 'emit').mockReturnValue('evt');

  JES = {};
  JournalEntry.findOne.mockImplementation((q) => ({ lean: () => Promise.resolve(JES[String(q._id)] || null) }));
  // Best-effort document lookup by linkedJournalEntryId → return a light doc.
  Invoice.findOne.mockImplementation((q) => ({ lean: () => Promise.resolve({ _id: 'inv-' + q.linkedJournalEntryId, invoiceNumber: 'INV-' + q.linkedJournalEntryId }) }));
  Bill.findOne.mockImplementation((q) => ({ lean: () => Promise.resolve({ _id: 'bill-' + q.linkedJournalEntryId, billNumber: 'BILL-' + q.linkedJournalEntryId }) }));
  // Cash account by _id; advance account by accountCode.
  ChartOfAccount.findOne.mockImplementation((q) => ({
    lean: () => Promise.resolve(q.accountCode ? { _id: 'adv-' + q.accountCode } : { _id: CASH }),
  }));
  Payment.nextPaymentNumber = jest.fn().mockResolvedValue('PAY-202605-00001');
  Payment.create = jest.fn().mockImplementation((data) => Promise.resolve(fakePaymentDoc(data)));
  txService.recordPartialPayment.mockImplementation((parentId) => Promise.resolve({ _id: 'child-' + parentId }));
  txService.deleteTransaction.mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

const emittedNames = () => businessEvents.emit.mock.calls.map((c) => c[0]);

// ── One payment → many invoices ──────────────────────────────────────────────
describe('recordPayment — one receipt across many invoices', () => {
  it('settles each invoice and broadcasts PAYMENT_APPLIED (fully allocated)', async () => {
    JES.je1 = makeJE({ _id: 'je1' }); JES.je2 = makeJE({ _id: 'je2' }); JES.je3 = makeJE({ _id: 'je3' });

    const payment = await paymentService.recordPayment(BIZ, {
      amount: 300, cashAccountId: CASH, paymentDate: new Date(),
      allocations: [
        { parentTransactionId: 'je1', amount: 100 },
        { parentTransactionId: 'je2', amount: 100 },
        { parentTransactionId: 'je3', amount: 100 },
      ],
    }, 'u1', '127.0.0.1');

    expect(txService.recordPartialPayment).toHaveBeenCalledTimes(3);
    expect(payment.direction).toBe('inbound');
    expect(payment.allocations).toHaveLength(3);
    expect(payment.allocations.every((a) => a.settlementTransactionId)).toBe(true);
    expect(payment.status).toBe('completed');
    expect(payment.unappliedAmount).toBe(0);
    expect(emittedNames()).toContain(EVENTS.PAYMENT_APPLIED);
    expect(ledgerPosting.postBalancedJournal).not.toHaveBeenCalled(); // nothing unapplied
  });
});

// ── One payment → many bills ─────────────────────────────────────────────────
describe('recordPayment — one disbursement across many bills', () => {
  it('routes AP allocations to the vendor and settles each bill', async () => {
    JES.jb1 = makeJE({ _id: 'jb1', transactionType: TRANSACTION_TYPES.CREDIT_PURCHASE, customerId: null, vendorId: VEND });
    JES.jb2 = makeJE({ _id: 'jb2', transactionType: TRANSACTION_TYPES.CREDIT_PURCHASE, customerId: null, vendorId: VEND });

    const payment = await paymentService.recordPayment(BIZ, {
      amount: 500, cashAccountId: CASH, paymentDate: new Date(),
      allocations: [
        { parentTransactionId: 'jb1', amount: 300 },
        { parentTransactionId: 'jb2', amount: 200 },
      ],
    }, 'u1', '127.0.0.1');

    expect(payment.direction).toBe('outbound');
    expect(payment.partyType).toBe('vendor');
    expect(txService.recordPartialPayment).toHaveBeenCalledTimes(2);
    expect(payment.status).toBe('completed');
  });
});

// ── Partial allocation + overpayment (on account) ────────────────────────────
describe('recordPayment — partial allocation with overpayment', () => {
  it('posts an advance journal for the unapplied amount and marks partially_allocated', async () => {
    JES.je1 = makeJE({ _id: 'je1' });

    const payment = await paymentService.recordPayment(BIZ, {
      amount: 1000, cashAccountId: CASH, paymentDate: new Date(),
      allocations: [{ parentTransactionId: 'je1', amount: 800 }],
    }, 'u1', '127.0.0.1');

    expect(txService.recordPartialPayment).toHaveBeenCalledTimes(1);
    expect(ledgerPosting.postBalancedJournal).toHaveBeenCalledTimes(1);
    const advJe = ledgerPosting.postBalancedJournal.mock.calls[0][0];
    expect(advJe.amount).toBe(200);
    expect(advJe.debitAccountId).toBe(CASH);           // inbound overpay → DR Cash
    expect(advJe.creditAccountId).toBe('adv-2190');    // CR Advance from Customers
    expect(payment.unappliedJournalEntryId).toBe('adv-je');
    expect(payment.status).toBe('partially_allocated');
    expect(payment.unappliedAmount).toBe(200);
  });
});

// ── Validation guards ────────────────────────────────────────────────────────
describe('recordPayment — validation (no writes on reject)', () => {
  it('rejects allocations exceeding the payment amount', async () => {
    JES.je1 = makeJE({ _id: 'je1' });
    await expect(paymentService.recordPayment(BIZ, {
      amount: 100, cashAccountId: CASH,
      allocations: [{ parentTransactionId: 'je1', amount: 150 }],
    }, 'u1', '127.0.0.1')).rejects.toMatchObject({ statusCode: 400 });
    expect(txService.recordPartialPayment).not.toHaveBeenCalled();
  });

  it('rejects an allocation above the document outstanding balance', async () => {
    JES.je1 = makeJE({ _id: 'je1', remainingBalance: 50 });
    await expect(paymentService.recordPayment(BIZ, {
      amount: 100, cashAccountId: CASH,
      allocations: [{ parentTransactionId: 'je1', amount: 100 }],
    }, 'u1', '127.0.0.1')).rejects.toMatchObject({ statusCode: 400 });
    expect(txService.recordPartialPayment).not.toHaveBeenCalled();
  });

  it('rejects two allocations to the SAME entry whose sum exceeds its balance', async () => {
    // Each 60 is individually ≤ the 100 balance, but together (120) they would
    // over-settle the single parent to a negative remaining. The per-allocation
    // check reads the same pre-settlement balance twice and must not be fooled.
    JES.je1 = makeJE({ _id: 'je1', remainingBalance: 100 });
    await expect(paymentService.recordPayment(BIZ, {
      amount: 120, cashAccountId: CASH,
      allocations: [
        { parentTransactionId: 'je1', amount: 60 },
        { parentTransactionId: 'je1', amount: 60 },
      ],
    }, 'u1', '127.0.0.1')).rejects.toMatchObject({ statusCode: 400 });
    expect(txService.recordPartialPayment).not.toHaveBeenCalled();
  });

  it('rejects mixing two different parties in one payment', async () => {
    JES.je1 = makeJE({ _id: 'je1', customerId: CUST });
    JES.je2 = makeJE({ _id: 'je2', customerId: '507f1f77bcf86cd7994390ff' });
    await expect(paymentService.recordPayment(BIZ, {
      amount: 200, cashAccountId: CASH,
      allocations: [{ parentTransactionId: 'je1', amount: 100 }, { parentTransactionId: 'je2', amount: 100 }],
    }, 'u1', '127.0.0.1')).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ── Rollback safety ──────────────────────────────────────────────────────────
describe('recordPayment — rollback safety', () => {
  it('compensates applied settlements and voids the payment when an apply fails', async () => {
    JES.je1 = makeJE({ _id: 'je1' }); JES.je2 = makeJE({ _id: 'je2' });
    txService.recordPartialPayment
      .mockResolvedValueOnce({ _id: 'child-je1' })          // 1st allocation succeeds
      .mockRejectedValueOnce(new Error('ledger write failed')); // 2nd fails mid-apply

    const captured = [];
    Payment.create.mockImplementation((data) => { const d = fakePaymentDoc(data); captured.push(d); return Promise.resolve(d); });

    await expect(paymentService.recordPayment(BIZ, {
      amount: 200, cashAccountId: CASH,
      allocations: [{ parentTransactionId: 'je1', amount: 100 }, { parentTransactionId: 'je2', amount: 100 }],
    }, 'u1', '127.0.0.1')).rejects.toThrow(/ledger write failed/);

    // the already-applied settlement was reversed (compensated)
    expect(txService.deleteTransaction).toHaveBeenCalledWith('child-je1', BIZ, 'u1', '127.0.0.1');
    // and the payment was marked void (not left "completed")
    expect(captured[0].status).toBe('void');
    expect(captured[0].voidReason).toMatch(/Rolled back/);
  });
});

// ── Unlinked AR/AP (no customer/vendor on the target entry) ──────────────────
describe('recordPayment — settles an entry with no linked party', () => {
  it('records the payment with partyId=null instead of throwing', async () => {
    // A manual credit-sale journal with NO customer (the "Client Invoice
    // Generated" case) — previously this rejected with "not linked to a
    // customer/vendor"; it must now settle.
    JES.je1 = makeJE({ _id: 'je1', customerId: null, remainingBalance: 100000 });

    const payment = await paymentService.recordPayment(BIZ, {
      amount: 100000, cashAccountId: CASH, paymentDate: new Date(),
      allocations: [{ parentTransactionId: 'je1', amount: 100000 }],
    }, 'u1', '127.0.0.1');

    expect(payment.direction).toBe('inbound');
    expect(payment.partyId).toBeNull();
    expect(payment.partySnapshot).toEqual({});
    expect(txService.recordPartialPayment).toHaveBeenCalledTimes(1);
    expect(payment.status).toBe('completed');
  });
});

// ── Legacy adapter ───────────────────────────────────────────────────────────
describe('recordLegacyPayment — backward-compatible single allocation', () => {
  it('returns the child settlement transaction (legacy contract)', async () => {
    JES.je1 = makeJE({ _id: 'je1' });
    const childTx = await paymentService.recordLegacyPayment('je1', BIZ,
      { amount: 100, paymentAccountId: CASH, transactionDate: new Date() }, 'u1', '127.0.0.1');
    expect(childTx).toEqual({ _id: 'child-je1' });
  });
});
