/**
 * tests/live/recognitionFailsClosed.live.test.js
 *
 * Recognition may never silently skip.
 *
 * postArJournal and postApLiabilityJournal used to warn and `return null` when a
 * required account was missing — so the document still became approved while the
 * receivable/payable and the revenue/expense were never recognised at all. The
 * sharpest evidence it was an oversight and not a decision: _applyCogsForInvoice,
 * in the same file, was deliberately fixed to fail CLOSED (INV-5). One half of an
 * invoice relieved stock and posted COGS while the other half posted nothing.
 *
 * Live tier because "the account is missing, and we healed it and posted anyway"
 * is a claim about a real database — a mocked findOne can be told to find
 * anything, which is exactly how this hid.
 */
'use strict';

const {
  startLiveDb, stopLiveDb, resetDb, buildIndexes, seedBusiness, expectGoldenInvariants,
} = require('./harness');

jest.setTimeout(120000);

const ChartOfAccount = require('../../models/ChartOfAccount.model');
const JournalEntry = require('../../models/JournalEntry.model');
const invoiceService = require('../../services/invoice.service');
const billService = require('../../services/bill.service');

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

/** A minimal approved-able invoice document, straight through the model. */
async function anInvoice({ lineAccountId = null } = {}) {
  const Invoice = require('../../models/Invoice.model');
  return Invoice.create({
    businessId: ctx.business._id,
    invoiceNumber: `INV-LIVE-${Date.now()}`,
    customerId: null,
    customerSnapshot: { fullName: 'Live Customer' },
    lineItems: [{
      name: 'Consulting', description: 'consulting', quantity: 1, unitPrice: 10000,
      ...(lineAccountId ? { accountId: lineAccountId } : {}),
    }],
    amount: 10000,
    taxAmount: 0,
    totalAmount: 10000,
    remainingBalance: 10000,
    issueDate: new Date('2026-05-01'),
    dueDate: new Date('2026-06-01'),
    state: 'approved',
    currencyCode: 'PKR',
    exchangeRate: 1,
    createdBy: ctx.user._id,
  });
}

const user = () => ({ _id: ctx.user._id, fullName: 'Live Tester', businessId: ctx.business._id });

describe('AR recognition', () => {
  it('posts the receivable and the revenue', async () => {
    const inv = await anInvoice();
    const je = await invoiceService.postArJournal(inv, user(), '127.0.0.1');

    expect(je).toBeTruthy();
    expect(String(je.debitAccountId)).toBe(String(ctx.acct('1110')._id));  // DR AR
    expect(String(je.creditAccountId)).toBe(String(ctx.acct('4110')._id)); // CR Sales
    await expectGoldenInvariants(ctx.businessId, { asOf: new Date('2026-12-31') });
  });

  it('heals a missing AR control account rather than skipping the whole posting', async () => {
    // The regression: 1110 absent → warn → return null → invoice approved with no
    // receivable and no revenue anywhere in the books.
    await ChartOfAccount.deleteOne({ businessId: ctx.business._id, accountCode: '1110' });
    const inv = await anInvoice();

    const je = await invoiceService.postArJournal(inv, user(), '127.0.0.1');

    expect(je).toBeTruthy();
    const healed = await ChartOfAccount.findOne({
      businessId: ctx.business._id, accountCode: '1110',
    }).lean();
    expect(healed).toBeTruthy();
    expect(String(je.debitAccountId)).toBe(String(healed._id));
    await expectGoldenInvariants(ctx.businessId, { asOf: new Date('2026-12-31') });
  });

  it('heals a missing revenue account rather than skipping the whole posting', async () => {
    await ChartOfAccount.deleteOne({ businessId: ctx.business._id, accountCode: '4110' });
    const inv = await anInvoice();

    const je = await invoiceService.postArJournal(inv, user(), '127.0.0.1');

    expect(je).toBeTruthy();
    expect(await JournalEntry.countDocuments({ businessId: ctx.business._id })).toBe(1);
    await expectGoldenInvariants(ctx.businessId, { asOf: new Date('2026-12-31') });
  });

  it('refuses, in plain language, when revenue points at the AR account itself', async () => {
    // Not healable — the entry would cancel itself out. Refusing is the only
    // honest answer, and the message says what to fix.
    const inv = await anInvoice({ lineAccountId: ctx.acct('1110')._id });

    await expect(invoiceService.postArJournal(inv, user(), '127.0.0.1'))
      .rejects.toThrow(/income is pointed at the Accounts Receivable account/i);
    expect(await JournalEntry.countDocuments({ businessId: ctx.business._id })).toBe(0);
  });

  it('stays idempotent — a second call posts nothing new', async () => {
    const inv = await anInvoice();
    await invoiceService.postArJournal(inv, user(), '127.0.0.1');
    await invoiceService.postArJournal(inv, user(), '127.0.0.1');
    expect(await JournalEntry.countDocuments({ businessId: ctx.business._id })).toBe(1);
  });
});

describe('AP recognition', () => {
  async function aBill({ lineAccountId = null } = {}) {
    const Bill = require('../../models/Bill.model');
    return Bill.create({
      businessId: ctx.business._id,
      billNumber: `BILL-LIVE-${Date.now()}`,
      vendorId: null,
      vendorSnapshot: { vendorName: 'Live Vendor' },
      lineItems: [{
        name: 'Office supplies', description: 'office supplies', quantity: 1, unitPrice: 5000,
        ...(lineAccountId ? { accountId: lineAccountId } : {}),
      }],
      amount: 5000,
      taxAmount: 0,
      totalAmount: 5000,
      remainingBalance: 5000,
      billDate: new Date('2026-05-01'),
      issueDate: new Date('2026-05-01'),
      dueDate: new Date('2026-06-01'),
      state: 'approved',
      currencyCode: 'PKR',
      exchangeRate: 1,
      createdBy: ctx.user._id,
    });
  }

  it('posts the payable, falling back to Miscellaneous when no category was chosen', async () => {
    // The old fallback chain asked for 5100 → 5000 → 6100, none of which exist in
    // DEFAULT_ACCOUNTS — so it always resolved to null and skipped the payable.
    // 6390 says "we were not told which expense" instead of guessing.
    const bill = await aBill();
    const je = await billService.postApLiabilityJournal(bill, user(), '127.0.0.1');

    expect(je).toBeTruthy();
    const lines = je.journalLines || [];
    expect(lines.some((l) => l.type === 'credit'
      && String(l.accountId) === String(ctx.acct('2110')._id))).toBe(true);
    expect(lines.some((l) => l.type === 'debit'
      && String(l.accountId) === String(ctx.acct('6390')._id))).toBe(true);
    await expectGoldenInvariants(ctx.businessId, { asOf: new Date('2026-12-31') });
  });

  it('heals a missing AP control account rather than skipping the payable', async () => {
    await ChartOfAccount.deleteOne({ businessId: ctx.business._id, accountCode: '2110' });
    const bill = await aBill();

    const je = await billService.postApLiabilityJournal(bill, user(), '127.0.0.1');

    expect(je).toBeTruthy();
    expect(await ChartOfAccount.findOne({
      businessId: ctx.business._id, accountCode: '2110',
    }).lean()).toBeTruthy();
    await expectGoldenInvariants(ctx.businessId, { asOf: new Date('2026-12-31') });
  });
});
