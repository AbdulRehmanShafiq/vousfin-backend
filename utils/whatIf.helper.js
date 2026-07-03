// utils/whatIf.helper.js — pure conversational what-if parsing + affordability
// projection (Intelligence Roadmap Phase 4 follow-on).
//
// Turns a plain question ("can I afford to hire 2 people at Rs 60k?") into a
// structured monthly cost delta, then projects the effect on cash runway from
// the tenant's REAL cash + burn. Deterministic and grounded by construction —
// no LLM, no invented numbers. VousFin is not a licensed advisor: the output is
// "here's what your runway does," never "you should."
'use strict';

const RUNWAY_COMFORT_MONTHS = 6;

function parseAmount(text) {
  // Rs 60,000 / 60000 / 60k / 1.2m
  const m = String(text).toLowerCase().match(/(?:rs\.?\s*)?([\d,]+(?:\.\d+)?)\s*([km])?/i);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  if (m[2] === 'k') n *= 1000;
  if (m[2] === 'm') n *= 1000000;
  return n;
}

/**
 * @param {string} question
 * @returns {{kind:'hire'|'spend'|'unknown', count:number|null, perUnit:number|null, monthlyDelta:number|null, note:string}}
 */
function parseWhatIf(question) {
  const q = String(question || '').toLowerCase().trim();
  if (!q) return { kind: 'unknown', count: null, perUnit: null, monthlyDelta: null, note: '' };

  // Hire N people [at Rs X each]
  const hire = q.match(/hire\s+(\d+)\s*(?:people|person|staff|employees?|hires?)?/);
  if (hire) {
    const count = parseInt(hire[1], 10);
    // Salary phrase: "at Rs 60000", "@ 60k each", "60,000 per"
    const salaryMatch = q.match(/(?:at|@|for|of)\s+(rs\.?\s*[\d,.]+\s*[km]?)/) || (/(each|per)/.test(q) ? q.match(/(rs\.?\s*[\d,.]+\s*[km]?)\s*(?:each|per|a month|\/month)/) : null);
    const perUnit = salaryMatch ? parseAmount(salaryMatch[1]) : null;
    return {
      kind: 'hire', count,
      perUnit: perUnit ?? null,
      monthlyDelta: perUnit != null ? count * perUnit : null,
      note: perUnit == null ? 'No salary given — tell me the monthly pay to project this.' : '',
    };
  }

  // Spend X (a month / on Y)
  if (/\b(spend|invest|budget|add)\b/.test(q)) {
    const amt = parseAmount(q);
    if (amt != null) return { kind: 'spend', count: null, perUnit: null, monthlyDelta: amt, note: '' };
  }

  return { kind: 'unknown', count: null, perUnit: null, monthlyDelta: null, note: '' };
}

/**
 * @param {{cashBalance:number, monthlyBurn:number}} financials
 * @param {number} monthlyDelta added monthly cost
 * @returns {{runwayBefore:number|null, runwayAfter:number|null, affordable:boolean, monthlyDelta:number}}
 */
function projectAffordability({ cashBalance = 0, monthlyBurn = 0 } = {}, monthlyDelta = 0) {
  const round1 = (n) => Math.round(n * 10) / 10;
  const runwayBefore = monthlyBurn > 0 ? round1(cashBalance / monthlyBurn) : null;
  const newBurn = monthlyBurn + (Number(monthlyDelta) || 0);
  const runwayAfter = newBurn > 0 && cashBalance > 0 ? round1(cashBalance / newBurn) : null;
  const affordable = runwayAfter != null && runwayAfter >= RUNWAY_COMFORT_MONTHS;
  return { runwayBefore, runwayAfter, affordable, monthlyDelta: Number(monthlyDelta) || 0 };
}

module.exports = { parseWhatIf, projectAffordability, RUNWAY_COMFORT_MONTHS };
