const reportService = require('../../../services/report.service');
const accountRepository = require('../../../repositories/account.repository');
const transactionRepository = require('../../../repositories/transaction.repository');

jest.mock('../../../repositories/account.repository');
jest.mock('../../../repositories/transaction.repository');

// Minimal chart: Capital (credit), Drawings (debit), Retained Earnings (credit),
// plus Revenue & Expense accounts that feed the synthetic Current Year Earnings.
const ACCOUNTS = [
  { _id: 'cap', accountCode: '3110', accountName: 'Capital / Investment', accountType: 'Equity', accountSubtype: 'Equity', normalBalance: 'Credit' },
  { _id: 'draw', accountCode: '3120', accountName: 'Distributions / Drawings', accountType: 'Equity', accountSubtype: 'Equity', normalBalance: 'Debit' },
  { _id: 're', accountCode: '3210', accountName: 'Retained Earnings', accountType: 'Equity', accountSubtype: 'Equity', normalBalance: 'Credit' },
  { _id: 'rev', accountCode: '4100', accountName: 'Sales Revenue', accountType: 'Revenue', accountSubtype: 'Revenue', normalBalance: 'Credit' },
  { _id: 'exp', accountCode: '6100', accountName: 'Operating Expense', accountType: 'Expense', accountSubtype: 'Operating Expenses', normalBalance: 'Debit' },
];

describe('getStatementOfChangesInEquity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    accountRepository.findByBusiness.mockResolvedValue(ACCOUNTS);
  });

  test('opening + movements foots to closing per column and reconciles to BS equity', async () => {
    const start = new Date('2026-01-01');
    const end = new Date('2026-12-31');

    // Economic balances: opening (day before start) vs closing (end).
    // _getBalancesAsOf returns balances in NORMAL direction:
    //   Drawings is debit-normal, so a 15000 withdrawal → raw balance +15000.
    // Opening: capital 100000, drawings 0, RE 50000, rev/exp all-time 0 → CYE 0.
    // Closing: capital 120000 (owner put in 20000), drawings +15000 (debit-normal raw),
    //          RE 50000, rev 200000, exp 140000 → CYE = 200000 - 140000 = 60000.
    // Equity-signed closing: 120000 + (-15000) + 50000 + 60000 = 215000.
    const openingMap = { cap: 100000, draw: 0, re: 50000, rev: 0, exp: 0 };
    const closingMap = { cap: 120000, draw: 15000, re: 50000, rev: 200000, exp: 140000 };

    jest.spyOn(reportService, '_getBalancesAsOf').mockImplementation(async (_b, d) =>
      new Date(d).getTime() < start.getTime() ? openingMap : closingMap
    );

    // Period movements: +20000 credit to capital, +15000 debit to drawings.
    transactionRepository.getDebitCreditTotalsBetween.mockResolvedValue({
      debitTotals: [{ _id: 'draw', total: 15000 }, { _id: 'exp', total: 140000 }],
      creditTotals: [{ _id: 'cap', total: 20000 }, { _id: 'rev', total: 200000 }],
    });

    const r = await reportService.getStatementOfChangesInEquity('biz1', start, end);

    const opening = r.rows.find(x => x.key === 'opening');
    const closing = r.rows.find(x => x.key === 'closing');
    const profit = r.rows.find(x => x.key === 'profit');

    // Per-column footing: opening + every movement row = closing
    for (const c of r.components) {
      const moves = r.rows
        .filter(x => !['opening', 'closing'].includes(x.key))
        .reduce((s, row) => s + (row.values[c.key] || 0), 0);
      expect(Math.round((opening.values[c.key] + moves) * 100) / 100)
        .toBeCloseTo(closing.values[c.key], 2);
    }

    // Profit row total equals net income (200000 - 140000)
    expect(profit.total).toBeCloseTo(60000, 2);

    // Opening total 150000 (100000 cap + 50000 RE), closing 215000 (120000 - 15000 + 50000 + 60000)
    expect(opening.total).toBeCloseTo(150000, 2);
    expect(closing.total).toBeCloseTo(215000, 2);

    // Distributions row: Drawings (debit-normal, 15000 debit movement) must be -15000
    // in the capital column (equitySign flips the sign).
    const distRow = r.rows.find(x => x.key === 'distributions');
    expect(distRow.values.capital).toBeCloseTo(-15000, 2);

    // Other row should be zero when all movements are fully explained.
    const otherRow = r.rows.find(x => x.key === 'other');
    expect(otherRow.total).toBeCloseTo(0, 2);

    // Reconciles to BS equity (Σ closing columns)
    expect(r.reconciliation.reconciles).toBe(true);
    expect(r.reconciliation.closingTotal).toBeCloseTo(215000, 2);
    expect(r.reconciliation.balanceSheetEquity).toBeCloseTo(215000, 2);
  });
});
