/**
 * taxIntelligence.js — Phase 5.4.7
 *
 * NLP + AI Tax Intelligence layer.
 *
 * Responsibilities:
 *  1. Detect tax-inclusive / tax-exclusive phrases in raw text
 *  2. Map NLP-detected tax types to country-profile canonical types
 *  3. Validate tax rates against country profile defaults
 *  4. Enrich parsedData with tax account suggestions based on business country
 *
 * Called from:
 *  - normalizationService.js (enrichWithTaxIntelligence)
 *  - The /ai/nl-parse endpoint can pass countryCode for richer suggestions
 *
 * This module is PURE (no async, no DB calls) — it operates on in-memory
 * country profiles and text analysis only.
 */

'use strict';

const { getProfile } = require('../../../config/countryTaxProfiles');
const { DEFAULT_TAX_RATES } = require('./taxCalculator');

// ─────────────────────────────────────────────────────────────────────────────
//  Tax phrase patterns
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phrases that indicate the amount INCLUDES tax (tax-inclusive).
 * Example: "received 11,700 inclusive of 17% GST"
 */
const INCLUSIVE_PATTERNS = [
  /inclus(?:ive|ing)\s+(?:of\s+)?(?:gst|vat|tax)/i,
  /\bincl\.?\s+(?:gst|vat|tax)/i,
  /with\s+(?:gst|vat|tax)\s+included/i,
  /(?:gst|vat|tax)\s+included/i,
  /inclusive\s+of\s+all\s+taxes/i,
  /(?:total\s+)?(?:gross\s+)?amount\s+includes/i,
  /all[\s-]inclusive/i,
];

/**
 * Phrases that indicate the amount EXCLUDES tax (tax-exclusive).
 * Example: "sold 10,000 + 17% GST"
 */
const EXCLUSIVE_PATTERNS = [
  /\+\s*\d+\.?\d*\s*%\s*(?:gst|vat|tax)/i,                           // +17% GST
  /plus\s+(?:\d+\.?\d*\s*%\s*)?(?:gst|vat|tax)/i,                    // plus GST / plus 17% GST
  /excl(?:uding|\.)\s+(?:gst|vat|tax)/i,
  /before\s+(?:gst|vat|tax)/i,
  /net\s+of\s+(?:gst|vat|tax)/i,
  /ex[\s-](?:gst|vat|tax)/i,
  /\+\s*tax/i,
  /add(?:ing|ed)?\s+(?:\d+\.?\d*\s*%\s*)?(?:gst|vat|tax)/i,          // adding 17% GST
];

/**
 * GST/VAT/WHT detection patterns → canonical tax type.
 * Order matters: more specific patterns first.
 */
const TAX_TYPE_PATTERNS = [
  { regex: /\bsrb\b/i,                                      type: 'SRB'   },
  { regex: /\bpra\b/i,                                      type: 'PRA'   },
  { regex: /\bkpra\b/i,                                     type: 'KPRA'  },
  { regex: /\bbra\b/i,                                      type: 'BRA'   },
  { regex: /sindh\s+(?:sales\s+)?tax/i,                     type: 'SRB'   },
  { regex: /punjab\s+(?:sales\s+)?tax/i,                    type: 'PRA'   },
  { regex: /kp(?:k)?\s+(?:sales\s+)?tax/i,                  type: 'KPRA'  },
  { regex: /balochistan\s+(?:sales\s+)?tax/i,               type: 'BRA'   },
  { regex: /\bcgst\b/i,                                     type: 'CGST'  },
  { regex: /\bsgst\b/i,                                     type: 'SGST'  },
  { regex: /\bigst\b/i,                                     type: 'IGST'  },
  { regex: /\btds\b/i,                                      type: 'TDS'   },
  { regex: /withholding[\s-]?tax|wht/i,                     type: 'WHT'   },
  { regex: /\bvat\b/i,                                      type: 'VAT'   },
  { regex: /\bgst\b/i,                                      type: 'GST'   },
  { regex: /sales[\s-]?tax/i,                               type: 'SALES_TAX' },
  { regex: /\btax\b/i,                                      type: 'GST'   },  // generic fallback
];

/**
 * WHT category detection patterns.
 */
const WHT_CATEGORY_PATTERNS = [
  { regex: /rent|lease/i,                                   category: 'rent_filer'         },
  { regex: /service.*company|corporate.*service/i,          category: 'services_company'   },
  { regex: /service|consulting|professional/i,              category: 'services_individual' },
  { regex: /goods|supply|material/i,                        category: 'goods_company'      },
  { regex: /dividend/i,                                     category: 'dividends'          },
  // India TDS
  { regex: /contractor|sub[\s-]?contract/i,                 category: 'tds_contractor'     },
  { regex: /professional\s+(?:fee|service)/i,               category: 'tds_professional'   },
  { regex: /interest/i,                                     category: 'tds_interest_bank'  },
];

// ─────────────────────────────────────────────────────────────────────────────
//  Detection functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect whether raw text implies tax-inclusive pricing.
 * @param {string} text
 * @returns {boolean}
 */
function detectTaxInclusive(text) {
  if (!text) return false;
  return INCLUSIVE_PATTERNS.some(p => p.test(text));
}

/**
 * Detect whether raw text implies tax-exclusive pricing.
 * @param {string} text
 * @returns {boolean}
 */
function detectTaxExclusive(text) {
  if (!text) return false;
  return EXCLUSIVE_PATTERNS.some(p => p.test(text));
}

/**
 * Detect tax type from raw text.
 * Returns null when no tax mention found.
 * @param {string} text
 * @returns {string|null} canonical tax type key
 */
function detectTaxType(text) {
  if (!text) return null;
  for (const { regex, type } of TAX_TYPE_PATTERNS) {
    if (regex.test(text)) return type;
  }
  return null;
}

/**
 * Detect WHT category from raw text.
 * @param {string} text
 * @returns {string|null}
 */
function detectWhtCategory(text) {
  if (!text) return null;
  for (const { regex, category } of WHT_CATEGORY_PATTERNS) {
    if (regex.test(text)) return category;
  }
  return null;
}

/**
 * Extract an explicit tax rate from raw text.
 * Examples: "17% GST", "5% VAT", "plus 18%"
 * @param {string} text
 * @returns {number|null}
 */
function extractTaxRate(text) {
  if (!text) return null;
  const match = text.match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? parseFloat(match[1]) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Country-profile enrichment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map an NLP-detected tax type to the canonical type for a given country.
 * Falls back to the detected type if no mapping found.
 *
 * @param {string|null} detectedType - e.g. 'VAT', 'GST', 'WHT'
 * @param {string}      countryCode  - e.g. 'AE', 'PK', 'IN'
 * @returns {string} canonical type for that country
 */
function mapTaxTypeToCountry(detectedType, countryCode = 'PK') {
  if (!detectedType) return 'GST';

  // WHT / TDS are always preserved — they're in whtSchedules, not taxes[]
  if (detectedType.startsWith('WHT') || detectedType === 'TDS') {
    return detectedType;
  }

  const profile = getProfile(countryCode);

  // Check if the detected type exists directly in the profile
  const exact = profile.taxes.find(t => t.type === detectedType);
  if (exact) return exact.type;

  // Country-specific mappings for common aliases
  const COUNTRY_MAPPINGS = {
    AE: { GST: 'VAT', SALES_TAX: 'VAT', GST_INPUT: 'VAT_INPUT' },
    SA: { GST: 'VAT', SALES_TAX: 'VAT', GST_INPUT: 'VAT_INPUT' },
    GB: { GST: 'VAT', SALES_TAX: 'VAT', GST_INPUT: 'VAT_INPUT' },
    IN: { GST: 'IGST', VAT: 'IGST' },  // default to IGST for India when not split
    US: { GST: 'SALES_TAX', VAT: 'SALES_TAX' },
  };

  const mapping = COUNTRY_MAPPINGS[countryCode];
  if (mapping && mapping[detectedType]) return mapping[detectedType];

  // Fallback: return first tax type from the country profile
  return profile.taxes[0]?.type || detectedType;
}

/**
 * Get the default tax rate for a type in a country.
 * @param {string} taxType
 * @param {string} countryCode
 * @returns {number}
 */
function getCountryDefaultRate(taxType, countryCode = 'PK') {
  const profile = getProfile(countryCode);
  const comp = profile.taxes.find(t => t.type === taxType);
  return comp?.rate ?? DEFAULT_TAX_RATES[taxType] ?? DEFAULT_TAX_RATES.GST ?? 0;
}

/**
 * Get suggested tax account names for a given type in a country.
 * @param {string} taxType
 * @param {string} countryCode
 * @param {'output'|'input'} side
 * @returns {{ payable: string|null, receivable: string|null }}
 */
function getTaxAccountSuggestions(taxType, countryCode = 'PK', side = 'output') {
  const profile = getProfile(countryCode);
  const comp = profile.taxes.find(t => t.type === taxType);
  if (!comp) {
    return { payable: 'GST Payable', receivable: 'GST Receivable' };
  }
  return {
    payable:    comp.accountPayable,
    receivable: comp.accountReceivable,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main enrichment function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enrich parsedData with country-profile-aware tax intelligence.
 *
 * This is the main integration point called after normalization.
 * Modifies parsedData IN PLACE (adds/overwrites tax-related fields).
 *
 * @param {object} parsedData  - Normalized parsed data from Gemini
 * @param {string} rawText     - Original user text (for pattern matching)
 * @param {string} countryCode - Business country code (from taxConfig)
 * @returns {object} enriched parsedData (same reference)
 */
function enrichWithTaxIntelligence(parsedData, rawText = '', countryCode = 'PK') {
  const text = (rawText || parsedData.description || parsedData.notes || '').toLowerCase();

  // ── 1. Detect inclusive/exclusive from raw text ──────────────────────────
  if (parsedData.isTaxInclusive === undefined || parsedData.isTaxInclusive === null) {
    if (detectTaxInclusive(text))  parsedData.isTaxInclusive = true;
    if (detectTaxExclusive(text))  { parsedData.isTaxInclusive = false; parsedData.isTaxExclusive = true; }
  }

  // ── 2. Detect tax type from raw text if not already set ──────────────────
  let detectedTaxType = parsedData.taxType || detectTaxType(text);

  // ── 3. Map to country canonical type ─────────────────────────────────────
  if (detectedTaxType) {
    parsedData.taxType = mapTaxTypeToCountry(detectedTaxType, countryCode);
  }

  // ── 4. Detect / validate tax rate ─────────────────────────────────────────
  if (!parsedData.taxRate && parsedData.taxType) {
    const textRate = extractTaxRate(text);
    parsedData.taxRate = textRate ?? getCountryDefaultRate(parsedData.taxType, countryCode);
  }

  // ── 5. Add tax account suggestions ───────────────────────────────────────
  if (parsedData.taxType) {
    const side = parsedData.transactionType?.toLowerCase().includes('sale') ? 'output' : 'input';
    const suggestions = getTaxAccountSuggestions(parsedData.taxType, countryCode, side);
    parsedData._taxAccountSuggestions = suggestions;  // UI hint, not persisted
  }

  // ── 6. WHT category detection ─────────────────────────────────────────────
  if (parsedData.taxType?.startsWith('WHT') || parsedData.taxType?.startsWith('TDS')) {
    if (!parsedData.whtCategory) {
      parsedData.whtCategory = detectWhtCategory(text);
    }
    parsedData.whtApply = true;
  }

  // ── 7. Tax confidence boost ───────────────────────────────────────────────
  //  When NLP detected a tax rate that matches country profile default → high confidence
  if (parsedData.taxType && parsedData.taxRate) {
    const profileRate = getCountryDefaultRate(parsedData.taxType, countryCode);
    if (Math.abs(parsedData.taxRate - profileRate) < 0.5) {
      parsedData._taxConfidence = 'high';
    } else {
      parsedData._taxConfidence = 'medium';  // non-standard rate
    }
  }

  return parsedData;
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  detectTaxInclusive,
  detectTaxExclusive,
  detectTaxType,
  detectWhtCategory,
  extractTaxRate,
  mapTaxTypeToCountry,
  getCountryDefaultRate,
  getTaxAccountSuggestions,
  enrichWithTaxIntelligence,
};
