// config/fbrRejectionRules.js
//
// FR-04.3 — catalog of the common reasons FBR rejects a return, run as a
// pre-filing gate so problems are caught (with a fix) before submission, not
// after. Expandable: add a rule object, no validator change needed.
//
// Each rule: { code, returnType ('*' = all), field, message, fix, severity,
//              check(ctx) -> boolean (true = violated) }
// ctx = { data (the builder output), returnType, businessNtn, unpostedCount }
//
'use strict';

const num = (v) => Number(v) || 0;
const digits = (s) => String(s || '').replace(/\D/g, '');
const sumBy = (arr, key) => (Array.isArray(arr) ? arr : []).reduce((s, x) => s + num(x[key]), 0);
// Annex must tie to the header within a rupee (rounding tolerance).
const TOL = 1;

const FBR_REJECTION_RULES = [
  {
    code: 'NTN_MISSING', returnType: '*', field: 'businessNtn', severity: 'error',
    message: 'Your business NTN/STRN is not set.',
    fix: 'Add your NTN/STRN in Settings → Tax Engine before filing.',
    check: (ctx) => !ctx.businessNtn,
  },
  {
    code: 'NTN_FORMAT', returnType: '*', field: 'businessNtn', severity: 'error',
    message: 'Your NTN/STRN format looks invalid.',
    fix: 'A Pakistan NTN is 7 digits (or a 13-digit CNIC-based STRN). Correct it in Settings → Tax Engine.',
    check: (ctx) => { const d = digits(ctx.businessNtn); return !!ctx.businessNtn && d.length !== 7 && d.length !== 13; },
  },
  {
    code: 'PERIOD_NOT_CLOSED', returnType: '*', field: 'period', severity: 'error',
    message: 'There are unposted/pending transactions in this period.',
    fix: 'Approve or clear pending transactions so the return reflects the final books.',
    check: (ctx) => num(ctx.unpostedCount) > 0,
  },
  {
    code: 'OUTPUT_LT_ANNEX', returnType: 'GST-01', field: 'outputTax', severity: 'error',
    message: 'Header output tax does not match the Annex-C sales lines.',
    fix: 'Add the missing taxable-sales invoices to Annex-C so the line total equals the header output tax.',
    check: (ctx) => Math.abs(num(ctx.data?.fields?.outputTax) - sumBy(ctx.data?.annexes?.C, 'salesTax')) > TOL,
  },
  {
    code: 'INPUT_LT_ANNEX', returnType: 'GST-01', field: 'inputTax', severity: 'error',
    message: 'Header input tax does not match the Annex-A purchase lines.',
    fix: 'Add the missing taxable-purchase invoices to Annex-A so the line total equals the header input tax.',
    check: (ctx) => Math.abs(num(ctx.data?.fields?.inputTax) - sumBy(ctx.data?.annexes?.A, 'inputTax')) > TOL,
  },
  {
    code: 'NEGATIVE_LIABILITY_NO_REFUND_FLAG', returnType: 'GST-01', field: 'netPayable', severity: 'warning',
    message: 'Net tax is negative but no refund/carry-forward election is recorded.',
    fix: 'Elect to claim a refund or carry the excess input tax forward before filing.',
    check: (ctx) => num(ctx.data?.fields?.netPayable) < 0 && ctx.data?.refundClaim !== true,
  },
  {
    code: 'ZERO_RATED_NO_EVIDENCE', returnType: 'GST-01', field: 'annexes.C', severity: 'warning',
    message: 'A zero-rated sale is missing supporting detail.',
    fix: 'Add a description/evidence to each zero-rated Annex-C line.',
    check: (ctx) => (ctx.data?.annexes?.C || []).some(l => num(l.taxRate) === 0 && !l.description),
  },
  {
    code: 'WHT_VENDOR_CNIC_MISSING', returnType: 'WHT-165', field: 'lines', severity: 'error',
    message: 'A withholding line has no vendor NTN/CNIC.',
    fix: 'Add the NTN/CNIC for every vendor in the statement (set it on the vendor record).',
    check: (ctx) => (ctx.data?.lines || []).some(l => !l.taxId),
  },
];

/** Rules applicable to a return type (its own + the universal '*' rules). */
function rulesFor(returnType) {
  return FBR_REJECTION_RULES.filter(r => r.returnType === '*' || r.returnType === returnType);
}

module.exports = { FBR_REJECTION_RULES, rulesFor };
