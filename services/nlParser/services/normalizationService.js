/**
 * @module normalizationService
 * @description Normalizes raw AI extraction output into standardized values.
 *
 * BUG FIXES (Phase 2):
 *  1. normalizeSubcategory() was a dead no-op — returned raw value regardless of validity.
 *     Fixed: unknowns return null, triggering fallback to 'miscellaneous'.
 *  2. sourceAccount confidence penalty fired for non-cash transactions (depreciation,
 *     owner drawings, financed purchases) that never have a source account by design.
 *     Fixed: penalty only applies when cashFlowDirection is 'outflow' or 'inflow'.
 *  3. Added normalization for new fields: debitAccount, creditAccount from Gemini.
 */

const { normalizeCurrency } = require('../utils/currencyNormalizer');
const { parseDate } = require('../utils/dateParser');
const { VALID_TRANSACTION_TYPES, CASH_FLOW_MAP } = require('../constants/transactionTypes');
const { ALL_SUBCATEGORIES } = require('../constants/subcategories');
const { SOURCE_ACCOUNT_ALIASES } = require('../utils/accountMappings');
const { resolveTaxType } = require('../utils/taxCalculator');
const { enrichWithTaxIntelligence } = require('../utils/taxIntelligence'); // Phase 5.4.7

/**
 * Normalize the raw AI-extracted data into clean, standardized values.
 * @param {object} rawExtraction - Raw data from Gemini API response.
 * @param {object} [opts] - Optional context
 * @param {string} [opts.rawText]     - Original user text for NLP tax detection
 * @param {string} [opts.countryCode] - Business country code (Phase 5.4.7)
 * @returns {{ normalized: object, confidence: object }}
 */
function normalizeExtraction(rawExtraction, opts = {}) {
  const transactionType = normalizeTransactionType(rawExtraction.transactionType);

  const normalized = {
    intent:                normalizeString(rawExtraction.intent) || 'unknown',
    transactionType,
    subcategory:           normalizeSubcategory(rawExtraction.subcategory),
    amount:                normalizeAmount(rawExtraction.amount),
    currency:              normalizeCurrency(rawExtraction.currency),
    date:                  null,
    description:           normalizeString(rawExtraction.description) || '',
    counterpartyName:      normalizeString(rawExtraction.counterpartyName) || null,
    paymentMethod:         normalizePaymentMethod(rawExtraction.paymentMethod),
    sourceAccount:         normalizeSourceAccount(rawExtraction.sourceAccount),
    // Phase 1: explicit debit/credit account names from Gemini
    debitAccount:          normalizeString(rawExtraction.debitAccount)  || null,
    creditAccount:         normalizeString(rawExtraction.creditAccount) || null,
    cashFlowDirection:     'non_cash',
    invoiceReference:      normalizeString(rawExtraction.invoiceReference) || null,
    notes:                 normalizeString(rawExtraction.notes) || null,
    // Tax fields — used by payroll and GST journal generators
    taxAmount:             normalizeAmount(rawExtraction.taxAmount || rawExtraction.tax_amount),
    taxRate:               normalizePositiveFloat(rawExtraction.taxRate || rawExtraction.tax_rate),
    // Installment metadata — preserved exactly as Gemini provides
    isInstallment:         rawExtraction.isInstallment === true || rawExtraction.isInstallment === 'true',
    totalInstallmentAmount:normalizeAmount(rawExtraction.totalInstallmentAmount),
    installmentPeriodMonths: normalizePositiveInt(rawExtraction.installmentPeriodMonths),
    // Down payment + interest rate — newly extracted by Gemini (Phase G)
    downPayment:           normalizeAmount(rawExtraction.downPayment),
    interestRate:          normalizePositiveFloat(rawExtraction.interestRate),
    // First payment date — when AI extracts a starting date from phrases like
    //   "first payment due January 15" or "starting next month"
    firstPaymentDate:      parseDate(rawExtraction.firstPaymentDate)?.date || null,
    // Interest method — defaults to reducing_balance; AI sets 'flat' for "simple interest" phrasing
    interestMethod:        (rawExtraction.interestMethod === 'flat') ? 'flat' : 'reducing_balance',
    // Phase 3: cost of goods for inventory_sale — enables GAAP COGS double-entry
    costAmount:            normalizeAmount(rawExtraction.costAmount || rawExtraction.cost_amount),

    // Phase 3 Step 4 — Tax + Liability + Inventory fields
    // isTaxExclusive: true when user says "plus GST", "excluding tax", "+ 17% GST"
    isTaxExclusive:        rawExtraction.isTaxExclusive === true || rawExtraction.isTaxExclusive === 'true',
    // isTaxInclusive: true when user says "including GST", "inc. tax", "with GST"
    isTaxInclusive:        rawExtraction.isTaxInclusive === true || rawExtraction.isTaxInclusive === 'true',
    // taxType: 'GST', 'SRB', 'WHT', 'VAT', 'SALES_TAX', etc.
    taxType:               normalizeTaxType(rawExtraction.taxType || rawExtraction.tax_type),
    // adjustmentType: 'write_down' (default) | 'write_up' — for inventory_adjustment
    adjustmentType:        normalizeAdjustmentType(rawExtraction.adjustmentType || rawExtraction.adjustment_type),
    // eobi: EOBI contribution amount (extracted from payroll entries)
    eobi:                  normalizeAmount(rawExtraction.eobi || rawExtraction.eobiAmount),
    // grossAmount: the total inclusive-of-tax amount (when Gemini extracts it separately)
    grossAmount:           normalizeAmount(rawExtraction.grossAmount || rawExtraction.gross_amount),
    // netAmount: the amount before tax (when Gemini extracts it separately)
    netAmount:             normalizeAmount(rawExtraction.netAmount || rawExtraction.net_amount),
  };

  // Normalize date
  const dateResult = parseDate(rawExtraction.date);
  normalized.date = dateResult.date;

  // Derive cash flow direction from transaction type
  if (normalized.transactionType && CASH_FLOW_MAP[normalized.transactionType]) {
    normalized.cashFlowDirection = CASH_FLOW_MAP[normalized.transactionType];
  }

  // If Gemini flagged isInstallment but the transactionType isn't the financed type,
  // upgrade the type so the journal generator uses the correct template.
  if (
    normalized.isInstallment &&
    normalized.transactionType === 'asset_purchase' &&
    !normalized.sourceAccount  // no cash payment source = truly financed
  ) {
    normalized.transactionType = 'financed_asset_purchase';
    normalized.cashFlowDirection = 'non_cash';
  }

  // Build confidence from AI scores + normalization adjustments
  const confidence = normalizeConfidenceScores(rawExtraction.confidence, normalized, dateResult);

  // Phase 5.4.7 — Enrich with country-profile-aware tax intelligence
  // Only fires when country is provided; completely non-invasive if country is absent
  if (opts.countryCode) {
    enrichWithTaxIntelligence(normalized, opts.rawText || '', opts.countryCode);
  }

  return { normalized, confidence };
}

/**
 * Normalize transaction type to valid enum value.
 */
function normalizeTransactionType(raw) {
  if (!raw) return null;
  const cleaned = raw.toString().toLowerCase().trim().replace(/[\s-]+/g, '_');
  return VALID_TRANSACTION_TYPES.has(cleaned) ? cleaned : null;
}

/**
 * Normalize subcategory value.
 *
 * BUG FIX: The previous implementation returned the raw value for both valid AND
 * invalid subcategories, making the validation a no-op.
 *
 *   BEFORE (broken): return ALL_SUBCATEGORIES.has(cleaned) ? cleaned : cleaned;
 *   AFTER  (fixed):  return ALL_SUBCATEGORIES.has(cleaned) ? cleaned : null;
 *
 * Returning null for unknowns forces the journal generator to use the 'miscellaneous'
 * fallback account instead of silently passing through fabricated subcategory names.
 */
function normalizeSubcategory(raw) {
  if (!raw) return null;
  const cleaned = raw.toString().toLowerCase().trim().replace(/[\s-]+/g, '_');

  // Handle "utilities:electricity" format (parent:child)
  if (cleaned.includes(':')) {
    const parts = cleaned.split(':');
    const sub = parts[parts.length - 1].trim();
    return ALL_SUBCATEGORIES.has(sub) ? sub : null;
  }

  // Fixed: unknown subcategories now return null instead of raw value
  return ALL_SUBCATEGORIES.has(cleaned) ? cleaned : null;
}

/**
 * Normalize amount to a positive number.
 */
function normalizeAmount(raw) {
  if (raw === null || raw === undefined) return null;

  if (typeof raw === 'number') {
    return raw > 0 ? Math.round(raw * 100) / 100 : null;
  }

  if (typeof raw === 'string') {
    let cleaned = raw.replace(/[,\s]/g, '').replace(/^[^\d.-]+/, '');

    const lakhMatch = cleaned.match(/^([\d.]+)\s*(?:lakh|lac|lacs)$/i);
    if (lakhMatch) return parseFloat(lakhMatch[1]) * 100000;

    const croreMatch = cleaned.match(/^([\d.]+)\s*(?:crore|cr)$/i);
    if (croreMatch) return parseFloat(croreMatch[1]) * 10000000;

    const kMatch = cleaned.match(/^([\d.]+)\s*k$/i);
    if (kMatch) return parseFloat(kMatch[1]) * 1000;

    const num = parseFloat(cleaned);
    return !isNaN(num) && num > 0 ? Math.round(num * 100) / 100 : null;
  }

  return null;
}

/**
 * Normalize a positive integer (used for installmentPeriodMonths).
 */
function normalizePositiveInt(raw) {
  if (raw === null || raw === undefined) return null;
  const num = parseInt(raw, 10);
  return !isNaN(num) && num > 0 ? num : null;
}

/**
 * Normalize a positive floating-point number (e.g., tax rate 17.5, 5.0).
 * Returns null when the value is absent or non-positive.
 */
function normalizePositiveFloat(raw) {
  if (raw === null || raw === undefined) return null;
  const num = parseFloat(raw);
  return !isNaN(num) && num > 0 ? num : null;
}

/**
 * Normalize payment method.
 */
function normalizePaymentMethod(raw) {
  if (!raw) return null;
  const cleaned = raw.toString().toLowerCase().trim();
  const validMethods = ['cash', 'bank', 'mobile_wallet', 'online', 'credit_card'];

  if (validMethods.includes(cleaned)) return cleaned;

  if (['bank transfer', 'bank_transfer', 'wire'].includes(cleaned)) return 'bank';
  if (['jazzcash', 'easypaisa', 'mobile'].includes(cleaned)) return 'mobile_wallet';
  if (['paypal', 'stripe', 'online_payment'].includes(cleaned)) return 'online';
  if (['credit card', 'cc', 'visa', 'mastercard'].includes(cleaned)) return 'credit_card';

  return cleaned;
}

/**
 * Normalize source account against known aliases.
 */
function normalizeSourceAccount(raw) {
  if (!raw) return null;
  const cleaned = raw.toString().toLowerCase().trim();
  return SOURCE_ACCOUNT_ALIASES[cleaned] || raw.toString().trim();
}

/**
 * Normalize confidence scores, adjusting based on normalization results.
 *
 * BUG FIX: Previously, missing sourceAccount penalized accountMapping confidence
 * even for non-cash transactions (depreciation, financed purchases, transfers)
 * that never have a source account by design. This caused false requiresReview flags.
 *
 * Fixed: penalty only applied when cashFlowDirection is 'inflow' or 'outflow'.
 */
function normalizeConfidenceScores(rawConfidence, normalized, dateResult) {
  const scores = {
    intent:         rawConfidence?.intent         ?? 0.5,
    amount:         rawConfidence?.amount         ?? 0.5,
    date:           rawConfidence?.date           ?? 0.5,
    accountMapping: rawConfidence?.accountMapping ?? 0.5,
  };

  // Adjust based on normalization success
  if (!normalized.transactionType) scores.intent *= 0.5;
  if (!normalized.amount || normalized.amount <= 0) scores.amount = 0.2;

  if (!normalized.date) {
    scores.date = dateResult.confidence || 0.2;
  } else {
    scores.date = Math.max(scores.date, dateResult.confidence);
  }

  // BUG FIX: Only penalize missing sourceAccount for cash-flow transactions.
  // Non-cash transactions (non_cash direction) never have a source account.
  if (
    !normalized.sourceAccount &&
    normalized.cashFlowDirection !== 'non_cash'
  ) {
    scores.accountMapping *= 0.7;
  }

  // Clamp all values
  for (const key of Object.keys(scores)) {
    scores[key] = Math.min(1, Math.max(0, Math.round(scores[key] * 100) / 100));
  }

  return scores;
}

function normalizeString(val) {
  if (!val || typeof val !== 'string') return null;
  return val.trim() || null;
}

/**
 * Normalize tax type string.
 * Delegates to taxCalculator.resolveTaxType for canonical conversion.
 */
function normalizeTaxType(raw) {
  if (!raw) return null;
  try {
    return resolveTaxType(raw);
  } catch {
    return null;
  }
}

/**
 * Normalize inventory adjustment type.
 * @param {string} raw
 * @returns {'write_down'|'write_up'|null}
 */
function normalizeAdjustmentType(raw) {
  if (!raw) return 'write_down'; // default: write-down (most common)
  const cleaned = raw.toString().toLowerCase().trim();
  if (['write_up', 'gain', 'write up', 'increase', 'write-up'].includes(cleaned)) return 'write_up';
  return 'write_down';
}

module.exports = {
  normalizeExtraction,
  normalizeAmount,
  normalizeSourceAccount,
  normalizeTaxType,
  normalizeAdjustmentType,
};
