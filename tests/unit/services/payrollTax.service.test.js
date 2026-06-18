'use strict';
const tax = require('../../../services/payrollTax.service');

const YEAR = '2025-26';

describe('annualSalaryTax', () => {
  it('is zero at or below the tax-free band', () => {
    expect(tax.annualSalaryTax(600000, YEAR)).toBe(0);
    expect(tax.annualSalaryTax(500000, YEAR)).toBe(0);
  });
  it('applies the 1% band just above the threshold', () => {
    // 700,000 → 0 + 1% of (700000-600000) = 1000
    expect(tax.annualSalaryTax(700000, YEAR)).toBe(1000);
  });
  it('applies fixed + marginal rate in a middle bracket', () => {
    // 2,000,000 → 6000 + 11% of (2,000,000-1,200,000) = 6000 + 88000 = 94000
    expect(tax.annualSalaryTax(2000000, YEAR)).toBe(94000);
  });
  it('throws for an unconfigured year', () => {
    expect(() => tax.annualSalaryTax(1000000, '2099-00')).toThrow(/not configured/i);
  });
});

describe('monthlySalaryTax', () => {
  it('annualizes monthly taxable then divides by 12, rounded', () => {
    // monthly 100,000 → annual 1,200,000 → tax 6,000 → /12 = 500
    expect(tax.monthlySalaryTax(100000, YEAR)).toBe(500);
  });
});

describe('taxableAfterExemptions', () => {
  it('exempts medical allowance up to the cap % of basic', () => {
    // basic 100,000; medical 15,000; cap 10% of basic = 10,000 exempt → taxable medical 5,000
    const r = tax.taxableAfterExemptions({ gross: 130000, basic: 100000, medical: 15000, medicalCapPctOfBasic: 10 });
    expect(r).toBe(120000); // 130000 - 10000 exempt
  });
  it('exempts the whole medical allowance when under the cap', () => {
    const r = tax.taxableAfterExemptions({ gross: 120000, basic: 100000, medical: 8000, medicalCapPctOfBasic: 10 });
    expect(r).toBe(112000); // 8000 fully exempt
  });
  it('exempts nothing when cap is 0', () => {
    const r = tax.taxableAfterExemptions({ gross: 120000, basic: 100000, medical: 8000, medicalCapPctOfBasic: 0 });
    expect(r).toBe(120000);
  });
});
