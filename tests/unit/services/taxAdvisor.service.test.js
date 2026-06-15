'use strict';

// Advisor = deterministic rules over a context built from the live ledger.
// Mock every collaborator so we test context assembly + rule orchestration.
const mockBusiness = { findById: jest.fn() };
jest.mock('mongoose', () => ({ model: () => mockBusiness, Types: { ObjectId: (v) => v } }));
jest.mock('../../../services/report.service',  () => ({ getIncomeStatement: jest.fn() }));
jest.mock('../../../services/taxReport.service', () => ({ reconcileTaxToLedger: jest.fn(), getWhtSummary: jest.fn() }));
jest.mock('../../../repositories/account.repository', () => ({ findByBusiness: jest.fn() }));

const report      = require('../../../services/report.service');
const taxReport   = require('../../../services/taxReport.service');
const accountRepo = require('../../../repositories/account.repository');
const advisor     = require('../../../services/taxAdvisor.service');

const BIZ = '507f1f77bcf86cd799439060';
const ASOF = new Date(2026, 5, 14); // 14 Jun 2026 (FY started 1 Jul 2025 → 12 months elapsed)

function mockBiz(taxConfig = { country: 'PK', incomeTaxProvisionRate: 0.29 }) {
  mockBusiness.findById.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve({ taxConfig, currency: 'PKR', fiscalYearStartMonth: 7 }) }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBiz();
  report.getIncomeStatement.mockResolvedValue({
    netProfit: 1_000_000, totalRevenue: 5_000_000, depreciationAmortization: { total: 0 },
  });
  taxReport.reconcileTaxToLedger.mockResolvedValue({ glNetPayable: 1200, glInputTax: 500, glOutputTax: 1700 });
  taxReport.getWhtSummary.mockResolvedValue({ totalWht: 0, vendors: [] });
  accountRepo.findByBusiness.mockResolvedValue([]);
});

describe('taxAdvisor.buildContext', () => {
  it('assembles the context from the live ledger sources', async () => {
    accountRepo.findByBusiness.mockResolvedValue([
      { accountCode: '1220', accountName: 'Office Equipment',     accountSubtype: 'Non-current Assets', normalBalance: 'Debit',  runningBalance: 800_000 },
      { accountCode: '1250', accountName: 'Accumulated Depreciation', accountSubtype: 'Non-current Assets', normalBalance: 'Credit', runningBalance: -100_000 },
      { accountCode: '1171', accountName: 'WHT Receivable',       accountSubtype: 'Current Assets',     normalBalance: 'Debit',  runningBalance: 50_000 },
    ])
    const ctx = await advisor.buildContext(BIZ, ASOF);
    expect(ctx.provisionRate).toBe(0.29);
    expect(ctx.country).toBe('PK');
    expect(ctx.fixedAssetsGross).toBe(800_000);          // excludes accumulated depreciation
    expect(ctx.accumulatedDepreciation).toBe(100_000);
    expect(ctx.advanceTaxPaid).toBe(50_000);             // tax-receivable asset
    expect(ctx.projectedAnnualIncome).toBe(1_000_000);   // 1,000,000 YTD over 12 months → ×12/12
    expect(ctx.depreciationBookedYTD).toBe(0);
  });
});

describe('taxAdvisor.getAdvisories', () => {
  it('returns nothing when the books are already efficient', async () => {
    const out = await advisor.getAdvisories(BIZ, ASOF);
    expect(out.advisories).toEqual([]);
    expect(out.totalPotentialSavingPKR).toBe(0);
    expect(out.currency).toBe('PKR');
  });

  it('surfaces an undepreciated-assets advisory with a legal ref and PKR saving', async () => {
    accountRepo.findByBusiness.mockResolvedValue([
      { accountCode: '1220', accountName: 'Office Equipment', accountSubtype: 'Non-current Assets', normalBalance: 'Debit', runningBalance: 1_000_000 },
    ])
    const out = await advisor.getAdvisories(BIZ, ASOF);
    const a = out.advisories.find(x => x.id === 'DEPRECIATION_UNCLAIMED');
    expect(a).toBeTruthy();
    expect(a.estimatedSavingPKR).toBe(29_000);
    expect(a.legalRef).toMatch(/Income Tax Ordinance/);
    expect(a.riskLevel).toBe('safe');
    expect(a.riskWarning).toBeUndefined();               // safe items carry no warning
    expect(a.actionLink).toBe('/tax');
  });

  it('attaches a prominent risk warning to every review-level advisory', async () => {
    accountRepo.findByBusiness.mockResolvedValue([
      { accountCode: '1171', accountName: 'WHT Receivable', accountSubtype: 'Current Assets', normalBalance: 'Debit', runningBalance: 500_000 },
    ])
    const out = await advisor.getAdvisories(BIZ, ASOF);
    const a = out.advisories.find(x => x.id === 'ADVANCE_TAX_OVERPAID');
    expect(a).toBeTruthy();
    expect(a.estimatedSavingPKR).toBe(210_000);          // 500,000 − 0.29×1,000,000
    expect(a.riskLevel).toBe('review');
    expect(a.riskWarning).toBeTruthy();                  // AC: no aggressive position without a warning
  });

  it('surfaces refundable input tax', async () => {
    taxReport.reconcileTaxToLedger.mockResolvedValue({ glNetPayable: -75_000, glInputTax: 100_000, glOutputTax: 25_000 });
    const out = await advisor.getAdvisories(BIZ, ASOF);
    const a = out.advisories.find(x => x.id === 'INPUT_TAX_UNCLAIMED');
    expect(a.estimatedSavingPKR).toBe(75_000);
  });

  it('sorts advisories by estimated saving (largest first) and totals them', async () => {
    accountRepo.findByBusiness.mockResolvedValue([
      { accountCode: '1220', accountName: 'Office Equipment', accountSubtype: 'Non-current Assets', normalBalance: 'Debit', runningBalance: 1_000_000 }, // depreciation 29,000
      { accountCode: '1171', accountName: 'WHT Receivable',   accountSubtype: 'Current Assets',     normalBalance: 'Debit', runningBalance: 500_000 },   // advance tax 210,000
    ])
    const out = await advisor.getAdvisories(BIZ, ASOF);
    expect(out.advisories[0].id).toBe('ADVANCE_TAX_OVERPAID'); // 210k > 29k
    expect(out.advisories[1].id).toBe('DEPRECIATION_UNCLAIMED');
    expect(out.totalPotentialSavingPKR).toBe(239_000);
    // every advisory must carry a legal ref + a positive saving (AC)
    for (const a of out.advisories) {
      expect(a.legalRef).toBeTruthy();
      expect(a.estimatedSavingPKR).toBeGreaterThan(0);
    }
  });
});
