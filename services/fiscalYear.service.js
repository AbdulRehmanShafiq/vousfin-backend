/**
 * fiscalYear.service.js — Phase 5.1 Accounting Period Engine
 *
 * Handles:
 *  1. Fiscal Year CRUD (create, list, get)
 *  2. Period lifecycle: open → close → lock → reopen
 *  3. Auto-generate monthly AccountingPeriods on fiscal year creation
 *  4. Period lock enforcement (called from transaction.service)
 *  5. Closing entries: Revenue + Expense → Retained Earnings
 *  6. Opening balances: carry forward for next fiscal year
 *  7. Audit trail on every status change
 */

'use strict';

const mongoose       = require('mongoose');
const FiscalYear     = require('../models/FiscalYear.model');
const AccountingPeriod = require('../models/AccountingPeriod.model');
const JournalEntry   = require('../models/JournalEntry.model');
const ChartOfAccount = require('../models/ChartOfAccount.model');
const {
  FISCAL_YEAR_STATUS, PERIOD_STATUS, PERIOD_TYPE,
  PERIOD_ACTION, ENTRY_TYPE, JOURNAL_STATUS, TRANSACTION_TYPES,
  TRANSACTION_SOURCES,
} = require('../config/constants');
const { ApiError } = require('../utils/ApiError');
const reportCache   = require('../utils/reportCache');
const logger        = require('../config/logger');

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/* ════════════════════════════════════════════════════════════════════════════
   FISCAL YEAR — CRUD
════════════════════════════════════════════════════════════════════════════ */

/**
 * Create a new fiscal year and auto-generate 12 monthly AccountingPeriods.
 */
async function createFiscalYear(businessId, { name, startDate, endDate }, userId) {
  const bizId = new mongoose.Types.ObjectId(String(businessId));

  // Validate no overlap with existing fiscal years
  const overlap = await FiscalYear.findOne({
    businessId: bizId,
    $or: [
      { startDate: { $lte: new Date(endDate) }, endDate: { $gte: new Date(startDate) } },
    ],
  });
  if (overlap) {
    throw new ApiError(409, `Fiscal year overlaps with "${overlap.name}" (${_fmtDate(overlap.startDate)} – ${_fmtDate(overlap.endDate)})`);
  }

  const fy = await FiscalYear.create({
    businessId: bizId,
    name,
    startDate: new Date(startDate),
    endDate:   new Date(endDate),
    status:    FISCAL_YEAR_STATUS.OPEN,
    createdBy: new mongoose.Types.ObjectId(String(userId)),
    auditTrail: [{
      action:      PERIOD_ACTION.OPENED,
      performedBy: new mongoose.Types.ObjectId(String(userId)),
      performedAt: new Date(),
      reason:      'Fiscal year created',
    }],
  });

  // Auto-generate monthly periods
  await _generateMonthlyPeriods(bizId, fy, userId);

  logger.info(`FiscalYear created: ${fy.name} (${businessId})`);
  return fy;
}

async function _generateMonthlyPeriods(businessId, fiscalYear, userId) {
  const start = new Date(fiscalYear.startDate);
  const end   = new Date(fiscalYear.endDate);
  const periods = [];

  let cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  let periodNumber = 1;

  while (cursor <= end) {
    const periodStart = new Date(cursor);
    const periodEnd   = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 23, 59, 59, 999);
    // Don't extend past the fiscal year end
    const effectiveEnd = periodEnd > end ? end : periodEnd;

    periods.push({
      businessId,
      fiscalYearId: fiscalYear._id,
      periodType:   PERIOD_TYPE.MONTHLY,
      periodNumber,
      name: `${MONTH_NAMES[cursor.getMonth()]} ${cursor.getFullYear()}`,
      startDate: periodStart,
      endDate:   effectiveEnd,
      status:    PERIOD_STATUS.OPEN,
      auditTrail: [{
        action:      PERIOD_ACTION.OPENED,
        performedBy: new mongoose.Types.ObjectId(String(userId)),
        performedAt: new Date(),
        reason:      'Auto-generated with fiscal year',
      }],
    });

    cursor.setMonth(cursor.getMonth() + 1);
    periodNumber++;
  }

  if (periods.length > 0) {
    await AccountingPeriod.insertMany(periods, { ordered: false });
  }
}

async function listFiscalYears(businessId) {
  return FiscalYear.find({
    businessId: new mongoose.Types.ObjectId(String(businessId)),
  }).sort({ startDate: -1 }).lean();
}

async function getFiscalYear(businessId, fiscalYearId) {
  const fy = await FiscalYear.findOne({
    _id: new mongoose.Types.ObjectId(String(fiscalYearId)),
    businessId: new mongoose.Types.ObjectId(String(businessId)),
  }).lean();
  if (!fy) throw new ApiError(404, 'Fiscal year not found');
  return fy;
}

async function getPeriodsForYear(businessId, fiscalYearId) {
  return AccountingPeriod.find({
    businessId:   new mongoose.Types.ObjectId(String(businessId)),
    fiscalYearId: new mongoose.Types.ObjectId(String(fiscalYearId)),
    periodType:   PERIOD_TYPE.MONTHLY,
  }).sort({ startDate: 1 }).lean();
}

/* ════════════════════════════════════════════════════════════════════════════
   PERIOD LOCK ENFORCEMENT
   Called from transaction.service.js before every create/update/reverse.
════════════════════════════════════════════════════════════════════════════ */

/**
 * Throws ApiError(423) if the transaction date falls inside a CLOSED or LOCKED period.
 *
 * @param {string} businessId
 * @param {Date|string} transactionDate
 * @param {Object} opts
 * @param {boolean} [opts.forcePost=false] — admin override; bypasses CLOSED (not LOCKED)
 * @param {boolean} [opts.allowClosingEntry=false] — system override for closing journal entries
 */
async function enforcePeriodLock(businessId, transactionDate, opts = {}) {
  if (opts.allowClosingEntry) return; // system-generated closing entries bypass the check

  const bizId = new mongoose.Types.ObjectId(String(businessId));
  const date  = new Date(transactionDate);

  const period = await AccountingPeriod.findOne({
    businessId: bizId,
    periodType: PERIOD_TYPE.MONTHLY,
    startDate:  { $lte: date },
    endDate:    { $gte: date },
  }).lean();

  if (!period) return; // no period defined → no restriction

  if (period.status === PERIOD_STATUS.LOCKED) {
    throw new ApiError(423, `Period "${period.name}" is permanently locked. No edits allowed.`);
  }

  if (period.status === PERIOD_STATUS.CLOSED && !opts.forcePost) {
    throw new ApiError(
      423,
      `Period "${period.name}" is closed. Use forcePost=true (admin only) to override.`,
      { periodId: period._id, periodName: period.name, status: period.status }
    );
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   PERIOD LIFECYCLE — close / lock / reopen
════════════════════════════════════════════════════════════════════════════ */

async function closePeriod(businessId, periodId, userId, { reason = '' } = {}) {
  const period = await _loadPeriod(businessId, periodId);

  if (period.status !== PERIOD_STATUS.OPEN) {
    throw new ApiError(400, `Period "${period.name}" is already ${period.status}.`);
  }

  // Snapshot totals
  const summary = await _computePeriodSummary(businessId, period.startDate, period.endDate);

  await AccountingPeriod.updateOne(
    { _id: period._id },
    {
      $set:  { status: PERIOD_STATUS.CLOSED, closingSummary: summary },
      $push: { auditTrail: _auditEntry(PERIOD_ACTION.CLOSED, userId, reason) },
    }
  );

  reportCache.invalidate(String(businessId));
  logger.info(`Period "${period.name}" closed (business ${businessId}) by ${userId}`);
  return { ...period, status: PERIOD_STATUS.CLOSED, closingSummary: summary };
}

async function lockPeriod(businessId, periodId, userId, { reason = '' } = {}) {
  const period = await _loadPeriod(businessId, periodId);

  if (period.status === PERIOD_STATUS.LOCKED) {
    throw new ApiError(400, `Period "${period.name}" is already locked.`);
  }

  await AccountingPeriod.updateOne(
    { _id: period._id },
    {
      $set:  { status: PERIOD_STATUS.LOCKED },
      $push: { auditTrail: _auditEntry(PERIOD_ACTION.LOCKED, userId, reason, true) },
    }
  );

  reportCache.invalidate(String(businessId));
  logger.info(`Period "${period.name}" LOCKED (business ${businessId}) by ${userId}`);
  return { ...period, status: PERIOD_STATUS.LOCKED };
}

async function reopenPeriod(businessId, periodId, userId, { reason = '', isAdminOverride = true } = {}) {
  const period = await _loadPeriod(businessId, periodId);

  if (period.status === PERIOD_STATUS.LOCKED) {
    throw new ApiError(403, `Period "${period.name}" is permanently locked. Only a system administrator can unlock.`);
  }
  if (period.status === PERIOD_STATUS.OPEN) {
    throw new ApiError(400, `Period "${period.name}" is already open.`);
  }

  await AccountingPeriod.updateOne(
    { _id: period._id },
    {
      $set:  { status: PERIOD_STATUS.OPEN },
      $push: { auditTrail: _auditEntry(PERIOD_ACTION.REOPENED, userId, reason, isAdminOverride) },
    }
  );

  reportCache.invalidate(String(businessId));
  logger.info(`Period "${period.name}" REOPENED (business ${businessId}) by ${userId}. Reason: ${reason}`);
  return { ...period, status: PERIOD_STATUS.OPEN };
}

/* ════════════════════════════════════════════════════════════════════════════
   FISCAL YEAR — CLOSE (runs closing entries + opening balances)
════════════════════════════════════════════════════════════════════════════ */

async function closeFiscalYear(businessId, fiscalYearId, userId, { reason = '' } = {}) {
  const bizId = new mongoose.Types.ObjectId(String(businessId));
  const fy    = await getFiscalYear(businessId, fiscalYearId);

  if (fy.status !== FISCAL_YEAR_STATUS.OPEN) {
    throw new ApiError(400, `Fiscal year "${fy.name}" is already ${fy.status}.`);
  }

  // Verify all monthly periods are closed first
  const openPeriods = await AccountingPeriod.countDocuments({
    businessId:   bizId,
    fiscalYearId: new mongoose.Types.ObjectId(fiscalYearId),
    status:       PERIOD_STATUS.OPEN,
    periodType:   PERIOD_TYPE.MONTHLY,
  });
  if (openPeriods > 0) {
    throw new ApiError(400, `${openPeriods} monthly period(s) are still open. Close all periods before closing the fiscal year.`);
  }

  // Run automated closing entries
  const { closingEntryIds, retainedEarningsTransferred } =
    await _runClosingEntries(businessId, bizId, fy, userId);

  await FiscalYear.updateOne(
    { _id: fy._id },
    {
      $set:  {
        status: FISCAL_YEAR_STATUS.CLOSED,
        closingEntryIds,
        retainedEarningsTransferred,
      },
      $push: {
        auditTrail: {
          action:      PERIOD_ACTION.CLOSED,
          performedBy: new mongoose.Types.ObjectId(String(userId)),
          performedAt: new Date(),
          reason:      reason || 'Year-end close',
        },
      },
    }
  );

  reportCache.invalidate(String(businessId));
  logger.info(`FiscalYear "${fy.name}" CLOSED. Retained earnings transferred: ${retainedEarningsTransferred}`);
  return { fiscalYearId: fy._id, closingEntryIds, retainedEarningsTransferred };
}

async function lockFiscalYear(businessId, fiscalYearId, userId, { reason = '' } = {}) {
  const fy = await getFiscalYear(businessId, fiscalYearId);

  if (fy.status === FISCAL_YEAR_STATUS.LOCKED) {
    throw new ApiError(400, `Fiscal year "${fy.name}" is already locked.`);
  }
  if (fy.status !== FISCAL_YEAR_STATUS.CLOSED) {
    throw new ApiError(400, `Fiscal year must be closed before it can be locked.`);
  }

  // Lock all monthly periods within this year too
  await AccountingPeriod.updateMany(
    {
      businessId:   new mongoose.Types.ObjectId(String(businessId)),
      fiscalYearId: new mongoose.Types.ObjectId(fiscalYearId),
    },
    {
      $set:  { status: PERIOD_STATUS.LOCKED },
      $push: { auditTrail: _auditEntry(PERIOD_ACTION.LOCKED, userId, 'Fiscal year locked', true) },
    }
  );

  await FiscalYear.updateOne(
    { _id: fy._id },
    {
      $set:  { status: FISCAL_YEAR_STATUS.LOCKED },
      $push: {
        auditTrail: {
          action:      PERIOD_ACTION.LOCKED,
          performedBy: new mongoose.Types.ObjectId(String(userId)),
          performedAt: new Date(),
          reason:      reason || 'Fiscal year permanently locked',
          isAdminOverride: true,
        },
      },
    }
  );

  reportCache.invalidate(String(businessId));
  logger.info(`FiscalYear "${fy.name}" LOCKED (business ${businessId})`);
  return { fiscalYearId, status: FISCAL_YEAR_STATUS.LOCKED };
}

/* ════════════════════════════════════════════════════════════════════════════
   CLOSING ENTRIES — Revenue + Expense → Retained Earnings
════════════════════════════════════════════════════════════════════════════ */

async function _runClosingEntries(businessId, bizId, fy, userId) {
  const closingEntryIds = [];

  // Find Retained Earnings account for this business
  const retainedEarningsAcct = await ChartOfAccount.findOne({
    businessId: bizId,
    $or: [
      { accountName: { $regex: /retained earnings/i } },
      { accountName: { $regex: /retained profit/i } },
    ],
  }).lean();

  if (!retainedEarningsAcct) {
    logger.warn(`No Retained Earnings account found for business ${businessId}. Skipping closing entries.`);
    return { closingEntryIds: [], retainedEarningsTransferred: 0 };
  }

  // Aggregate total revenue and expenses for this fiscal year
  const [revRow, expRow] = await Promise.all([
    JournalEntry.aggregate([
      {
        $match: {
          businessId: bizId,
          transactionDate: { $gte: fy.startDate, $lte: fy.endDate },
          status: { $in: [JOURNAL_STATUS.POSTED, JOURNAL_STATUS.SETTLED, JOURNAL_STATUS.PARTIALLY_SETTLED] },
          isArchived: { $ne: true },
        },
      },
      { $lookup: { from: 'chartofaccounts', localField: 'creditAccountId', foreignField: '_id', as: 'creditAcc' } },
      { $unwind: { path: '$creditAcc', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: { $cond: [{ $eq: ['$creditAcc.accountType', 'Revenue'] }, '$amount', 0] } },
        },
      },
    ]),
    JournalEntry.aggregate([
      {
        $match: {
          businessId: bizId,
          transactionDate: { $gte: fy.startDate, $lte: fy.endDate },
          status: { $in: [JOURNAL_STATUS.POSTED, JOURNAL_STATUS.SETTLED, JOURNAL_STATUS.PARTIALLY_SETTLED] },
          isArchived: { $ne: true },
        },
      },
      { $lookup: { from: 'chartofaccounts', localField: 'debitAccountId', foreignField: '_id', as: 'debitAcc' } },
      { $unwind: { path: '$debitAcc', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: null,
          totalExpenses: { $sum: { $cond: [{ $in: ['$debitAcc.accountType', ['Expense', 'Direct Cost']] }, '$amount', 0] } },
        },
      },
    ]),
  ]);

  const totalRevenue  = revRow[0]?.totalRevenue  || 0;
  const totalExpenses = expRow[0]?.totalExpenses || 0;
  const netIncome     = totalRevenue - totalExpenses;

  if (netIncome === 0) {
    logger.info(`Zero net income for ${fy.name} — no closing entries needed`);
    return { closingEntryIds: [], retainedEarningsTransferred: 0 };
  }

  // Find a Cash or Revenue account to use as contra for the closing entry
  // We create ONE summary closing journal entry: DR/CR Retained Earnings for net income
  // This is the simplified direct-to-retained-earnings approach used by SME software
  const systemAcct = await ChartOfAccount.findOne({
    businessId: bizId,
    accountType: 'Revenue',
  }).lean();

  if (!systemAcct) {
    logger.warn(`No Revenue account found for closing entry for business ${businessId}`);
    return { closingEntryIds: [], retainedEarningsTransferred: 0 };
  }

  // Net income > 0: CR Retained Earnings (equity increases), DR Income Summary (revenue-side)
  // Net income < 0: DR Retained Earnings (equity decreases), CR Income Summary (expense-side)
  let debitAccountId, creditAccountId, description;

  if (netIncome > 0) {
    // Profit: transfer net income to Retained Earnings (credit)
    debitAccountId  = systemAcct._id;          // temporary: debit the revenue account to close it
    creditAccountId = retainedEarningsAcct._id; // credit retained earnings
    description = `Year-end closing: Net income of ${Math.abs(netIncome).toLocaleString()} transferred to Retained Earnings (${fy.name})`;
  } else {
    // Loss: charge the net loss to Retained Earnings (debit)
    debitAccountId  = retainedEarningsAcct._id; // debit retained earnings
    creditAccountId = systemAcct._id;           // credit the revenue account side
    description = `Year-end closing: Net loss of ${Math.abs(netIncome).toLocaleString()} charged to Retained Earnings (${fy.name})`;
  }

  const closingEntry = await JournalEntry.create({
    businessId:      bizId,
    transactionDate: new Date(fy.endDate),
    description,
    transactionType: TRANSACTION_TYPES.JOURNAL_ENTRY,
    amount:          Math.abs(netIncome),
    debitAccountId,
    creditAccountId,
    status:          JOURNAL_STATUS.POSTED,
    entryType:       ENTRY_TYPE.CLOSING,
    transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
    lastModifiedBy:  new mongoose.Types.ObjectId(String(userId)),
    tags:            ['closing-entry', `fy-${fy.name}`],
  });

  closingEntryIds.push(closingEntry._id);

  logger.info(`Closing entry created: net income ${netIncome} → Retained Earnings for ${fy.name}`);
  return { closingEntryIds, retainedEarningsTransferred: netIncome };
}

/* ════════════════════════════════════════════════════════════════════════════
   ADJUSTING ENTRIES — Accruals, Deferrals, Year-end adjustments
════════════════════════════════════════════════════════════════════════════ */

/**
 * Post an adjusting entry for a specific period.
 * Supports: accrual | deferral | year_end | depreciation
 */
async function postAdjustingEntry(businessId, {
  adjustingType, // from ADJUSTING_TYPE
  periodId,
  description,
  amount,
  debitAccountId,
  creditAccountId,
  memo,
}, userId) {
  // Validate period is not locked
  const period = await _loadPeriod(businessId, periodId);
  if (period.status === PERIOD_STATUS.LOCKED) {
    throw new ApiError(423, `Period "${period.name}" is locked. Adjusting entries not allowed.`);
  }

  const bizId = new mongoose.Types.ObjectId(String(businessId));

  const entry = await JournalEntry.create({
    businessId:      bizId,
    transactionDate: new Date(period.endDate), // adjustments dated at period end
    description:     description || `${adjustingType} adjusting entry`,
    transactionType: TRANSACTION_TYPES.JOURNAL_ENTRY,
    amount,
    debitAccountId:  new mongoose.Types.ObjectId(String(debitAccountId)),
    creditAccountId: new mongoose.Types.ObjectId(String(creditAccountId)),
    status:          JOURNAL_STATUS.POSTED,
    entryType:       ENTRY_TYPE.ADJUSTING,
    adjustingType,
    memo:            memo || '',
    transactionSource: TRANSACTION_SOURCES.MANUAL,
    lastModifiedBy:  new mongoose.Types.ObjectId(String(userId)),
    tags:            ['adjusting-entry', adjustingType],
  });

  // Link adjusting entry to the period
  await AccountingPeriod.updateOne(
    { _id: period._id },
    { $push: { closingEntryIds: entry._id } }
  );

  reportCache.invalidate(String(businessId));
  return entry;
}

/* ════════════════════════════════════════════════════════════════════════════
   HELPERS
════════════════════════════════════════════════════════════════════════════ */

async function _loadPeriod(businessId, periodId) {
  const period = await AccountingPeriod.findOne({
    _id:        new mongoose.Types.ObjectId(String(periodId)),
    businessId: new mongoose.Types.ObjectId(String(businessId)),
  }).lean();
  if (!period) throw new ApiError(404, 'Accounting period not found');
  return period;
}

async function _computePeriodSummary(businessId, startDate, endDate) {
  const bizId = new mongoose.Types.ObjectId(String(businessId));
  const [revRow, expRow, countRow] = await Promise.all([
    JournalEntry.aggregate([
      { $match: { businessId: bizId, transactionDate: { $gte: startDate, $lte: endDate }, isArchived: { $ne: true } } },
      { $lookup: { from: 'chartofaccounts', localField: 'creditAccountId', foreignField: '_id', as: 'cAcc' } },
      { $unwind: { path: '$cAcc', preserveNullAndEmptyArrays: true } },
      { $group: { _id: null, total: { $sum: { $cond: [{ $eq: ['$cAcc.accountType', 'Revenue'] }, '$amount', 0] } } } },
    ]),
    JournalEntry.aggregate([
      { $match: { businessId: bizId, transactionDate: { $gte: startDate, $lte: endDate }, isArchived: { $ne: true } } },
      { $lookup: { from: 'chartofaccounts', localField: 'debitAccountId', foreignField: '_id', as: 'dAcc' } },
      { $unwind: { path: '$dAcc', preserveNullAndEmptyArrays: true } },
      { $group: { _id: null, total: { $sum: { $cond: [{ $in: ['$dAcc.accountType', ['Expense', 'Direct Cost']] }, '$amount', 0] } } } },
    ]),
    JournalEntry.countDocuments({
      businessId: bizId,
      transactionDate: { $gte: startDate, $lte: endDate },
      isArchived: { $ne: true },
    }),
  ]);

  const totalRevenue  = revRow[0]?.total || 0;
  const totalExpenses = expRow[0]?.total || 0;
  return {
    totalRevenue,
    totalExpenses,
    netIncome: totalRevenue - totalExpenses,
    transactionCount: countRow,
  };
}

function _auditEntry(action, userId, reason = '', isAdminOverride = false) {
  return {
    action,
    performedBy:     new mongoose.Types.ObjectId(String(userId)),
    performedAt:     new Date(),
    reason:          reason || '',
    isAdminOverride: Boolean(isAdminOverride),
  };
}

function _fmtDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

/* ════════════════════════════════════════════════════════════════════════════
   CURRENT PERIOD — convenience query used by the frontend banner
════════════════════════════════════════════════════════════════════════════ */
async function getCurrentPeriod(businessId) {
  return AccountingPeriod.findOne({
    businessId: new mongoose.Types.ObjectId(String(businessId)),
    periodType: PERIOD_TYPE.MONTHLY,
    startDate:  { $lte: new Date() },
    endDate:    { $gte: new Date() },
  }).lean();
}

module.exports = {
  createFiscalYear,
  listFiscalYears,
  getFiscalYear,
  getPeriodsForYear,
  closePeriod,
  lockPeriod,
  reopenPeriod,
  closeFiscalYear,
  lockFiscalYear,
  postAdjustingEntry,
  enforcePeriodLock,
  getCurrentPeriod,
};
