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
    expect(res.checks).toHaveLength(4);
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
