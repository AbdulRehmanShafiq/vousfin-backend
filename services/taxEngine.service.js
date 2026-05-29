/**
 * taxEngine.service.js — Phase 5.4.1
 *
 * Modular, country-aware tax calculation engine.
 *
 * Responsibilities:
 *  1. Resolve which taxes apply to a transaction (country + type)
 *  2. Calculate tax amounts (inclusive / exclusive, multi-tax)
 *  3. Produce journal line descriptors for debit/credit postings
 *  4. Lazy-create tax accounts in the CoA when first needed
 *  5. Apply WHT rules when vendor/transaction flags are set
 *  6. Apply reverse-charge rules for AE, SA, IN
 *
 * Principles:
 *  - NEVER hardcode tax logic in transaction.service.js — call this service
 *  - Backward-compatible: no tax applied when taxConfig.gstEnabled = false
 *  - Builds on existing taxCalculator.js (reuses calcFromInclusive/Exclusive)
 *  - All arithmetic rounded to 2dp to avoid floating-point drift
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  Entry points                                                            │
 * │  ─────────────                                                           │
 * │  resolveApplicableTaxes(options)  → TaxResult                           │
 * │  calculateTax(amount, taxComponent, mode)  → { net, tax, gross }        │
 * │  generateTaxJournalLines(txnType, amount, taxResult, accountMap)         │
 * │  ensureTaxAccounts(businessId, countryCode)                              │
 * │  getBusinessTaxConfig(businessId)                                        │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const { getProfile, getApplicableTaxes, getWhtSchedule } = require('../config/countryTaxProfiles');
const { calcFromInclusive, calcFromExclusive }            = require('./nlParser/utils/taxCalculator');
const logger             = require('../config/logger');

// ── Model references ─────────────────────────────────────────────────────────
// FIX (ERP Step 6): the Chart-of-Accounts model is registered as
// 'ChartOfAccount', NOT 'Account'. The previous `mongoose.model('Account')`
// threw MissingSchemaError, so ensureTaxAccounts could NEVER seed the tax
// accounts — which silently broke every downstream tax journal posting
// (transaction.service skips a tax line whose account can't be resolved).
// Requiring the model modules directly also guarantees registration.
const ChartOfAccount = require('../models/ChartOfAccount.model');
const Business       = require('../models/Business.model');

// ─────────────────────────────────────────────────────────────────────────────
//  Internal rounding helper
// ─────────────────────────────────────────────────────────────────────────────
const r2 = n => Math.round((n || 0) * 100) / 100;

// ─────────────────────────────────────────────────────────────────────────────
//  Type definitions (JSDoc only — no runtime cost)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @typedef {Object} TaxApplicationOptions
 * @property {string}   businessId        - MongoDB ObjectId string
 * @property {string}   transactionType   - TRANSACTION_TYPES value
 * @property {number}   amount            - Raw amount from form (may be gross or net)
 * @property {'inclusive'|'exclusive'} [mode='inclusive']  - Is amount tax-inclusive?
 * @property {string}   [overrideTaxType] - Force a specific tax type key
 * @property {number}   [overrideTaxRate] - Force a specific rate (beats profile default)
 * @property {boolean}  [isReverseCharge] - Flag: apply reverse-charge logic
 * @property {boolean}  [isImportedService] - Flag for RC trigger
 * @property {string}   [whtCategory]     - WHT schedule category (e.g. 'services_company')
 * @property {boolean}  [whtApply]        - Explicitly enable WHT on this transaction
 *
 * @typedef {Object} TaxLineResult
 * @property {string}  taxType
 * @property {string}  taxName
 * @property {number}  rate
 * @property {number}  taxAmount
 * @property {number}  netAmount
 * @property {number}  grossAmount
 * @property {string}  accountPayable
 * @property {string}  accountReceivable
 * @property {string}  side             - 'output' | 'input'
 * @property {boolean} isWithholding
 * @property {boolean} isReverseCharge
 *
 * @typedef {Object} TaxResult
 * @property {TaxLineResult[]} lines     - One entry per tax component applied
 * @property {number}          totalTax  - Sum of all taxAmount values
 * @property {number}          netAmount - Amount ex-all-taxes
 * @property {number}          grossAmount
 * @property {boolean}         taxApplied - False when business has tax disabled
 * @property {string}          countryCode
 */

// ─────────────────────────────────────────────────────────────────────────────
//  Core: resolveApplicableTaxes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main entry point — resolves and calculates all taxes for a transaction.
 *
 * Steps:
 *  1. Load business taxConfig
 *  2. Check if tax is enabled (gstEnabled / vatEnabled) — short-circuit if not
 *  3. Get applicable tax components from country profile
 *  4. Apply rate overrides (business custom rate > profile default)
 *  5. Calculate amounts for each component
 *  6. If WHT applicable, calculate WHT line
 *  7. If reverse charge, flip output→input lines and add RC line
 *  8. Return TaxResult
 *
 * @param {TaxApplicationOptions} options
 * @returns {Promise<TaxResult>}
 */
async function resolveApplicableTaxes(options) {
  const {
    businessId,
    transactionType,
    amount,
    mode = 'inclusive',
    overrideTaxType,
    overrideTaxRate,
    isReverseCharge = false,
    isImportedService = false,
    whtCategory,
    whtApply = false,
  } = options;

  // ── 1. Load business tax config ──────────────────────────────────────────
  const business = await Business.findById(businessId).lean();
  if (!business) {
    throw new Error(`Business ${businessId} not found`);
  }

  const taxCfg     = business.taxConfig || {};
  const country    = taxCfg.country || 'PK';
  const profile    = getProfile(country);

  // ── 2. Tax-disabled guard ────────────────────────────────────────────────
  const anyTaxEnabled = taxCfg.gstEnabled || taxCfg.vatEnabled || taxCfg.whtEnabled;
  if (!anyTaxEnabled) {
    return _emptyResult(amount, country);
  }

  // ── 3. Get applicable components ─────────────────────────────────────────
  let components;
  if (overrideTaxType) {
    const comp = profile.taxes.find(t => t.type === overrideTaxType);
    components = comp ? [comp] : [];
  } else {
    components = getApplicableTaxes(country, transactionType);
    // Filter by which taxes are actually enabled on this business
    components = components.filter(c => _isTaxComponentEnabled(c, taxCfg));
  }

  if (components.length === 0) {
    return _emptyResult(amount, country);
  }

  // ── 4. Apply rate overrides ───────────────────────────────────────────────
  const customRates = taxCfg.customRates || {};
  components = components.map(c => ({
    ...c,
    rate: overrideTaxRate
      ?? customRates[c.type]
      ?? c.rate,
  }));

  // ── 5. Calculate amounts ──────────────────────────────────────────────────
  //  Multi-tax: each component is applied to the NET amount (sequential).
  //  For most countries there is one primary tax so this is straightforward.
  const lines = [];
  let workingNet = amount; // starts as gross (inclusive) or net (exclusive)

  for (const comp of components) {
    let calc;
    if (mode === 'inclusive') {
      calc = calcFromInclusive(workingNet, comp.rate);
      workingNet = calc.netAmount; // peel each layer off the gross
    } else {
      calc = calcFromExclusive(workingNet, comp.rate);
      // exclusive: net stays same, gross grows
    }

    lines.push({
      taxType:          comp.type,
      taxName:          comp.name,
      rate:             comp.rate,
      taxAmount:        calc.taxAmount,
      netAmount:        calc.netAmount,
      grossAmount:      calc.grossAmount,
      accountPayable:   comp.accountPayable,
      accountReceivable:comp.accountReceivable,
      side:             comp.side,
      isWithholding:    false,
      isReverseCharge:  false,
    });
  }

  // ── 6. WHT line ───────────────────────────────────────────────────────────
  if (whtApply && taxCfg.whtEnabled && whtCategory) {
    const whtLine = _buildWhtLine(country, whtCategory, workingNet || amount, taxCfg);
    if (whtLine) lines.push(whtLine);
  }

  // ── 7. Reverse-charge transformation ────────────────────────────────────
  if (isReverseCharge || isImportedService) {
    const rcLines = _applyReverseCharge(lines, profile, workingNet || amount, taxCfg);
    if (rcLines.length > 0) {
      // Replace original output VAT lines with RC versions
      return _buildResult(amount, rcLines, country);
    }
  }

  return _buildResult(amount, lines, country);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Pure calculation (no DB — used by frontend preview endpoint)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate tax for a single tax component. No side effects.
 *
 * @param {number} amount
 * @param {object} taxComponent - from countryTaxProfiles taxes[]
 * @param {'inclusive'|'exclusive'} mode
 * @returns {{ netAmount: number, taxAmount: number, grossAmount: number }}
 */
function calculateTax(amount, taxComponent, mode = 'inclusive') {
  if (!amount || amount <= 0 || !taxComponent) {
    return { netAmount: r2(amount || 0), taxAmount: 0, grossAmount: r2(amount || 0) };
  }
  if (mode === 'inclusive') {
    return calcFromInclusive(amount, taxComponent.rate);
  }
  return calcFromExclusive(amount, taxComponent.rate);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Journal line generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produce journal debit/credit line descriptors for a taxed transaction.
 * These are pure descriptors — journalGenerator.service.js resolves account IDs.
 *
 * For OUTPUT tax (sales):
 *   DR  Accounts Receivable / Cash   (grossAmount)
 *   CR  Sales / Revenue              (netAmount)
 *   CR  GST Payable                  (taxAmount)
 *
 * For INPUT tax (purchases):
 *   DR  Expense / Inventory          (netAmount)
 *   DR  GST Receivable               (taxAmount)
 *   CR  Accounts Payable / Cash      (grossAmount)
 *
 * For WHT (deducted at source):
 *   DR  Expense                      (netAmount)
 *   CR  Cash / Bank                  (net - whtAmount)
 *   CR  WHT Payable                  (whtAmount)
 *
 * @param {string}        transactionType
 * @param {number}        amount         - Original amount passed to engine
 * @param {TaxResult}     taxResult      - Result from resolveApplicableTaxes
 * @param {object}        accountMap     - { debitAccountName, creditAccountName, … }
 * @returns {{ lines: Array<{account:string, debit:number, credit:number, memo:string}>, notes:string }}
 */
function generateTaxJournalLines(transactionType, amount, taxResult, accountMap = {}) {
  if (!taxResult?.taxApplied || taxResult.lines.length === 0) {
    return { lines: [], notes: '' };
  }

  const journalLines = [];
  const notes = [];

  for (const line of taxResult.lines) {
    if (line.isWithholding) {
      // WHT: vendor paid net, remainder goes to WHT Payable
      journalLines.push({
        account: line.accountPayable,
        debit: 0,
        credit: r2(line.taxAmount),
        memo: `${line.taxName} (${line.rate}%) withheld`,
      });
      notes.push(`WHT ${line.rate}% = ${line.taxAmount}`);
      continue;
    }

    if (line.isReverseCharge) {
      // Reverse charge: buyer is both payer and receiver
      journalLines.push(
        { account: line.accountReceivable || line.accountPayable, debit: r2(line.taxAmount), credit: 0, memo: `RC Input ${line.taxName}` },
        { account: line.accountPayable,                           debit: 0, credit: r2(line.taxAmount), memo: `RC Output ${line.taxName}` },
      );
      notes.push(`Reverse charge ${line.taxName} ${line.rate}% = ${line.taxAmount}`);
      continue;
    }

    if (line.side === 'output') {
      // Sales tax: CR Tax Payable
      journalLines.push({
        account: line.accountPayable,
        debit: 0,
        credit: r2(line.taxAmount),
        memo: `${line.taxName} (${line.rate}%) on sale`,
      });
    } else if (line.side === 'input') {
      // Purchase tax: DR Tax Receivable
      journalLines.push({
        account: line.accountReceivable,
        debit: r2(line.taxAmount),
        credit: 0,
        memo: `${line.taxName} (${line.rate}%) on purchase`,
      });
    } else if (line.side === 'both') {
      // India CGST+SGST on sales: treat as output
      journalLines.push({
        account: line.accountPayable,
        debit: 0,
        credit: r2(line.taxAmount),
        memo: `${line.taxName} (${line.rate}%)`,
      });
    }

    notes.push(`${line.taxType} ${line.rate}% = ${line.taxAmount}`);
  }

  return { lines: journalLines, notes: notes.join('; ') };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Account auto-seeding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure all tax-related CoA accounts exist for a business.
 * Creates missing accounts without touching existing ones.
 * Called once when a business enables tax.
 *
 * @param {string} businessId
 * @param {string} countryCode
 * @returns {Promise<{ created: number, skipped: number }>}
 */
async function ensureTaxAccounts(businessId, countryCode = 'PK') {
  const profile  = getProfile(countryCode);
  const accounts = profile.additionalAccounts || [];
  let created = 0, skipped = 0;

  for (const acc of accounts) {
    const exists = await ChartOfAccount.findOne({ businessId, accountCode: acc.accountCode });
    if (exists) { skipped++; continue; }

    await ChartOfAccount.create({
      businessId,
      accountCode:    acc.accountCode,
      accountName:    acc.accountName,
      accountType:    acc.accountType,
      accountSubtype: acc.accountSubtype,
      normalBalance:  acc.normalBalance,
      isDefault:      acc.isDefault,
      runningBalance: 0,
    });
    created++;
    logger.info(`[TaxEngine] Created tax account ${acc.accountCode} (${acc.accountName}) for business ${businessId}`);
  }

  return { created, skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Business tax config helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the effective tax config for a business.
 * Merges business.taxConfig with country profile defaults.
 *
 * @param {string} businessId
 * @returns {Promise<{ config: object, profile: object }>}
 */
async function getBusinessTaxConfig(businessId) {
  const business = await Business.findById(businessId, 'taxConfig currency').lean();
  const taxCfg   = business?.taxConfig || {};
  const country  = taxCfg.country || 'PK';
  const profile  = getProfile(country);
  return { config: taxCfg, profile };
}

/**
 * Check if a business has any tax enabled.
 * @param {string} businessId
 * @returns {Promise<boolean>}
 */
async function isTaxEnabled(businessId) {
  const business = await Business.findById(businessId, 'taxConfig').lean();
  const cfg      = business?.taxConfig || {};
  return !!(cfg.gstEnabled || cfg.vatEnabled || cfg.whtEnabled);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Reverse Charge detection (Phase 5.4.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine whether reverse charge applies for a given transaction context.
 *
 * Reverse charge triggers when:
 *  - Business is in AE / SA / IN (RC-capable countries)
 *  - Transaction is a PURCHASE type
 *  - Vendor is outside the business country (isImportedService flag)
 *  - OR explicit isReverseCharge flag set by caller
 *
 * @param {object} opts
 * @param {string}  opts.businessCountry    - e.g. 'AE', 'SA', 'IN'
 * @param {string}  opts.transactionType
 * @param {boolean} opts.isImportedService
 * @param {boolean} opts.isReverseCharge    - explicit caller flag
 * @param {string}  [opts.vendorCountry]    - vendor's country code (from vendor profile)
 * @returns {boolean}
 */
function shouldApplyReverseCharge({ businessCountry, transactionType, isImportedService, isReverseCharge, vendorCountry }) {
  // Explicit override always wins
  if (isReverseCharge === true)  return true;
  if (isReverseCharge === false) return false;

  const RC_COUNTRIES = ['AE', 'SA', 'IN', 'GB'];
  if (!RC_COUNTRIES.includes(businessCountry)) return false;

  const PURCHASE_TYPES = [
    'Cash Purchase', 'Credit Purchase', 'Inventory Purchase',
  ];
  if (!PURCHASE_TYPES.includes(transactionType)) return false;

  // Auto-trigger when vendor is from outside the business country
  if (isImportedService) return true;
  if (vendorCountry && vendorCountry !== businessCountry) return true;

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Private helpers
// ─────────────────────────────────────────────────────────────────────────────

function _emptyResult(amount, country) {
  return {
    lines:       [],
    totalTax:    0,
    netAmount:   r2(amount),
    grossAmount: r2(amount),
    taxApplied:  false,
    countryCode: country,
  };
}

function _buildResult(originalAmount, lines, country) {
  const totalTax   = r2(lines.reduce((s, l) => s + (l.taxAmount || 0), 0));
  const netAmount  = lines[0]?.netAmount ?? r2(originalAmount);
  const grossAmount = lines[0]?.grossAmount ?? r2(originalAmount);
  return {
    lines,
    totalTax,
    netAmount,
    grossAmount,
    taxApplied:  lines.length > 0,
    countryCode: country,
  };
}

function _isTaxComponentEnabled(component, taxCfg) {
  const t = component.type.toUpperCase();
  if (t.startsWith('GST') || t === 'SALES_TAX' || t.startsWith('SRB') ||
      t.startsWith('PRA') || t.startsWith('KPRA') || t.startsWith('BRA')) {
    return !!taxCfg.gstEnabled;
  }
  if (t.startsWith('VAT') || t.startsWith('CGST') || t.startsWith('SGST') ||
      t.startsWith('IGST')) {
    return !!taxCfg.vatEnabled;
  }
  if (t.startsWith('WHT') || t.startsWith('TDS')) {
    return !!taxCfg.whtEnabled;
  }
  return true; // unknown types: pass through
}

function _buildWhtLine(country, category, netAmount, taxCfg) {
  const schedule = getWhtSchedule(country, category);
  if (!schedule) return null;

  const rate  = schedule.rateNormal || 0;
  if (rate === 0) return null;

  const taxAmount = r2(netAmount * rate / 100);
  return {
    taxType:          `WHT_${category.toUpperCase()}`,
    taxName:          `WHT — ${category.replace(/_/g, ' ')} (${rate}%)`,
    rate,
    taxAmount,
    netAmount:        r2(netAmount - taxAmount),
    grossAmount:      r2(netAmount),
    accountPayable:   schedule.account,
    accountReceivable: null,
    side:             'output',
    isWithholding:    true,
    isReverseCharge:  false,
  };
}

function _applyReverseCharge(originalLines, profile, netAmount, taxCfg) {
  const rcRules = profile.reverseChargeRules || [];
  if (rcRules.length === 0) return [];

  // Use first matching RC rule
  const rule = rcRules[0];
  const rate  = (taxCfg.customRates || {})[rule.taxType] ?? rule.rate;
  const taxAmount = r2(netAmount * rate / 100);

  return [{
    taxType:          rule.taxType || 'VAT_REVERSE_CHARGE',
    taxName:          `Reverse Charge — ${rule.description || rule.taxType}`,
    rate,
    taxAmount,
    netAmount:        r2(netAmount),
    grossAmount:      r2(netAmount),   // RC: no cash price difference
    accountPayable:   originalLines[0]?.accountPayable   || 'VAT Payable',
    accountReceivable:originalLines[0]?.accountReceivable || 'VAT Receivable (Input)',
    side:             'both',
    isWithholding:    false,
    isReverseCharge:  true,
  }];
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  resolveApplicableTaxes,
  calculateTax,
  generateTaxJournalLines,
  ensureTaxAccounts,
  getBusinessTaxConfig,
  isTaxEnabled,
  shouldApplyReverseCharge,
};
