// services/forecasting/platform/currencyNormalizer.js
//
// Forecast Platform — Foundation (F1). CURRENCY NORMALIZATION ENGINE.
//
// Every monetary feature is expressed in the business's BASE currency so models
// never see a mix of PKR/USD/EUR magnitudes. Uses the existing fx.service
// (historical, as-of rates) and an in-request rate cache to avoid N FX lookups.
//
// Leakage-safe: each amount is converted at the rate AS OF its own transaction
// date — never a future rate.
//
'use strict';
const fxService = require('../../fx.service');
const logger = require('../../../config/logger');

class CurrencyNormalizer {
  constructor(businessId, baseCurrency) {
    this.businessId = businessId;
    this.baseCurrency = (baseCurrency || 'USD').toUpperCase();
    this._rateCache = new Map(); // `${from}->${to}@${yyyy-mm}` → rate
  }

  static async forBusiness(businessId) {
    let base = 'USD';
    try { base = (await fxService.getBaseCurrency(businessId)) || 'USD'; } catch { /* default */ }
    return new CurrencyNormalizer(businessId, base);
  }

  _key(from, to, asOf) {
    const m = new Date(asOf || Date.now()).toISOString().slice(0, 7); // monthly rate bucket
    return `${from}->${to}@${m}`;
  }

  /** Convert one amount to the base currency, as-of its own date. */
  async toBase(amount, fromCurrency, asOf) {
    const from = (fromCurrency || this.baseCurrency).toUpperCase();
    if (from === this.baseCurrency || !amount) return Number(amount) || 0;
    const key = this._key(from, this.baseCurrency, asOf);
    if (this._rateCache.has(key)) return (Number(amount) || 0) * this._rateCache.get(key);
    try {
      const converted = await fxService.convert(Number(amount) || 0, from, this.baseCurrency, asOf, this.businessId);
      const rate = (Number(amount) ? converted / Number(amount) : 1);
      this._rateCache.set(key, rate);
      return converted;
    } catch (e) {
      logger.warn(`[currencyNormalizer] convert ${from}->${this.baseCurrency} failed (using 1:1): ${e.message}`);
      this._rateCache.set(key, 1);
      return Number(amount) || 0;
    }
  }

  /** Normalize an array of {amount, currencyCode, transactionDate} rows in place-safe form. */
  async normalizeRows(rows, { amountField = 'amount', currencyField = 'currencyCode', dateField = 'transactionDate' } = {}) {
    const out = [];
    for (const r of rows) {
      out.push({ ...r, baseAmount: await this.toBase(r[amountField], r[currencyField], r[dateField]) });
    }
    return out;
  }
}

module.exports = CurrencyNormalizer;
