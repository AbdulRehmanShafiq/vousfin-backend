// services/forecasting/platform/timezone.js
//
// Forecast Platform — Foundation (F1). TIMEZONE NORMALIZATION + GRANULARITY ENGINE.
//
// Buckets timestamps into daily / weekly / monthly / quarterly periods on a
// stable, leakage-safe calendar. All math is UTC-based and deterministic; a
// per-business `tzOffsetMinutes` shifts the instant BEFORE bucketing so a sale
// at 23:30 local lands in the correct local day. (IANA-zone support via
// luxon/date-fns-tz is a target-stack upgrade — the offset path is dependency-free.)
//
// Pure functions only — trivially unit-testable, no I/O.
//
'use strict';

const MS_PER_DAY = 86400000;
const GRANULARITIES = Object.freeze(['daily', 'weekly', 'monthly', 'quarterly']);

/** Apply a tz offset (minutes east of UTC) and return a Date whose UTC fields
 *  read as the LOCAL wall-clock — so getUTC* gives local calendar components. */
function toLocal(date, tzOffsetMinutes = 0) {
  return new Date(new Date(date).getTime() + tzOffsetMinutes * 60000);
}

function pad(n) { return String(n).padStart(2, '0'); }

/** ISO-8601 week number + week-year for a (local) date. */
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;            // Mon=1..Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - day);    // nearest Thursday
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / MS_PER_DAY + 1) / 7);
  return { year: t.getUTCFullYear(), week };
}

/**
 * Canonical period key for a timestamp at a granularity.
 *   daily      → "2026-01-08"
 *   weekly     → "2026-W02"   (ISO week)
 *   monthly    → "2026-01"
 *   quarterly  → "2026-Q1"
 */
function periodKey(date, granularity, tzOffsetMinutes = 0) {
  if (!GRANULARITIES.includes(granularity)) {
    throw new Error(`Unknown granularity: ${granularity}`);
  }
  const d = toLocal(date, tzOffsetMinutes);
  const y = d.getUTCFullYear();
  switch (granularity) {
    case 'daily':   return `${y}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    case 'weekly':  { const { year, week } = isoWeek(d); return `${year}-W${pad(week)}`; }
    case 'monthly': return `${y}-${pad(d.getUTCMonth() + 1)}`;
    case 'quarterly': return `${y}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    default: throw new Error(`Unknown granularity: ${granularity}`);
  }
}

/** Inclusive [start,end) UTC instants spanning the period a date falls in. */
function periodBounds(date, granularity, tzOffsetMinutes = 0) {
  const d = toLocal(date, tzOffsetMinutes);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  let startLocal; let endLocal;
  if (granularity === 'daily') {
    startLocal = Date.UTC(y, m, d.getUTCDate());
    endLocal   = startLocal + MS_PER_DAY;
  } else if (granularity === 'weekly') {
    const day = d.getUTCDay() || 7;
    const monday = Date.UTC(y, m, d.getUTCDate()) - (day - 1) * MS_PER_DAY;
    startLocal = monday; endLocal = monday + 7 * MS_PER_DAY;
  } else if (granularity === 'monthly') {
    startLocal = Date.UTC(y, m, 1);
    endLocal   = Date.UTC(y, m + 1, 1);
  } else { // quarterly
    const q = Math.floor(m / 3);
    startLocal = Date.UTC(y, q * 3, 1);
    endLocal   = Date.UTC(y, q * 3 + 3, 1);
  }
  // Shift back to true UTC instants.
  const off = tzOffsetMinutes * 60000;
  return { start: new Date(startLocal - off), end: new Date(endLocal - off) };
}

/** Generate ordered period keys spanning [from,to] inclusive (fills gaps so a
 *  forecasting series has no missing periods). */
function enumeratePeriods(from, to, granularity, tzOffsetMinutes = 0) {
  const keys = [];
  let cursor = periodBounds(from, granularity, tzOffsetMinutes).start;
  const end = new Date(to);
  let guard = 0;
  while (cursor <= end && guard++ < 100000) {
    keys.push(periodKey(cursor, granularity, tzOffsetMinutes));
    const b = periodBounds(cursor, granularity, tzOffsetMinutes);
    cursor = new Date(b.end.getTime() + 1000); // step into next period
  }
  return keys;
}

module.exports = { GRANULARITIES, periodKey, periodBounds, enumeratePeriods, toLocal, isoWeek };
