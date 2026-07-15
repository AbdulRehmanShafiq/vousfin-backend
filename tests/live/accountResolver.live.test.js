/**
 * tests/live/accountResolver.live.test.js
 *
 * The resolver is the fix for a whole class of silent loss.
 *
 * Account lookup was scattered across five idioms — name regex (fiscalYear),
 * bare findOne by code (invoice/bill), $in fallback lists, resolveCostAccounts,
 * ensureTaxAccounts — and most of them, on a miss, logged a warning and skipped
 * the posting. Renaming "Retained Earnings" silently disabled year-end close.
 * A missing revenue account silently recognised no revenue while COGS still
 * posted.
 *
 * One chain replaces all of it: code → role → seed the default → only then
 * refuse. Lives in the live tier because "seeds the missing default" is a claim
 * about a real database, and because a mocked findOne can be told to find
 * anything.
 */
'use strict';

const { startLiveDb, stopLiveDb, resetDb, seedBusiness } = require('./harness');

jest.setTimeout(120000);

const resolver = require('../../services/accountResolver.service');
const ChartOfAccount = require('../../models/ChartOfAccount.model');

let ctx;

beforeAll(startLiveDb);
afterAll(stopLiveDb);
beforeEach(async () => {
  await resetDb();
  ctx = await seedBusiness();
});

describe('resolving an account that is present', () => {
  it('finds it by code', async () => {
    const acct = await resolver.resolve(ctx.businessId, '1110');
    expect(acct.accountCode).toBe('1110');
    expect(String(acct.businessId)).toBe(ctx.businessId);
  });

  it('finds it even when the owner has renamed it', async () => {
    // The bug this kills: fiscalYear resolved Retained Earnings by
    // /retained earnings/i, so renaming it to "Accumulated Profit" silently
    // turned year-end close into a no-op — forever, with only a log line.
    await ChartOfAccount.updateOne(
      { businessId: ctx.business._id, accountCode: '3210' },
      { $set: { accountName: 'Accumulated Profit' } }
    );

    const acct = await resolver.resolve(ctx.businessId, '3210');
    expect(acct.accountName).toBe('Accumulated Profit');
    expect(acct.accountCode).toBe('3210');
  });

  it('never returns another business’s account', async () => {
    const other = await seedBusiness({ name: 'Other Co' });
    const mine = await resolver.resolve(ctx.businessId, '1110');
    const theirs = await resolver.resolve(other.businessId, '1110');
    expect(String(mine._id)).not.toBe(String(theirs._id));
    expect(String(mine.businessId)).toBe(ctx.businessId);
  });
});

describe('resolving an account that is missing', () => {
  it('seeds it from the defaults rather than failing', async () => {
    await ChartOfAccount.deleteOne({ businessId: ctx.business._id, accountCode: '3210' });

    const acct = await resolver.resolve(ctx.businessId, '3210');

    expect(acct.accountCode).toBe('3210');
    expect(acct.accountName).toBe('Retained Earnings');
    expect(acct.accountType).toBe('Equity');
    // It really landed in the database, not just in the return value.
    const persisted = await ChartOfAccount.findOne({
      businessId: ctx.business._id, accountCode: '3210',
    }).lean();
    expect(persisted).toBeTruthy();
    expect(persisted.runningBalance).toBe(0);
  });

  it('is idempotent — concurrent resolves of the same missing account make one', async () => {
    await ChartOfAccount.deleteOne({ businessId: ctx.business._id, accountCode: '3310' });

    const results = await Promise.all([
      resolver.resolve(ctx.businessId, '3310'),
      resolver.resolve(ctx.businessId, '3310'),
      resolver.resolve(ctx.businessId, '3310'),
    ]);

    const ids = new Set(results.map((a) => String(a._id)));
    expect(ids.size).toBe(1);
    expect(await ChartOfAccount.countDocuments({
      businessId: ctx.business._id, accountCode: '3310',
    })).toBe(1);
  });

  it('refuses, in plain language, when the code is not a known default', async () => {
    // Self-healing is only honest for accounts we have a definition for.
    // Anything else must fail loudly rather than invent an account.
    await expect(resolver.resolve(ctx.businessId, '9999')).rejects.toThrow(/9999/);
    // Plain language, and it says what to do next — no jargon, no stack trace.
    await expect(resolver.resolve(ctx.businessId, '9999')).rejects.toThrow(
      /doesn.t have account 9999 set up/i
    );
    await expect(resolver.resolve(ctx.businessId, '9999')).rejects.toThrow(
      /Chart of Accounts/i
    );
  });
});

describe('resolveMany', () => {
  it('resolves a whole posting’s accounts in one call', async () => {
    await ChartOfAccount.deleteOne({ businessId: ctx.business._id, accountCode: '4110' });

    const { ar, revenue } = await resolver.resolveMany(ctx.businessId, {
      ar: '1110', revenue: '4110',
    });

    expect(ar.accountCode).toBe('1110');
    expect(revenue.accountCode).toBe('4110'); // healed on the way through
  });

  it('names the account that could not be resolved', async () => {
    await expect(
      resolver.resolveMany(ctx.businessId, { ar: '1110', mystery: '9999' })
    ).rejects.toThrow(/9999/);
  });
});

describe('resolveId', () => {
  it('returns just the id, for callers that only need to post', async () => {
    const id = await resolver.resolveId(ctx.businessId, '1150');
    const acct = await ChartOfAccount.findById(id).lean();
    expect(acct.accountCode).toBe('1150');
  });
});
