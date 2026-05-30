/**
 * tests/unit/services/arApReconciliation.service.test.js
 *
 * AR/AP Domain Refactor — Milestone M1.
 * Validates the ledger → document payment reconciliation: the JournalEntry's
 * authoritative paid/remaining/state is PROJECTED onto the linked Invoice/Bill,
 * idempotently and replay-safely, respecting the document state machine.
 */
'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../services/audit.service', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../models/Invoice.model', () => ({ findOne: jest.fn(), canTransition: jest.fn(() => true) }));
jest.mock('../../../models/Bill.model',    () => ({ findOne: jest.fn(), canTransition: jest.fn(() => true) }));
jest.mock('../../../models/JournalEntry.model', () => ({ findOne: jest.fn() }));

const reconcile        = require('../../../services/arApReconciliation.service');
const Invoice          = require('../../../models/Invoice.model');
const Bill             = require('../../../models/Bill.model');
const JournalEntry     = require('../../../models/JournalEntry.model');
const auditService     = require('../../../services/audit.service');
const { TRANSACTION_TYPES, INVOICE_STATES, BILL_STATES } = require('../../../config/constants');

const BIZ = '507f1f77bcf86cd799439060';
const JE_ID = '507f1f77bcf86cd799439071';

const makeJE = (o = {}) => ({
  _id: JE_ID, businessId: BIZ, transactionType: TRANSACTION_TYPES.CREDIT_SALE,
  amount: 1000, taxAmount: 0, remainingBalance: 0, partiallyPaidAmount: 1000,
  invoiceNumber: 'INV-1', ...o,
});

const makeDoc = (o = {}) => ({
  _id: 'doc1', businessId: BIZ, state: 'approved', totalAmount: 1000,
  paidAmount: 0, remainingBalance: 1000, invoiceNumber: 'INV-1', billNumber: 'BILL-1',
  createdBy: 'u1',
  recordStateChange: jest.fn(),
  save: jest.fn().mockResolvedValue(undefined),
  ...o,
});

beforeEach(() => {
  jest.clearAllMocks();
  Invoice.canTransition.mockReturnValue(true);
  Bill.canTransition.mockReturnValue(true);
});

// ── Full payment ─────────────────────────────────────────────────────────────
describe('reconcileFromJournal — full payment', () => {
  it('projects a fully-settled JE onto the invoice → state PAID, remaining 0', async () => {
    const doc = makeDoc();
    Invoice.findOne.mockResolvedValue(doc);

    const res = await reconcile.reconcileFromJournal(makeJE({ remainingBalance: 0, partiallyPaidAmount: 1000 }));

    expect(res.reconciled).toBe(true);
    expect(res.documentType).toBe('invoice');
    expect(doc.paidAmount).toBe(1000);
    expect(doc.remainingBalance).toBe(0);
    expect(doc.state).toBe(INVOICE_STATES.PAID);
    expect(doc.recordStateChange).toHaveBeenCalledWith(INVOICE_STATES.PAID, expect.any(Object), expect.any(String));
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(auditService.log).toHaveBeenCalledTimes(1);
  });
});

// ── Partial payment ──────────────────────────────────────────────────────────
describe('reconcileFromJournal — partial payment', () => {
  it('projects a partially-paid JE → state PARTIALLY_PAID with correct money', async () => {
    const doc = makeDoc({ state: 'sent' });
    Invoice.findOne.mockResolvedValue(doc);

    const res = await reconcile.reconcileFromJournal(makeJE({ remainingBalance: 600, partiallyPaidAmount: 400 }));

    expect(res.reconciled).toBe(true);
    expect(doc.paidAmount).toBe(400);
    expect(doc.remainingBalance).toBe(600);
    expect(doc.state).toBe(INVOICE_STATES.PARTIALLY_PAID);
  });
});

// ── Idempotency / duplicate event replay ─────────────────────────────────────
describe('reconcileFromJournal — duplicate replay is idempotent', () => {
  it('the second identical reconcile is a no-op (no extra save)', async () => {
    const doc = makeDoc();            // same stateful instance returned both times
    Invoice.findOne.mockResolvedValue(doc);
    const je = makeJE({ remainingBalance: 0, partiallyPaidAmount: 1000 });

    const first  = await reconcile.reconcileFromJournal(je);
    const second = await reconcile.reconcileFromJournal(je);

    expect(first.reconciled).toBe(true);
    expect(second.reconciled).toBe(false);
    expect(second.reason).toBe('already_in_sync');
    expect(doc.save).toHaveBeenCalledTimes(1);  // ← projected exactly once
    expect(doc.state).toBe(INVOICE_STATES.PAID);
  });
});

// ── AP / Bill side ───────────────────────────────────────────────────────────
describe('reconcileFromJournal — bill (AP)', () => {
  it('routes CREDIT_PURCHASE to the Bill model and marks it PAID', async () => {
    const doc = makeDoc({ state: 'approved' });
    Bill.findOne.mockResolvedValue(doc);

    const res = await reconcile.reconcileFromJournal(
      makeJE({ transactionType: TRANSACTION_TYPES.CREDIT_PURCHASE, remainingBalance: 0, partiallyPaidAmount: 1000 })
    );

    expect(res.documentType).toBe('bill');
    expect(doc.state).toBe(BILL_STATES.PAID);
    expect(Invoice.findOne).not.toHaveBeenCalled();
  });
});

// ── Guards ───────────────────────────────────────────────────────────────────
describe('reconcileFromJournal — guards', () => {
  it('skips a non AR/AP journal entry', async () => {
    const res = await reconcile.reconcileFromJournal(makeJE({ transactionType: 'Expense' }));
    expect(res).toMatchObject({ reconciled: false, reason: 'not_ar_ap' });
    expect(Invoice.findOne).not.toHaveBeenCalled();
  });

  it('skips when no document is linked', async () => {
    Invoice.findOne.mockResolvedValue(null); // both link + number lookups miss
    const res = await reconcile.reconcileFromJournal(makeJE());
    expect(res).toMatchObject({ reconciled: false, reason: 'document_not_found' });
  });

  it('corrects money but leaves state when the transition is illegal', async () => {
    const doc = makeDoc({ state: 'draft' });
    Invoice.findOne.mockResolvedValue(doc);
    Invoice.canTransition.mockReturnValue(false); // draft → partially_paid not allowed

    const res = await reconcile.reconcileFromJournal(makeJE({ remainingBalance: 600, partiallyPaidAmount: 400 }));

    expect(res.reconciled).toBe(true);
    expect(doc.paidAmount).toBe(400);
    expect(doc.remainingBalance).toBe(600);
    expect(doc.state).toBe('draft');                 // unchanged
    expect(doc.recordStateChange).not.toHaveBeenCalled();
  });
});

// ── id entry point (live handler + backfill share this) ──────────────────────
describe('reconcileByJournalEntryId', () => {
  it('re-reads the JE and delegates to reconcileFromJournal', async () => {
    JournalEntry.findOne.mockReturnValue({ lean: () => Promise.resolve(makeJE({ remainingBalance: 0, partiallyPaidAmount: 1000 })) });
    const doc = makeDoc();
    Invoice.findOne.mockResolvedValue(doc);

    const res = await reconcile.reconcileByJournalEntryId(BIZ, JE_ID, { userId: 'u9' });

    expect(JournalEntry.findOne).toHaveBeenCalledWith({ _id: JE_ID, businessId: BIZ });
    expect(res.reconciled).toBe(true);
    expect(doc.state).toBe(INVOICE_STATES.PAID);
  });

  it('returns a no-op when the journal entry is gone', async () => {
    JournalEntry.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    const res = await reconcile.reconcileByJournalEntryId(BIZ, JE_ID);
    expect(res).toMatchObject({ reconciled: false, reason: 'journal_entry_not_found' });
  });
});
