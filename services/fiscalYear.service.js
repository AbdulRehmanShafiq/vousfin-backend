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
const { postBalancedJournal } = require('./ledgerPosting.service');
const transactionRepository = require('../repositories/transaction.repository');
const {
  FISCAL_YEAR_STATUS, PERIOD_STATUS, PERIOD_TYPE,
  PERIOD_ACTION, ENTRY_TYPE, JOURNAL_STATUS, TRANSACTION_TYPES,
  TRANSACTION_SOURCES, INPUT_METHODS,
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

  // Aggregate total revenue and expenses for this fiscal year. Use the SAME
  // effective-lines income-statement aggregation the financial statements use
  // (EFFECTIVE_LINES_STAGE under the hood) so compound entries whose COGS / tax
  // legs live ONLY in journalLines are fully counted (audit A7). The previous
  // top-level creditAccountId/debitAccountId aggregation missed those legs,
  // mis-splitting Retained Earnings vs Current-Year-Earnings.
  const { revenue, expenses } =
    await transactionRepository.getIncomeStatementData(businessId, fy.startDate, fy.endDate);
  const totalRevenue  = revenue.reduce((s, r) => s + (r.amount || 0), 0);
  const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);
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

  const closingEntry = await postBalancedJournal({
    businessId:      bizId,
    transactionDate: new Date(fy.endDate),
    description,
    transactionType: TRANSACTION_TYPES.JOURNAL_ENTRY,
    amount:          Math.abs(netIncome),
    debitAccountId,
    creditAccountId,
    status:          JOURNAL_STATUS.POSTED,
    entryType:       ENTRY_TYPE.CLOSING,
    inputMethod:     INPUT_METHODS.FORM,
    createdBy:       new mongoose.Types.ObjectId(String(userId)),
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

  const entry = await postBalancedJournal({
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
    inputMethod:     INPUT_METHODS.FORM,
    createdBy:       new mongoose.Types.ObjectId(String(userId)),
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
  // Revenue / expense come from the effective-lines income statement so a period
  // snapshot counts compound journalLines legs (COGS / tax) exactly like the P&L
  // (audit A7). transactionCount stays a raw document count over the date range.
  const [{ revenue, expenses }, transactionCount] = await Promise.all([
    transactionRepository.getIncomeStatementData(businessId, startDate, endDate),
    JournalEntry.countDocuments({
      businessId: bizId,
      transactionDate: { $gte: startDate, $lte: endDate },
      isArchived: { $ne: true },
    }),
  ]);

  const totalRevenue  = revenue.reduce((s, r) => s + (r.amount || 0), 0);
  const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  return {
    totalRevenue,
    totalExpenses,
    netIncome: totalRevenue - totalExpenses,
    transactionCount,
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

/* ════════════════════════════════════════════════════════════════════════════
   OPENING BALANCES — carry forward balance sheet accounts to next fiscal year
════════════════════════════════════════════════════════════════════════════ */

/**
 * Create opening balance journal entries for a new fiscal year.
 * Takes the ending balance of every Asset, Liability, and Equity account
 * from the PREVIOUS fiscal year and posts an opening_balance entry at the
 * start of the new fiscal year.
 *
 * This records the opening position so the new year's books start correctly.
 */
async function createOpeningBalances(businessId, fiscalYearId, userId) {
  const bizId = new mongoose.Types.ObjectId(String(businessId));
  const fy    = await getFiscalYear(businessId, fiscalYearId);

  if (fy.openingBalanceEntryId) {
    throw new ApiError(409, `Opening balances for "${fy.name}" have already been created.`);
  }

  // Find the previous fiscal year (ends just before this one starts)
  const prevFY = await FiscalYear.findOne({
    businessId: bizId,
    endDate: { $lt: fy.startDate },
  }).sort({ endDate: -1 }).lean();

  // Get all Balance Sheet accounts for this business
  const bsAccounts = await ChartOfAccount.find({
    businessId: bizId,
    accountType: { $in: ['Asset', 'Liability', 'Equity'] },
  }).lean();

  if (bsAccounts.length === 0) {
    throw new ApiError(400, 'No Balance Sheet accounts found. Set up Chart of Accounts first.');
  }

  // Compute ending balances as of the day before this FY starts
  const asOf = new Date(fy.startDate);
  asOf.setDate(asOf.getDate() - 1);

  // Per-account ending balances from the SAME effective-lines aggregation the
  // Trial Balance / Balance Sheet use (EFFECTIVE_LINES_STAGE) so an account whose
  // balance exists only through compound journalLines legs still carries forward
  // (audit A7). getDebitCreditTotals already filters to report statuses and
  // transactionDate <= asOf, matching the previous behaviour.
  const { debitTotals, creditTotals } =
    await transactionRepository.getDebitCreditTotals(businessId, asOf);

  const debitMap  = new Map(debitTotals.map(r => [r._id.toString(), r.total]));
  const creditMap = new Map(creditTotals.map(r => [r._id.toString(), r.total]));

  // Find a "Retained Earnings" equity account for the balancing entry
  const retainedEarningsAcct = await ChartOfAccount.findOne({
    businessId: bizId,
    $or: [
      { accountName: { $regex: /retained earnings/i } },
      { accountName: { $regex: /retained profit/i } },
    ],
  }).lean();

  if (!retainedEarningsAcct) {
    throw new ApiError(400, 'No Retained Earnings account found. Add a "Retained Earnings" equity account before generating opening balances.');
  }
  const retainedEarningsId = retainedEarningsAcct._id.toString();

  const createdEntryIds = [];

  // Create one opening balance journal entry per BS account with a non-zero balance.
  for (const acc of bsAccounts) {
    const accId = acc._id.toString();
    // Retained Earnings is the contra for every other account, so its own opening
    // balance is reconstructed automatically (in a balanced trial balance those
    // offsets sum to exactly RE's carry-forward). Posting an entry for RE here
    // would be self-referential (debit === credit) — skip it.
    if (accId === retainedEarningsId) continue;
    const debits  = debitMap.get(accId)  || 0;
    const credits = creditMap.get(accId) || 0;

    // Normal balance determines the "balance" direction
    let balance;
    if (acc.normalBalance === 'Debit') {
      balance = debits - credits; // positive = debit balance
    } else {
      balance = credits - debits; // positive = credit balance
    }

    if (Math.abs(balance) < 0.01) continue; // skip zero balances

    // For a debit-normal account with a debit balance: DR account / CR Retained Earnings
    // For a credit-normal account with a credit balance: DR Retained Earnings / CR account
    let debitAccountId, creditAccountId;
    const contraAcct = retainedEarningsAcct;

    if (acc.normalBalance === 'Debit') {
      debitAccountId  = acc._id;
      creditAccountId = contraAcct._id;
    } else {
      debitAccountId  = contraAcct._id;
      creditAccountId = acc._id;
    }

    const entry = await postBalancedJournal({
      businessId:      bizId,
      transactionDate: new Date(fy.startDate),
      description:     `Opening balance — ${acc.accountName} (${fy.name})`,
      transactionType: TRANSACTION_TYPES.JOURNAL_ENTRY,
      amount:          Math.abs(balance),
      debitAccountId,
      creditAccountId,
      status:          JOURNAL_STATUS.POSTED,
      entryType:       ENTRY_TYPE.OPENING_BALANCE,
      inputMethod:     INPUT_METHODS.FORM,
      createdBy:       new mongoose.Types.ObjectId(String(userId)),
      transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
      lastModifiedBy:  new mongoose.Types.ObjectId(String(userId)),
      tags:            ['opening-balance', `fy-${fy.name}`, acc.accountType.toLowerCase()],
    });

    createdEntryIds.push(entry._id);
  }

  // Record the opening balance entry IDs on the fiscal year
  if (createdEntryIds.length > 0) {
    await FiscalYear.updateOne(
      { _id: fy._id },
      { $set: { openingBalanceEntryId: createdEntryIds[0] } }
    );
  }

  reportCache.invalidate(String(businessId));
  logger.info(`Opening balances created for ${fy.name}: ${createdEntryIds.length} entries`);
  return { fiscalYearId, entriesCreated: createdEntryIds.length, entryIds: createdEntryIds };
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
  createOpeningBalances,
  enforcePeriodLock,
  getCurrentPeriod,
};
