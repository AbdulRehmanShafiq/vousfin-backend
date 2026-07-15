/**
 * tests/unit/services/fiscalYear.service.test.js
 *
 * Audit A7 — year-end close, period summary and opening balances must count
 * COMPOUND entries whose COGS / tax legs live ONLY in `journalLines`. They must
 * therefore derive their numbers from the SAME effective-lines aggregations the
 * financial statements use (transactionRepository.getIncomeStatementData /
 * getDebitCreditTotals — both built on EFFECTIVE_LINES_STAGE), NOT a top-level
 * debitAccountId/creditAccountId aggregation that misses the compound legs.
 *
 * Each test makes the legacy top-level path (JournalEntry.aggregate) DISAGREE with
 * the effective-lines repository path and asserts the effective-lines numbers win.
 * Plus a close→reopen round-trip guarding the period lifecycle.
 */
'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../utils/reportCache', () => ({ invalidate: jest.fn(), get: jest.fn(), set: jest.fn(), clear: jest.fn() }));
jest.mock('../../../repositories/transaction.repository');
jest.mock('../../../services/ledgerPosting.service', () => ({
  postBalancedJournal: jest.fn(),
  postCompoundJournal: jest.fn(),
}));
jest.mock('../../../models/FiscalYear.model',     () => ({ findOne: jest.fn(), create: jest.fn(), updateOne: jest.fn() }));
jest.mock('../../../models/AccountingPeriod.model', () => ({ findOne: jest.fn(), updateOne: jest.fn(), updateMany: jest.fn(), countDocuments: jest.fn(), insertMany: jest.fn() }));
jest.mock('../../../models/JournalEntry.model',   () => ({ aggregate: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../../models/ChartOfAccount.model', () => ({ findOne: jest.fn(), find: jest.fn() }));
// Closing entries resolve 3210/3310 through the resolver now, not by hand-rolled
// findOne queries — see accountResolver.service. Its own behaviour (resolve by
// code, heal a missing default, refuse an unknown one) is proved for real in
// tests/live/accountResolver.live.test.js; here we only care which accounts the
// closing entry lands on.
jest.mock('../../../services/accountResolver.service', () => ({
  resolve: jest.fn(), resolveMany: jest.fn(), resolveId: jest.fn(),
}));

const mongoose            = require('mongoose');
const fiscalYearService   = require('../../../services/fiscalYear.service');
const transactionRepository = require('../../../repositories/transaction.repository');
const { postBalancedJournal } = require('../../../services/ledgerPosting.service');
const FiscalYear          = require('../../../models/FiscalYear.model');
const AccountingPeriod    = require('../../../models/AccountingPeriod.model');
const JournalEntry        = require('../../../models/JournalEntry.model');
const ChartOfAccount      = require('../../../models/ChartOfAccount.model');
const accountResolver     = require('../../../services/accountResolver.service');
const { PERIOD_STATUS, FISCAL_YEAR_STATUS } = require('../../../config/constants');

const oid = () => new mongoose.Types.ObjectId();
const BIZ  = oid().toString();
const USER = oid().toString();

const leanOf = (val) => ({ lean: () => Promise.resolve(val) });

/**
 * Point the resolver at the two equity accounts a close needs. Replaces a
 * hand-rolled findOne classifier that had to understand the service's $or/regex
 * query shapes — the exact coupling the resolver removed.
 */
const makeAcctFindOne = ({ cyeId, reId }) => {
  accountResolver.resolveMany.mockResolvedValue({
    retainedEarningsAcct: { _id: reId, accountCode: '3210', accountName: 'Retained Earnings' },
    clearingAcct:         { _id: cyeId, accountCode: '3310', accountName: 'Current Year Earnings' },
  });
  return () => leanOf(null);
};

beforeEach(() => {
  jest.clearAllMocks();
  // Legacy top-level aggregation path returns NOTHING — proves the service no
  // longer relies on it. If the service still reads top-level totals, the
  // compound numbers below would be missed and the assertions fail.
  JournalEntry.aggregate.mockResolvedValue([]);
  JournalEntry.countDocuments.mockResolvedValue(0);
  AccountingPeriod.updateOne.mockResolvedValue({});
  FiscalYear.updateOne.mockResolvedValue({});
  postBalancedJournal.mockResolvedValue({ _id: oid() });
});

// ════════════════════════════════════════════════════════════════════════════
//  A7 — period summary counts compound (journalLines-only) expenses
// ════════════════════════════════════════════════════════════════════════════
describe('closePeriod — period summary uses effective lines (A7)', () => {
  test('totalExpenses includes a COGS leg that lives only in journalLines', async () => {
    const periodId = oid();
    AccountingPeriod.findOne.mockReturnValue(leanOf({
      _id: periodId, name: 'Jan 2026', status: PERIOD_STATUS.OPEN,
      startDate: new Date('2026-01-01'), endDate: new Date('2026-01-31'),
    }));
    // Effective-lines income statement: revenue 1000, COGS 600 (compound leg).
    transactionRepository.getIncomeStatementData.mockResolvedValue({
      revenue:  [{ name: 'Sales',            amount: 1000 }],
      expenses: [{ name: 'Cost of Goods Sold', amount: 600 }],
    });
    JournalEntry.countDocuments.mockResolvedValue(5);

    const res = await fiscalYearService.closePeriod(BIZ, periodId, USER, { reason: 'eom' });

    expect(res.closingSummary).toEqual({
      totalRevenue: 1000,
      totalExpenses: 600,
      netIncome: 400,
      transactionCount: 5,
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  A7 — closing net income uses effective-lines revenue/expense
// ════════════════════════════════════════════════════════════════════════════
describe('closeFiscalYear — closing entry net income uses effective lines (A7)', () => {
  test('posts a closing entry for the compound-aware net income', async () => {
    const fyId = oid();
    const reId = oid();
    const revId = oid();
    FiscalYear.findOne.mockReturnValue(leanOf({
      _id: fyId, name: 'FY2026', status: FISCAL_YEAR_STATUS.OPEN,
      startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'),
    }));
    AccountingPeriod.countDocuments.mockResolvedValue(0); // no open periods

    const cyeId = oid();
    ChartOfAccount.findOne.mockImplementation(makeAcctFindOne({ cyeId, reId, revId }));
    transactionRepository.getIncomeStatementData.mockResolvedValue({
      revenue:  [{ name: 'Sales', amount: 1000 }],
      expenses: [{ name: 'Cost of Goods Sold', amount: 600 }], // compound COGS leg
    });

    const res = await fiscalYearService.closeFiscalYear(BIZ, fyId, USER, {});

    expect(postBalancedJournal).toHaveBeenCalledTimes(1);
    expect(postBalancedJournal).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 400, // 1000 - 600
        // One closing entry per year, forever — the key is what stops a retry
        // transferring net income into Retained Earnings twice.
        idempotencyKey: `fy-close:${fyId}`,
      }),
      expect.anything() // { session } — close posts inside its own transaction
    );
    expect(res.retainedEarningsTransferred).toBe(400);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  A8 — closing entry debits the Current Year Earnings clearing account, never
//  an arbitrary Revenue account (which it would drive negative)
// ════════════════════════════════════════════════════════════════════════════
describe('closeFiscalYear — closing entry uses Current Year Earnings clearing account (A8)', () => {
  function setupClose({ revenue, expenses, cyeId, reId, revId, fyId }) {
    FiscalYear.findOne.mockReturnValue(leanOf({
      _id: fyId, name: 'FY2026', status: FISCAL_YEAR_STATUS.OPEN,
      startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'),
    }));
    AccountingPeriod.countDocuments.mockResolvedValue(0);
    ChartOfAccount.findOne.mockImplementation(makeAcctFindOne({ cyeId, reId, revId }));
    transactionRepository.getIncomeStatementData.mockResolvedValue({ revenue, expenses });
  }

  test('profit: DR Current Year Earnings / CR Retained Earnings (revenue acct untouched)', async () => {
    const fyId = oid(), cyeId = oid(), reId = oid(), revId = oid();
    setupClose({
      revenue:  [{ name: 'Sales', amount: 1000 }],
      expenses: [{ name: 'COGS', amount: 600 }],
      cyeId, reId, revId, fyId,
    });

    await fiscalYearService.closeFiscalYear(BIZ, fyId, USER, {});

    const arg = postBalancedJournal.mock.calls[0][0];
    expect(arg.amount).toBe(400);
    expect(arg.debitAccountId).toEqual(cyeId);   // DR Current Year Earnings
    expect(arg.creditAccountId).toEqual(reId);   // CR Retained Earnings
    expect(arg.debitAccountId).not.toEqual(revId); // never the Revenue account
  });

  test('loss: DR Retained Earnings / CR Current Year Earnings', async () => {
    const fyId = oid(), cyeId = oid(), reId = oid(), revId = oid();
    setupClose({
      revenue:  [{ name: 'Sales', amount: 400 }],
      expenses: [{ name: 'COGS', amount: 1000 }], // net loss 600
      cyeId, reId, revId, fyId,
    });

    await fiscalYearService.closeFiscalYear(BIZ, fyId, USER, {});

    const arg = postBalancedJournal.mock.calls[0][0];
    expect(arg.amount).toBe(600);
    expect(arg.debitAccountId).toEqual(reId);    // DR Retained Earnings (loss)
    expect(arg.creditAccountId).toEqual(cyeId);  // CR Current Year Earnings
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  A7 — opening balances include accounts that appear ONLY in journalLines
// ════════════════════════════════════════════════════════════════════════════
describe('createOpeningBalances — uses effective-lines per-account balances (A7)', () => {
  test('carries forward an Asset balance present only via journalLines', async () => {
    const fyId = oid();
    const reId = oid();
    const inventoryId = oid();

    // getFiscalYear (1st findOne, .lean) then prevFY (2nd findOne, .sort().lean)
    FiscalYear.findOne
      .mockReturnValueOnce(leanOf({
        _id: fyId, name: 'FY2026', startDate: new Date('2026-01-01'),
      }))
      .mockReturnValueOnce({ sort: () => leanOf(null) }); // no previous FY

    ChartOfAccount.find.mockReturnValue(leanOf([
      { _id: inventoryId, accountName: 'Inventory', accountType: 'Asset', normalBalance: 'Debit' },
      { _id: reId, accountName: 'Retained Earnings', accountType: 'Equity', normalBalance: 'Credit' },
    ]));
    ChartOfAccount.findOne.mockReturnValue(leanOf({ _id: reId, accountName: 'Retained Earnings' }));

    // Effective-lines totals: Inventory carries a 5,000 debit balance that exists
    // only because a compound sale posted COGS against it via journalLines.
    transactionRepository.getDebitCreditTotals.mockResolvedValue({
      debitTotals:  [{ _id: inventoryId, total: 5000 }],
      creditTotals: [],
    });

    const res = await fiscalYearService.createOpeningBalances(BIZ, fyId, USER);

    expect(res.entriesCreated).toBe(1);
    expect(postBalancedJournal).toHaveBeenCalledTimes(1);
    expect(postBalancedJournal).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 5000,
        debitAccountId: inventoryId,   // DR Inventory
        creditAccountId: reId,         // CR Retained Earnings
      })
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  Lifecycle round-trip — close → reopen (guards period state machine)
// ════════════════════════════════════════════════════════════════════════════
describe('period close → reopen round-trip', () => {
  test('a closed period can be reopened back to OPEN', async () => {
    const periodId = oid();
    AccountingPeriod.findOne
      .mockReturnValueOnce(leanOf({
        _id: periodId, name: 'Jan 2026', status: PERIOD_STATUS.OPEN,
        startDate: new Date('2026-01-01'), endDate: new Date('2026-01-31'),
      }))
      .mockReturnValueOnce(leanOf({
        _id: periodId, name: 'Jan 2026', status: PERIOD_STATUS.CLOSED,
        startDate: new Date('2026-01-01'), endDate: new Date('2026-01-31'),
      }));
    transactionRepository.getIncomeStatementData.mockResolvedValue({ revenue: [], expenses: [] });

    const closed = await fiscalYearService.closePeriod(BIZ, periodId, USER, {});
    expect(closed.status).toBe(PERIOD_STATUS.CLOSED);

    const reopened = await fiscalYearService.reopenPeriod(BIZ, periodId, USER, { reason: 'correction' });
    expect(reopened.status).toBe(PERIOD_STATUS.OPEN);
  });
});
