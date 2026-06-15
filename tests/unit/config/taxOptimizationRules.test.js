'use strict';

const { TAX_OPTIMIZATION_RULES } = require('../../../config/taxOptimizationRules');

const byId = (id) => TAX_OPTIMIZATION_RULES.find(r => r.id === id);

describe('taxOptimizationRules — catalog integrity', () => {
  it('every rule carries the required, auditable shape', () => {
    expect(TAX_OPTIMIZATION_RULES.length).toBeGreaterThanOrEqual(4);
    for (const r of TAX_OPTIMIZATION_RULES) {
      expect(typeof r.id).toBe('string');
      expect(typeof r.taxType).toBe('string');
      expect(typeof r.title).toBe('string');
      expect(r.legalRef).toBeTruthy();                 // AC: every advisory cites a legal provision
      expect(['safe', 'review']).toContain(r.riskLevel);
      expect(typeof r.detect).toBe('function');
    }
  });

  it('has unique rule ids', () => {
    const ids = TAX_OPTIMIZATION_RULES.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('DEPRECIATION_UNCLAIMED', () => {
  const rule = byId('DEPRECIATION_UNCLAIMED');
  it('fires when fixed assets exist but no depreciation is booked', () => {
    const out = rule.detect({ fixedAssetsGross: 1_000_000, depreciationBookedYTD: 0, provisionRate: 0.29 });
    expect(out.estimatedSavingPKR).toBe(29000);      // 0.29 × (0.10 × 1,000,000)
    expect(out.explanation).toMatch(/depreciation/i);
  });
  it('stays silent when depreciation is already booked', () => {
    expect(rule.detect({ fixedAssetsGross: 1_000_000, depreciationBookedYTD: 50_000, provisionRate: 0.29 })).toBeNull();
  });
  it('stays silent with no fixed assets', () => {
    expect(rule.detect({ fixedAssetsGross: 0, depreciationBookedYTD: 0, provisionRate: 0.29 })).toBeNull();
  });
});

describe('INPUT_TAX_UNCLAIMED', () => {
  const rule = byId('INPUT_TAX_UNCLAIMED');
  it('fires when input tax exceeds output (refundable)', () => {
    const out = rule.detect({ glNetPayable: -50_000 });
    expect(out.estimatedSavingPKR).toBe(50_000);
  });
  it('stays silent when GST is payable', () => {
    expect(rule.detect({ glNetPayable: 1_200 })).toBeNull();
  });
});

describe('ADVANCE_TAX_OVERPAID', () => {
  const rule = byId('ADVANCE_TAX_OVERPAID');
  it('fires when advance tax exceeds projected liability', () => {
    const out = rule.detect({ advanceTaxPaid: 500_000, provisionRate: 0.29, projectedAnnualIncome: 1_000_000 });
    expect(out.estimatedSavingPKR).toBe(210_000);    // 500,000 − (0.29 × 1,000,000)
  });
  it('stays silent when advance tax is below projected liability', () => {
    expect(rule.detect({ advanceTaxPaid: 100_000, provisionRate: 0.29, projectedAnnualIncome: 1_000_000 })).toBeNull();
  });
  it('stays silent with no advance tax', () => {
    expect(rule.detect({ advanceTaxPaid: 0, provisionRate: 0.29, projectedAnnualIncome: 1_000_000 })).toBeNull();
  });
});

describe('WHT_SECTION_OPTIMISATION', () => {
  const rule = byId('WHT_SECTION_OPTIMISATION');
  it('flags an upper-bound saving on material withholding', () => {
    const out = rule.detect({ whtWithheldYTD: 100_000 });
    expect(out.estimatedSavingPKR).toBe(50_000);     // up to half (filer vs non-filer)
    expect(rule.riskLevel).toBe('review');
  });
  it('stays silent on trivial withholding', () => {
    expect(rule.detect({ whtWithheldYTD: 500 })).toBeNull();
  });
});
