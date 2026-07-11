// utils/journalGuardrails.js
//
// Structural type-safety net for AI-suggested journals (fail-closed at the
// auto-post gate): a purchase can never debit Revenue, a sale can never credit
// an Expense — no matter how confident the model was. Violation messages are
// plain language because they surface in the review banner.
'use strict';

const PURCHASE_LIKE = new Set([
  'Expense', 'Cash Purchase', 'Credit Purchase', 'Inventory Purchase',
  'Asset Purchase', 'Prepaid Expense',
]);
const SALE_LIKE = new Set(['Income', 'Cash Sale', 'Credit Sale', 'Inventory Sale']);

const DEBIT_OK_PURCHASE  = new Set(['Asset', 'Expense']);
const CREDIT_OK_PURCHASE = new Set(['Asset', 'Liability']);

/**
 * @param {{transactionType?:string, debitAccountType?:string, creditAccountType?:string}} p
 * @returns {{ ok: boolean, violations: string[] }}
 */
function checkJournalShape({ transactionType, debitAccountType, creditAccountType } = {}) {
  const violations = [];
  if (!transactionType || !debitAccountType || !creditAccountType) {
    return { ok: true, violations };
  }
  if (PURCHASE_LIKE.has(transactionType)) {
    if (!DEBIT_OK_PURCHASE.has(debitAccountType)) {
      violations.push(`This looks like a purchase, but the money is going into a ${debitAccountType} account — it should go to what you bought (an asset, stock, or an expense).`);
    }
    if (!CREDIT_OK_PURCHASE.has(creditAccountType)) {
      violations.push(`This looks like a purchase, but it is being paid from a ${creditAccountType} account — it should come from cash, bank, or an amount you owe.`);
    }
  } else if (SALE_LIKE.has(transactionType)) {
    if (debitAccountType !== 'Asset') {
      violations.push(`This looks like a sale, but the money received is landing in a ${debitAccountType} account — it should land in cash, bank, or receivables.`);
    }
    if (creditAccountType !== 'Revenue') {
      violations.push(`This looks like a sale, but it is being recorded against a ${creditAccountType} account instead of an income account.`);
    }
  }
  return { ok: violations.length === 0, violations };
}

module.exports = { checkJournalShape, PURCHASE_LIKE, SALE_LIKE };
