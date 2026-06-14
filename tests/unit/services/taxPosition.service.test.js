'use strict';

// Mock Business model (mongoose) and the taxReport aggregations the service reuses.
const mockBusiness = { findById: jest.fn() };
jest.mock('mongoose', () => ({ model: () => mockBusiness, Types: { ObjectId: (v) => v } }));
jest.mock('../../../services/taxReport.service', () => ({
  reconcileTaxToLedger: jest.fn(),
  getWhtSummary: jest.fn(),
}));

const taxReport   = require('../../../services/taxReport.service');
const taxPosition = require('../../../services/taxPosition.service');

const BIZ = '507f1f77bcf86cd799439060';

function mockBiz(taxConfig = { country: 'PK' }, currency = 'PKR') {
  mockBusiness.findById.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve({ taxConfig, currency }) }),
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
});

describe('taxPosition.getLivePosition', () => {
  it('computes GST liability from the GL net payable for the current month', async () => {
    const pos = await taxPosition.getLivePosition(BIZ, new Date(2026, 5, 10));
    const gst = pos.taxes.find(t => t.taxType === 'GST');
    expect(gst.liability).toBe(1200);
    expect(gst.refundable).toBe(false);
    // current-month window passed to the GL reconciliation
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

  it('leaves income-tax/payroll not_tracked in phase 1 and sums total from tracked taxes', async () => {
    const pos = await taxPosition.getLivePosition(BIZ, new Date(2026, 5, 10));
    expect(pos.taxes.find(t => t.taxType === 'INCOME_TAX').status).toBe('not_tracked');
    expect(pos.taxes.find(t => t.taxType === 'EOBI').status).toBe('not_tracked');
    expect(pos.totalPayable).toBe(1500); // 1200 GST + 300 WHT
    expect(pos.currency).toBe('PKR');
    expect(pos.country).toBe('PK');
  });

  it('defaults country to PK and currency to PKR when config is missing', async () => {
    mockBusiness.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) });
    const pos = await taxPosition.getLivePosition(BIZ, new Date(2026, 5, 10));
    expect(pos.country).toBe('PK');
    expect(pos.currency).toBe('PKR');
  });
});
