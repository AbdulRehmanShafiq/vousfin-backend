'use strict';

// Mock Business model (mongoose), the taxReport aggregations and the income
// statement the service reuses.
const mockBusiness = { findById: jest.fn() };
jest.mock('mongoose', () => ({ model: () => mockBusiness, Types: { ObjectId: (v) => v } }));
jest.mock('../../../services/taxReport.service', () => ({
  reconcileTaxToLedger: jest.fn(),
  getWhtSummary: jest.fn(),
}));
jest.mock('../../../services/report.service', () => ({
  getIncomeStatement: jest.fn(),
}));
jest.mock('../../../repositories/payrollAccrual.repository', () => ({
  latest: jest.fn(),
}));

const taxReport   = require('../../../services/taxReport.service');
const report      = require('../../../services/report.service');
const payrollRepo = require('../../../repositories/payrollAccrual.repository');
const taxPosition = require('../../../services/taxPosition.service');

const BIZ = '507f1f77bcf86cd799439060';

function mockBiz(taxConfig = { country: 'PK', incomeTaxProvisionRate: 0.29 }, currency = 'PKR', fiscalYearStartMonth = 7) {
  mockBusiness.findById.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve({ taxConfig, currency, fiscalYearStartMonth }) }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBiz();
  taxReport.reconcileTaxToLedger.mockResolvedValue({
    glOutputTax: 1700, glInputTax: 500, glNetPayable: 1200,
    taxAccounts: { output: ['2120'], input: ['1170'] },
  });
  taxReport.getWhtSummary.mockResolvedValue({ totalWht: 300, vendors: [], period: {} });
  report.getIncomeStatement.mockResolvedValue({ netProfit: 0, netIncome: 0 });
  payrollRepo.latest.mockResolvedValue(null);
});

describe('taxPosition.getLivePosition — GST & WHT', () => {
  it('computes GST liability from the GL net payable for the current month', async () => {
    const pos = await taxPosition.getLivePosition(BIZ, new Date(2026, 5, 10));
    const gst = pos.taxes.find(t => t.taxType === 'GST');
    expect(gst.liability).toBe(1200);
    expect(gst.refundable).toBe(false);
    const period = taxReport.reconcileTaxToLedger.mock.calls[0][1];
    expect(period.startDate.getMonth()).toBe(5); // June
    expect(period.startDate.getDate()).toBe(1);
  });

  it('flags GST refundable (and floors display liability) when input exceeds output', async () => {
    taxReport.reconcileTaxToLedger.mockResolvedValue({
      glOutputTax: 100, glInputTax: 400, glNetPayable: -300, taxAccounts: { output: [], input: [] },
    });
    const pos = await taxPosition.getLivePosition(BIZ, new Date(2026, 5, 10));
    const gst = pos.taxes.find(t => t.taxType === 'GST');
    expect(gst.refundable).toBe(true);
    expect(gst.liability).toBe(0);
    expect(gst.raw).toBe(-300);
  });

  it('computes WHT liability from the WHT summary', async () => {
    const pos = await taxPosition.getLivePosition(BIZ, new Date(2026, 5, 10));
    expect(pos.taxes.find(t => t.taxType === 'WHT').liability).toBe(300);
  });

  it('attaches the correct next deadline per tax type', async () => {
    const pos = await taxPosition.getLivePosition(BIZ, new Date(2026, 5, 10));
    const gst = pos.taxes.find(t => t.taxType === 'GST');
    expect(gst.nextDeadline.daysRemaining).toBe(8);   // due 18th
    expect(gst.nextDeadline.returnType).toBe('GST-01');
    const wht = pos.taxes.find(t => t.taxType === 'WHT');
    expect(wht.nextDeadline.daysRemaining).toBe(5);   // due 15th
  });
});

describe('taxPosition.getLivePosition — income-tax provision (Phase 3)', () => {
  it('computes provision = rate × net-profit YTD over the fiscal year', async () => {
    report.getIncomeStatement.mockResolvedValue({ netProfit: 1000000, netIncome: 1000000 });
    const asOf = new Date(2026, 5, 10);
    const pos  = await taxPosition.getLivePosition(BIZ, asOf);

    const it = pos.taxes.find(t => t.taxType === 'INCOME_TAX');
    expect(it.liability).toBe(290000);   // 0.29 × 1,000,000
    expect(it.status).toBe('tracked');

    // YTD range = current fiscal year (July start) → asOf
    const [bizArg, fyStart, end] = report.getIncomeStatement.mock.calls[0];
    expect(bizArg).toBe(BIZ);
    expect(fyStart.getFullYear()).toBe(2025); // FY started last July
    expect(fyStart.getMonth()).toBe(6);
    expect(end).toBe(asOf);
  });

  it('floors a year-to-date loss to a zero provision', async () => {
    report.getIncomeStatement.mockResolvedValue({ netProfit: -500000 });
    const pos = await taxPosition.getLivePosition(BIZ, new Date(2026, 5, 10));
    const it  = pos.taxes.find(t => t.taxType === 'INCOME_TAX');
    expect(it.liability).toBe(0);
    expect(it.status).toBe('tracked');
  });

  it('honours a configured provision rate', async () => {
    mockBiz({ country: 'PK', incomeTaxProvisionRate: 0.35 });
    report.getIncomeStatement.mockResolvedValue({ netProfit: 200000 });
    const pos = await taxPosition.getLivePosition(BIZ, new Date(2026, 5, 10));
    expect(pos.taxes.find(t => t.taxType === 'INCOME_TAX').liability).toBe(70000); // 0.35 × 200k
  });

  it('defaults the rate to 0.29 when unset', async () => {
    mockBiz({ country: 'PK' }); // no incomeTaxProvisionRate
    report.getIncomeStatement.mockResolvedValue({ netProfit: 100000 });
    const pos = await taxPosition.getLivePosition(BIZ, new Date(2026, 5, 10));
    expect(pos.taxes.find(t => t.taxType === 'INCOME_TAX').liability).toBe(29000);
  });

  it('marks income tax not_tracked (0) when the income statement is unavailable', async () => {
    report.getIncomeStatement.mockRejectedValue(new Error('no data'));
    const pos = await taxPosition.getLivePosition(BIZ, new Date(2026, 5, 10));
    const it  = pos.taxes.find(t => t.taxType === 'INCOME_TAX');
    expect(it.status).toBe('not_tracked');
    expect(it.liability).toBe(0);
    // a failure to value income tax must not break the whole position
    expect(pos.taxes.find(t => t.taxType === 'GST').liability).toBe(1200);
  });

  it('includes the income-tax provision in totalPayable', async () => {
    report.getIncomeStatement.mockResolvedValue({ netProfit: 1000000 });
    const pos = await taxPosition.getLivePosition(BIZ, new Date(2026, 5, 10));
    expect(pos.totalPayable).toBe(291500); // 1200 GST + 300 WHT + 290000 income tax
  });
});

describe('taxPosition.getLivePosition — payroll + defaults', () => {
  it('leaves EOBI/SESSI not_tracked when payroll is disabled', async () => {
    const pos = await taxPosition.getLivePosition(BIZ, new Date(2026, 5, 10));
    expect(pos.taxes.find(t => t.taxType === 'EOBI').status).toBe('not_tracked');
    expect(pos.taxes.find(t => t.taxType === 'SESSI').status).toBe('not_tracked');
    expect(pos.currency).toBe('PKR');
    expect(pos.country).toBe('PK');
    // payroll repo is never queried when the feature is off
    expect(payrollRepo.latest).not.toHaveBeenCalled();
  });

  it('tracks EOBI/SESSI from the latest accrual when payroll is enabled', async () => {
    mockBiz({ country: 'PK', incomeTaxProvisionRate: 0.29, payrollEnabled: true });
    payrollRepo.latest.mockResolvedValue({ month: '2026-06', eobi: 5000, sessi: 3000 });

    const pos   = await taxPosition.getLivePosition(BIZ, new Date(2026, 5, 10));
    const eobi  = pos.taxes.find(t => t.taxType === 'EOBI');
    const sessi = pos.taxes.find(t => t.taxType === 'SESSI');

    expect(payrollRepo.latest).toHaveBeenCalledWith(BIZ);
    expect(eobi.liability).toBe(5000);
    expect(eobi.status).toBe('tracked');
    expect(sessi.liability).toBe(3000);
    expect(sessi.status).toBe('tracked');
    expect(pos.totalPayable).toBe(1500 + 5000 + 3000); // GST+WHT + payroll (income tax 0)
  });

  it('reports zero (still tracked) when payroll is enabled but no accrual exists yet', async () => {
    mockBiz({ country: 'PK', incomeTaxProvisionRate: 0.29, payrollEnabled: true });
    payrollRepo.latest.mockResolvedValue(null);
    const pos = await taxPosition.getLivePosition(BIZ, new Date(2026, 5, 10));
    expect(pos.taxes.find(t => t.taxType === 'EOBI').liability).toBe(0);
    expect(pos.taxes.find(t => t.taxType === 'EOBI').status).toBe('tracked');
  });

  it('defaults country to PK and currency to PKR when config is missing', async () => {
    mockBusiness.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) });
    const pos = await taxPosition.getLivePosition(BIZ, new Date(2026, 5, 10));
    expect(pos.country).toBe('PK');
    expect(pos.currency).toBe('PKR');
  });
});
