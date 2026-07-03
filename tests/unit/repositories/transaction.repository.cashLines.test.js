/**
 * tests/unit/repositories/transaction.repository.cashLines.test.js
 *
 * Audit 2026-07-02 F15 — getCashLineTotals is the Cash Flow Statement's data
 * source: a line-level aggregation over the SAME effective-lines normalisation
 * as every other statement (reversals included so pairs net to zero).
 */
'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const transactionRepository = require('../../../repositories/transaction.repository');
const { JOURNAL_STATUS } = require('../../../config/constants');

const BIZ = '64b7a1f2c9e77a0012345678';
const CASH_ID = '64b7a1f2c9e77a0012345699';

afterEach(() => jest.restoreAllMocks());

describe('getCashLineTotals — pipeline shape', () => {
  let pipeline;

  beforeEach(async () => {
    const aggregate = jest
      .spyOn(transactionRepository.model, 'aggregate')
      .mockResolvedValue([]);
    await transactionRepository.getCashLineTotals(BIZ, [CASH_ID], new Date('2026-01-01'), new Date('2026-12-31'));
    pipeline = aggregate.mock.calls[0][0];
  });

  test('filters by REPORT_STATUSES (reversals included) and the date range', () => {
    const match = pipeline.find((s) => s.$match && s.$match.status).$match;
    expect(match.status.$in).toContain(JOURNAL_STATUS.REVERSED);
    expect(match.transactionDate).toBeDefined();
  });

  test('normalises through the shared EFFECTIVE_LINES_STAGE and unwinds lines', () => {
    expect(pipeline).toContainEqual(transactionRepository.EFFECTIVE_LINES_STAGE);
    expect(pipeline.some((s) => s.$unwind === '$effectiveLines')).toBe(true);
  });

  test('keeps only lines touching the cash accounts, grouped net per transaction type', () => {
    const lineMatch = pipeline.find((s) => s.$match && s.$match['effectiveLines.accountId']);
    expect(lineMatch).toBeDefined();

    const group = pipeline.find((s) => s.$group).$group;
    expect(group._id).toBe('$transactionType');
    expect(JSON.stringify(group.cashIn)).toContain('debit');
    expect(JSON.stringify(group.cashOut)).toContain('credit');
  });
});
