const reportService = require('../../../services/report.service');
const accountRepository = require('../../../repositories/account.repository');
const transactionRepository = require('../../../repositories/transaction.repository');

jest.mock('../../../repositories/account.repository');
jest.mock('../../../repositories/transaction.repository');

describe('getRevenueNotes', () => {
  beforeEach(() => jest.clearAllMocks());

  test('disaggregates revenue by account and totals to income-statement revenue', async () => {
    accountRepository.findByBusiness.mockResolvedValue([
      { _id: 'r1', accountName: 'Product Sales', accountType: 'Revenue', normalBalance: 'Credit' },
      { _id: 'r2', accountName: 'Service Income', accountType: 'Revenue', normalBalance: 'Credit' },
      { _id: 'e1', accountName: 'Rent', accountType: 'Expense', normalBalance: 'Debit' },
    ]);
    transactionRepository.getDebitCreditTotalsBetween.mockResolvedValue({
      debitTotals: [],
      creditTotals: [{ _id: 'r1', total: 75000 }, { _id: 'r2', total: 25000 }],
    });

    const r = await reportService.getRevenueNotes('biz1', new Date('2026-01-01'), new Date('2026-12-31'));

    expect(r.totalRevenue).toBeCloseTo(100000, 2);
    const product = r.disaggregation.find(d => d.stream === 'Product Sales');
    expect(product.amount).toBeCloseTo(75000, 2);
    expect(product.pct).toBeCloseTo(75, 1);
    expect(typeof r.policyText).toBe('string');
    expect(r.policyText.length).toBeGreaterThan(40);
  });
});
