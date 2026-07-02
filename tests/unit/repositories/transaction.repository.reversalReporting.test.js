/**
 * tests/unit/repositories/transaction.repository.reversalReporting.test.js
 *
 * Audit 2026-07-02 F1 — reversal pairs must NET TO ZERO in every financial
 * statement instead of misstating them.
 *
 * The engine marks a reversed ORIGINAL `status: 'reversed'` and posts its
 * counter-entry as `status: 'posted'`. If reports exclude 'reversed', every
 * reversal leaves the flipped counter-entry in the statements with nothing to
 * offset it (Cash −100 instead of 0), and the original silently vanishes from
 * its historical period (retroactive mutation of closed-period reports).
 *
 * Enterprise convention (SAP / Oracle / NetSuite): BOTH entries stay in the
 * ledger and the reports; each nets in its own period.
 *
 * Consequence for the Income Statement: with both entries visible, the old
 * gross convention (revenue = credit lines only / expense = debit lines only)
 * would ignore a reversal's DR-Revenue leg, so the P&L must instead show the
 * NET movement per account — with system closing / opening-balance entries
 * excluded explicitly by entryType (the gross convention used to exclude the
 * closing sweep "naturally"; netting no longer does).
 */
'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const transactionRepository = require('../../../repositories/transaction.repository');
const { JOURNAL_STATUS } = require('../../../config/constants');

const BIZ = '64b7a1f2c9e77a0012345678';

afterEach(() => jest.restoreAllMocks());

describe('F1 — reversal entries in financial reports', () => {
  test('REPORT_STATUSES includes "reversed" so a reversal pair nets to zero', () => {
    expect(transactionRepository.REPORT_STATUSES).toContain(JOURNAL_STATUS.REVERSED);
  });

  test('getDebitCreditTotals default filter includes reversed originals', async () => {
    const aggregate = jest
      .spyOn(transactionRepository.model, 'aggregate')
      .mockResolvedValue([{ debitTotals: [], creditTotals: [] }]);

    await transactionRepository.getDebitCreditTotals(BIZ, new Date('2026-06-30'));

    const pipeline = aggregate.mock.calls[0][0];
    const match = pipeline.find((s) => s.$match).$match;
    expect(match.status.$in).toContain(JOURNAL_STATUS.REVERSED);
  });

  test('getByDateRange (report feed) includes reversed originals', async () => {
    const chain = {
      populate: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    };
    const find = jest.spyOn(transactionRepository.model, 'find').mockReturnValue(chain);

    await transactionRepository.getByDateRange(BIZ, new Date('2026-01-01'), new Date('2026-12-31'));

    const filter = find.mock.calls[0][0];
    expect(filter.status.$in).toContain(JOURNAL_STATUS.REVERSED);
  });

  describe('getIncomeStatementData — net movement per account', () => {
    let pipeline;

    beforeEach(async () => {
      const aggregate = jest
        .spyOn(transactionRepository.model, 'aggregate')
        .mockResolvedValue([{ revenue: [], expenses: [] }]);
      await transactionRepository.getIncomeStatementData(BIZ, new Date('2026-01-01'), new Date('2026-12-31'));
      pipeline = aggregate.mock.calls[0][0];
    });

    test('includes reversed entries and excludes closing / opening-balance sweeps by entryType', () => {
      const match = pipeline.find((s) => s.$match).$match;
      expect(match.status.$in).toContain(JOURNAL_STATUS.REVERSED);
      expect(match.entryType).toEqual({ $nin: ['closing', 'opening_balance'] });
    });

    test('revenue is NET (credits − debits) so a reversal reduces the P&L', () => {
      const facet = pipeline.find((s) => s.$facet).$facet;
      const revenueJson = JSON.stringify(facet.revenue);
      // must NOT pre-filter to credit lines only (the gross convention)…
      expect(revenueJson).not.toContain('"effectiveLines.type":"credit"');
      // …and must subtract debit lines via a conditional sum.
      expect(revenueJson).toContain('$cond');
    });

    test('expenses are NET (debits − credits) so an expense reversal reduces the P&L', () => {
      const facet = pipeline.find((s) => s.$facet).$facet;
      const expenseJson = JSON.stringify(facet.expenses);
      expect(expenseJson).not.toContain('"effectiveLines.type":"debit"');
      expect(expenseJson).toContain('$cond');
    });
  });
});
