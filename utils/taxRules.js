/**
 * Tax Rule Registry — Phase 3.5 Step 4
 *
 * Maps (country, transactionType) pairs to applicable tax rules.
 * Rules define: default tax type, rate, whether it applies to the
 * sale side or purchase side, and whether it should be auto-applied.
 *
 * The NLP parser and transaction form use this for suggestion/validation;
 * the actual amounts are always user-confirmed before saving.
 */

'use strict';

const { TRANSACTION_TYPES } = require('../config/constants');

/**
 * @typedef {Object} TaxRule
 * @property {string}  taxType   - Canonical tax type key
 * @property {number}  rate      - Default rate (%)
 * @property {'output'|'input'} side - output = collected from customer, input = paid to vendor
 * @property {boolean} autoApply - Suggest this tax automatically
 * @property {string}  account   - Account name to debit/credit
 */

/** @type {Record<string, Record<string, TaxRule[]>>} */
const TAX_RULES = Object.freeze({
  PK: {  // Pakistan
    [TRANSACTION_TYPES.CASH_SALE]:        [{ taxType: 'GST',  rate: 17,  side: 'output', autoApply: false, account: 'GST Payable' }],
    [TRANSACTION_TYPES.CREDIT_SALE]:      [{ taxType: 'GST',  rate: 17,  side: 'output', autoApply: false, account: 'GST Payable' }],
    [TRANSACTION_TYPES.INVENTORY_SALE]:   [{ taxType: 'GST',  rate: 17,  side: 'output', autoApply: false, account: 'GST Payable' }],
    [TRANSACTION_TYPES.CASH_PURCHASE]:    [{ taxType: 'GST',  rate: 17,  side: 'input',  autoApply: false, account: 'GST Receivable' }],
    [TRANSACTION_TYPES.CREDIT_PURCHASE]:  [{ taxType: 'GST',  rate: 17,  side: 'input',  autoApply: false, account: 'GST Receivable' }],
    [TRANSACTION_TYPES.SALARY]:           [{ taxType: 'WHT',  rate: 0,   side: 'output', autoApply: false, account: 'WHT Payable' }],
    [TRANSACTION_TYPES.GST_COLLECTION]:   [{ taxType: 'GST',  rate: 17,  side: 'output', autoApply: true,  account: 'GST Payable' }],
    [TRANSACTION_TYPES.GST_PAYMENT]:      [{ taxType: 'GST',  rate: 17,  side: 'input',  autoApply: true,  account: 'GST Payable' }],
    [TRANSACTION_TYPES.WHT_PAYMENT]:      [{ taxType: 'WHT',  rate: 10,  side: 'input',  autoApply: true,  account: 'WHT Payable' }],
  },
  US: {
    [TRANSACTION_TYPES.CASH_SALE]:       [{ taxType: 'SALES_TAX', rate: 8.5, side: 'output', autoApply: false, account: 'Sales Tax Payable' }],
    [TRANSACTION_TYPES.CREDIT_SALE]:     [{ taxType: 'SALES_TAX', rate: 8.5, side: 'output', autoApply: false, account: 'Sales Tax Payable' }],
  },
  GB: {
    [TRANSACTION_TYPES.CASH_SALE]:       [{ taxType: 'VAT', rate: 20, side: 'output', autoApply: false, account: 'VAT Payable' }],
    [TRANSACTION_TYPES.CREDIT_SALE]:     [{ taxType: 'VAT', rate: 20, side: 'output', autoApply: false, account: 'VAT Payable' }],
    [TRANSACTION_TYPES.CASH_PURCHASE]:   [{ taxType: 'VAT', rate: 20, side: 'input',  autoApply: false, account: 'VAT Receivable' }],
    [TRANSACTION_TYPES.CREDIT_PURCHASE]: [{ taxType: 'VAT', rate: 20, side: 'input',  autoApply: false, account: 'VAT Receivable' }],
  },
  AE: {  // UAE
    [TRANSACTION_TYPES.CASH_SALE]:       [{ taxType: 'VAT', rate: 5, side: 'output', autoApply: false, account: 'VAT Payable' }],
    [TRANSACTION_TYPES.CREDIT_SALE]:     [{ taxType: 'VAT', rate: 5, side: 'output', autoApply: false, account: 'VAT Payable' }],
    [TRANSACTION_TYPES.CASH_PURCHASE]:   [{ taxType: 'VAT', rate: 5, side: 'input',  autoApply: false, account: 'VAT Receivable' }],
    [TRANSACTION_TYPES.CREDIT_PURCHASE]: [{ taxType: 'VAT', rate: 5, side: 'input',  autoApply: false, account: 'VAT Receivable' }],
  },
});

/**
 * Get applicable tax rules for a given country + transaction type.
 * Falls back to PK (Pakistan) rules when country is not mapped.
 * Returns an empty array when no tax applies.
 *
 * @param {string} country        - ISO 3166-1 alpha-2 code (e.g., 'PK', 'US', 'GB')
 * @param {string} transactionType - TRANSACTION_TYPES value
 * @returns {TaxRule[]}
 */
function getTaxRules(country = 'PK', transactionType) {
  const countryRules = TAX_RULES[country] || TAX_RULES.PK;
  return countryRules[transactionType] || [];
}

/**
 * Get the primary (first auto-apply) tax rule for a given context.
 * Returns null when none found.
 *
 * @param {string} country
 * @param {string} transactionType
 * @returns {TaxRule|null}
 */
function getPrimaryTaxRule(country, transactionType) {
  const rules = getTaxRules(country, transactionType);
  return rules.find(r => r.autoApply) || rules[0] || null;
}

/**
 * Validate a taxAmount/taxRate combination against the applicable rule.
 * Returns warnings as string[]. Empty array = no issues.
 *
 * @param {string} country
 * @param {string} transactionType
 * @param {number} amount
 * @param {number} taxAmount
 * @param {number} taxRate
 * @returns {string[]} warnings
 */
function validateTax(country, transactionType, amount, taxAmount, taxRate) {
  const warnings = [];
  const rules = getTaxRules(country, transactionType);
  if (!rules.length) return warnings;

  const primaryRule = rules[0];
  const expectedRate = taxRate || primaryRule.rate;
  if (expectedRate > 0 && amount > 0) {
    const expectedTax = Math.round(amount * expectedRate / 100 * 100) / 100;
    const actualTax   = taxAmount || 0;
    const deviation   = Math.abs(actualTax - expectedTax) / expectedTax;
    if (actualTax > 0 && deviation > 0.05) {
      warnings.push(`Tax amount (${actualTax}) deviates significantly from expected ${expectedRate}% = ${expectedTax}`);
    }
  }
  return warnings;
}

module.exports = { TAX_RULES, getTaxRules, getPrimaryTaxRule, validateTax };
