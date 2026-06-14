// utils/fiscalYearStart.js
//
// FR-04.1 (Phase 3) — resolve the start of the fiscal year that contains `asOf`,
// from a business's `fiscalYearStartMonth` (1–12). Used to compute net-profit YTD
// for the continuous income-tax provision. Pure + timezone-safe (local midnight).
//
'use strict';

/**
 * @param {Date}   asOf
 * @param {number} [startMonth]  1–12 (Jan..Dec); invalid/missing → January
 * @returns {Date} first day of the current fiscal year (local midnight)
 */
function fiscalYearStart(asOf, startMonth) {
  const sm = Number(startMonth);
  const m  = (Number.isInteger(sm) && sm >= 1 && sm <= 12) ? sm - 1 : 0; // 0-indexed month
  const year = asOf.getMonth() >= m ? asOf.getFullYear() : asOf.getFullYear() - 1;
  return new Date(year, m, 1);
}

module.exports = { fiscalYearStart };
