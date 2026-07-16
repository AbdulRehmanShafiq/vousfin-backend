/**
 * tests/live/booksAssurance.live.test.js
 *
 * The standing check that VousFin's books add up.
 *
 * A check that only ever says "fine" is worthless, so these prove BOTH
 * directions: it passes on correct books, and it actually catches a break when
 * one is introduced. The second half is the part that matters — every other
 * live test leans on this check being able to fail.
 */
'use strict';

const {
  startLiveDb, stopLiveDb, resetDb, buildIndexes, seedBusiness,
} = require('./harness');

jest.setTimeout(120000);

const booksAssurance = require('../../services/booksAssurance.service');
const { postBalancedJournal } = require('../../services/ledgerPosting.service');
const ChartOfAccount = require('../../models/ChartOfAccount.model');
const { TRANSACTION_TYPES, JOURNAL_STATUS, INPUT_METHODS } = require('../../config/constants');

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

const post = (over = {}) => postBalancedJournal({
  businessId: ctx.business._id,
  transactionDate: new Date('2026-04-10'),
  description: 'a sale',
  transactionType: TRANSACTION_TYPES.JOURNAL_ENTRY,
  amount: 7500,
  debitAccountId: ctx.acct('1110')._id,
  creditAccountId: ctx.acct('4110')._id,
  status: JOURNAL_STATUS.POSTED,
  inputMethod: INPUT_METHODS.FORM,
  createdBy: ctx.user._id,
  lastModifiedBy: ctx.user._id,
  idempotencyKey: `assurance:${Math.random()}`,
  ...over,
});

describe('books that add up', () => {
  it('says so, on an empty business', async () => {
    const res = await booksAssurance.verify(ctx.businessId);
    expect(res.correct).toBe(true);
    expect(res.verified).toBe(true);
    expect(res.breaks).toEqual([]);
    expect(res.summary).toBe('Your books add up.');
  });

  it('says so after real activity', async () => {
    await post();
    await post({ amount: 2500, description: 'another sale' });

    const res = await booksAssurance.verify(ctx.businessId);
    expect(res.correct).toBe(true);
    // Five: the four ledger-internal invariants, plus "everything you sold and
    // bought is recorded" — which reads from the documents back, because an
    // absent entry breaks no balance and the other four cannot see it.
    expect(res.checks).toHaveLength(5);
    expect(res.checks.every((c) => c.ok && c.verified)).toBe(true);
  });

  it('reports in plain language, with no accounting jargon', async () => {
    const res = await booksAssurance.verify(ctx.businessId);
    const words = res.checks.map((c) => `${c.title} ${c.detail}`).join(' ');
    // An owner reads this, not an accountant.
    expect(words).not.toMatch(/debit|credit|ledger|sub-ledger|reconcil|drift|journal entr/i);
  });
});

describe('books that do not add up', () => {
  it('catches a cached balance that no longer matches its entries', async () => {
    await post();
    // Corrupt the cache the way a missed $inc would: the entries still say 7500.
    await ChartOfAccount.updateOne(
      { businessId: ctx.business._id, accountCode: '1110' },
      { $set: { runningBalance: 9999 } }
    );

    const res = await booksAssurance.verify(ctx.businessId);

    expect(res.correct).toBe(false);
    const broken = res.breaks.find((b) => b.key === 'balances_match');
    expect(broken).toBeTruthy();
    expect(broken.detail).toMatch(/Accounts Receivable/);
    // It names what to look at and by how much — not just "something is wrong".
    expect(broken.offenders[0]).toMatchObject({ code: '1110', shows: 9999, shouldBe: 7500 });
  });

  it('assertCorrect throws, naming the invariant, so a caller can gate on it', async () => {
    await post();
    await ChartOfAccount.updateOne(
      { businessId: ctx.business._id, accountCode: '1110' },
      { $set: { runningBalance: 1 } }
    );

    await expect(booksAssurance.assertCorrect(ctx.businessId))
      .rejects.toThrow(/Books do not add up[\s\S]*Account balances match the entries/);
  });

  it('reads a source failure as "could not verify", never as all clear', async () => {
    // Silence is not evidence. If a check cannot run, the answer must not be yes.
    jest.spyOn(require('../../services/report.service'), 'getBalanceSheet')
      .mockRejectedValueOnce(new Error('report pipeline exploded'));

    const res = await booksAssurance.verify(ctx.businessId);

    expect(res.verified).toBe(false);
    expect(res.correct).toBe(false);
    const unverified = res.checks.find((c) => c.key === 'equation_holds');
    expect(unverified.verified).toBe(false);
    expect(unverified.detail).toMatch(/could not check/i);
    jest.restoreAllMocks();
  });
});

describe('tenant isolation', () => {
  it('one business’s broken books do not condemn another’s', async () => {
    const other = await seedBusiness({ name: 'Healthy Co' });
    await post();
    await ChartOfAccount.updateOne(
      { businessId: ctx.business._id, accountCode: '1110' },
      { $set: { runningBalance: 4 } }
    );

    expect((await booksAssurance.verify(ctx.businessId)).correct).toBe(false);
    expect((await booksAssurance.verify(other.businessId)).correct).toBe(true);
  });
});

/**
 * The invariant the other four are blind to.
 *
 * Two approved invoices worth 88,500 sat outside the live books for weeks while
 * every other check was GREEN — the trial balance balanced, drift was 0, A still
 * equalled L + E, the sub-ledgers reconciled. All true. A missing document is not
 * an inconsistency, it is an ABSENCE, and no check that only reads the ledger can
 * see what never reached it. This one reads from the documents back.
 */
describe('documents that never reached the books', () => {
  const anInvoice = async (over = {}) => {
    const Invoice = require('../../models/Invoice.model');
    return Invoice.create({
      businessId: ctx.business._id,
      invoiceNumber: `INV-A-${Math.random().toString(36).slice(2, 8)}`,
      customerSnapshot: { fullName: 'Live Customer' },
      lineItems: [{ name: 'Work', description: 'work', quantity: 1, unitPrice: 5000 }],
      amount: 5000, taxAmount: 0, totalAmount: 5000, remainingBalance: 5000,
      issueDate: new Date('2026-05-01'), dueDate: new Date('2026-06-01'),
      state: 'approved', currencyCode: 'PKR', exchangeRate: 1,
      createdBy: ctx.user._id,
      ...over,
    });
  };

  it('flags an approved invoice with no journal behind it', async () => {
    await anInvoice();

    const res = await booksAssurance.verify(ctx.businessId);
    const check = res.checks.find((c) => c.key === 'everything_recorded');

    expect(check.ok).toBe(false);
    expect(res.correct).toBe(false);
    expect(check.detail).toMatch(/1 invoice worth 5,000/);
    // Plain language, and it says what to do — an owner reads this.
    expect(check.detail).toMatch(/approve it again/i);
    expect(check.offenders[0]).toMatchObject({ kind: 'invoice', totalAmount: 5000 });
  });

  it('proves the other four cannot see it — they all pass on the same books', async () => {
    // This is the whole reason the check exists. An absent entry breaks no
    // balance, so every ledger-internal invariant stays green.
    await anInvoice();

    const res = await booksAssurance.verify(ctx.businessId);
    const others = res.checks.filter((c) => c.key !== 'everything_recorded');
    expect(others.every((c) => c.ok)).toBe(true);
    expect(res.breaks).toHaveLength(1);
  });

  it('ignores drafts and cancelled invoices — they claim nothing happened', async () => {
    await anInvoice({ state: 'draft' });
    await anInvoice({ state: 'cancelled' });

    const res = await booksAssurance.verify(ctx.businessId);
    expect(res.checks.find((c) => c.key === 'everything_recorded').ok).toBe(true);
  });

  it('passes once the invoice carries its journal', async () => {
    const je = await post({ idempotencyKey: 'doc-recorded' });
    await anInvoice({ arJournalId: je._id });

    const res = await booksAssurance.verify(ctx.businessId);
    expect(res.checks.find((c) => c.key === 'everything_recorded').ok).toBe(true);
  });
});
