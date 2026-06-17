// services/closeAgent.service.js
//
// Autonomy roadmap Phase 5 — the Controller / Close agent.
//
// At month-end it offers to wrap up the month in one approval: post any
// recognition entries that have come due, write up the month's CFO report +
// plain-language narrative, and close the accounting period. Per the close dial:
//   - Suggest  → a draft close waits for the owner's OK (default),
//   - Autopilot → the month closes itself and the report is filed; exceptions
//     are surfaced.
// The close is a soft close (status → closed) and is reversible: one click
// reopens the period for adjustments. No money is moved by the close itself.
//
'use strict';
const actionRouter = require('./actionRouter.service');
const executors = require('./actionExecutors');
const recognitionSchedule = require('./recognitionSchedule.service');
const cfoReport = require('./cfoReport.service');
const accountingPeriod = require('./accountingPeriod.service');
const AccountingPeriod = require('../models/AccountingPeriod.model');
const RecognitionSchedule = require('../models/RecognitionSchedule.model');
const repo = require('../repositories/proposedAction.repository');
const logger = require('../config/logger');
const { PROPOSED_ACTION_TYPES, PROPOSED_ACTION_STATUS, PERIOD_STATUS } = require('../config/constants');

const CLOSE_MONTH = PROPOSED_ACTION_TYPES.CLOSE_MONTH;

const monthLabel = (d) => new Date(d).toLocaleString('en-US', { month: 'long', year: 'numeric' });

/** The most recent monthly period that has ended but is still open — the one to close. */
async function findCloseablePeriod(businessId, now = new Date()) {
  return AccountingPeriod.findOne({
    businessId, periodType: 'monthly', endDate: { $lt: now }, status: PERIOD_STATUS.OPEN,
  }).sort({ endDate: -1 }).lean();
}

/** How many recognition schedules have a line that's come due by `asOf` (not yet posted). */
async function dueRecognitionCount(businessId, asOf) {
  try {
    return await RecognitionSchedule.countDocuments({
      businessId, status: 'active',
      lines: { $elemMatch: { status: 'pending', scheduledDate: { $lte: asOf } } },
    });
  } catch (e) { logger.warn(`[close] due-recognition count failed: ${e.message}`); return 0; }
}

async function alreadyHandled(businessId, sourceId) {
  const last = await repo.latestBySource(businessId, 'period_close', sourceId);
  return last && last.status !== PROPOSED_ACTION_STATUS.FAILED;
}

/* ── Offer a month-end close when a month has ended and is still open ───────── */
async function scanBusiness(businessId, actor, now = new Date()) {
  let period;
  try { period = await findCloseablePeriod(businessId, now); }
  catch (e) { logger.warn(`[close] find period failed: ${e.message}`); return 0; }
  if (!period) return 0;

  const sourceId = String(period._id);
  if (await alreadyHandled(businessId, sourceId)) return 0;

  const label = period.name || monthLabel(period.endDate);
  const dueRecognitions = await dueRecognitionCount(businessId, period.endDate);
  const recogNote = dueRecognitions > 0 ? ` Post ${dueRecognitions} recognition ${dueRecognitions === 1 ? 'entry' : 'entries'} that came due, then` : '';

  await actionRouter.propose({
    businessId,
    capability: 'close',
    type:       CLOSE_MONTH,
    title:      `Close ${label}`,
    summary:    `${label} has ended.${recogNote} write up the month and close the books — with a plain-language summary you can read.`,
    rationale:  `Period "${label}" ended ${new Date(period.endDate).toLocaleDateString()} and is still open.`,
    citations:  [`Period ${label}: ${new Date(period.startDate).toLocaleDateString()} → ${new Date(period.endDate).toLocaleDateString()}`,
                 ...(dueRecognitions > 0 ? [`${dueRecognitions} recognition schedule(s) due`] : [])],
    confidence: 0.78, // auto-closes only on Autopilot; Suggest/Co-pilot draft for review
    payload:    { periodId: sourceId, periodName: label, dueRecognitions, userId: actor?.id || null },
    reversal:   { kind: 'period_reopen' },
    sourceType: 'period_close',
    sourceId,
  });
  return 1;
}

/* ── A read-only month-end checklist (the plan view) ───────────────────────── */
async function getCloseStatus(businessId, now = new Date()) {
  const period = await findCloseablePeriod(businessId, now);
  if (!period) return { closeable: false, period: null, dueRecognitions: 0 };
  return {
    closeable: true,
    period: { id: String(period._id), name: period.name || monthLabel(period.endDate), startDate: period.startDate, endDate: period.endDate, status: period.status },
    dueRecognitions: await dueRecognitionCount(businessId, period.endDate),
  };
}

/* ── Executor: the orchestrated close (post recognitions → report → close) ──── */
async function executeCloseMonth(action) {
  const p = action.payload || {};
  const businessId = action.businessId;
  const period = await AccountingPeriod.findOne({ _id: p.periodId, businessId }).lean();
  if (!period) throw new Error('That accounting period no longer exists.');
  if (period.status !== PERIOD_STATUS.OPEN) throw new Error(`The period is already ${period.status}.`);

  // 1. Post any recognition entries that have come due by period end.
  let recognitionsPosted = 0;
  try {
    const r = await recognitionSchedule.postDueRecognitions(businessId, new Date(period.endDate));
    recognitionsPosted = r?.linesPosted || 0;
  } catch (e) { logger.warn(`[close] recognition posting failed: ${e.message}`); }

  // 2. Write up the month: CFO report + plain-language narrative (filed for the owner).
  let reportMonth = null;
  try {
    const mid = new Date((new Date(period.startDate).getTime() + new Date(period.endDate).getTime()) / 2);
    const report = await cfoReport.generate(businessId, mid);
    reportMonth = report?.month || null;
  } catch (e) { logger.warn(`[close] CFO report generation failed: ${e.message}`); }

  // 3. Close the period (soft close — reversible).
  await accountingPeriod.closePeriod(businessId, p.periodId, p.userId || null, 'Month-end close by VousFin Controller');

  return { periodClosed: true, periodName: p.periodName, recognitionsPosted, reportMonth };
}

/* ── Reverser: reopen the period for adjustments ───────────────────────────── */
async function reverseCloseMonth(action) {
  const p = action.payload || {};
  await accountingPeriod.reopenPeriod(action.businessId, p.periodId, p.userId || null, 'Reopened from the Command Center');
  return { reopened: true, periodName: p.periodName };
}

executors.register(CLOSE_MONTH, { execute: executeCloseMonth, reverse: reverseCloseMonth });

module.exports = {
  scanBusiness, getCloseStatus,
  findCloseablePeriod, dueRecognitionCount, executeCloseMonth, reverseCloseMonth,
};
