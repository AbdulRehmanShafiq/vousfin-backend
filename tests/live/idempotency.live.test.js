/**
 * tests/live/idempotency.live.test.js
 *
 * Idempotency is opt-in, and most callers opted out.
 *
 * F7 built the mechanism correctly — a partial unique index on
 * {businessId, metadata.idempotencyKey}, with E11000 translated into "already
 * posted". But the poster reads `if (idempotencyKey)`: no key means no
 * protection at all, and the partial index only binds when the key is a string.
 * 14 of 22 posting services passed no key, so any retry — network, double-click,
 * cron re-run, driver retry — posted the journal twice.
 *
 * These tests prove the key does what it claims against a REAL index. A mocked
 * test cannot: there is no index to violate, so a "unique" constraint that never
 * built (see indexes.live.test.js — seven of them) still looks like it works.
 */
'use strict';

const {
  startLiveDb, stopLiveDb, resetDb, buildIndexes, seedBusiness, expectGoldenInvariants,
} = require('./harness');

jest.setTimeout(120000);

const { postBalancedJournal } = require('../../services/ledgerPosting.service');
const JournalEntry = require('../../models/JournalEntry.model');
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
  transactionDate: new Date('2026-05-01'),
  description: 'keyed posting',
  transactionType: TRANSACTION_TYPES.JOURNAL_ENTRY,
  amount: 1000,
  debitAccountId: ctx.acct('1110')._id,
  creditAccountId: ctx.acct('4110')._id,
  status: JOURNAL_STATUS.POSTED,
  inputMethod: INPUT_METHODS.FORM,
  createdBy: ctx.user._id,
  lastModifiedBy: ctx.user._id,
  ...over,
});

const count = () => JournalEntry.countDocuments({ businessId: ctx.business._id });
const balanceOf = async (code) => {
  const ChartOfAccount = require('../../models/ChartOfAccount.model');
  const a = await ChartOfAccount.findOne({
    businessId: ctx.business._id, accountCode: code,
  }).lean();
  return a.runningBalance;
};

describe('a keyed posting', () => {
  it('posts once no matter how many times it is retried', async () => {
    for (let i = 0; i < 4; i += 1) await post({ idempotencyKey: 'retry-me' });

    expect(await count()).toBe(1);
    // The point of idempotency is not the row count — it is that the BALANCE
    // was applied once. Four posts of 1000 would show 4000 here.
    expect(await balanceOf('1110')).toBe(1000);
    await expectGoldenInvariants(ctx.businessId);
  });

  it('survives concurrent retries, because the DB index is the arbiter', async () => {
    // A check-then-insert guard cannot stop this: all five reads miss, all five
    // insert. Only the unique partial index does — which is why F7 added it and
    // why this test must run against a real one.
    await Promise.all(Array.from({ length: 5 }, () => post({ idempotencyKey: 'race-me' })));

    expect(await count()).toBe(1);
    expect(await balanceOf('1110')).toBe(1000);
    await expectGoldenInvariants(ctx.businessId);
  });

  it('scopes the key to one business, so two tenants may reuse it', async () => {
    const other = await seedBusiness({ name: 'Other Co' });
    await post({ idempotencyKey: 'shared-key' });
    await postBalancedJournal({
      businessId: other.business._id,
      transactionDate: new Date('2026-05-01'),
      description: 'their posting',
      transactionType: TRANSACTION_TYPES.JOURNAL_ENTRY,
      amount: 50,
      debitAccountId: other.acct('1110')._id,
      creditAccountId: other.acct('4110')._id,
      status: JOURNAL_STATUS.POSTED,
      inputMethod: INPUT_METHODS.FORM,
      createdBy: other.user._id,
      lastModifiedBy: other.user._id,
      idempotencyKey: 'shared-key',
    });

    expect(await count()).toBe(1);
    expect(await JournalEntry.countDocuments({ businessId: other.business._id })).toBe(1);
  });

  it('lets genuinely different events through', async () => {
    await post({ idempotencyKey: 'event:1' });
    await post({ idempotencyKey: 'event:2' });
    expect(await count()).toBe(2);
    expect(await balanceOf('1110')).toBe(2000);
  });
});

describe('an unkeyed posting', () => {
  it('is NOT protected — this is the remaining exposure, not the design', async () => {
    // Documents today's truth rather than the ideal. The partial index only
    // binds when a key exists, so a keyless caller double-posts freely and the
    // balance doubles with it. Every posting that represents a once-ever event
    // now carries a key; what is left are the genuinely repeatable operations
    // (stock adjustments, builds, recalcs), where retry-safety has to come from
    // a caller-supplied request key at the API boundary.
    await post();
    await post();

    expect(await count()).toBe(2);
    expect(await balanceOf('1110')).toBe(2000);
    // Note the books are still INTERNALLY consistent — double-posting is not
    // corruption, it is duplication. That is exactly why nothing caught it.
    await expectGoldenInvariants(ctx.businessId);
  });
});
