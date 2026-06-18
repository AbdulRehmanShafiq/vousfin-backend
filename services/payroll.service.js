// services/payroll.service.js — FR-08.2/.3
'use strict';
const payrollTax = require('./payrollTax.service');
const { ApiError } = require('../utils/ApiError');
const { PAYROLL_RUN_STATUS } = require('../config/constants');
const Employee = require('../models/Employee.model');
const PayrollRun = require('../models/PayrollRun.model');
const employeeRepo = require('../repositories/employee.repository');
const runRepo = require('../repositories/payrollRun.repository');
const accountRepo = require('../repositories/account.repository');
const txService = require('./transaction.service');

const PAY = { WAGES_EXP: '6180', EOBI_EXP: '6192', PF_EXP: '6194',
  WAGES_PAYABLE: '2140', SALARY_TAX_PAYABLE: '2141', EOBI_PAYABLE: '2142',
  PF_PAYABLE: '2143', OTHER_PAYABLE: '2148' };

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

/** July–June Pakistani tax year string for a 'YYYY-MM' period, e.g. 2026-06 → '2025-26'. */
function taxYearFor(period) {
  const [y, m] = period.split('-').map(Number);
  const startYear = m >= 7 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

function rollUp(lines) {
  const t = { gross: 0, incomeTax: 0, eobiEmployee: 0, eobiEmployer: 0, pfEmployee: 0, pfEmployer: 0, otherDeductions: 0, netPay: 0 };
  for (const l of lines) {
    t.gross += l.gross; t.incomeTax += l.incomeTax;
    t.eobiEmployee += l.eobiEmployee; t.eobiEmployer += l.eobiEmployer;
    t.pfEmployee += l.pfEmployee; t.pfEmployer += l.pfEmployer;
    t.otherDeductions += l.otherDeductionsTotal; t.netPay += l.netPay;
  }
  return t;
}

async function processRun(businessId, period, { employeeIds = null, adjustments = {} } = {}, actor) {
  const existing = await runRepo.findActiveByPeriod(businessId, period);
  if (existing && [PAYROLL_RUN_STATUS.POSTED, PAYROLL_RUN_STATUS.PAID].includes(existing.status)) {
    throw new ApiError(409, `Payroll for ${period} is already posted. Reverse it before reprocessing.`);
  }

  const taxYear = taxYearFor(period);
  const asOf = new Date(`${period}-28T00:00:00Z`); // any day in-month resolves the in-force structure
  let employees = await employeeRepo.findActive(businessId);
  if (employeeIds) employees = employees.filter((e) => employeeIds.includes(String(e._id)));

  const lines = [];
  for (const emp of employees) {
    const structure = Employee.resolveStructure(emp, asOf);
    if (!structure) continue; // not yet effective this period
    const variable = adjustments[String(emp._id)] || {};
    const base = computeNetPay(structure, { taxYear }, variable);
    lines.push({ employeeId: emp._id, employeeCode: emp.code, employeeName: emp.fullName, costCenterId: emp.department || null, ...base });
  }

  const doc = {
    businessId, period, taxYear, status: PAYROLL_RUN_STATUS.PROCESSED,
    lines, totals: rollUp(lines), processedBy: actor?.id || null, processedAt: new Date(),
  };

  if (existing) { Object.assign(existing, doc); return existing.save(); }
  return runRepo.create(doc);
}

async function getRun(businessId, id) {
  const run = await runRepo.findOwned(businessId, id);
  if (!run) throw new ApiError(404, 'Payroll run not found.');
  return run;
}

async function listRuns(businessId) { return runRepo.listByBusiness(businessId); }

/** Group a run's lines by costCenterId and subtotal each deduction bucket. */
function groupByCostCentre(lines) {
  const groups = new Map();
  for (const l of lines) {
    const key = l.costCenterId ? String(l.costCenterId) : '';
    const g = groups.get(key) || { costCenterId: l.costCenterId || null,
      netPay: 0, incomeTax: 0, eobiEmployee: 0, eobiEmployer: 0, pfEmployee: 0, pfEmployer: 0, otherDeductions: 0 };
    g.netPay += l.netPay; g.incomeTax += l.incomeTax;
    g.eobiEmployee += l.eobiEmployee; g.eobiEmployer += l.eobiEmployer;
    g.pfEmployee += l.pfEmployee; g.pfEmployer += l.pfEmployer;
    g.otherDeductions += l.otherDeductionsTotal;
    groups.set(key, g);
  }
  return [...groups.values()];
}

async function postToGL(businessId, runId, actor, ipAddress = null) {
  const run = await runRepo.findOwned(businessId, runId);
  if (!run) throw new ApiError(404, 'Payroll run not found.');
  if (!PayrollRun.canTransition(run.status, PAYROLL_RUN_STATUS.POSTED)) {
    throw new ApiError(409, `A ${run.status} payroll run cannot be posted.`);
  }

  // resolve account ids once
  const ids = {};
  for (const code of Object.values(PAY)) ids[code] = (await accountRepo.findByCode(businessId, code))?._id;

  const transactionDate = new Date(`${run.period}-28T00:00:00Z`);
  const groups = groupByCostCentre(run.lines);
  const postedIds = [];
  let seq = 0;

  const post = async (debitCode, creditCode, amount, costCenterId, note) => {
    if (!amount || amount <= 0) return;
    const je = await txService.createTransaction({
      businessId, transactionDate, amount,
      description: `Payroll ${run.period} — ${note}`,
      transactionType: 'Salary', inputMethod: 'batch', transactionSource: 'system_generated',
      debitAccountId: ids[debitCode], creditAccountId: ids[creditCode],
      costCenterId: costCenterId || undefined,
      metadata: { idempotencyKey: `pr:${run._id}:${++seq}` },
    }, actor?.id, ipAddress);
    postedIds.push(je._id);
  };

  for (const g of groups) {
    const cc = g.costCenterId;
    await post(PAY.WAGES_EXP, PAY.WAGES_PAYABLE,       g.netPay,          cc, 'net pay');
    await post(PAY.WAGES_EXP, PAY.SALARY_TAX_PAYABLE,  g.incomeTax,       cc, 'income tax withheld');
    await post(PAY.WAGES_EXP, PAY.EOBI_PAYABLE,        g.eobiEmployee,    cc, 'EOBI (employee)');
    await post(PAY.WAGES_EXP, PAY.PF_PAYABLE,          g.pfEmployee,      cc, 'provident fund (employee)');
    await post(PAY.WAGES_EXP, PAY.OTHER_PAYABLE,       g.otherDeductions, cc, 'other deductions');
    await post(PAY.EOBI_EXP,  PAY.EOBI_PAYABLE,        g.eobiEmployer,    cc, 'EOBI (employer)');
    await post(PAY.PF_EXP,    PAY.PF_PAYABLE,          g.pfEmployer,      cc, 'provident fund (employer)');
  }

  run.status = PAYROLL_RUN_STATUS.POSTED;
  run.postedJournalEntryIds = postedIds;
  run.postedBy = actor?.id || null;
  run.postedAt = new Date();
  return run.save();
}

async function markPaid(businessId, runId, bankAccountId, actor, ipAddress = null) {
  const run = await runRepo.findOwned(businessId, runId);
  if (!run) throw new ApiError(404, 'Payroll run not found.');
  if (!PayrollRun.canTransition(run.status, PAYROLL_RUN_STATUS.PAID)) {
    throw new ApiError(409, `A ${run.status} payroll run cannot be paid.`);
  }
  const wagesPayable = (await accountRepo.findByCode(businessId, PAY.WAGES_PAYABLE))?._id;
  await txService.createTransaction({
    businessId, transactionDate: new Date(), amount: run.totals.netPay,
    description: `Payroll ${run.period} — net pay disbursement`,
    transactionType: 'Salary', inputMethod: 'batch', transactionSource: 'system_generated',
    debitAccountId: wagesPayable, creditAccountId: bankAccountId,
    metadata: { idempotencyKey: `pr:${run._id}:pay` },
  }, actor?.id, ipAddress);
  run.status = PAYROLL_RUN_STATUS.PAID; run.bankAccountId = bankAccountId; run.paidAt = new Date();
  return run.save();
}

async function reverseRun(businessId, runId, actor, ipAddress = null) {
  const run = await runRepo.findOwned(businessId, runId);
  if (!run) throw new ApiError(404, 'Payroll run not found.');
  if (!PayrollRun.canTransition(run.status, PAYROLL_RUN_STATUS.REVERSED)) {
    throw new ApiError(409, `A ${run.status} payroll run cannot be reversed.`);
  }
  const reversalIds = [];
  for (const jeId of run.postedJournalEntryIds) {
    const rev = await txService.reverseTransaction(jeId, businessId,
      { reversalDate: new Date(), reason: `Reversal of payroll ${run.period}` }, actor?.id, ipAddress);
    reversalIds.push(rev._id);
  }
  run.status = PAYROLL_RUN_STATUS.REVERSED; run.reversalJournalEntryIds = reversalIds;
  return run.save();
}

module.exports = { computeNetPay, processRun, getRun, listRuns, taxYearFor, postToGL, markPaid, reverseRun };
