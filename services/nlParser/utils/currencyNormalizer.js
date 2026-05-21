/**
 * @module currencyNormalizer
 * @description Normalizes currency expressions into standard ISO currency codes.
 */

const CURRENCY_MAP = Object.freeze({
  // Pakistani Rupee
  rs: 'PKR',
  'rs.': 'PKR',
  pkr: 'PKR',
  rupees: 'PKR',
  rupee: 'PKR',
  rupay: 'PKR',

  // US Dollar
  $: 'USD',
  usd: 'USD',
  dollar: 'USD',
  dollars: 'USD',
  'us$': 'USD',

  // Euro
  '€': 'EUR',
  eur: 'EUR',
  euro: 'EUR',
  euros: 'EUR',

  // British Pound
  '£': 'GBP',
  gbp: 'GBP',
  pound: 'GBP',
  pounds: 'GBP',

  // UAE Dirham
  aed: 'AED',
  dirham: 'AED',
  dirhams: 'AED',

  // Saudi Riyal
  sar: 'SAR',
  riyal: 'SAR',
  riyals: 'SAR',

  // Indian Rupee
  inr: 'INR',
  '₹': 'INR',
});

/** Default currency when none is detected */
const DEFAULT_CURRENCY = 'PKR';

/**
 * Normalize a raw currency string to ISO code.
 * @param {string|null} raw - Raw currency text from AI extraction.
 * @returns {string} Normalized ISO currency code.
 */
function normalizeCurrency(raw) {
  if (!raw || typeof raw !== 'string') {
    return DEFAULT_CURRENCY;
  }

  const cleaned = raw.trim().toLowerCase().replace(/\./g, '');
  if (CURRENCY_MAP[cleaned]) {
    return CURRENCY_MAP[cleaned];
  }

  // Partial match
  for (const [key, code] of Object.entries(CURRENCY_MAP)) {
    if (cleaned.includes(key)) {
      return code;
    }
  }

  return DEFAULT_CURRENCY;
}

module.exports = { normalizeCurrency, CURRENCY_MAP, DEFAULT_CURRENCY };
