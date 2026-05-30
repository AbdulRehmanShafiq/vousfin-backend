// services/forecasting/platform/datasetBuilder.service.js
//
// Forecast Platform — Foundation (F1). DATASET BUILDER (the read-side data lake + ETL).
//
// Assembles a clean, leakage-safe, currency- & timezone-normalized time series
// for (tenant, granularity, sources, range) from the live MongoDB ledger.
//
// Pipeline (per request):
//   1. Tenant scope (mandatory businessId guard).
//   2. Source extractors → DAILY×currency aggregates in Mongo (cheap, indexed).
//   3. Currency normalization → base currency, as-of each day.
//   4. Timezone-aware re-bucketing → daily/weekly/monthly/quarterly periods.
//   5. Gap-fill the period axis (no missing periods).
//   6. Validate (Great-Expectations-style suite) before anything downstream.
//
// Extractors are pluggable: journal_entries / invoices / bills are live; the
// remaining declared sources (payments, payroll, assets, liabilities, inventory,
// customer/vendor behavior, macro) are registered as contracts to be filled in
// later phases without changing this builder's shape.
//
'use strict';
const crypto = require('crypto');
const JournalEntry = require('../../../models/JournalEntry.model');
const Invoice = require('../../../models/Invoice.model');
const Bill = require('../../../models/Bill.model');
const CurrencyNormalizer = require('./currencyNormalizer');
const tz = require('./timezone');
const { validateDataset } = require('./dataValidation');
const { assertTenant, scopeFilter } = require('./tenantScope');
const { JOURNAL_STATUS } = require('../../../config/constants');
const logger = require('../../../config/logger');

const LIVE_SOURCES = ['journal_entries', 'invoices', 'bills'];
const DECLARED_SOURCES = [
  'payments', 'payroll', 'assets', 'liabilities', 'inventory',
  'customer_behavior', 'vendor_behavior', 'macro_indicators',
];
const ALL_SOURCES = [...LIVE_SOURCES, ...DECLARED_SOURCES];

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/* ── Daily×currency extractor: revenue / expenses / cashflow from the ledger ── */
async function _extractJournalDaily(businessId, rangeStart, asOf) {
  const id = assertTenant(businessId);
  return JournalEntry.aggregate([
    { $match: {
      businessId: id,
      transactionDate: { $gte: rangeStart, $lt: asOf },
      status: { $in: [JOURNAL_STATUS.POSTED, JOURNAL_STATUS.PARTIALLY_SETTLED, JOURNAL_STATUS.SETTLED] },
      isArchived: { $ne: true },
    } },
    { $lookup: { from: 'chartofaccounts', localField: 'creditAccountId', foreignField: '_id', as: 'ca' } },
    { $lookup: { from: 'chartofaccounts', localField: 'debitAccountId',  foreignField: '_id', as: 'da' } },
    { $unwind: { path: '$ca', preserveNullAndEmptyArrays: true } },
    { $unwind: { path: '$da', preserveNullAndEmptyArrays: true } },
    { $group: {
      _id: {
        y: { $year: '$transactionDate' }, m: { $month: '$transactionDate' }, d: { $dayOfMonth: '$transactionDate' },
        ccy: { $ifNull: ['$currencyCode', 'USD'] },
      },
      date:     { $first: '$transactionDate' },
      revenue:  { $sum: { $cond: [{ $in: ['$ca.accountType', ['Revenue', 'Income']] }, '$amount', 0] } },
      expenses: { $sum: { $cond: [{ $in: ['$da.accountType', ['Expense', 'Direct Cost', 'Cost']] }, '$amount', 0] } },
      entries:  { $sum: 1 },
    } },
    { $sort: { date: 1 } },
  ]);
}

/* ── Daily×currency extractor: AR (invoices) / AP (bills) newly issued ── */
async function _extractDocDaily(Model, businessId, rangeStart, asOf, amountField = 'totalAmount') {
  const id = assertTenant(businessId);
  return Model.aggregate([
    { $match: { businessId: id, issueDate: { $gte: rangeStart, $lt: asOf }, isArchived: { $ne: true } } },
    { $group: {
      _id: {
        y: { $year: '$issueDate' }, m: { $month: '$issueDate' }, d: { $dayOfMonth: '$issueDate' },
        ccy: { $ifNull: ['$currencyCode', 'USD'] },
      },
      date:   { $first: '$issueDate' },
      amount: { $sum: `$${amountField}` },
      count:  { $sum: 1 },
    } },
    { $sort: { date: 1 } },
  ]);
}

class DatasetBuilderService {
  /**
   * Build a normalized forecasting dataset.
   * @param {string} businessId
   * @param {Object} opts { granularity, sources[], monthsBack, tzOffsetMinutes, asOf, datasetKey }
   * @returns {Promise<{ meta, rows, validation, contentHash }>}
   */
  async buildDataset(businessId, opts = {}) {
    assertTenant(businessId);
    const {
      granularity = 'monthly',
      sources = ['journal_entries', 'invoices', 'bills'],
      monthsBack = 24,
      tzOffsetMinutes = 0,
      asOf = new Date(),
      datasetKey = 'core-financials',
    } = opts;

    if (!tz.GRANULARITIES.includes(granularity)) {
      throw new Error(`Unsupported granularity: ${granularity}`);
    }
    const rangeStart = new Date(asOf);
    rangeStart.setMonth(rangeStart.getMonth() - monthsBack);
    rangeStart.setHours(0, 0, 0, 0);

    const normalizer = await CurrencyNormalizer.forBusiness(businessId);
    const baseCurrency = normalizer.baseCurrency;

    // ── period bucket accumulator ───────────────────────────────────────────
    const periods = new Map(); // periodKey → row
    const ensure = (key, date) => {
      if (!periods.has(key)) {
        const b = tz.periodBounds(date, granularity, tzOffsetMinutes);
        periods.set(key, {
          periodKey: key, periodStart: b.start, periodEnd: b.end, baseCurrency,
          revenue: 0, expenses: 0, netCashFlow: 0, entries: 0,
          arNew: 0, arCount: 0, apNew: 0, apCount: 0,
        });
      }
      return periods.get(key);
    };

    const liveSources = sources.filter((s) => LIVE_SOURCES.includes(s));

    // 1) Ledger → revenue/expenses/cashflow
    if (liveSources.includes('journal_entries')) {
      const daily = await _extractJournalDaily(businessId, rangeStart, asOf);
      for (const d of daily) {
        const rev = await normalizer.toBase(d.revenue, d._id.ccy, d.date);
        const exp = await normalizer.toBase(d.expenses, d._id.ccy, d.date);
        const row = ensure(tz.periodKey(d.date, granularity, tzOffsetMinutes), d.date);
        row.revenue += rev; row.expenses += exp; row.entries += d.entries;
      }
    }
    // 2) Invoices → AR newly issued
    if (liveSources.includes('invoices')) {
      const daily = await _extractDocDaily(Invoice, businessId, rangeStart, asOf, 'totalAmount');
      for (const d of daily) {
        const amt = await normalizer.toBase(d.amount, d._id.ccy, d.date);
        const row = ensure(tz.periodKey(d.date, granularity, tzOffsetMinutes), d.date);
        row.arNew += amt; row.arCount += d.count;
      }
    }
    // 3) Bills → AP newly issued
    if (liveSources.includes('bills')) {
      const daily = await _extractDocDaily(Bill, businessId, rangeStart, asOf, 'totalAmount');
      for (const d of daily) {
        const amt = await normalizer.toBase(d.amount, d._id.ccy, d.date);
        const row = ensure(tz.periodKey(d.date, granularity, tzOffsetMinutes), d.date);
        row.apNew += amt; row.apCount += d.count;
      }
    }

    // ── finalize numbers + derive cashflow ────────────────────────────────────
    for (const row of periods.values()) {
      row.revenue = r2(row.revenue);
      row.expenses = r2(row.expenses);
      row.netCashFlow = r2(row.revenue - row.expenses);
      row.arNew = r2(row.arNew); row.apNew = r2(row.apNew);
    }

    // ── gap-fill the period axis so the series is contiguous ──────────────────
    let rows = [];
    if (periods.size) {
      const sorted = [...periods.values()].sort((a, b) => a.periodStart - b.periodStart);
      const allKeys = tz.enumeratePeriods(sorted[0].periodStart, asOf, granularity, tzOffsetMinutes);
      rows = allKeys.map((key) => {
        if (periods.has(key)) return periods.get(key);
        const sampleDate = tz.periodBounds(sorted[0].periodStart, granularity, tzOffsetMinutes); // placeholder
        // derive bounds for the empty key by parsing — reuse a representative date
        const b = _boundsForKey(key, granularity, tzOffsetMinutes) || sampleDate;
        return {
          periodKey: key, periodStart: b.start, periodEnd: b.end, baseCurrency,
          revenue: 0, expenses: 0, netCashFlow: 0, entries: 0,
          arNew: 0, arCount: 0, apNew: 0, apCount: 0, imputed: true,
        };
      });
    }

    // ── validate ──────────────────────────────────────────────────────────────
    const validation = validateDataset(rows, { asOf });

    const contentHash = crypto.createHash('sha256')
      .update(JSON.stringify(rows.map((r) => [r.periodKey, r.revenue, r.expenses, r.arNew, r.apNew]))).digest('hex');

    const meta = {
      datasetKey, granularity, baseCurrency, tzOffsetMinutes,
      sources, liveSources,
      declaredButNotMaterialized: sources.filter((s) => DECLARED_SOURCES.includes(s)),
      rangeStart, rangeEnd: asOf, rowCount: rows.length,
    };
    if (meta.declaredButNotMaterialized.length) {
      logger.info(`[datasetBuilder] sources declared, pending later phases: ${meta.declaredButNotMaterialized.join(', ')}`);
    }
    return { meta, rows, validation, contentHash };
  }

  get sources() { return { live: LIVE_SOURCES, declared: DECLARED_SOURCES, all: ALL_SOURCES }; }
}

/* Parse a periodKey back into [start,end) bounds (for gap-filled empty periods). */
function _boundsForKey(key, granularity, tzOffsetMinutes) {
  try {
    if (granularity === 'monthly') {
      const [y, m] = key.split('-').map(Number);
      return tz.periodBounds(new Date(Date.UTC(y, m - 1, 1, 12)), granularity, tzOffsetMinutes);
    }
    if (granularity === 'quarterly') {
      const [y, q] = key.split('-Q').map(Number);
      return tz.periodBounds(new Date(Date.UTC(y, (q - 1) * 3, 1, 12)), granularity, tzOffsetMinutes);
    }
    if (granularity === 'daily') {
      const [y, m, d] = key.split('-').map(Number);
      return tz.periodBounds(new Date(Date.UTC(y, m - 1, d, 12)), granularity, tzOffsetMinutes);
    }
    if (granularity === 'weekly') {
      const [y, w] = key.split('-W').map(Number);
      const jan4 = new Date(Date.UTC(y, 0, 4, 12));
      const target = new Date(jan4.getTime() + (w - 1) * 7 * 86400000);
      return tz.periodBounds(target, granularity, tzOffsetMinutes);
    }
  } catch { /* fall through */ }
  return null;
}

module.exports = new DatasetBuilderService();
module.exports.LIVE_SOURCES = LIVE_SOURCES;
module.exports.DECLARED_SOURCES = DECLARED_SOURCES;
