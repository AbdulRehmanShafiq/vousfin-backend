// services/forecasting/domains/survival.js
//
// Forecast Platform — F6. Customer payment-behavior via survival analysis (pure).
//
// Kaplan-Meier estimate of "time to payment" from observed invoice settlement
// durations (with right-censoring for still-open invoices). Yields the survival
// curve S(t) = P(still unpaid after t days), the median/mean days-to-pay, and an
// expected collection schedule for a given open AR amount.
//
'use strict';

const r4 = (v) => Math.round((Number(v) || 0) * 10000) / 10000;

/**
 * Kaplan-Meier survival curve.
 * @param {number[]} durations  days observed (to payment, or to "now" if censored)
 * @param {number[]} [events]   1 = paid (event), 0 = censored (still open); default all 1
 * @returns {Array<{ t, survival, atRisk, events }>}
 */
function kaplanMeier(durations, events) {
  const data = durations
    .map((d, i) => ({ d: Number(d), e: events ? Number(events[i]) : 1 }))
    .filter((x) => Number.isFinite(x.d) && x.d >= 0)
    .sort((a, b) => a.d - b.d);
  if (!data.length) return [];

  const times = [...new Set(data.filter((x) => x.e === 1).map((x) => x.d))].sort((a, b) => a - b);
  let surv = 1;
  const curve = [];
  for (const t of times) {
    const atRisk = data.filter((x) => x.d >= t).length;
    const deaths = data.filter((x) => x.d === t && x.e === 1).length;
    if (atRisk > 0) surv *= (1 - deaths / atRisk);
    curve.push({ t, survival: r4(surv), atRisk, events: deaths });
  }
  return curve;
}

/** Median days-to-pay = first time the survival curve drops to ≤ 0.5. */
function medianDaysToPay(curve) {
  const hit = curve.find((p) => p.survival <= 0.5);
  return hit ? hit.t : (curve.length ? curve[curve.length - 1].t : null);
}

/** Restricted mean days-to-pay = area under the survival curve. */
function meanDaysToPay(curve) {
  if (!curve.length) return null;
  let area = 0; let prevT = 0; let prevS = 1;
  for (const p of curve) { area += prevS * (p.t - prevT); prevT = p.t; prevS = p.survival; }
  return r4(area);
}

/**
 * Expected collection schedule: split an open AR amount across the next
 * `buckets` periods of `bucketDays` using the survival curve's implied
 * cumulative payment probability.
 */
function collectionSchedule(curve, openAmount, { buckets = 3, bucketDays = 30 } = {}) {
  const survAt = (days) => {
    let s = 1;
    for (const p of curve) { if (p.t <= days) s = p.survival; else break; }
    return s;
  };
  const out = [];
  let prevPaidProb = 0;
  for (let b = 1; b <= buckets; b++) {
    const cumPaid = 1 - survAt(b * bucketDays);
    const inBucket = Math.max(0, cumPaid - prevPaidProb);
    out.push({ bucket: b, byDay: b * bucketDays, expectedCollected: Math.round(openAmount * inBucket) });
    prevPaidProb = cumPaid;
  }
  return out;
}

module.exports = { kaplanMeier, medianDaysToPay, meanDaysToPay, collectionSchedule };
