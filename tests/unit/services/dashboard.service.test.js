// tests/unit/services/dashboard.service.test.js
jest.mock('../../../services/report.service');
jest.mock('../../../repositories/transaction.repository');
jest.mock('../../../repositories/account.repository');

const dashboardService = require('../../../services/dashboard.service');
const reportService = require('../../../services/report.service');
const transactionRepository = require('../../../repositories/transaction.repository');
const accountRepository = require('../../../repositories/account.repository');

const BIZ_ID = 'biz001';
const START = new Date('2026-01-01');
const END   = new Date('2026-01-31');

beforeEach(() => {
  jest.clearAllMocks();

  reportService.getKPISummary = jest.fn().mockResolvedValue({
    revenue: 100000,
    expenses: 60000,
    netProfit: 40000,
    cashBalance: 25000,
    profitMargin: 40,
    accountsReceivable: 15000,
    accountsPayable: 8000,
  });

  transactionRepository.getByDateRange = jest.fn().mockResolvedValue([]);
  transactionRepository.getByAccount   = jest.fn().mockResolvedValue([]);
  accountRepository.findByBusiness = jest.fn().mockResolvedValue([]);
});

// ── getKPIs ───────────────────────────────────────────────────────────────────
describe('DashboardService.getKPIs()', () => {
  test('should throw 400 when businessId is missing', async () => {
    await expect(dashboardService.getKPIs(null, START, END))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('should return KPI object with correct shape', async () => {
    const kpis = await dashboardService.getKPIs(BIZ_ID, START, END);
    expect(kpis).toHaveProperty('revenue', 100000);
    expect(kpis).toHaveProperty('expenses', 60000);
    expect(kpis).toHaveProperty('netProfit', 40000);
    expect(kpis).toHaveProperty('period');
    expect(kpis.period).toEqual({ startDate: START, endDate: END });
  });
});

// ── getRevenueVsExpensesChart ──────────────────────────────────────────────────
describe('DashboardService.getRevenueVsExpensesChart()', () => {
  test('should throw 400 when businessId is missing', async () => {
    await expect(dashboardService.getRevenueVsExpensesChart(null, START, END))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('should return an empty array when no transactions exist', async () => {
    const result = await dashboardService.getRevenueVsExpensesChart(BIZ_ID, START, END);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  test('should group transactions by month and sum revenue/expenses', async () => {
    transactionRepository.getByDateRange.mockResolvedValue([
      { transactionDate: new Date('2026-01-15'), transactionType: 'Income',  amount: 5000 },
      { transactionDate: new Date('2026-01-20'), transactionType: 'Expense', amount: 2000 },
      { transactionDate: new Date('2026-01-25'), transactionType: 'Income',  amount: 3000 },
    ]);

    const result = await dashboardService.getRevenueVsExpensesChart(BIZ_ID, START, END, 'month');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ period: '2026-01', revenue: 8000, expenses: 2000 });
  });
});

// ── getCashFlowTrend ───────────────────────────────────────────────────────────
describe('DashboardService.getCashFlowTrend()', () => {
  test('should return empty array when no Cash account found', async () => {
    accountRepository.findByBusiness.mockResolvedValue([
      { _id: 'acc_bank', accountName: 'Bank' },
    ]);
    const result = await dashboardService.getCashFlowTrend(BIZ_ID, START, END);
    expect(result).toEqual([]);
  });

  test('should return net cash flow data when Cash account exists', async () => {
    const cashAccId = 'acc_cash';
    accountRepository.findByBusiness.mockResolvedValue([
      { _id: cashAccId, accountName: 'Cash' },
    ]);
    transactionRepository.getByAccount.mockResolvedValue([
      {
        transactionDate: new Date('2026-01-10'),
        amount: 10000,
        debitAccountId:  { _id: cashAccId },
        creditAccountId: { _id: 'acc_other' },
      },
      {
        transactionDate: new Date('2026-01-20'),
        amount: 3000,
        debitAccountId:  { _id: 'acc_other' },
        creditAccountId: { _id: cashAccId },
      },
    ]);

    const result = await dashboardService.getCashFlowTrend(BIZ_ID, START, END, 'month');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ period: '2026-01', netCashFlow: 7000 });
  });
});

// ── getAllDashboardData ────────────────────────────────────────────────────────
describe('DashboardService.getAllDashboardData()', () => {
  test('should return kpis, revenueVsExpenses and cashFlowTrend', async () => {
    const result = await dashboardService.getAllDashboardData(BIZ_ID, START, END);
    expect(result).toHaveProperty('kpis');
    expect(result).toHaveProperty('revenueVsExpenses');
    expect(result).toHaveProperty('cashFlowTrend');
  });
});

// ── _getPeriodKey (private, tested indirectly) ─────────────────────────────────
describe('DashboardService period grouping', () => {
  test('should group by day when interval=day', async () => {
    transactionRepository.getByDateRange.mockResolvedValue([
      { transactionDate: new Date('2026-01-05'), transactionType: 'Income', amount: 1000 },
    ]);
    const result = await dashboardService.getRevenueVsExpensesChart(BIZ_ID, START, END, 'day');
    expect(result[0].period).toBe('2026-01-05');
  });

  test('should group by week when interval=week', async () => {
    transactionRepository.getByDateRange.mockResolvedValue([
      { transactionDate: new Date('2026-01-05'), transactionType: 'Income', amount: 1000 },
    ]);
    const result = await dashboardService.getRevenueVsExpensesChart(BIZ_ID, START, END, 'week');
    expect(result[0].period).toMatch(/^\d{4}-W\d{2}$/);
  });
});
