// services/payroll.service.js — FR-08.2/.3
'use strict';
const payrollTax = require('./payrollTax.service');

const r = (n) => Math.round(n || 0);
const sumAmt = (arr) => (arr || []).reduce((t, x) => t + r(x.amount), 0);

/**
 * Pure gross-to-net for one employee in one period.
 * @param {Object} s  resolved salary-structure version
 * @param {Object} ctx { taxYear }
 * @param {Object} variable { additions:[{label,amount}], deductions:[{label,amount}] }
 */
function computeNetPay(s, ctx, variable = {}) {
  const a = s.allowances || {};
  const allowancesTotal = r(a.houseRent) + r(a.medical) + r(a.conveyance) + r(a.special) + r(a.other);
  const additions = (variable.additions || []).map((x) => ({ label: x.label, amount: r(x.amount) }));
  const additionsTotal = sumAmt(additions);
  const gross = r(s.basic) + allowancesTotal + additionsTotal;

  const taxableIncome = payrollTax.taxableAfterExemptions({
    gross, basic: r(s.basic), medical: r(a.medical),
    medicalCapPctOfBasic: s.taxExempt?.medicalCapPctOfBasic || 0,
  });
  const incomeTax = payrollTax.monthlySalaryTax(taxableIncome, ctx.taxYear);

  const eobiEmployee = s.eobi?.enabled ? r(s.eobi.employeeAmount) : 0;
  const eobiEmployer = s.eobi?.enabled ? r(s.eobi.employerAmount) : 0;
  const pfEmployee = s.providentFund?.enabled ? r((s.basic * s.providentFund.employeePctOfBasic) / 100) : 0;
  const pfEmployer = s.providentFund?.enabled ? r((s.basic * s.providentFund.employerPctOfBasic) / 100) : 0;

  const otherDeductions = [
    ...(s.recurringDeductions || []).map((x) => ({ label: x.label, amount: r(x.amount) })),
    ...(variable.deductions || []).map((x) => ({ label: x.label, amount: r(x.amount) })),
  ];
  const otherDeductionsTotal = sumAmt(otherDeductions);

  const netPay = gross - incomeTax - eobiEmployee - pfEmployee - otherDeductionsTotal;

  return {
    basic: r(s.basic), allowancesTotal, additions, gross,
    taxableIncome, incomeTax, eobiEmployee, eobiEmployer, pfEmployee, pfEmployer,
    otherDeductions, otherDeductionsTotal, netPay,
  };
}

module.exports = { computeNetPay };
