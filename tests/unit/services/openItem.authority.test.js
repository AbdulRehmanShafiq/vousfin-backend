/**
 * tests/unit/services/openItem.authority.test.js
 *
 * AR/AP open-item authority closeout (spec 2026-07-16) — every open item has
 * exactly ONE authority, decided by an airtight discriminator:
 *
 *   JE.isProjection === true  ⟺  the DOCUMENT owns the money (invoice-first)
 *   otherwise                 ⟺  the JE owns it (transaction-first — unchanged)
 *
 * resolveOpenItem is the only place that decision is made. Everything that
 * validates, settles, ages or reconciles an open item resolves through it.
 *
 * Unit discipline (F2): JE.remainingBalance is BASE currency;
 * doc.remainingBalance is DOCUMENT currency. The resolver exposes BASE only.
 */
'use strict';

jest.mock('../../../models/JournalEntry.model', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));
jest.mock('../../../models/Invoice.model', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/Bill.model', () => ({ findOne: jest.fn() }));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const JournalEntry = require('../../../models/JournalEntry.model');
const Invoice = require('../../../models/Invoice.model');
const Bill = require('../../../models/Bill.model');
const { resolveOpenItem } = require('../../../services/openItem.service');
const { TRANSACTION_TYPES } = require('../../../config/constants');

const BIZ = 'biz1';
const leanChain = (doc) => ({ session: () => ({ lean: () => Promise.resolve(doc) }) });
const mockJe = (je) => JournalEntry.findOne.mockReturnValue(leanChain(je));
const mockInvoice = (doc) => Invoice.findOne.mockReturnValue(leanChain(doc));
const mockBill = (doc) => Bill.findOne.mockReturnValue(leanChain(doc));

beforeEach(() => jest.clearAllMocks());

describe('resolveOpenItem — journal authority (transaction-first, unchanged behavior)', () => {
  test('a plain credit-sale JE is its own open item, in base currency', async () => {
    mockJe({
      _id: 'je1', transactionType: TRANSACTION_TYPES.CREDIT_SALE,
      remainingBalance: 500, partiallyPaidAmount: 100, amount: 600,
      customerId: 'cust1', dueDate: '2026-08-01', isProjection: false,
    });

    const item = await resolveOpenItem(BIZ, { journalEntryId: 'je1' });

    expect(item.authority).toBe('journal');
    expect(item.direction).toBe('receivable');
    expect(item.remainingBase).toBe(500);
    expect(item.partyId).toBe('cust1');
    expect(item.doc).toBeNull();
  });

  test('a non-open-item JE keeps the exact existing rejection', async () => {
    mockJe({ _id: 'je1', transactionType: TRANSACTION_TYPES.CREDIT_SALE, remainingBalance: null });

    await expect(resolveOpenItem(BIZ, { journalEntryId: 'je1' }))
      .rejects.toMatchObject({ statusCode: 400, message: 'Target entry does not track an outstanding balance' });
  });

  test('a missing JE is a 404', async () => {
    mockJe(null);
    await expect(resolveOpenItem(BIZ, { journalEntryId: 'nope' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  test('a non-AR/AP entry is rejected like the payment engine always did', async () => {
    mockJe({ _id: 'je1', transactionType: 'Expense', remainingBalance: 100 });
    await expect(resolveOpenItem(BIZ, { journalEntryId: 'je1' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('resolveOpenItem — document authority (invoice-first)', () => {
  test('a projection JE hands authority to its invoice', async () => {
    mockJe({
      _id: 'je1', transactionType: TRANSACTION_TYPES.CREDIT_SALE,
      remainingBalance: null, isProjection: true,
      projectionOf: { documentType: 'invoice', documentId: 'inv1' },
    });
    mockInvoice({
      _id: 'inv1', invoiceNumber: 'INV-1', customerId: 'cust1',
      totalAmount: 2500, paidAmount: 0, remainingBalance: 2500,
      exchangeRate: 1, currencyCode: 'PKR', dueDate: '2026-08-15', state: 'approved',
    });

    const item = await resolveOpenItem(BIZ, { journalEntryId: 'je1' });

    expect(item.authority).toBe('document');
    expect(item.direction).toBe('receivable');
    expect(item.remainingBase).toBe(2500);
    expect(item.dueDate).toBe('2026-08-15');
    expect(item.doc._id).toBe('inv1');
    expect(item.je._id).toBe('je1');
  });

  test('document balances convert to BASE at the booking rate (F2 discipline)', async () => {
    mockInvoice({
      _id: 'inv1', invoiceNumber: 'INV-2', customerId: 'cust1',
      arJournalId: 'je9', totalAmount: 100, paidAmount: 25, remainingBalance: 75,
      exchangeRate: 280, currencyCode: 'USD', state: 'partially_paid',
    });
    mockJe({ _id: 'je9', transactionType: TRANSACTION_TYPES.CREDIT_SALE, isProjection: true, debitAccountId: 'ar' });

    const item = await resolveOpenItem(BIZ, { documentType: 'invoice', documentId: 'inv1' });

    expect(item.authority).toBe('document');
    expect(item.remainingBase).toBe(21000); // 75 × 280
    expect(item.paidBase).toBe(7000);       // 25 × 280
    expect(item.bookingRate).toBe(280);
  });

  test('a projection whose document is missing REFUSES — corruption is never skipped', async () => {
    mockJe({
      _id: 'je1', transactionType: TRANSACTION_TYPES.CREDIT_SALE,
      remainingBalance: null, isProjection: true,
      projectionOf: { documentType: 'invoice', documentId: 'gone' },
    });
    mockInvoice(null);

    await expect(resolveOpenItem(BIZ, { journalEntryId: 'je1' }))
      .rejects.toMatchObject({ statusCode: 500 });
  });

  test('a bill with an AP liability journal is document authority on the payable side', async () => {
    mockBill({
      _id: 'bill1', billNumber: 'BILL-1', vendorId: 'v1',
      apLiabilityJournalId: 'je5', totalAmount: 900, paidAmount: 0, remainingBalance: 900,
      exchangeRate: 1, state: 'approved',
    });
    mockJe({ _id: 'je5', transactionType: TRANSACTION_TYPES.CREDIT_PURCHASE, isProjection: true });

    const item = await resolveOpenItem(BIZ, { documentType: 'bill', documentId: 'bill1' });

    expect(item.authority).toBe('document');
    expect(item.direction).toBe('payable');
    expect(item.partyId).toBe('v1');
  });
});

describe('resolveOpenItem — document ref falls through to journal authority (transaction-first docs)', () => {
  test('a synced invoice follows linkedJournalEntryId to the JE that owns it', async () => {
    mockInvoice({
      _id: 'inv1', invoiceNumber: 'INV-3', customerId: 'cust1',
      arJournalId: null, linkedJournalEntryId: 'je7',
      totalAmount: 700, remainingBalance: 700, exchangeRate: 1,
    });
    mockJe({
      _id: 'je7', transactionType: TRANSACTION_TYPES.CREDIT_SALE,
      remainingBalance: 700, customerId: 'cust1', isProjection: false,
    });

    const item = await resolveOpenItem(BIZ, { documentType: 'invoice', documentId: 'inv1' });

    expect(item.authority).toBe('journal');
    expect(item.remainingBase).toBe(700);
  });

  test('a document with no journal at all keeps the exact existing rejection', async () => {
    mockInvoice({ _id: 'inv1', invoiceNumber: 'INV-4', arJournalId: null, linkedJournalEntryId: null });

    await expect(resolveOpenItem(BIZ, { documentType: 'invoice', documentId: 'inv1' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('a missing document is a 404', async () => {
    mockInvoice(null);
    await expect(resolveOpenItem(BIZ, { documentType: 'invoice', documentId: 'nope' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});
