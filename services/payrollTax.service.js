// services/payrollTax.service.js — FR-08.4
// Salary income tax (annualize → salaried slabs → ÷12) + exempt-cap helper.
'use strict';
const { resolveSlabs } = require('../config/payrollTaxSlabs');
const PayrollRun = require('../models/PayrollRun.model');
const { ApiError } = require('../utils/ApiError');

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

const TAX_YEAR_MONTHS = (taxYear) => {
  const start = Number(taxYear.split('-')[0]);     // e.g. 2025 → Jul-2025 .. Jun-2026
  const months = [];
  for (let i = 0; i < 12; i++) {
    const m = ((6 + i) % 12) + 1;                  // 7..12,1..6
    const y = i < 6 ? start : start + 1;
    months.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return months;
};

async function generateSalaryCertificate(businessId, employeeId, taxYear) {
  const periods = TAX_YEAR_MONTHS(taxYear);
  const runs = await PayrollRun.find({
    businessId, period: { $in: periods }, status: { $in: ['posted', 'paid'] },
  }).lean();

  const months = [];
  const totals = { gross: 0, taxableIncome: 0, taxWithheld: 0 };
  let employeeName = null;
  for (const run of runs) {
    const line = (run.lines || []).find((l) => String(l.employeeId) === String(employeeId));
    if (!line) continue;
    employeeName = line.employeeName;
    months.push({ period: run.period, gross: line.gross, taxableIncome: line.taxableIncome, taxWithheld: line.incomeTax });
    totals.gross += line.gross; totals.taxableIncome += line.taxableIncome; totals.taxWithheld += line.incomeTax;
  }
  if (!months.length) throw new ApiError(404, `No payroll found for this employee in ${taxYear}.`);
  months.sort((a, b) => a.period.localeCompare(b.period));
  return { businessId, employeeId, employeeName, taxYear, months, totals };
}

module.exports = { annualSalaryTax, monthlySalaryTax, taxableAfterExemptions, generateSalaryCertificate };
