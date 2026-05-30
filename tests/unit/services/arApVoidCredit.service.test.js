/**
 * tests/unit/services/arApVoidCredit.service.test.js
 *
 * AR/AP Domain Refactor — Milestone M5 (void + credit memo).
 * Validates accounting-correct voiding for unpaid / partially-paid / fully-paid
 * documents (records preserved, reversing JEs posted, balances unwound) and
 * credit-memo application.
 */
'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../services/ledgerPosting.service', () => {
  let c = 0;
  return { postBalancedJournal: jest.fn().mockImplementation((je) => Promise.resolve({ _id: `je-${++c}`, ...je })) };
});
jest.mock('../../../services/partyBalance.service', () => ({ adjustReceivable: jest.fn(), adjustPayable: jest.fn() }));
jest.mock('../../../services/audit.service', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../services/businessEventEngine.service', () => ({
  businessEvents: { emit: jest.fn() },
  EVENTS: { INVOICE_VOIDED: 'invoice.voided', BILL_VOIDED: 'bill.voided', CREDIT_MEMO_APPLIED: 'credit_memo.applied' },
}));
jest.mock('../../../models/ChartOfAccount.model', () => ({
  findOne: jest.fn((q) => ({ lean: () => Promise.resolve({ _id: `acc-${q.accountCode.$in[0]}` }) })),
}));
jest.mock('../../../models/JournalEntry.model', () => ({
  findById: jest.fn(() => ({ lean: () => Promise.resolve({ _id: 'recog', debitAccountId: 'EXP-acct', creditAccountId: 'REV-acct' }) })),
}));

const svc = require('../../../services/arApVoidCredit.service');
const ledgerPosting = require('../../../services/ledgerPosting.service');
const partyBalance = require('../../../services/partyBalance.service');

const BIZ = '507f1f77bcf86cd799439060';
const USER = { _id: 'u1', fullName: 'Tester' };

const makeInvoice = (o = {}) => ({
  _id: 'inv1', businessId: BIZ, invoiceNumber: 'INV-1', state: 'approved',
  totalAmount: 1000, taxAmount: 100, paidAmount: 0, remainingBalance: 1000,
  customerId: 'cust1', arJournalId: 'arje1', linkedJournalEntryId: 'arje1',
  currencyCode: 'PKR', exchangeRate: 1, voidJournalEntryIds: [], creditMemos: [],
  recordStateChange: jest.fn(), save: jest.fn().mockResolvedValue(undefined),
  constructor: { canTransition: () => true },
  ...o,
});

beforeEach(() => jest.clearAllMocks());

// ── VOID ─────────────────────────────────────────────────────────────────────
describe('voidDocument — unpaid invoice', () => {
  it('reverses recognition (net + tax), no refund, unwinds AR by total, preserves record', async () => {
    const inv = makeInvoice();
    await svc.voidDocument('invoice', inv, 'duplicate', USER, '127.0.0.1');

    expect(ledgerPosting.postBalancedJournal).toHaveBeenCalledTimes(2); // net + tax, no payment
    const [net, tax] = ledgerPosting.postBalancedJournal.mock.calls.map((c) => c[0]);
    expect(net.amount).toBe(900);  expect(net.debitAccountId).toBe('REV-acct'); expect(net.creditAccountId).toBe('acc-1110');
    expect(tax.amount).toBe(100);  expect(tax.creditAccountId).toBe('acc-1110');
    expect(partyBalance.adjustReceivable).toHaveBeenCalledWith(BIZ, 'cust1', -1000, expect.any(Object));
    expect(inv.state).toBe('voided');
    expect(inv.voidedAt).toBeInstanceOf(Date);
    expect(inv.voidJournalEntryIds).toHaveLength(2);
    expect(inv.save).toHaveBeenCalled();           // NOT deleted — record preserved
  });
});

describe('voidDocument — fully paid invoice', () => {
  it('also refunds cash (DR AR / CR Cash) and leaves AR unwind at 0', async () => {
    const inv = makeInvoice({ paidAmount: 1000, remainingBalance: 0 });
    await svc.voidDocument('invoice', inv, 'refund', USER, '127.0.0.1');

    expect(ledgerPosting.postBalancedJournal).toHaveBeenCalledTimes(3); // net + tax + refund
    const refund = ledgerPosting.postBalancedJournal.mock.calls[2][0];
    expect(refund.amount).toBe(1000);
    expect(refund.debitAccountId).toBe('acc-1110');   // DR AR
    expect(refund.creditAccountId).toBe('acc-1010');  // CR Cash (refund)
    expect(partyBalance.adjustReceivable).not.toHaveBeenCalled(); // remaining was 0
    expect(inv.state).toBe('voided');
  });
});

describe('voidDocument — partially paid invoice', () => {
  it('reverses recognition + refunds the paid part, unwinds AR by remaining', async () => {
    const inv = makeInvoice({ paidAmount: 400, remainingBalance: 600 });
    await svc.voidDocument('invoice', inv, null, USER, '127.0.0.1');

    expect(ledgerPosting.postBalancedJournal).toHaveBeenCalledTimes(3);
    expect(ledgerPosting.postBalancedJournal.mock.calls[2][0].amount).toBe(400); // refund = paid
    expect(partyBalance.adjustReceivable).toHaveBeenCalledWith(BIZ, 'cust1', -600, expect.any(Object));
  });
});

describe('voidDocument — guards', () => {
  it('rejects voiding an already-voided document', async () => {
    await expect(svc.voidDocument('invoice', makeInvoice({ state: 'voided' }), 'x', USER, ''))
      .rejects.toMatchObject({ statusCode: 409 });
  });
  it('rejects voiding a document with no posted journal entry', async () => {
    await expect(svc.voidDocument('invoice', makeInvoice({ arJournalId: null, linkedJournalEntryId: null }), 'x', USER, ''))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('voidDocument — bill (AP mirror)', () => {
  it('reverses AP recognition and reclaims any payment', async () => {
    const bill = {
      _id: 'b1', businessId: BIZ, billNumber: 'BILL-1', state: 'approved',
      totalAmount: 500, taxAmount: 0, paidAmount: 500, remainingBalance: 0,
      vendorId: 'vend1', apLiabilityJournalId: 'apje1', currencyCode: 'PKR', exchangeRate: 1,
      voidJournalEntryIds: [], recordStateChange: jest.fn(), save: jest.fn().mockResolvedValue(undefined),
      constructor: { canTransition: () => true },
    };
    await svc.voidDocument('bill', bill, 'wrong vendor', USER, '');
    // net (500) + reclaim (500); no tax
    expect(ledgerPosting.postBalancedJournal).toHaveBeenCalledTimes(2);
    expect(bill.state).toBe('voided');
  });
});

// ── CREDIT MEMO ──────────────────────────────────────────────────────────────
describe('applyCreditMemo — customer credit', () => {
  it('posts DR Sales Returns / CR AR, reduces remaining, records the memo', async () => {
    const inv = makeInvoice({ remainingBalance: 1000, paidAmount: 0 });
    await svc.applyCreditMemo('invoice', inv, 300, 'goods returned', USER, '');

    expect(ledgerPosting.postBalancedJournal).toHaveBeenCalledTimes(1);
    const je = ledgerPosting.postBalancedJournal.mock.calls[0][0];
    expect(je.amount).toBe(300);
    expect(je.debitAccountId).toBe('acc-4115');  // DR Sales Returns
    expect(je.creditAccountId).toBe('acc-1110'); // CR AR
    expect(inv.remainingBalance).toBe(700);
    expect(inv.paidAmount).toBe(300);
    expect(inv.state).toBe('partially_paid');
    expect(inv.creditMemos).toHaveLength(1);
    expect(partyBalance.adjustReceivable).toHaveBeenCalledWith(BIZ, 'cust1', -300, expect.any(Object));
  });

  it('marks PAID when the credit clears the balance', async () => {
    const inv = makeInvoice({ remainingBalance: 200, paidAmount: 800 });
    await svc.applyCreditMemo('invoice', inv, 200, 'settle', USER, '');
    expect(inv.remainingBalance).toBe(0);
    expect(inv.state).toBe('paid');
  });

  it('rejects a credit memo exceeding the outstanding balance', async () => {
    await expect(svc.applyCreditMemo('invoice', makeInvoice({ remainingBalance: 100 }), 500, 'x', USER, ''))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});
