/**
 * tests/live/ledger.invariants.live.test.js
 *
 * The first tests in this repo to execute a real MongoDB. No jest.mock here —
 * that is the entire point. These drive the real poster, the real aggregation
 * pipelines, the real indexes and the real schema middleware.
 *
 * What this tier is for: invariants that only exist once the database is real.
 * Anything provable with a mock belongs in tests/unit.
 */
'use strict';

const mongoose = require('mongoose');
const {
  startLiveDb, stopLiveDb, resetDb, buildIndexes, seedBusiness, expectGoldenInvariants,
} = require('./harness');

jest.setTimeout(120000); // a real mongod has to boot

const { postCompoundJournal, postBalancedJournal } = require('../../services/ledgerPosting.service');
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

/** The boilerplate every posting needs, so the tests below say only what matters. */
const base = (over = {}) => ({
  businessId: ctx.business._id,
  transactionDate: new Date('2026-03-15'),
  description: 'live test entry',
  transactionType: TRANSACTION_TYPES.JOURNAL_ENTRY,
  status: JOURNAL_STATUS.POSTED,
  inputMethod: INPUT_METHODS.FORM,
  createdBy: ctx.user._id,
  lastModifiedBy: ctx.user._id,
  ...over,
});

describe('the seeded chart of accounts', () => {
  it('gives every business the accounts the posting paths look up by code', async () => {
    // These codes are hard-wired into recognition paths (AR/AP/inventory/COGS/
    // equity). A business missing one silently loses recognition, so pin them.
    for (const code of ['1110', '1150', '2110', '3210', '3310', '4110', '5110']) {
      expect(ctx.acct(code)).toBeTruthy();
    }
  });
});

describe('the poster, against a real database', () => {
  it('keeps the books whole after a simple two-account posting', async () => {
    await postBalancedJournal(base({
      amount: 5000,
      debitAccountId: ctx.acct('1110')._id,   // AR
      creditAccountId: ctx.acct('4110')._id,  // Sales
      idempotencyKey: 'live:simple-1',
    }));

    await expectGoldenInvariants(ctx.businessId);
  });

  it('keeps the books whole after a compound (3+ line) posting', async () => {
    // A compound entry is where a top-level debit/credit pair stops being the
    // truth — exactly the shape that hid audit F1/F15 from the mocked suite.
    await postCompoundJournal(base({
      description: 'invoice with tax',
      lines: [
        { accountId: ctx.acct('1110')._id, type: 'debit', amount: 11700 },
        { accountId: ctx.acct('4110')._id, type: 'credit', amount: 10000 },
        { accountId: ctx.acct('2130')._id, type: 'credit', amount: 1700 },
      ],
      idempotencyKey: 'live:compound-1',
    }));

    await expectGoldenInvariants(ctx.businessId);
  });

  it('refuses an unbalanced journal', async () => {
    await expect(postCompoundJournal(base({
      lines: [
        { accountId: ctx.acct('1110')._id, type: 'debit', amount: 100 },
        { accountId: ctx.acct('4110')._id, type: 'credit', amount: 99 },
      ],
      idempotencyKey: 'live:unbalanced',
    }))).rejects.toThrow(/balance|equal/i);
  });

  it('refuses to post to another tenant’s account', async () => {
    const other = await seedBusiness({ name: 'Someone Else Ltd' });
    await expect(postBalancedJournal(base({
      amount: 100,
      debitAccountId: ctx.acct('1110')._id,
      creditAccountId: other.acct('4110')._id, // not ours
      idempotencyKey: 'live:cross-tenant',
    }))).rejects.toThrow(/do not belong to this business/i);
  });
});

describe('idempotency, enforced by the real unique index', () => {
  it('returns the original entry instead of posting a second one', async () => {
    const payload = base({
      amount: 2500,
      debitAccountId: ctx.acct('1110')._id,
      creditAccountId: ctx.acct('4110')._id,
      idempotencyKey: 'live:same-key',
    });

    const first = await postBalancedJournal(payload);
    const second = await postBalancedJournal(payload);

    expect(String(second._id)).toBe(String(first._id));

    const JournalEntry = require('../../models/JournalEntry.model');
    expect(await JournalEntry.countDocuments({ businessId: ctx.business._id })).toBe(1);
    // The real test: a double-post would have double-applied the balance too.
    await expectGoldenInvariants(ctx.businessId);
  });

  it('survives the same key racing itself, because the index is real', async () => {
    // Two concurrent posts defeat a check-then-insert guard; only the DB-level
    // unique partial index (audit F7) actually stops the second one. A mocked
    // test cannot prove this — there is no index to violate.
    const payload = () => base({
      amount: 900,
      debitAccountId: ctx.acct('1110')._id,
      creditAccountId: ctx.acct('4110')._id,
      idempotencyKey: 'live:race',
    });

    const results = await Promise.allSettled([
      postBalancedJournal(payload()),
      postBalancedJournal(payload()),
      postBalancedJournal(payload()),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const JournalEntry = require('../../models/JournalEntry.model');
    expect(await JournalEntry.countDocuments({ businessId: ctx.business._id })).toBe(1);
    await expectGoldenInvariants(ctx.businessId);
  });

  it('does NOT protect a posting that supplies no key', async () => {
    // Documents today's real exposure rather than asserting the ideal: the
    // partial index only binds when a key exists, so keyless callers can
    // double-post freely. Phase 3 makes the key mandatory; when it lands this
    // test flips to expecting a rejection.
    const payload = () => base({
      amount: 700,
      debitAccountId: ctx.acct('1110')._id,
      creditAccountId: ctx.acct('4110')._id,
    });
    await postBalancedJournal(payload());
    await postBalancedJournal(payload());

    const JournalEntry = require('../../models/JournalEntry.model');
    expect(await JournalEntry.countDocuments({ businessId: ctx.business._id })).toBe(2);
  });
});

describe('immutability of posted history', () => {
  it('refuses a bulk delete of journal entries', async () => {
    await postBalancedJournal(base({
      amount: 100,
      debitAccountId: ctx.acct('1110')._id,
      creditAccountId: ctx.acct('4110')._id,
      idempotencyKey: 'live:immutable',
    }));

    const JournalEntry = require('../../models/JournalEntry.model');
    await expect(
      JournalEntry.deleteMany({ businessId: ctx.business._id })
    ).rejects.toThrow();
    expect(await JournalEntry.countDocuments({ businessId: ctx.business._id })).toBe(1);
  });
});

describe('the reporting pipelines, executed for real', () => {
  it('reports a reversed entry and its reversal as a net zero', async () => {
    // Audit F1: `reversed` originals were excluded from reports while their
    // reversals were included, so every statement was misstated. 1,786 mocked
    // tests could not see it. This is that test.
    const reportService = require('../../services/report.service');

    const original = await postBalancedJournal(base({
      amount: 4000,
      debitAccountId: ctx.acct('1110')._id,
      creditAccountId: ctx.acct('4110')._id,
      idempotencyKey: 'live:rev-original',
    }));
    await postBalancedJournal(base({
      description: 'reversal of live test entry',
      amount: 4000,
      debitAccountId: ctx.acct('4110')._id,
      creditAccountId: ctx.acct('1110')._id,
      idempotencyKey: 'live:rev-reversal',
    }));
    const JournalEntry = require('../../models/JournalEntry.model');
    await JournalEntry.updateOne({ _id: original._id }, { $set: { status: 'reversed' } });

    const is = await reportService.getIncomeStatement(
      ctx.businessId, new Date('2026-01-01'), new Date('2026-12-31')
    );
    expect(is.totalRevenue).toBe(0);
    await expectGoldenInvariants(ctx.businessId);
  });

  it('counts every leg of a compound entry, not just the top-level pair', async () => {
    // Audit F15's class: reading only (debitAccountId, creditAccountId) drops
    // the 3rd+ leg. Here the tax leg exists ONLY in journalLines.
    const reportService = require('../../services/report.service');

    await postCompoundJournal(base({
      description: 'compound with a leg only in journalLines',
      lines: [
        { accountId: ctx.acct('1110')._id, type: 'debit', amount: 11700 },
        { accountId: ctx.acct('4110')._id, type: 'credit', amount: 10000 },
        { accountId: ctx.acct('2130')._id, type: 'credit', amount: 1700 },
      ],
      idempotencyKey: 'live:compound-report',
    }));

    const is = await reportService.getIncomeStatement(
      ctx.businessId, new Date('2026-01-01'), new Date('2026-12-31')
    );
    expect(is.totalRevenue).toBe(10000); // not 11700, and not 0

    const bs = await reportService.getBalanceSheet(ctx.businessId, new Date('2026-12-31'));
    expect(bs.totalLiabilities).toBe(1700); // the tax leg reached the balance sheet
    await expectGoldenInvariants(ctx.businessId);
  });
});

describe('transactions are real here', () => {
  it('rolls the whole posting back when the work throws mid-flight', async () => {
    // withTransaction is a no-op against a standalone mongod. Only a replica set
    // proves a rollback actually rolls back.
    const { withTransaction } = require('../../utils/withTransaction');
    const JournalEntry = require('../../models/JournalEntry.model');

    await expect(withTransaction(async (session) => {
      await postBalancedJournal(base({
        amount: 300,
        debitAccountId: ctx.acct('1110')._id,
        creditAccountId: ctx.acct('4110')._id,
        idempotencyKey: 'live:rollback',
      }), { session });
      throw new Error('boom — caller failed after posting');
    })).rejects.toThrow('boom');

    expect(await JournalEntry.countDocuments({ businessId: ctx.business._id })).toBe(0);
    await expectGoldenInvariants(ctx.businessId);
  });
});
