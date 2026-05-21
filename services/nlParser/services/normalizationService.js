/**
 * @module normalizationService
 * @description Normalizes raw AI extraction output into standardized values.
 * Handles currency, date, amount, source account, and subcategory normalization.
 */

const { normalizeCurrency } = require('../utils/currencyNormalizer');
const { parseDate } = require('../utils/dateParser');
const { VALID_TRANSACTION_TYPES, CASH_FLOW_MAP } = require('../constants/transactionTypes');
const { ALL_SUBCATEGORIES } = require('../constants/subcategories');
const { SOURCE_ACCOUNT_ALIASES } = require('../utils/accountMappings');

/**
 * Normalize the raw AI-extracted data into clean, standardized values.
 * @param {object} rawExtraction - Raw data from GROK API response.
 * @returns {object} Normalized parsed data with confidence adjustments.
 */
function normalizeExtraction(rawExtraction) {
  const normalized = {
    intent: normalizeString(rawExtraction.intent) || 'unknown',
    transactionType: normalizeTransactionType(rawExtraction.transactionType),
    subcategory: normalizeSubcategory(rawExtraction.subcategory),
    amount: normalizeAmount(rawExtraction.amount),
    currency: normalizeCurrency(rawExtraction.currency),
    date: null,
    description: normalizeString(rawExtraction.description) || '',
    counterpartyName: normalizeString(rawExtraction.counterpartyName) || null,
    paymentMethod: normalizePaymentMethod(rawExtraction.paymentMethod),
    sourceAccount: normalizeSourceAccount(rawExtraction.sourceAccount),
    cashFlowDirection: 'non_cash',
    invoiceReference: normalizeString(rawExtraction.invoiceReference) || null,
    notes: normalizeString(rawExtraction.notes) || null,
    isInstallment: rawExtraction.isInstallment === true || rawExtraction.isInstallment === 'true',
    totalInstallmentAmount: normalizeAmount(rawExtraction.totalInstallmentAmount),
    installmentPeriodMonths: Number(rawExtraction.installmentPeriodMonths) || null
  };

  // Normalize date
  const dateResult = parseDate(rawExtraction.date);
  normalized.date = dateResult.date;

  // Derive cash flow direction from transaction type
  if (normalized.transactionType && CASH_FLOW_MAP[normalized.transactionType]) {
    normalized.cashFlowDirection = CASH_FLOW_MAP[normalized.transactionType];
  }

  // Build confidence from AI scores + normalization adjustments
  const confidence = normalizeConfidenceScores(rawExtraction.confidence, normalized, dateResult);

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
 */
function normalizeSubcategory(raw) {
  if (!raw) return null;
  const cleaned = raw.toString().toLowerCase().trim().replace(/[\s-]+/g, '_');

  // Handle "utilities:electricity" format
  if (cleaned.includes(':')) {
    const parts = cleaned.split(':');
    const sub = parts[parts.length - 1].trim();
    return ALL_SUBCATEGORIES.has(sub) ? `${parts[0].trim()}:${sub}` : sub;
  }

  return ALL_SUBCATEGORIES.has(cleaned) ? cleaned : cleaned;
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

    // Handle "lakh" / "lac" / "k" / "crore"
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
 * Normalize payment method.
 */
function normalizePaymentMethod(raw) {
  if (!raw) return null;
  const cleaned = raw.toString().toLowerCase().trim();
  const validMethods = ['cash', 'bank', 'mobile_wallet', 'online', 'credit_card'];

  if (validMethods.includes(cleaned)) return cleaned;

  // Fuzzy mapping
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
 */
function normalizeConfidenceScores(rawConfidence, normalized, dateResult) {
  const scores = {
    intent: rawConfidence?.intent ?? 0.5,
    amount: rawConfidence?.amount ?? 0.5,
    date: rawConfidence?.date ?? 0.5,
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
  if (!normalized.sourceAccount) scores.accountMapping *= 0.7;

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

module.exports = { normalizeExtraction, normalizeAmount, normalizeSourceAccount };
