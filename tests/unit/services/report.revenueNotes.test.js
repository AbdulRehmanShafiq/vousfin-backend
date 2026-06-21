const reportService = require('../../../services/report.service');

describe('getRevenueNotes', () => {
  beforeEach(() => jest.restoreAllMocks());

  test('disaggregates the SAME revenue the income statement reports (reconciles by construction)', async () => {
    // getRevenueNotes derives from getIncomeStatement so the totals always match
    // the P&L. We stub the income statement with a known revenue breakdown.
    jest.spyOn(reportService, 'getIncomeStatement').mockResolvedValue({
      revenue: {
        accounts: [
          { accountName: 'Product Sales', balance: 75000 },
          { accountName: 'Service Income', balance: 25000 },
          { accountName: 'Unused Stream', balance: 0 }, // zero rows are dropped
        ],
        total: 100000,
      },
      totalRevenue: 100000,
    });

    const r = await reportService.getRevenueNotes('biz-notes-a', new Date('2026-01-01'), new Date('2026-12-31'));

    // Total matches the income statement exactly.
    expect(r.totalRevenue).toBeCloseTo(100000, 2);
    // Disaggregation sums to the same total (reconciles by construction).
    expect(r.disaggregation.reduce((s, d) => s + d.amount, 0)).toBeCloseTo(100000, 2);

    const product = r.disaggregation.find(d => d.stream === 'Product Sales');
    expect(product.amount).toBeCloseTo(75000, 2);
    expect(product.pct).toBeCloseTo(75, 1);

    // Zero-amount streams excluded; sorted descending by amount.
    expect(r.disaggregation.find(d => d.stream === 'Unused Stream')).toBeUndefined();
    expect(r.disaggregation[0].amount).toBeGreaterThanOrEqual(r.disaggregation[1].amount);

    expect(typeof r.policyText).toBe('string');
    expect(r.policyText.length).toBeGreaterThan(40);
  });

  test('zero total revenue yields zero percentages without dividing by zero', async () => {
    jest.spyOn(reportService, 'getIncomeStatement').mockResolvedValue({
      revenue: { accounts: [], total: 0 },
      totalRevenue: 0,
    });

    const r = await reportService.getRevenueNotes('biz-notes-b', new Date('2026-01-01'), new Date('2026-12-31'));
    expect(r.totalRevenue).toBe(0);
    expect(r.disaggregation).toEqual([]);
  });
});
