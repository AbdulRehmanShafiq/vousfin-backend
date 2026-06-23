// config/industryBenchmarks.js — Phase 8 FR-09.3
//
// Industry median benchmarks for 8 financial ratios.
// Sectors map to BUSINESS_TYPES in constants.js.
// Values are Pakistan SME medians (SBP/SECP flavoured).
//
// Ratio keys (exactly 8):
//   currentRatio, quickRatio, debtToEquity, grossMargin, netMargin,
//   returnOnAssets, assetTurnover, interestCoverage
'use strict';

const INDUSTRY_BENCHMARKS = {
  // ── Fallback: applies when no sector matches ──────────────────────────────
  default: {
    currentRatio:    1.5,
    quickRatio:      1.0,
    debtToEquity:    1.0,
    grossMargin:     0.30,
    netMargin:       0.07,
    returnOnAssets:  0.07,
    assetTurnover:   1.2,
    interestCoverage: 3.5,
  },

  // ── Retail (Retail Store, Wholesale/Distribution, Import & Export, E-commerce) ──
  retail: {
    currentRatio:    1.4,
    quickRatio:      0.9,
    debtToEquity:    0.8,
    grossMargin:     0.28,
    netMargin:       0.06,
    returnOnAssets:  0.09,
    assetTurnover:   1.8,
    interestCoverage: 4.2,
  },

  // ── Manufacturing (Manufacturing, Agriculture/Farming) ──────────────────
  manufacturing: {
    currentRatio:    1.6,
    quickRatio:      0.8,
    debtToEquity:    1.2,
    grossMargin:     0.32,
    netMargin:       0.06,
    returnOnAssets:  0.06,
    assetTurnover:   0.9,
    interestCoverage: 3.0,
  },

  // ── Services (Consulting, Accounting, Law, Logistics, etc.) ─────────────
  services: {
    currentRatio:    1.8,
    quickRatio:      1.5,
    debtToEquity:    0.6,
    grossMargin:     0.55,
    netMargin:       0.12,
    returnOnAssets:  0.10,
    assetTurnover:   1.5,
    interestCoverage: 5.0,
  },

  // ── Technology (IT Services, SaaS, Digital Agency) ──────────────────────
  technology: {
    currentRatio:    2.2,
    quickRatio:      2.0,
    debtToEquity:    0.4,
    grossMargin:     0.60,
    netMargin:       0.15,
    returnOnAssets:  0.12,
    assetTurnover:   1.1,
    interestCoverage: 8.0,
  },

  // ── Construction (Construction/Contracting) ──────────────────────────────
  construction: {
    currentRatio:    1.3,
    quickRatio:      0.7,
    debtToEquity:    1.4,
    grossMargin:     0.20,
    netMargin:       0.05,
    returnOnAssets:  0.05,
    assetTurnover:   1.0,
    interestCoverage: 2.5,
  },

  // ── Healthcare (Healthcare/Medical Practice) ─────────────────────────────
  healthcare: {
    currentRatio:    1.7,
    quickRatio:      1.3,
    debtToEquity:    0.7,
    grossMargin:     0.42,
    netMargin:       0.10,
    returnOnAssets:  0.08,
    assetTurnover:   0.8,
    interestCoverage: 4.5,
  },

  // ── Food & Beverage (Restaurant/Food Service, Hotel & Hospitality, Bakery) ─
  food_beverage: {
    currentRatio:    1.2,
    quickRatio:      0.7,
    debtToEquity:    1.1,
    grossMargin:     0.35,
    netMargin:       0.07,
    returnOnAssets:  0.08,
    assetTurnover:   1.4,
    interestCoverage: 3.2,
  },

  // ── Education (Education & Training, Schools, Colleges) ─────────────────
  education: {
    currentRatio:    1.9,
    quickRatio:      1.6,
    debtToEquity:    0.5,
    grossMargin:     0.50,
    netMargin:       0.11,
    returnOnAssets:  0.09,
    assetTurnover:   0.7,
    interestCoverage: 5.5,
  },
};

module.exports = { INDUSTRY_BENCHMARKS };
