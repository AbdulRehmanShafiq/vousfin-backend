/**
 * tests/live/fiscalYearClose.live.test.js
 *
 * Year-end close is the one operation that, done wrong, is wrong forever: it
 * rolls a whole year's profit into equity, and the year then locks.
 *
 * Three defects it had, all silent:
 *   1. Retained Earnings was matched by name regex, so renaming the account
 *      turned close into a no-op — and closeFiscalYear marked the year CLOSED
 *      anyway, with zero transferred.
 *   2. The closing entry posted with no idempotency key, so a retry transferred
 *      net income twice.
 *   3. The entry posted OUTSIDE the transaction that flipped the status, so a
 *      failure in between left entries posted against a still-open year.
 *
 * Live tier because all three are claims about a real database.
 */
'use strict';

const mongoose = require('mongoose');
const {
  startLiveDb, stopLiveDb, resetDb, buildIndexes, seedBusiness, expectGoldenInvariants,
} = require('./harness');

jest.setTimeout(120000);

const fiscalYearService = require('../../services/fiscalYear.service');
const { postBalancedJournal } = require('../../services/ledgerPosting.service');
const ChartOfAccount = require('../../models/ChartOfAccount.model');
const JournalEntry = require('../../models/JournalEntry.model');
const FiscalYear = require('../../models/FiscalYear.model');
const {
  TRANSACTION_TYPES, JOURNAL_STATUS, INPUT_METHODS, FISCAL_YEAR_STATUS,
} = require('../../config/constants');

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

/** A fiscal year with a real profit sitting in it, ready to close. */
async function aYearWithProfit({ revenue = 100000, expenses = 40000 } = {}) {
  const fy = await FiscalYear.create({
    businessId: ctx.business._id,
    name: 'FY2026',
    startDate: new Date('2026-01-01'),
    endDate: new Date('2026-12-31'),
    status: FISCAL_YEAR_STATUS.OPEN,
    createdBy: ctx.user._id,
  });

  const base = (over) => ({
    businessId: ctx.business._id,
    transactionDate: new Date('2026-06-15'),
    transactionType: TRANSACTION_TYPES.JOURNAL_ENTRY,
    status: JOURNAL_STATUS.POSTED,
    inputMethod: INPUT_METHODS.FORM,
    createdBy: ctx.user._id,
    lastModifiedBy: ctx.user._id,
    ...over,
  });

  await postBalancedJournal(base({
    description: 'sales for the year',
    amount: revenue,
    debitAccountId: ctx.acct('1110')._id,  // AR
    creditAccountId: ctx.acct('4110')._id, // Sales
    idempotencyKey: 'fyt:revenue',
  }));
  await postBalancedJournal(base({
    description: 'costs for the year',
    amount: expenses,
    debitAccountId: ctx.acct('5110')._id,  // COGS
    creditAccountId: ctx.acct('1110')._id,
    idempotencyKey: 'fyt:expense',
  }));

  return fy;
}

const closingEntries = () => JournalEntry.find({
  businessId: ctx.business._id, entryType: 'closing',
}).lean();

describe('year-end close', () => {
  it('moves the year’s profit into Retained Earnings', async () => {
    const fy = await aYearWithProfit({ revenue: 100000, expenses: 40000 });

    const res = await fiscalYearService.closeFiscalYear(
      ctx.businessId, String(fy._id), String(ctx.user._id), { reason: 'test close' }
    );

    expect(res.retainedEarningsTransferred).toBe(60000);
    const entries = await closingEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].amount).toBe(60000);
    // DR Current Year Earnings (3310) / CR Retained Earnings (3210)
    expect(String(entries[0].debitAccountId)).toBe(String(ctx.acct('3310')._id));
    expect(String(entries[0].creditAccountId)).toBe(String(ctx.acct('3210')._id));

    await expectGoldenInvariants(ctx.businessId, { asOf: new Date('2026-12-31') });
  });

  it('still closes when the owner has renamed Retained Earnings', async () => {
    // The regression: close matched /retained earnings/i, so this rename made it
    // silently skip — a year that "closed" while transferring nothing.
    await ChartOfAccount.updateOne(
      { businessId: ctx.business._id, accountCode: '3210' },
      { $set: { accountName: 'Accumulated Profit' } }
    );
    const fy = await aYearWithProfit();

    const res = await fiscalYearService.closeFiscalYear(
      ctx.businessId, String(fy._id), String(ctx.user._id), {}
    );

    expect(res.retainedEarningsTransferred).toBe(60000);
    expect(await closingEntries()).toHaveLength(1);
  });

  it('heals a missing Retained Earnings account rather than skipping the close', async () => {
    await ChartOfAccount.deleteOne({ businessId: ctx.business._id, accountCode: '3210' });
    const fy = await aYearWithProfit();

    const res = await fiscalYearService.closeFiscalYear(
      ctx.businessId, String(fy._id), String(ctx.user._id), {}
    );

    expect(res.retainedEarningsTransferred).toBe(60000);
    const healed = await ChartOfAccount.findOne({
      businessId: ctx.business._id, accountCode: '3210',
    }).lean();
    expect(healed).toBeTruthy();
    await expectGoldenInvariants(ctx.businessId, { asOf: new Date('2026-12-31') });
  });

  it('charges a loss against Retained Earnings the other way round', async () => {
    const fy = await aYearWithProfit({ revenue: 30000, expenses: 50000 });

    const res = await fiscalYearService.closeFiscalYear(
      ctx.businessId, String(fy._id), String(ctx.user._id), {}
    );

    expect(res.retainedEarningsTransferred).toBe(-20000);
    const entries = await closingEntries();
    expect(String(entries[0].debitAccountId)).toBe(String(ctx.acct('3210')._id));
    expect(String(entries[0].creditAccountId)).toBe(String(ctx.acct('3310')._id));
    await expectGoldenInvariants(ctx.businessId, { asOf: new Date('2026-12-31') });
  });

  it('refuses to close a year twice', async () => {
    const fy = await aYearWithProfit();
    await fiscalYearService.closeFiscalYear(ctx.businessId, String(fy._id), String(ctx.user._id), {});

    await expect(
      fiscalYearService.closeFiscalYear(ctx.businessId, String(fy._id), String(ctx.user._id), {})
    ).rejects.toThrow(/already/i);

    // The real assertion: profit was transferred ONCE, not twice.
    expect(await closingEntries()).toHaveLength(1);
    await expectGoldenInvariants(ctx.businessId, { asOf: new Date('2026-12-31') });
  });

  it('does not post a second closing entry even if the status flip is undone', async () => {
    // Simulates the retry the idempotency key exists for: something reopens or
    // rolls back the year, and close runs again. Without the key this posted
    // net income into Retained Earnings a second time.
    const fy = await aYearWithProfit();
    await fiscalYearService.closeFiscalYear(ctx.businessId, String(fy._id), String(ctx.user._id), {});
    await FiscalYear.updateOne({ _id: fy._id }, { $set: { status: FISCAL_YEAR_STATUS.OPEN } });

    await fiscalYearService.closeFiscalYear(ctx.businessId, String(fy._id), String(ctx.user._id), {});

    expect(await closingEntries()).toHaveLength(1);
    await expectGoldenInvariants(ctx.businessId, { asOf: new Date('2026-12-31') });
  });

  it('leaves the year open if the closing entry cannot post', async () => {
    // Atomicity: entries and the status flip are one act. An unresolvable
    // account must abort the whole close, not leave a half-closed year.
    const fy = await aYearWithProfit();
    jest.spyOn(require('../../services/accountResolver.service'), 'resolveMany')
      .mockRejectedValueOnce(new Error('resolver exploded'));

    await expect(
      fiscalYearService.closeFiscalYear(ctx.businessId, String(fy._id), String(ctx.user._id), {})
    ).rejects.toThrow();

    const after = await FiscalYear.findById(fy._id).lean();
    expect(after.status).toBe(FISCAL_YEAR_STATUS.OPEN);
    expect(await closingEntries()).toHaveLength(0);
    jest.restoreAllMocks();
  });
});
