// services/forecasting/featureEngineering/catalog.js
//
// Forecast Platform — Feature Engineering Framework. The FEATURE FAMILIES CATALOG.
//
// A single, declarative registry of every engineered feature: its family,
// formula, source, and leakage-safety. The pipeline computes from this catalog;
// the registry/UI document forecasts against it. New features are added here
// (one row) — never scattered across services.
//
'use strict';

const FAMILIES = {
  financial_health: [
    { name: 'revenue_growth',        formula: 'pctChange(revenue)',                       source: 'ledger',   leakageSafe: true },
    { name: 'expense_growth',        formula: 'pctChange(expenses)',                      source: 'ledger',   leakageSafe: true },
    { name: 'profit_margin',         formula: 'profit / revenue',                         source: 'ledger',   leakageSafe: true },
    { name: 'liquidity_ratio',       formula: 'currentAssets / currentLiabilities',       source: 'snapshot', leakageSafe: true },
    { name: 'debt_ratio',            formula: 'liabilities / assets',                     source: 'snapshot', leakageSafe: true },
    { name: 'working_capital_trend', formula: 'diff(currentAssets − currentLiabilities)', source: 'snapshot', leakageSafe: true },
    { name: 'cash_burn_rate',        formula: 'max(0, −netCashFlow)',                     source: 'ledger',   leakageSafe: true },
    { name: 'operating_leverage',    formula: 'pctChange(profit) / pctChange(revenue)',   source: 'ledger',   leakageSafe: true },
  ],
  behavioral: [
    { name: 'customer_payment_delay',     formula: 'meanDaysToPay (survival)',         source: 'invoices+payments', leakageSafe: true },
    { name: 'collection_velocity',        formula: 'cashInflow / arNew (trailing)',    source: 'payments+invoices', leakageSafe: true },
    { name: 'vendor_payment_cycle',       formula: 'cashOutflow / apNew (trailing)',   source: 'payments+bills',    leakageSafe: true },
    { name: 'churn_signal',               formula: 'Δ activeCustomers (decline)',      source: 'invoices',          leakageSafe: true },
    { name: 'recurring_revenue_stability',formula: '1 / coeff_of_variation(revenue)',  source: 'ledger',            leakageSafe: true },
  ],
  seasonality: [
    { name: 'fourier_weekly',    formula: 'sin/cos(2π·t/7)',   source: 'calendar', leakageSafe: true, granularity: 'daily' },
    { name: 'fourier_monthly',   formula: 'sin/cos(2π·t/12)',  source: 'calendar', leakageSafe: true, granularity: 'monthly' },
    { name: 'fourier_quarterly', formula: 'sin/cos(2π·t/4)',   source: 'calendar', leakageSafe: true },
    { name: 'fourier_yearly',    formula: 'sin/cos(2π·t/12|365)', source: 'calendar', leakageSafe: true },
    { name: 'holiday_effect',    formula: 'holiday calendar indicator',           source: 'calendar', leakageSafe: true },
    { name: 'payroll_cycle',     formula: 'month-end / fortnight payroll phase',  source: 'calendar', leakageSafe: true },
  ],
  risk: [
    { name: 'volatility',            formula: 'rollingStd / rollingMean (CV)',     source: 'ledger',  leakageSafe: true },
    { name: 'spending_spike',        formula: 'rollingZScore(expenses)',           source: 'ledger',  leakageSafe: true },
    { name: 'fraud_influence',       formula: 'anomalyRisk.riskScore',             source: 'anomaly', leakageSafe: true },
    { name: 'anomaly_adjusted_trend',formula: 'trend with anomaly periods down-weighted', source: 'anomaly', leakageSafe: true },
    { name: 'regime_shift',          formula: 'CUSUM rolling-mean break score',    source: 'ledger',  leakageSafe: true },
  ],
  macro: [
    { name: 'inflation',          formula: 'CPI YoY',              source: 'external', leakageSafe: true, external: true },
    { name: 'interest_rate',      formula: 'policy rate',          source: 'external', leakageSafe: true, external: true },
    { name: 'oil_price',          formula: 'Brent/WTI',            source: 'external', leakageSafe: true, external: true },
    { name: 'gold_price',         formula: 'XAU',                  source: 'external', leakageSafe: true, external: true },
    { name: 'fx_rate',            formula: 'base→USD (CurrencyRate)', source: 'fx',    leakageSafe: true },
    { name: 'regional_indicator', formula: 'regional macro index', source: 'external', leakageSafe: true, external: true },
  ],
};

const listFamilies = () => Object.keys(FAMILIES);
const family = (name) => FAMILIES[name] || [];
const flatten = () => Object.entries(FAMILIES).flatMap(([fam, feats]) => feats.map((f) => ({ family: fam, ...f })));
const count = () => flatten().length;

module.exports = { FAMILIES, listFamilies, family, flatten, count };
