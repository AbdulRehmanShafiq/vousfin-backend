'use strict';

// Pure scheduling helper. The cron registration (scheduleReportDelivery) and
// the delivery sweep (runDueReports) are added in Task 8 — this file currently
// exports only the pure next-run calculator the controller's setSchedule needs.

/** Pure: next run instant given a schedule and a reference time (UTC). */
function computeNextRun(schedule, fromDate) {
  const from = new Date(fromDate);
  const hour = Number.isInteger(schedule.hour) ? schedule.hour : 6;
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hour, 0, 0, 0));
  if (schedule.frequency === 'daily') {
    if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  if (schedule.frequency === 'weekly') {
    const target = Number.isInteger(schedule.dayOfWeek) ? schedule.dayOfWeek : 1;
    let delta = (target - next.getUTCDay() + 7) % 7;
    if (delta === 0 && next <= from) delta = 7;
    next.setUTCDate(next.getUTCDate() + delta);
    return next;
  }
  // monthly
  const dom = Number.isInteger(schedule.dayOfMonth) ? schedule.dayOfMonth : 1;
  next.setUTCDate(dom);
  if (next <= from) next.setUTCMonth(next.getUTCMonth() + 1, dom);
  return next;
}

module.exports = { computeNextRun };
