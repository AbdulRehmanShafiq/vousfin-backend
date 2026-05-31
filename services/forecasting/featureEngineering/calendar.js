// services/forecasting/featureEngineering/calendar.js
//
// Forecast Platform — Stage B2. Calendar / seasonality regressors (pure).
//
// Teaches the models about the calendar: month/quarter/year boundaries, payroll
// windows, holidays, and the strength of any seasonal cycle. All causal (a date's
// features depend only on the date), so they're leakage-safe by construction.
//
'use strict';

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Minimal built-in fixed-date holiday set (extensible per region/calendar later).
const HOLIDAYS = {
  default: [
    { m: 1,  d: 1,  name: "New Year's Day" },
    { m: 5,  d: 1,  name: 'Labour Day' },
    { m: 8,  d: 14, name: 'Independence Day' }, // PK default
    { m: 12, d: 25, name: 'Christmas' },
  ],
};

function daysInMonth(year, month /* 1-12 */) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }

/** Holidays falling in a given month (region calendar). */
function holidaysInMonth(year, month, region = 'default') {
  return (HOLIDAYS[region] || HOLIDAYS.default).filter((h) => h.m === month);
}

/**
 * Calendar features for a single date.
 * @returns {Object} is_month_end, is_quarter_end, is_year_end, days_to_month_end,
 *                   payroll_window, holiday, holiday_name
 */
function calendarFeatures(date, region = 'default') {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const dim = daysInMonth(y, m);
  const daysToEnd = dim - day;
  const hol = (HOLIDAYS[region] || HOLIDAYS.default).find((h) => h.m === m && h.d === day);
  return {
    is_month_end:   daysToEnd <= 2 ? 1 : 0,
    is_quarter_end: (m % 3 === 0 && daysToEnd <= 2) ? 1 : 0,
    is_year_end:    (m === 12 && daysToEnd <= 2) ? 1 : 0,
    days_to_month_end: daysToEnd,
    // payroll typically runs at month-end or mid-month (the 1st/15th cycle)
    payroll_window: (daysToEnd <= 2 || (day >= 13 && day <= 16)) ? 1 : 0,
    holiday:      hol ? 1 : 0,
    holiday_name: hol ? hol.name : null,
  };
}

/**
 * Seasonal strength of a series at a given period: fraction of variance explained
 * by the seasonal (phase) means. ∈ [0,1]; higher = stronger seasonality.
 */
function seasonalStrength(series, period) {
  if (!series || series.length < period * 2 || period < 2) return 0;
  const overall = mean(series);
  const phaseMeans = Array.from({ length: period }, (_, p) =>
    mean(series.filter((_, i) => i % period === p)));
  let ssTotal = 0; let ssResid = 0;
  series.forEach((v, i) => { ssTotal += (v - overall) ** 2; ssResid += (v - phaseMeans[i % period]) ** 2; });
  return ssTotal ? clamp(1 - ssResid / ssTotal, 0, 1) : 0;
}

/** Detect the dominant seasonal period among candidates (null if none strong).
 *  Iterates ascending and requires a margin to override a smaller period, so the
 *  fundamental cycle wins over its multiples (a period-4 signal is also period-12). */
function detectPeriod(series, candidates = [12, 4, 3, 2], threshold = 0.1) {
  const sorted = [...candidates].sort((a, b) => a - b);
  let best = null; let bestStrength = threshold;
  for (const p of sorted) {
    const s = seasonalStrength(series, p);
    if (s > bestStrength + 0.02) { bestStrength = s; best = p; }
  }
  return { period: best, strength: Math.round(bestStrength * 1000) / 1000 };
}

module.exports = { calendarFeatures, holidaysInMonth, seasonalStrength, detectPeriod, daysInMonth, HOLIDAYS };
