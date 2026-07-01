/**
 * tests/unit/services/taxEngine.service.test.js
 *
 * ERP Integration Refactor — Step 6 (Tax engine integration).
 * Locks in the critical fix: ensureTaxAccounts now seeds onto the ChartOfAccount
 * model (the previous mongoose.model('Account') threw MissingSchemaError, so tax
 * accounts were never created and every downstream tax journal line was skipped).
 * Also covers the pure inclusive/exclusive calculation that powers the live
 * preview, and the tax-disabled short-circuit.
 */
'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../models/ChartOfAccount.model', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../../../models/Business.model', () => ({ findById: jest.fn() }));
jest.mock('../../../config/countryTaxProfiles', () => ({
  getProfile: jest.fn(),
  getApplicableTaxes: jest.fn(() => []),
  getWhtSchedule: jest.fn(),
}));

const taxEngine      = require('../../../services/taxEngine.service');
const ChartOfAccount = require('../../../models/ChartOfAccount.model');
const Business       = require('../../../models/Business.model');
const { getProfile } = require('../../../config/countryTaxProfiles');

beforeEach(() => jest.clearAllMocks());

// ── ensureTaxAccounts (the Step 6 fix) ───────────────────────────────────────
describe('taxEngine.ensureTaxAccounts()', () => {
  beforeEach(() => {
    getProfile.mockReturnValue({
      additionalAccounts: [
        { accountCode: '1170', accountName: 'GST Receivable', accountType: 'Asset',     accountSubtype: 'Current Assets',      normalBalance: 'Debit',  isDefault: false },
        { accountCode: '2121', accountName: 'SRB Payable',    accountType: 'Liability', accountSubtype: 'Current Liabilities', normalBalance: 'Credit', isDefault: false },
      ],
    });
  });

  it('seeds missing tax accounts onto the ChartOfAccount model', async () => {
    ChartOfAccount.findOne.mockResolvedValue(null);   // none exist yet
    ChartOfAccount.create.mockResolvedValue({});

    const res = await taxEngine.ensureTaxAccounts('biz1', 'PK');

    expect(res).toEqual({ created: 2, skipped: 0 });
    expect(ChartOfAccount.create).toHaveBeenCalledTimes(2);
    expect(ChartOfAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: 'biz1', accountCode: '1170', runningBalance: 0 })
    );
  });

  it('flags newly-created tax accounts as isControlAccount:true (only the tax engine posts to them)', async () => {
    ChartOfAccount.findOne.mockResolvedValue(null);
    ChartOfAccount.create.mockResolvedValue({});

    await taxEngine.ensureTaxAccounts('biz1', 'PK');

    expect(ChartOfAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({ accountCode: '1170', isControlAccount: true })
    );
    expect(ChartOfAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({ accountCode: '2121', isControlAccount: true })
    );
  });

  it('skips accounts that already exist (idempotent)', async () => {
    ChartOfAccount.findOne.mockResolvedValue({ _id: 'existing' });

    const res = await taxEngine.ensureTaxAccounts('biz1', 'PK');

    expect(res).toEqual({ created: 0, skipped: 2 });
    expect(ChartOfAccount.create).not.toHaveBeenCalled();
  });
});

// ── calculateTax — the pure math behind the live preview ─────────────────────
describe('taxEngine.calculateTax()', () => {
  it('extracts tax from a tax-INCLUSIVE amount', () => {
    const r = taxEngine.calculateTax(1170, { rate: 17 }, 'inclusive');
    expect(r.netAmount).toBeCloseTo(1000, 1);
    expect(r.taxAmount).toBeCloseTo(170, 1);
    expect(r.grossAmount).toBeCloseTo(1170, 1);
  });

  it('adds tax onto a tax-EXCLUSIVE amount', () => {
    const r = taxEngine.calculateTax(1000, { rate: 17 }, 'exclusive');
    expect(r.netAmount).toBeCloseTo(1000, 1);
    expect(r.taxAmount).toBeCloseTo(170, 1);
    expect(r.grossAmount).toBeCloseTo(1170, 1);
  });

  it('returns a zero-tax shape for a non-positive amount', () => {
    const r = taxEngine.calculateTax(0, { rate: 17 }, 'inclusive');
    expect(r.taxAmount).toBe(0);
  });
});

// ── resolveApplicableTaxes — tax-disabled short-circuit ──────────────────────
describe('taxEngine.resolveApplicableTaxes()', () => {
  it('returns taxApplied=false when the business has no tax enabled', async () => {
    Business.findById.mockReturnValue({
      lean: () => Promise.resolve({ taxConfig: { gstEnabled: false, vatEnabled: false, whtEnabled: false } }),
    });

    const res = await taxEngine.resolveApplicableTaxes({
      businessId: 'biz1', transactionType: 'Cash Sale', amount: 1000, mode: 'inclusive',
    });

    expect(res.taxApplied).toBe(false);
    expect(res.totalTax).toBe(0);
    expect(res.netAmount).toBe(1000);
  });
});
