// services/payrollTax.service.js — FR-08.4
// Salary income tax (annualize → salaried slabs → ÷12) + exempt-cap helper.
'use strict';
const { resolveSlabs } = require('../config/payrollTaxSlabs');

/** Progressive annual tax for a given annual taxable income and tax year. */
function annualSalaryTax(annualTaxable, taxYear) {
  const slabs = resolveSlabs(taxYear);
  if (annualTaxable <= 0) return 0;
  // find the bracket whose range contains annualTaxable
  const b = slabs.find((s) => annualTaxable <= s.upTo) || slabs[slabs.length - 1];
  return Math.round(b.fixed + b.rate * (annualTaxable - b.lowerBound));
}

/** Monthly withholding: annualize the month's taxable pay, tax it, divide by 12. */
function monthlySalaryTax(monthlyTaxable, taxYear) {
  return Math.round(annualSalaryTax(Math.round(monthlyTaxable * 12), taxYear) / 12);
}

/**
 * Reduce gross by exempt components. v1 rule: medical allowance is exempt up to
 * `medicalCapPctOfBasic`% of basic (a common Pakistani exemption). Conservative
 * and explicit — extend here as more exempt components are added.
 */
function taxableAfterExemptions({ gross, basic = 0, medical = 0, medicalCapPctOfBasic = 0 }) {
  const cap = Math.round((basic * (medicalCapPctOfBasic || 0)) / 100);
  const exempt = Math.min(medical, cap);
  return Math.round(gross - exempt);
}

module.exports = { annualSalaryTax, monthlySalaryTax, taxableAfterExemptions };
