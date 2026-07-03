/**
 * tests/unit/models/journalEntry.settlementPeriodLock.test.js
 *
 * Audit 2026-07-02 F9 — closing an accounting period must block POSTINGS, not
 * open-item settlement.
 *
 * Applying a March payment against a January invoice updates the January JE's
 * settlement metadata (remainingBalance, partiallyPaidAmount, paymentStatus,
 * status, settlements[], relatedTransactions[], metadata). The period-lock
 * query hooks used to reject ANY update to an entry dated in a closed/locked
 * period — freezing collection of every open invoice the moment its period
 * closed. Enterprise GLs allow open-item clearing on closed periods; only the
 * financial fields / dates / deletes stay blocked.
 *
 * F17 — deleteMany must be blocked like updateMany (it had no guard at all).
 */
'use strict';

const mongoose = require('mongoose');

jest.mock('../../../models/AccountingPeriod.model', () => ({
  findCoveringPeriod: jest.fn(),
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const JournalEntry = require('../../../models/JournalEntry.model');
const AccountingPeriod = require('../../../models/AccountingPeriod.model');
const { PERIOD_STATUS } = require('../../../config/constants');
const { ApiError } = require('../../../utils/ApiError');

const closedPeriodDoc = () => ({
  _id: 'je1',
  businessId: new mongoose.Types.ObjectId(),
  transactionDate: new Date('2026-01-15'),
  status: 'posted',
});

beforeEach(() => {
  jest.clearAllMocks();
  mongoose.set('bufferTimeoutMS', 50); // fail fast when a query legitimately reaches the (absent) driver
  AccountingPeriod.findCoveringPeriod.mockResolvedValue({ status: PERIOD_STATUS.CLOSED, name: 'Jan 2026' });
  mongoose.model = jest.fn((name) => (name === 'AccountingPeriod' ? AccountingPeriod : mongoose.models[name]));
  jest.spyOn(JournalEntry, 'findOne').mockResolvedValue(closedPeriodDoc());
});

afterEach(() => jest.restoreAllMocks());

describe('isSettlementMetadataOnlyUpdate — the allowlist predicate', () => {
  const ok = (u) => expect(JournalEntry.isSettlementMetadataOnlyUpdate(u)).toBe(true);
  const no = (u) => expect(JournalEntry.isSettlementMetadataOnlyUpdate(u)).toBe(false);

  test('accepts a pure settlement update ($set + $push)', () => {
    ok({
      remainingBalance: 0,
      partiallyPaidAmount: 1000,
      paymentStatus: 'paid',
      status: 'settled',
      $push: { settlements: { transactionId: 't', amount: 1000 }, relatedTransactions: 't' },
    });
  });

  test('accepts the reversal bookkeeping update (status + metadata)', () => {
    ok({ status: 'reversed', paymentStatus: null, remainingBalance: 0, metadata: { reversalId: 'r1' } });
  });

  test('ignores timestamps-injected $setOnInsert (upsert defaults never mutate an existing entry)', () => {
    ok({
      remainingBalance: 0,
      $set: { updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    });
  });

  test('rejects any financial-field mutation', () => {
    no({ remainingBalance: 0, amount: 500 });
    no({ debitAccountId: 'x' });
    no({ journalLines: [] });
    no({ $set: { 'journalLines.0.amount': 9 } });
  });

  test('rejects a transactionDate move', () => {
    no({ transactionDate: new Date(), remainingBalance: 0 });
  });

  test('rejects status values outside the settlement lifecycle (no hiding entries)', () => {
    no({ status: 'draft' });
    no({ status: 'void', remainingBalance: 0 });
  });

  test('rejects empty updates', () => {
    no({});
    no(null);
  });
});

describe('checkPeriodLock — settlement metadata clears through closed periods', () => {
  test('still BLOCKS a non-settlement update on a closed-period entry', async () => {
    await expect(
      JournalEntry.updateOne({ _id: 'je1' }, { description: 'rename' }).exec()
    ).rejects.toThrow(/closed accounting period/i);
  });

  test('ALLOWS a settlement-metadata-only update on a closed-period entry (payment application)', async () => {
    let err;
    try {
      await JournalEntry.updateOne(
        { _id: 'je1' },
        {
          remainingBalance: 0,
          partiallyPaidAmount: 1000,
          paymentStatus: 'paid',
          status: 'settled',
          $push: { settlements: { transactionId: 't1', amount: 1000 } },
        }
      ).exec();
    } catch (e) {
      err = e;
    }
    // The hook must NOT reject it — the query then fails on the absent DB
    // connection, which is a mongoose buffering error, not our ApiError.
    expect(err).toBeDefined();
    expect(err).not.toBeInstanceOf(ApiError);
  });

  test('ALLOWS the same on a LOCKED-period entry (open-item clearing is period-independent)', async () => {
    AccountingPeriod.findCoveringPeriod.mockResolvedValue({ status: PERIOD_STATUS.LOCKED, name: 'Jan 2026' });
    let err;
    try {
      await JournalEntry.updateOne(
        { _id: 'je1' },
        { remainingBalance: 500, partiallyPaidAmount: 500, paymentStatus: 'partially_paid', status: 'partially_settled' }
      ).exec();
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err).not.toBeInstanceOf(ApiError);
  });
});

describe('deleteMany guard (F17)', () => {
  test('deleteMany on journal entries is forbidden outright', async () => {
    await expect(JournalEntry.deleteMany({ businessId: 'b' }).exec()).rejects.toThrow(/not supported/i);
  });
});
