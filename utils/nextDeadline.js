/**
 * nextDeadline.js — FR-04.1
 *
 * Given a filing-calendar rule and an "as of" date, returns the next due date
 * and whole days remaining. Pure, timezone-stable (operates on local midnight).
 */
'use strict';

/**
 * @param {{frequency:'monthly'|'annual', dueDay:number, dueMonth?:number}} rule
 * @param {Date} [asOf]
 * @returns {{ dueDate: Date, daysRemaining: number }}
 */
function nextDeadline(rule, asOf = new Date()) {
  const ref = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate()); // local midnight
  let dueDate;

  if (rule.frequency === 'annual') {
    const m = (rule.dueMonth || 1) - 1;
    dueDate = new Date(ref.getFullYear(), m, rule.dueDay);
    if (dueDate < ref) dueDate = new Date(ref.getFullYear() + 1, m, rule.dueDay);
  } else {
    dueDate = new Date(ref.getFullYear(), ref.getMonth(), rule.dueDay);
    if (dueDate < ref) dueDate = new Date(ref.getFullYear(), ref.getMonth() + 1, rule.dueDay);
  }

  const daysRemaining = Math.round((dueDate - ref) / 86400000);
  return { dueDate, daysRemaining };
}

module.exports = { nextDeadline };
