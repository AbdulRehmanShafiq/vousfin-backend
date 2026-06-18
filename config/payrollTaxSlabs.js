// config/payrollTaxSlabs.js — FR-08.4
// Pakistan salaried income-tax slabs, keyed by tax year (July–June).
// Progressive: tax = fixed + rate * (annualTaxable - lowerBound), where
// lowerBound is the previous bracket's `upTo`. Data only — update each budget.
'use strict';

const SALARY_TAX_SLABS = {
  // FBR salaried slabs, Tax Year 2025-26 (Finance Act 2025). Amounts in PKR/year.
  '2025-26': [
    { upTo: 600000,    fixed: 0,      rate: 0,     lowerBound: 0 },
    { upTo: 1200000,   fixed: 0,      rate: 0.01,  lowerBound: 600000 },
    { upTo: 2200000,   fixed: 6000,   rate: 0.11,  lowerBound: 1200000 },
    { upTo: 3200000,   fixed: 116000, rate: 0.23,  lowerBound: 2200000 },
    { upTo: 4100000,   fixed: 346000, rate: 0.30,  lowerBound: 3200000 },
    { upTo: Infinity,  fixed: 616000, rate: 0.35,  lowerBound: 4100000 },
  ],
};

function resolveSlabs(taxYear) {
  const slabs = SALARY_TAX_SLABS[taxYear];
  if (!slabs) {
    throw new Error(`Salary tax slabs for tax year ${taxYear} are not configured yet.`);
  }
  return slabs;
}

module.exports = { SALARY_TAX_SLABS, resolveSlabs };
