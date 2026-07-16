/**
 * tests/live/openItemAuthority.live.test.js
 *
 * AR/AP open-item authority (spec 2026-07-16) — the live reproduction of the
 * production bug and the proof it stays fixed.
 *
 * THE BUG: postArJournal posts a projection JE (isProjection: true, no
 * remainingBalance — the M-refactor's convention: the DOCUMENT owns the money),
 * but every open-item reader summed only JE.remainingBalance. So approving an
 * invoice-first invoice moved the customer's balance while aging, the
 * outstanding list and the sub-ledger reconciler all saw nothing. Live
 * evidence 2026-07-16: customer cached 4,500 vs open JEs 2,000 → drift 2,500.
 *
 * Live tier because the claim under test is about real aggregation pipelines
 * over both collections at once — exactly what a mocked aggregate() cannot see.
 */
'use strict';

const {
  startLiveDb, stopLiveDb, resetDb, buildIndexes, seedBusiness, expectGoldenInvariants,
} = require('./harness');

jest.setTimeout(180000);

const invoiceService = require('../../services/invoice.service');
const billService = require('../../services/bill.service');
const transactionService = require('../../services/transaction.service');
const reportService = require('../../services/report.service');
const booksAssurance = require('../../services/booksAssurance.service');
const { computeArApSubledgerDrift } = require('../../services/ledgerIntegrity.service');
const { TRANSACTION_TYPES } = require('../../config/constants');

let ctx;

beforeAll(async () => {
  await startLiveDb();
  await buildIndexes();
});
afterAll(stopLiveDb);
beforeEach(async () => {
  await resetDb();
  await buildIndexes();
  ctx = await seedBusiness();
});

const user = () => ({ _id: ctx.user._id, fullName: 'Live Tester', businessId: ctx.business._id });

async function aCustomer(name = 'Ali Raza') {
  const Customer = require('../../models/Customer.model');
  return Customer.create({ businessId: ctx.business._id, fullName: name, createdBy: ctx.user._id });
}

/** An approved invoice, as the invoice-first flow produces one pre-recognition. */
async function anInvoice({ customerId, total = 2500, currencyCode = 'PKR', exchangeRate = 1 } = {}) {
  const Invoice = require('../../models/Invoice.model');
  return Invoice.create({
    businessId: ctx.business._id,
    invoiceNumber: `INV-LIVE-${Date.now()}-${Math.floor(Math.random() * 1e5)}`,
    customerId: customerId || null,
    customerSnapshot: { fullName: 'Ali Raza' },
    lineItems: [{ name: 'Consulting', description: 'consulting', quantity: 1, unitPrice: total }],
    amount: total,
    taxAmount: 0,
    totalAmount: total,
    remainingBalance: total, // DOCUMENT currency (F2)
    issueDate: new Date('2026-05-01'),
    dueDate: new Date('2026-06-01'),
    state: 'approved',
    currencyCode,
    exchangeRate,
    createdBy: ctx.user._id,
  });
}

/** A transaction-first credit sale — the JE itself is the open item. */
async function aCreditSale({ customerId, amount = 1000 } = {}) {
  return transactionService.createTransaction({
    businessId: ctx.business._id,
    transactionType: TRANSACTION_TYPES.CREDIT_SALE,
    amount,
    description: 'Manual credit sale',
    transactionDate: new Date('2026-05-10'),
    dueDate: new Date('2026-06-10'),
    debitAccountId: ctx.acct('1110')._id,
    creditAccountId: ctx.acct('4110')._id,
    customerId,
    inputMethod: 'form',
  }, ctx.user._id, '127.0.0.1');
}

describe('the live bug, reproduced: an invoice-first invoice must be a real open item', () => {
  it('is visible to the reconciler, the aging report and the outstanding list', async () => {
    const customer = await aCustomer();
    const inv = await anInvoice({ customerId: customer._id, total: 2500 });
    await invoiceService.postArJournal(inv, user(), '127.0.0.1');

    // The reconciler: customer cached 2,500 must be MATCHED by the open-item
    // union, not contradicted by an empty JE side (the production drift).
    const s = await computeArApSubledgerDrift(ctx.businessId);
    expect(s.ar.subledgerSum).toBe(2500);
    expect(s.ar.partyLinkedLedger).toBe(2500);
    expect(s.ar.reconciled).toBe(true);

    // Aging: the invoice appears, bucketed by its dueDate.
    const aging = await reportService.getAgingReport(ctx.businessId, 'receivable');
    expect(aging.grandTotal).toBe(2500);
    expect(aging.totalItems).toBe(1);

    // Outstanding list: one row, anchored on the projection JE so the payment
    // engine can resolve it.
    const rows = await transactionService.getOutstandingBalances(ctx.businessId, 'receivable');
    expect(rows).toHaveLength(1);
    expect(String(rows[0]._id)).toBe(String(inv.arJournalId));
    expect(rows[0].remainingBalance).toBe(2500);
    expect(rows[0].authority).toBe('document');

    await expectGoldenInvariants(ctx.businessId, { asOf: new Date('2026-12-31') });
  });

  it('coexists with a transaction-first sale for the same customer — counted once each, never twice', async () => {
    const customer = await aCustomer();
    const inv = await anInvoice({ customerId: customer._id, total: 2500 });
    await invoiceService.postArJournal(inv, user(), '127.0.0.1');
    await aCreditSale({ customerId: customer._id, amount: 1000 });

    const aging = await reportService.getAgingReport(ctx.businessId, 'receivable');
    expect(aging.totalItems).toBe(2);
    expect(aging.grandTotal).toBe(3500);

    const s = await computeArApSubledgerDrift(ctx.businessId);
    expect(s.ar.subledgerSum).toBe(3500);      // customer cached: 2500 + 1000
    expect(s.ar.partyLinkedLedger).toBe(3500); // union: doc 2500 + JE 1000
    expect(s.ar.reconciled).toBe(true);

    await expectGoldenInvariants(ctx.businessId, { asOf: new Date('2026-12-31') });
  });

  it('reconciles a foreign-currency invoice in BASE at the booking rate (F2 discipline)', async () => {
    const customer = await aCustomer('US Client');
    const inv = await anInvoice({
      customerId: customer._id, total: 100, currencyCode: 'USD', exchangeRate: 280,
    });
    await invoiceService.postArJournal(inv, user(), '127.0.0.1');

    const s = await computeArApSubledgerDrift(ctx.businessId);
    expect(s.ar.partyLinkedLedger).toBe(28000); // 100 USD × 280
    expect(s.ar.reconciled).toBe(true);

    const rows = await transactionService.getOutstandingBalances(ctx.businessId, 'receivable');
    expect(rows[0].remainingBalance).toBe(28000);

    await expectGoldenInvariants(ctx.businessId, { asOf: new Date('2026-12-31') });
  });

  it('the AP side mirrors all of it: a bill-first bill is a real open payable', async () => {
    const Vendor = require('../../models/Vendor.model');
    const vendor = await Vendor.create({
      businessId: ctx.business._id, vendorName: 'Live Vendor', createdBy: ctx.user._id,
    });
    const Bill = require('../../models/Bill.model');
    const bill = await Bill.create({
      businessId: ctx.business._id,
      billNumber: `BILL-LIVE-${Date.now()}`,
      vendorId: vendor._id,
      vendorSnapshot: { vendorName: 'Live Vendor' },
      lineItems: [{ name: 'Supplies', description: 'supplies', quantity: 1, unitPrice: 900 }],
      amount: 900, taxAmount: 0, totalAmount: 900, remainingBalance: 900,
      billDate: new Date('2026-05-01'), issueDate: new Date('2026-05-01'), dueDate: new Date('2026-06-01'),
      state: 'approved', currencyCode: 'PKR', exchangeRate: 1, createdBy: ctx.user._id,
    });
    await billService.postApLiabilityJournal(bill, user(), '127.0.0.1');

    const s = await computeArApSubledgerDrift(ctx.businessId);
    expect(s.ap.subledgerSum).toBe(900);
    expect(s.ap.partyLinkedLedger).toBe(900);
    expect(s.ap.reconciled).toBe(true);

    const aging = await reportService.getAgingReport(ctx.businessId, 'payable');
    expect(aging.grandTotal).toBe(900);

    await expectGoldenInvariants(ctx.businessId, { asOf: new Date('2026-12-31') });
  });
});

describe('the discriminator is guarded, not assumed', () => {
  it('a projection that loses its document is SURFACED by the assurance check, never silently mis-summed', async () => {
    const customer = await aCustomer();
    const inv = await anInvoice({ customerId: customer._id, total: 2500 });
    await invoiceService.postArJournal(inv, user(), '127.0.0.1');

    // Simulate corruption: the source document vanishes out-of-band.
    const Invoice = require('../../models/Invoice.model');
    await Invoice.deleteOne({ _id: inv._id });

    const res = await booksAssurance.verify(ctx.businessId, { asOf: new Date('2026-12-31') });
    const check = res.checks.find((c) => c.key === 'subledger_agrees');
    expect(check.ok).toBe(false);
    expect(check.offenders.some((o) => o.kind === 'projection_without_document')).toBe(true);
  });
});
