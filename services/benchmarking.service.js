// services/benchmarking.service.js — Phase 8 FR-09.3
//
// Industry benchmarking: compare a business's 8 key financial ratios against
// Pakistan SME sector medians (INDUSTRY_BENCHMARKS in config/industryBenchmarks.js).
//
// Singleton service — require() is idempotent.
'use strict';

const mongoose = require('mongoose');
const logger = require('../config/logger');
const { INDUSTRY_BENCHMARKS } = require('../config/industryBenchmarks');
const accountRepository = require('../repositories/account.repository');

const safeDiv = (a, b) => {
  if (b == null || b === 0 || !isFinite(b)) return null;
  const r = a / b;
  return isFinite(r) ? r : null;
};

// ── Sector mapping ────────────────────────────────────────────────────────────
// Maps businessType strings (from constants.js BUSINESS_TYPES) to sector slugs.
const TYPE_TO_SECTOR = [
  // Technology
  { test: /IT Services|Software|SaaS|Digital Agency|E-commerce/i, sector: 'technology' },
  // Retail / Trade
  { test: /Retail|Wholesale|Import|Export/i, sector: 'retail' },
  // Manufacturing
  { test: /Manufacturing|Agriculture|Farming/i, sector: 'manufacturing' },
  // Construction
  { test: /Construction|Contracting/i, sector: 'construction' },
  // Healthcare
  { test: /Healthcare|Medical/i, sector: 'healthcare' },
  // Food & Beverage
  { test: /Restaurant|Food Service|Hotel|Hospitality|Bakery/i, sector: 'food_beverage' },
  // Education
  { test: /Education|Training|School|College/i, sector: 'education' },
];

class BenchmarkingService {
  // ── Sector resolution ──────────────────────────────────────────────────────
  async getSectorForBusiness(businessId) {
    try {
      const Business = require('../models/Business.model');
      const biz = await Business.findById(businessId).lean();
      if (!biz?.businessType) return 'services';
      for (const { test, sector } of TYPE_TO_SECTOR) {
        if (test.test(biz.businessType)) return sector;
      }
      return 'services';
    } catch (err) {
      logger.warn('[benchmarking] getSectorForBusiness error — defaulting to services', { err: err.message });
      return 'services';
    }
  }

  // ── Ratio computation ──────────────────────────────────────────────────────
  async getBusinessRatios(businessId) {
    const ratios = {
      currentRatio:     null,
      quickRatio:       null,
      debtToEquity:     null,
      grossMargin:      null,
      netMargin:        null,
      returnOnAssets:   null,
      assetTurnover:    null,
      interestCoverage: null,
    };

    try {
      // ── Balance sheet buckets from Chart of Accounts ──────────────────────
      const accounts = await accountRepository.findByBusiness(businessId);

      let currentAssets = 0;
      let inventory = 0;
      let totalAssets = 0;
      let currentLiabilities = 0;
      let totalLiabilities = 0;
      let equity = 0;

      for (const a of accounts) {
        const type    = (a.accountType || '').toLowerCase();
        const subtype = (a.accountSubtype || '').toLowerCase();
        const bal     = Number(a.runningBalance) || 0;

        if (type === 'asset') {
          totalAssets += bal;
          if (/bank and cash|^current assets$/.test(subtype)) {
            currentAssets += bal;
          }
          if (/inventory/.test(subtype) || /inventory/.test((a.accountName || '').toLowerCase())) {
            inventory += bal;
          }
        }
        if (type === 'liability') {
          totalLiabilities += bal;
          // Match 'Current Liabilities' but NOT 'Non-current Liabilities'
          if (/^current liabilities$/i.test(subtype)) {
            currentLiabilities += bal;
          }
        }
        if (type === 'equity') {
          equity += bal;
        }
      }

      // ── P&L buckets from JournalEntry ────────────────────────────────────
      const JournalEntry = require('../models/JournalEntry.model');
      const twelveMonthsAgo = new Date();
      twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);

      let revenue = 0;
      let cogs = 0;
      let totalExpense = 0;
      let interestExpense = 0;

      try {
        const bizOid = mongoose.Types.ObjectId.isValid(businessId)
          ? new mongoose.Types.ObjectId(businessId)
          : businessId;

        const aggResult = await JournalEntry.aggregate([
          {
            $match: {
              businessId: bizOid,
              transactionDate: { $gte: twelveMonthsAgo },
              status: { $ne: 'reversed' },
            },
          },
          {
            $group: {
              _id: {
                $cond: [
                  { $in: ['$transactionType', ['Income', 'Revenue', 'Cash Sale', 'Credit Sale', 'Subscription Revenue']] },
                  'revenue',
                  {
                    $cond: [
                      {
                        $regexMatch: {
                          input: { $ifNull: ['$description', ''] },
                          regex: /cost of goods|cogs|direct cost|direct labour|direct material/i,
                        },
                      },
                      'cogs',
                      {
                        $cond: [
                          {
                            $regexMatch: {
                              input: { $ifNull: ['$description', ''] },
                              regex: /interest expense|finance charge|loan interest/i,
                            },
                          },
                          'interest',
                          'expense',
                        ],
                      },
                    ],
                  },
                ],
              },
              total: { $sum: '$amount' },
            },
          },
        ]);

        for (const row of aggResult) {
          if (row._id === 'revenue')  revenue  = Number(row.total) || 0;
          if (row._id === 'cogs')     cogs     = Number(row.total) || 0;
          if (row._id === 'interest') interestExpense = Number(row.total) || 0;
          if (row._id === 'expense')  totalExpense += Number(row.total) || 0;
        }
        totalExpense += cogs; // total expense includes COGS
      } catch (aggErr) {
        logger.warn('[benchmarking] JE aggregate failed — using zero P&L values', { err: aggErr.message });
      }

      const netIncome      = revenue - totalExpense;
      const operatingIncome = revenue - totalExpense + interestExpense; // EBIT

      // ── Compute the 8 ratios ──────────────────────────────────────────────
      ratios.currentRatio     = safeDiv(currentAssets, currentLiabilities);
      ratios.quickRatio       = safeDiv(currentAssets - inventory, currentLiabilities);
      ratios.debtToEquity     = safeDiv(totalLiabilities, equity);
      ratios.grossMargin      = safeDiv(revenue - cogs, revenue);
      ratios.netMargin        = safeDiv(netIncome, revenue);
      ratios.returnOnAssets   = safeDiv(netIncome, totalAssets);
      ratios.assetTurnover    = safeDiv(revenue, totalAssets);
      ratios.interestCoverage = safeDiv(operatingIncome, interestExpense);

    } catch (err) {
      logger.error('[benchmarking] getBusinessRatios error — returning nulls', { err: err.message });
    }

    return ratios;
  }

  // ── Main API ───────────────────────────────────────────────────────────────
  async getBenchmark(businessId) {
    const sector      = await this.getSectorForBusiness(businessId);
    const benchmarks  = INDUSTRY_BENCHMARKS[sector] || INDUSTRY_BENCHMARKS.default;
    const bizRatios   = await this.getBusinessRatios(businessId);

    // Ratios where HIGHER is better (above = good)
    const higherIsBetter = new Set(['currentRatio','quickRatio','grossMargin','netMargin','returnOnAssets','assetTurnover','interestCoverage']);
    // Ratios where LOWER is better (below = good)
    const lowerIsBetter  = new Set(['debtToEquity']);

    const ratioKeys = Object.keys(benchmarks);
    const ratioResult = {};
    let aboveCount = 0;
    let measuredCount = 0;

    for (const key of ratioKeys) {
      const biz       = bizRatios[key] !== undefined ? bizRatios[key] : null;
      const benchmark = benchmarks[key];

      let direction = 'no_data';
      if (biz !== null && biz !== undefined) {
        measuredCount++;
        const EPS = benchmark * 0.02; // ±2% = "at"
        if (Math.abs(biz - benchmark) <= EPS) {
          direction = 'at';
          aboveCount++;
        } else if (higherIsBetter.has(key)) {
          if (biz > benchmark) { direction = 'above'; aboveCount++; }
          else                   direction = 'below';
        } else {
          // lower is better
          if (biz < benchmark) { direction = 'above'; aboveCount++; }
          else                   direction = 'below';
        }
      }

      ratioResult[key] = { business: biz, benchmark, direction };
    }

    return {
      sector,
      ratios: ratioResult,
      overallScore: aboveCount,       // count of above/at ratios out of non-null
      measuredRatios: measuredCount,  // how many ratios had data
      generatedAt: new Date(),
    };
  }
}

module.exports = new BenchmarkingService();
