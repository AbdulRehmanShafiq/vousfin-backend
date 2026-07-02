/**
 * tests/unit/services/report.cashFlow.effectiveLines.test.js
 *
 * Audit 2026-07-02 F15 — the Cash Flow Statement must read the SAME effective
 * journal lines as every other statement.
 *
 * It used to match only the top-level debit/credit account pair, so cash legs
 * living inside compound journalLines (a payroll run's CR Cash, a taxed sale's
 * DR Cash) were invisible or misread, and a cash→cash transfer was counted
 * one-sided. The statement now derives from a line-level aggregation
 * (transactionRepository.getCashLineTotals) built on EFFECTIVE_LINES_STAGE.
 */
'use strict';

jest.mock('../../../repositories/transaction.repository', () => ({
  getCashLineTotals: jest.fn(),
  getDebitCreditTotals: jest.fn(),
  getIncomeStatementData: jest.fn(),
  getGeneralLedgerEntries: jest.fn(),
}));
jest.mock('../../../repositories/account.repository', () => ({
  findByBusiness: jest.fn(),
}));
jest.mock('../../../utils/reportCache', () => ({
  get: jest.fn(() => null),
  set: jest.fn(),
  invalidate: jest.fn(),
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const reportService         = require('../../../services/report.service');
const transactionRepository = require('../../../repositories/transaction.repository');
const accountRepository     = require('../../../repositories/account.repository');
const { TRANSACTION_TYPES, ACCOUNT_SUBTYPES } = require('../../../config/constants');

const BIZ = 'biz1';
const START = new Date('2026-01-01');
const END = new Date('2026-12-31');

const CASH_ACCOUNTS = [
  { _id: 'cash1', accountName: 'Cash at Bank', accountType: 'Asset', accountSubtype: ACCOUNT_SUBTYPES.BANK_AND_CASH },
  { _id: 'cash2', accountName: 'Petty Cash',   accountType: 'Asset', accountSubtype: ACCOUNT_SUBTYPES.BANK_AND_CASH },
];

beforeEach(() => {
  jest.clearAllMocks();
  accountRepository.findByBusiness.mockResolvedValue(CASH_ACCOUNTS);
});

describe('F15 — cash flow derives from effective journal lines', () => {
  test('classifies line-level net cash per transaction type into the three sections', async () => {
    transactionRepository.getCashLineTotals.mockResolvedValue([
      // Payroll compound entry: only the CR-Cash LEG hits cash (5,000 out).
      { _id: TRANSACTION_TYPES.SALARY || 'Salary', cashIn: 0, cashOut: 5000 },
      { _id: TRANSACTION_TYPES.OWNER_INVESTMENT, cashIn: 10000, cashOut: 0 },
      { _id: TRANSACTION_TYPES.ASSET_PURCHASE, cashIn: 0, cashOut: 3000 },
      // Cash→cash transfer nets to zero at line level → dropped from the statement.
      { _id: TRANSACTION_TYPES.TRANSFER || 'Transfer', cashIn: 2000, cashOut: 2000 },
    ]);

    const result = await reportService.getCashFlowStatement(BIZ, START, END);

    // The repo was asked for line-level cash totals over BOTH cash accounts.
    expect(transactionRepository.getCashLineTotals).toHaveBeenCalledWith(
      BIZ, ['cash1', 'cash2'], START, END
    );

    expect(result.operating.total).toBe(-5000);
    expect(result.financing.total).toBe(10000);
    expect(result.investing.total).toBe(-3000);
    expect(result.netCashFlow).toBe(2000);

    // The zero-net transfer must not appear as a line item.
    const allItems = [...result.operating.items, ...result.investing.items, ...result.financing.items];
    expect(allItems.some((i) => /transfer/i.test(i.transactionType || ''))).toBe(false);
  });

  test('throws when the business has no cash or bank account', async () => {
    accountRepository.findByBusiness.mockResolvedValue([
      { _id: 'x', accountName: 'Sales', accountType: 'Revenue', accountSubtype: 'Revenue' },
    ]);

    await expect(reportService.getCashFlowStatement(BIZ, START, END)).rejects.toMatchObject({ statusCode: 500 });
  });
});
