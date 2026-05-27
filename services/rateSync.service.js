// services/rateSync.service.js
// Fetches live exchange rates from public APIs and upserts them into the
// CurrencyRate model for every business.
//
// Primary source  : open.er-api.com  (free, no API key, all currencies)
// Fallback source : frankfurter.app  (ECB data, free, no API key)
// Zero new npm dependencies — uses the built-in https module.

const https    = require('https');
const http     = require('http');
const CurrencyRate = require('../models/CurrencyRate.model');
const Business     = require('../models/Business.model');
const fxService    = require('./fx.service');
const logger       = require('../config/logger');

// Currencies to sync by default — covers major remittance / trade currencies for Pakistan
const DEFAULT_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'AED', 'SAR', 'CAD', 'AUD',
  'CNY', 'JPY', 'CHF', 'INR', 'KWD', 'QAR', 'BHD',
];

class RateSyncService {
  // ── Low-level HTTP helper ─────────────────────────────────────────────────

  /**
   * Minimal HTTPS GET with JSON parsing and redirect-following.
   * @param {string} url
   * @param {number} [redirects=0]
   * @returns {Promise<object>}
   */
  _fetch(url, redirects = 0) {
    return new Promise((resolve, reject) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const lib = url.startsWith('https') ? https : http;
      const req = lib.get(url, { headers: { 'User-Agent': 'VousFin-RateSync/1.0' } }, (res) => {
        // Follow redirects
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          return this._fetch(res.headers.location, redirects + 1).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          res.resume(); // consume response so socket is released
          return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        }
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try   { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`JSON parse error from ${url}: ${e.message}`)); }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
    });
  }

  // ── External API adapters ─────────────────────────────────────────────────

  /**
   * Fetch from open.er-api.com (completely free, no key, ~15 min update cycle).
   * Returns { base_code, rates: { USD: x, PKR: x, ... } }
   */
  async _fetchOpenER(baseCurrency) {
    const data = await this._fetch(`https://open.er-api.com/v6/latest/${baseCurrency}`);
    if (data.result !== 'success') throw new Error(`open.er-api error: ${data['error-type'] || 'unknown'}`);
    return { base_code: data.base_code, rates: data.rates };
  }

  /**
   * Fallback: frankfurter.app — ECB rates, updated daily (~16:00 CET).
   * Returns same shape as _fetchOpenER.
   */
  async _fetchFrankfurter(baseCurrency) {
    const data = await this._fetch(`https://api.frankfurter.app/latest?base=${baseCurrency}`);
    if (!data.rates) throw new Error('frankfurter.app returned no rates');
    // Frankfurter omits the base itself; add it as 1 for consistency
    data.rates[data.base] = 1;
    return { base_code: data.base, rates: data.rates };
  }

  /**
   * Try primary then fallback. Throws only if both fail.
   */
  async _fetchWithFallback(baseCurrency) {
    try {
      const result = await this._fetchOpenER(baseCurrency);
      result._source = 'open.er-api.com';
      return result;
    } catch (primaryErr) {
      logger.warn(`[RateSync] Primary API failed (${primaryErr.message}) — falling back to frankfurter.app`);
      try {
        const result = await this._fetchFrankfurter(baseCurrency);
        result._source = 'frankfurter.app (ECB)';
        return result;
      } catch (fallbackErr) {
        throw new Error(`All FX sources failed. Primary: ${primaryErr.message}. Fallback: ${fallbackErr.message}`);
      }
    }
  }

  // ── Core sync logic ───────────────────────────────────────────────────────

  /**
   * Sync live exchange rates for a single business.
   *
   * Uses USD as a universal pivot so we only need ONE API call regardless of
   * how many currency pairs we need:
   *   rateForeignToBase = rates[baseCurrency] / rates[foreignCurrency]
   *
   * Example (base = PKR):
   *   rates.PKR = 280, rates.EUR = 0.92  →  EUR→PKR = 280/0.92 = 304.35
   *
   * @param {string|ObjectId} businessId
   * @param {string[]}        [targetCurrencies]  default: DEFAULT_CURRENCIES
   * @returns {Promise<{ synced: number, date: string, source: string, baseCurrency: string }>}
   */
  async syncForBusiness(businessId, targetCurrencies) {
    const biz = await Business.findById(businessId).select('currency').lean();
    const base = (biz?.currency || 'PKR').toUpperCase();

    // Build target list (exclude base currency itself)
    const targets = [...new Set(targetCurrencies || DEFAULT_CURRENCIES)]
      .map(c => c.toUpperCase())
      .filter(c => c !== base);

    // Single API call with USD as pivot
    const { base_code: pivotBase, rates: pivotRates, _source } = await this._fetchWithFallback('USD');

    // Rate of base currency vs USD (e.g., 280 PKR per 1 USD)
    const usdToBase = pivotRates[base];
    if (!usdToBase) {
      throw new Error(`Base currency ${base} not found in API response — cannot compute cross rates`);
    }

    const rateDate = new Date();
    rateDate.setHours(0, 0, 0, 0); // normalise to start of today

    const ops = [];
    const skipped = [];

    for (const foreign of targets) {
      // USD→foreign rate (e.g., 0.92 EUR per 1 USD)
      const usdToForeign = foreign === 'USD' ? 1 : pivotRates[foreign];
      if (!usdToForeign) {
        skipped.push(foreign);
        continue;
      }
      // 1 foreign = (usdToBase / usdToForeign) base
      const rate = fxService.round(usdToBase / usdToForeign, base);

      ops.push({
        updateOne: {
          filter:  { businessId, fromCurrency: foreign, toCurrency: base, rateDate },
          update:  {
            $set: {
              rate,
              source: 'imported',
              notes:  `Auto-synced via ${_source} on ${new Date().toISOString()}`,
            },
          },
          upsert: true,
        },
      });
    }

    if (ops.length === 0) throw new Error('No rates could be computed for the requested currencies');

    const bulkResult = await CurrencyRate.bulkWrite(ops, { ordered: false });
    fxService.invalidate(String(businessId));

    if (skipped.length > 0) {
      logger.warn(`[RateSync] Skipped currencies (not in API response): ${skipped.join(', ')}`);
    }

    const synced = bulkResult.upsertedCount + bulkResult.modifiedCount;
    const dateStr = rateDate.toISOString().split('T')[0];

    logger.info(
      `[RateSync] ${synced} rates synced for business ${businessId} ` +
      `(base: ${base}) on ${dateStr} via ${_source}`
    );

    return { synced, date: dateStr, source: _source, baseCurrency: base, skipped };
  }

  /**
   * Sync rates for ALL businesses in the system.
   * Called by the daily cron job. Errors per-business are logged, not thrown.
   *
   * @returns {Promise<{ total: number, succeeded: number, failed: number }>}
   */
  async syncAllBusinesses() {
    const businesses = await Business.find({}).select('_id currency').lean();
    const stats = { total: businesses.length, succeeded: 0, failed: 0 };

    // Group businesses by base currency so we reuse the same pivot fetch
    // (future optimisation — for now process sequentially to respect rate limits)
    for (const biz of businesses) {
      try {
        await this.syncForBusiness(biz._id);
        stats.succeeded++;
      } catch (err) {
        stats.failed++;
        logger.error(`[RateSync] Failed for business ${biz._id}: ${err.message}`);
      }
    }

    logger.info(`[RateSync] Daily sync complete: ${stats.succeeded}/${stats.total} businesses updated`);
    return stats;
  }
}

module.exports = new RateSyncService();
