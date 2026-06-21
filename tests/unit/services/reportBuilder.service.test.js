const builder = require('../../../services/reportBuilder.service');

describe('computeComparativeWindow', () => {
  test('prior-period is the immediately preceding equal-length window', () => {
    const { priorStart, priorEnd } = builder.computeComparativeWindow(
      'prior-period', new Date('2026-04-01'), new Date('2026-06-30')
    );
    // 91-day window → prior ends the day before start
    expect(priorEnd.toISOString().slice(0, 10)).toBe('2026-03-31');
    expect(priorStart.toISOString().slice(0, 10)).toBe('2025-12-31');
  });

  test('prior-year shifts the window back one year', () => {
    const { priorStart, priorEnd } = builder.computeComparativeWindow(
      'prior-year', new Date('2026-04-01'), new Date('2026-06-30')
    );
    expect(priorStart.toISOString().slice(0, 10)).toBe('2025-04-01');
    expect(priorEnd.toISOString().slice(0, 10)).toBe('2025-06-30');
  });
});

describe('renderTemplate', () => {
  test('renders rows with comparative absolute + percent variance', async () => {
    const reportTemplateRepo = require('../../../repositories/reportTemplate.repository');
    const reportService = require('../../../services/report.service');
    const accountRepository = require('../../../repositories/account.repository');
    const transactionRepository = require('../../../repositories/transaction.repository');
    jest.spyOn(reportService, 'getBalancesAsOf').mockResolvedValue({});
    jest.spyOn(reportTemplateRepo, 'findOwnedById').mockResolvedValue({
      _id: 't1', name: 'P&L', baseType: 'pl',
      filters: {}, comparative: { enabled: true, mode: 'prior-year' },
      layout: [{ id: 'r1', kind: 'account', label: 'Sales', accountIds: ['rev'], metric: 'flow', visible: true }],
    });
    jest.spyOn(accountRepository, 'findByBusiness').mockResolvedValue([
      { _id: 'rev', accountName: 'Sales', accountType: 'Revenue', normalBalance: 'Credit' },
    ]);
    jest.spyOn(transactionRepository, 'getDebitCreditTotalsBetween').mockImplementation(async (_b, s) =>
      new Date(s).getFullYear() === 2026
        ? { debitTotals: [], creditTotals: [{ _id: 'rev', total: 120000 }] }
        : { debitTotals: [], creditTotals: [{ _id: 'rev', total: 100000 }] }
    );

    const r = await builder.renderTemplate('biz1', 't1', { startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31') });
    const row = r.rows.find(x => x.id === 'r1');
    expect(row.current).toBeCloseTo(120000, 2);
    expect(row.prior).toBeCloseTo(100000, 2);
    expect(row.change).toBeCloseTo(20000, 2);
    expect(row.changePct).toBeCloseTo(20, 1);
  });
});
