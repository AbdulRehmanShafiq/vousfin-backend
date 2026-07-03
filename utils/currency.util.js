/**
 * utils/currency.util.js — audit 2026-07-02 F2 (residual).
 *
 * ONE conversion rule for document-first posting: the ledger, running balances,
 * party balances and open items are ALWAYS in the base (reporting) currency;
 * documents keep their foreign face amounts for display. Every service that
 * posts a document's money to the GL converts through here at the document's
 * BOOKING rate (IAS 21 — the carrying value), so no caller can leak foreign
 * units into a base-currency ledger again.
 */
'use strict';

/**
 * Convert a document-currency amount to base currency at the given rate,
 * rounded to cents. A missing/zero rate means base currency (rate 1).
 *
 * @param {number} amount        document-currency amount
 * @param {number} [exchangeRate] document booking rate (units of base per unit of doc currency)
 * @returns {number}
 */
function toBaseAmount(amount, exchangeRate) {
  const rate = Number(exchangeRate) > 0 ? Number(exchangeRate) : 1;
  return Math.round((Number(amount) || 0) * rate * 100) / 100;
}

module.exports = { toBaseAmount };
