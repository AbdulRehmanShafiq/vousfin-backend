/**
 * accountingPeriod.service.js — Phase 5.1 Accounting Period Engine
 *
 * Handles:
 *  1. Fiscal year creation + auto-generating monthly periods
 *  2. Period locking / unlocking (with audit trail)
 *  3. Fiscal year closing entries (revenue/expense → retained earnings)
 *  4. Opening balance journals (carry forward to new fiscal year)
 *  5. Adjusting entries (accruals, deferrals, year-end)
 *  6. Period close summary snapshots
 */

'use strict';

const mongoose       = require('mongoose');
const FiscalYear     = require('../models/FiscalYear.model');
const AccountingPeriod = require('../models/AccountingPeriod.model');
const JournalEntry   = require('../models/JournalEntry.model');
const ChartOfAccount = require('../models/ChartOfAccount.model');
const { ApiError }   = require('../utils/ApiError');
const { FISCAL_YEAR_STATUS, PERIOD_STATUS, PERIOD_TYPE,
        TRANSACTION_TYPES, JOURNAL_STATUS, INPUT_METHODS,
        TRANSACTION_SOURCES, AUDIT_ACTIONS, ENTITY_TYPES } = require('../config/constants');
const logger         = require('../config/logger');
const reportCache    = require('../utils/reportCache');

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/* ══════════════════════════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════════════════════════ */

function _validId(id) {
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id;
}

/** End of last day of a month */
function _monthEnd(year, month) {
  return new Date(year, month, 0, 23, 59, 59, 999); // month is 1-based; day 0 = last day of previous month
}

/* ══════════════════════════════════════════════════════════════════════════════
   1. FISCAL YEAR MANAGEMENT
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Create a new fiscal year and auto-generate monthly + quarterly + yearly periods.
 * Validates that the date range does not overlap any existing fiscal year.
 */
async function createFiscalYear(businessId, { name, startDate, endDate }, createdBy) {
  const bizId = _validId(businessId);
  const start = new Date(startDate);
  const end   = new Date(endDate);

  if (end <= start) throw new ApiError(400, 'endDate must be after startDate');

  // Check for overlap with existing fiscal years
  const overlap = await FiscalYear.findOne({
    businessId: bizId,
    $or: [
      { startDate: { $lte: end },   endDate: { $gte: start } },
    ],
  });
  if (overlap) {
    throw new ApiError(409, `Date range overlaps with existing fiscal year "${overlap.name}"`);
  }

  const fy = await FiscalYear.create({
    businessId: bizId,
    name,
    startDate:  start,
    endDate:    end,
    status:     FISCAL_YEAR_STATUS.OPEN,
    createdBy:  _validId(createdBy),
    auditTrail: [{
      action:      'created',
      performedBy: _validId(createdBy),
      reason:      'Fiscal year created',
    }],
  });

  // Auto-generate monthly periods
  const periods = [];
  let cursor = new Date(start.getFullYear(), start.getMonth(), 1);

  while (cursor <= end) {
    const pYear  = cursor.getFullYear();
    const pMonth = cursor.getMonth(); // 0-based
    const pStart = new Date(pYear, pMonth, 1);
    const pEnd   = _monthEnd(pYear, pMonth + 1);
    const periodNumber = pMonth + 1; // 1–12

    periods.push({
      businessId:   bizId,
      fiscalYearId: fy._id,
      periodType:   PERIOD_TYPE.MONTHLY,
      periodNumber,
      name:         `${MONTH_NAMES[pMonth]} ${pYear}`,
      startDate:    pStart,
      endDate:      pEnd < end ? pEnd : end,
      status:       PERIOD_STATUS.OPEN,
    });

    cursor.setMonth(cursor.getMonth() + 1);
  }

  // Quarterly periods
  const qMap = {};
  for (const p of periods) {
    const q = Math.ceil(p.periodNumber / 3);
    if (!qMap[q]) qMap[q] = { start: p.startDate, end: p.endDate, q };
    else qMap[q].end = p.endDate;
  }
  for (const [q, { start: qs, end: qe }] of Object.entries(qMap)) {
    periods.push({
      businessId:   bizId,
      fiscalYearId: fy._id,
      periodType:   PERIOD_TYPE.QUARTERLY,
      periodNumber: Number(q),
      name:         `Q${q} ${start.getFullYear()}`,
      startDate:    qs,
      endDate:      qe,
      status:       PERIOD_STATUS.OPEN,
    });
  }

  // Yearly period
  periods.push({
    businessId:   bizId,
    fiscalYearId: fy._id,
    periodType:   PERIOD_TYPE.YEARLY,
    periodNumber: 1,
    name:         name,
    startDate:    start,
    endDate:      end,
    status:       PERIOD_STATUS.OPEN,
  });

  await AccountingPeriod.insertMany(periods);
  logger.info(`Fiscal year "${name}" created with ${periods.length} periods (business ${businessId})`);

  reportCache.invalidate(businessId.toString());
  return fy;
}

/**
 * List fiscal years for a business (newest first).
 */
async function listFiscalYears(businessId) {
  return FiscalYear.find({ businessId: _validId(businessId) })
    .sort({ startDate: -1 })
    .lean();
}

/**
 * List accounting periods for a fiscal year.
 */
async function listPeriods(businessId, fiscalYearId, periodType) {
  const query = {
    businessId:   _validId(businessId),
    fiscalYearId: _validId(fiscalYearId),
  };
  if (periodType) query.periodType = periodType;
  return AccountingPeriod.find(query).sort({ periodNumber: 1 }).lean();
}

/* ══════════════════════════════════════════════════════════════════════════════
   2. PERIOD STATUS MANAGEMENT
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Compute and snapshot the closing summary for a period.
 */
async function _computeClosingSummary(businessId, period) {
  const bizId = _validId(businessId);

  const REVENUE_TYPES = [
    TRANSACTION_TYPES.INCOME, TRANSACTION_TYPES.CASH_SALE,
    TRANSACTION_TYPES.CREDIT_SALE, TRANSACTION_TYPES.INVENTORY_SALE,
  ];
  const EXPENSE_TYPES = [
    TRANSACTION_TYPES.EXPENSE, TRANSACTION_TYPES.CASH_PURCHASE,
    TRANSACTION_TYPES.CREDIT_PURCHASE, TRANSACTION_TYPES.INVENTORY_PURCHASE,
    TRANSACTION_TYPES.SALARY,
  ];

  const [agg] = await JournalEntry.aggregate([
    {
      $match: {
        businessId: bizId,
        transactionDate: { $gte: period.startDate, $lte: period.endDate },
        status: { $in: [JOURNAL_STATUS.POSTED, JOURNAL_STATUS.PARTIALLY_SETTLED, JOURNAL_STATUS.SETTLED] },
        isArchived: { $ne: true },
        entryType: 'normal',
      },
    },
    {
      $group: {
        _id: null,
        totalRevenue:     { $sum: { $cond: [{ $in: ['$transactionType', REVENUE_TYPES] }, '$amount', 0] } },
        totalExpenses:    { $sum: { $cond: [{ $in: ['$transactionType', EXPENSE_TYPES] }, '$amount', 0] } },
        transactionCount: { $sum: 1 },
      },
    },
  ]);

  const totalRevenue  = agg?.totalRevenue  || 0;
  const totalExpenses = agg?.totalExpenses || 0;
  return {
    totalRevenue,
    totalExpenses,
    netIncome:        totalRevenue - totalExpenses,
    transactionCount: agg?.transactionCount || 0,
  };
}

/**
 * Close a period (OPEN → CLOSED).
 * Snapshots the closing summary. Does NOT create closing entries
 * (that's done at fiscal year level via runClosingEntries).
 */
async function closePeriod(businessId, periodId, userId, reason = '', { isAdminOverride = false } = {}) {
  const period = await AccountingPeriod.findOne({
    _id:        _validId(periodId),
    businessId: _validId(businessId),
  });
  if (!period) throw new ApiError(404, 'Accounting period not found');
  if (period.status === PERIOD_STATUS.CLOSED)  throw new ApiError(400, 'Period is already closed');
  if (period.status === PERIOD_STATUS.LOCKED)  throw new ApiError(400, 'Period is locked — cannot close directly. It is already locked.');

  // Snapshot summary before closing
  const summary = await _computeClosingSummary(businessId, period);
  period.closingSummary = summary;
  period.status = PERIOD_STATUS.CLOSED;
  period.auditTrail.push({
    action:          AUDIT_ACTIONS.PERIOD_CLOSED,
    performedBy:     _validId(userId),
    reason,
    isAdminOverride,
  });

  await period.save();
  reportCache.invalidate(businessId.toString());
  logger.info(`Period "${period.name}" closed by ${userId} (business ${businessId})`);
  return period;
}

/**
 * Lock a period (CLOSED → LOCKED).
 * Locked periods are permanent unless an admin unlocks.
 */
async function lockPeriod(businessId, periodId, userId, reason = '') {
  const period = await AccountingPeriod.findOne({
    _id:        _validId(periodId),
    businessId: _validId(businessId),
  });
  if (!period) throw new ApiError(404, 'Accounting period not found');
  if (period.status === PERIOD_STATUS.OPEN)   throw new ApiError(400, 'Close the period before locking it');
  if (period.status === PERIOD_STATUS.LOCKED) throw new ApiError(400, 'Period is already locked');

  period.status = PERIOD_STATUS.LOCKED;
  period.auditTrail.push({
    action:      AUDIT_ACTIONS.PERIOD_LOCKED,
    performedBy: _validId(userId),
    reason,
  });

  await period.save();
  reportCache.invalidate(businessId.toString());
  logger.info(`Period "${period.name}" locked by ${userId} (business ${businessId})`);
  return period;
}

/**
 * Reopen a period (CLOSED or LOCKED → OPEN). Admin only for locked.
 */
async function reopenPeriod(businessId, periodId, userId, reason = '', { isAdminOverride = false } = {}) {
  const period = await AccountingPeriod.findOne({
    _id:        _validId(periodId),
    businessId: _validId(businessId),
  });
  if (!period) throw new ApiError(404, 'Accounting period not found');
  if (period.status === PERIOD_STATUS.OPEN) throw new ApiError(400, 'Period is already open');
  if (period.status === PERIOD_STATUS.LOCKED && !isAdminOverride) {
    throw new ApiError(403, 'Locked periods require admin override to reopen');
  }

  period.status = PERIOD_STATUS.OPEN;
  period.auditTrail.push({
    action:          AUDIT_ACTIONS.PERIOD_REOPENED,
    performedBy:     _validId(userId),
    reason,
    isAdminOverride,
  });

  await period.save();
  reportCache.invalidate(businessId.toString());
  logger.info(`Period "${period.name}" reopened by ${userId} (isAdminOverride=${isAdminOverride})`);
  return period;
}

/* ══════════════════════════════════════════════════════════════════════════════
   3. CLOSING ENTRIES (Year-End)
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Run year-end closing entries for a fiscal year.
 *
 * Process:
 *  1. Sum all Revenue account balances in this fiscal year
 *  2. Sum all Expense account balances in this fiscal year
 *  3. Create closing entries: DR Revenue accts → CR Retained Earnings
 *     and: DR Retained Earnings → CR Expense accts
 *  4. Net effect: Retained Earnings += Net Income
 *  5. Mark fiscal year as CLOSED
 *
 * Idempotency: if closingEntryIds already set, throws an error.
 */
async function runClosingEntries(businessId, fiscalYearId, userId) {
  const bizId = _validId(businessId);
  const fy    = await FiscalYear.findOne({ _id: _validId(fiscalYearId), businessId: bizId });
  if (!fy)     throw new ApiError(404, 'Fiscal year not found');
  if (fy.status === FISCAL_YEAR_STATUS.LOCKED) throw new ApiError(400, 'Fiscal year is locked');
  if (fy.closingEntryIds?.length > 0)          throw new ApiError(400, 'Closing entries already exist for this fiscal year. Reverse them first.');

  // Find Income Summary / Retained Earnings accounts
  const [retainedEarningsAcc, incomeSummaryAcc] = await Promise.all([
    ChartOfAccount.findOne({ businessId: bizId, accountName: { $regex: /retained earnings/i } }).lean(),
    ChartOfAccount.findOne({ businessId: bizId, $or: [
      { accountName: { $regex: /current year earnings/i } },
      { accountName: { $regex: /income summary/i } },
    ] }).lean(),
  ]);

  if (!retainedEarningsAcc) throw new ApiError(500, 'Retained Earnings account not found in Chart of Accounts');

  // Use Retained Earnings directly if no Income Summary account
  const targetEquityAcc = incomeSummaryAcc || retainedEarningsAcc;

  // Aggregate Revenue account balances for this fiscal year
  const revenueAccs = await JournalEntry.aggregate([
    {
      $match: {
        businessId: bizId,
        transactionDate: { $gte: fy.startDate, $lte: fy.endDate },
        status: { $in: [JOURNAL_STATUS.POSTED, JOURNAL_STATUS.PARTIALLY_SETTLED, JOURNAL_STATUS.SETTLED] },
        isArchived: { $ne: true },
        entryType: 'normal',
      },
    },
    { $lookup: { from: 'chartofaccounts', localField: 'creditAccountId', foreignField: '_id', as: 'creditAcc' } },
    { $unwind: { path: '$creditAcc', preserveNullAndEmptyArrays: true } },
    { $match: { 'creditAcc.accountType': 'Revenue' } },
    { $group: { _id: '$creditAccountId', accountName: { $first: '$creditAcc.accountName' }, total: { $sum: '$amount' } } },
  ]);

  // Aggregate Expense account balances for this fiscal year
  const expenseAccs = await JournalEntry.aggregate([
    {
      $match: {
        businessId: bizId,
        transactionDate: { $gte: fy.startDate, $lte: fy.endDate },
        status: { $in: [JOURNAL_STATUS.POSTED, JOURNAL_STATUS.PARTIALLY_SETTLED, JOURNAL_STATUS.SETTLED] },
        isArchived: { $ne: true },
        entryType: 'normal',
      },
    },
    { $lookup: { from: 'chartofaccounts', localField: 'debitAccountId', foreignField: '_id', as: 'debitAcc' } },
    { $unwind: { path: '$debitAcc', preserveNullAndEmptyArrays: true } },
    { $match: { 'debitAcc.accountType': { $in: ['Expense', 'Direct Cost'] } } },
    { $group: { _id: '$debitAccountId', accountName: { $first: '$debitAcc.accountName' }, total: { $sum: '$amount' } } },
  ]);

  const totalRevenue  = revenueAccs.reduce((s, r) => s + r.total, 0);
  const totalExpenses = expenseAccs.reduce((s, r) => s + r.total, 0);
  const netIncome     = totalRevenue - totalExpenses;

  if (totalRevenue === 0 && totalExpenses === 0) {
    throw new ApiError(400, 'No revenue or expense transactions found for this fiscal year. Nothing to close.');
  }

  const batchId    = new mongoose.Types.ObjectId().toString();
  const closingDate = new Date(fy.endDate);
  const closingEntryIds = [];
  const userId_oid = _validId(userId);

  // Create closing entries: DR each Revenue account → CR Target Equity (retained earnings / income summary)
  for (const rev of revenueAccs) {
    if (rev.total <= 0) continue;
    const entry = await JournalEntry.create({
      businessId:       bizId,
      transactionDate:  closingDate,
      description:      `Year-End Close: ${rev.accountName} → ${targetEquityAcc.accountName}`,
      transactionType:  TRANSACTION_TYPES.CLOSING_ENTRY,
      amount:           rev.total,
      debitAccountId:   rev._id,           // DR Revenue account (zeroes it out)
      creditAccountId:  targetEquityAcc._id, // CR Retained Earnings / Income Summary
      status:           JOURNAL_STATUS.POSTED,
      inputMethod:      INPUT_METHODS.FORM,
      createdBy:        userId_oid,
      lastModifiedBy:   userId_oid,
      fiscalYearId:     fy._id,
      entryType:        'closing',
      closingBatchId:   batchId,
      transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
    });
    closingEntryIds.push(entry._id);
  }

  // Create closing entries: DR Target Equity → CR each Expense account (zeroes it out)
  for (const exp of expenseAccs) {
    if (exp.total <= 0) continue;
    const entry = await JournalEntry.create({
      businessId:       bizId,
      transactionDate:  closingDate,
      description:      `Year-End Close: ${targetEquityAcc.accountName} → ${exp.accountName}`,
      transactionType:  TRANSACTION_TYPES.CLOSING_ENTRY,
      amount:           exp.total,
      debitAccountId:   targetEquityAcc._id, // DR Income Summary
      creditAccountId:  exp._id,             // CR Expense account (zeroes it out)
      status:           JOURNAL_STATUS.POSTED,
      inputMethod:      INPUT_METHODS.FORM,
      createdBy:        userId_oid,
      lastModifiedBy:   userId_oid,
      fiscalYearId:     fy._id,
      entryType:        'closing',
      closingBatchId:   batchId,
      transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
    });
    closingEntryIds.push(entry._id);
  }

  // If Income Summary is separate from Retained Earnings, transfer net
  if (incomeSummaryAcc && retainedEarningsAcc && incomeSummaryAcc._id.toString() !== retainedEarningsAcc._id.toString()) {
    const absNet = Math.abs(netIncome);
    if (absNet > 0.005) {
      const isProfit = netIncome >= 0;
      const entry = await JournalEntry.create({
        businessId:       bizId,
        transactionDate:  closingDate,
        description:      `Year-End Transfer: Net ${isProfit ? 'Income' : 'Loss'} to Retained Earnings`,
        transactionType:  TRANSACTION_TYPES.CLOSING_ENTRY,
        amount:           absNet,
        debitAccountId:   isProfit ? incomeSummaryAcc._id  : retainedEarningsAcc._id,
        creditAccountId:  isProfit ? retainedEarningsAcc._id : incomeSummaryAcc._id,
        status:           JOURNAL_STATUS.POSTED,
        inputMethod:      INPUT_METHODS.FORM,
        createdBy:        userId_oid,
        lastModifiedBy:   userId_oid,
        fiscalYearId:     fy._id,
        entryType:        'closing',
        closingBatchId:   batchId,
        transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
      });
      closingEntryIds.push(entry._id);
    }
  }

  // Update fiscal year
  fy.closingEntryIds            = closingEntryIds;
  fy.retainedEarningsTransferred = netIncome;
  fy.status                     = FISCAL_YEAR_STATUS.CLOSED;
  fy.auditTrail.push({
    action:      AUDIT_ACTIONS.YEAR_CLOSED,
    performedBy: userId_oid,
    reason:      `Net income: ${netIncome >= 0 ? '+' : ''}${netIncome.toFixed(2)}. Entries: ${closingEntryIds.length}`,
  });
  await fy.save();

  // Also close all OPEN monthly periods for this fiscal year
  await AccountingPeriod.updateMany(
    { fiscalYearId: fy._id, status: PERIOD_STATUS.OPEN },
    {
      $set:  { status: PERIOD_STATUS.CLOSED },
      $push: { auditTrail: { action: AUDIT_ACTIONS.PERIOD_CLOSED, performedBy: userId_oid, reason: 'Auto-closed with fiscal year' } },
    }
  );

  reportCache.invalidate(businessId.toString());
  logger.info(`Fiscal year "${fy.name}" closed: revenue=${totalRevenue}, expenses=${totalExpenses}, netIncome=${netIncome}`);

  return {
    fiscalYear:    fy,
    totalRevenue,
    totalExpenses,
    netIncome,
    entriesCreated: closingEntryIds.length,
    closingBatchId: batchId,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
   4. OPENING BALANCES
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Create opening balance journals for a new fiscal year.
 * Carries forward Asset and Liability account balances as of the previous year end.
 *
 * @param {string} businessId
 * @param {string} newFiscalYearId  — the NEW fiscal year receiving opening balances
 * @param {string} userId
 */
async function createOpeningBalances(businessId, newFiscalYearId, userId) {
  const bizId = _validId(businessId);
  const newFY = await FiscalYear.findOne({ _id: _validId(newFiscalYearId), businessId: bizId });
  if (!newFY) throw new ApiError(404, 'New fiscal year not found');

  // Find the immediately preceding fiscal year
  const prevFY = await FiscalYear.findOne({
    businessId: bizId,
    endDate:    { $lt: newFY.startDate },
    status:     { $in: [FISCAL_YEAR_STATUS.CLOSED, FISCAL_YEAR_STATUS.LOCKED] },
  }).sort({ endDate: -1 });

  if (!prevFY) throw new ApiError(400, 'No closed previous fiscal year found to carry balances from');
  if (newFY.openingBalanceEntryId) throw new ApiError(400, 'Opening balances already created for this fiscal year');

  // Get all balance-sheet accounts (Asset, Liability, Equity)
  const bsAccounts = await ChartOfAccount.find({
    businessId: bizId,
    accountType: { $in: ['Asset', 'Liability', 'Equity'] },
  }).lean();

  // Aggregate balances as of previous fiscal year end
  const { debitTotals, creditTotals } = await _getDebitCreditTotals(bizId, prevFY.endDate);

  // Compute net balance per account
  const openingEntries = [];
  for (const acc of bsAccounts) {
    const accId  = acc._id.toString();
    const debits = debitTotals.find(d => d._id.toString() === accId)?.total || 0;
    const credits = creditTotals.find(c => c._id.toString() === accId)?.total || 0;

    let balance;
    if (acc.normalBalance === 'Debit') {
      balance = debits - credits;
    } else {
      balance = credits - debits;
    }

    if (Math.abs(balance) < 0.005) continue; // skip zero balances

    openingEntries.push({ acc, balance });
  }

  if (openingEntries.length === 0) {
    throw new ApiError(400, 'No non-zero balance-sheet balances found to carry forward');
  }

  // Find a "Retained Earnings" or equity account to use as the offset
  const retainedEarningsAcc = bsAccounts.find(a => /retained earnings/i.test(a.accountName));
  if (!retainedEarningsAcc) throw new ApiError(500, 'Retained Earnings account not found');

  const openingDate  = new Date(newFY.startDate);
  const userId_oid   = _validId(userId);
  const batchId      = new mongoose.Types.ObjectId().toString();
  const createdIds   = [];

  for (const { acc, balance } of openingEntries) {
    // Skip the retained earnings account itself (it's the offset account)
    if (acc._id.toString() === retainedEarningsAcc._id.toString()) continue;

    const absBalance = Math.abs(balance);
    const isDebitBalance = balance > 0;

    // Determine debit/credit sides:
    // - Debit-normal assets with positive balance: DR [asset] / CR Retained Earnings
    // - Credit-normal liabilities: DR Retained Earnings / CR [liability]
    const debitAccId  = acc.normalBalance === 'Debit'  ? acc._id : retainedEarningsAcc._id;
    const creditAccId = acc.normalBalance === 'Credit' ? acc._id : retainedEarningsAcc._id;

    // Skip if debit === credit (would fail schema validation)
    if (debitAccId.toString() === creditAccId.toString()) continue;

    const entry = await JournalEntry.create({
      businessId:       bizId,
      transactionDate:  openingDate,
      description:      `Opening Balance: ${acc.accountName}`,
      transactionType:  TRANSACTION_TYPES.OPENING_BALANCE,
      amount:           absBalance,
      debitAccountId:   debitAccId,
      creditAccountId:  creditAccId,
      status:           JOURNAL_STATUS.POSTED,
      inputMethod:      INPUT_METHODS.FORM,
      createdBy:        userId_oid,
      lastModifiedBy:   userId_oid,
      fiscalYearId:     newFY._id,
      entryType:        'opening_balance',
      closingBatchId:   batchId,
      transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
    });
    createdIds.push(entry._id);
  }

  // Update new fiscal year with opening balance reference
  newFY.openingBalanceEntryId = createdIds[0] || null;
  newFY.auditTrail.push({
    action:      'opening_balances_created',
    performedBy: userId_oid,
    reason:      `${createdIds.length} opening balance entries created from FY "${prevFY.name}"`,
  });
  await newFY.save();

  reportCache.invalidate(businessId.toString());
  logger.info(`Opening balances created for "${newFY.name}": ${createdIds.length} entries`);

  return {
    newFiscalYear:   newFY,
    previousFiscalYear: prevFY.name,
    entriesCreated:  createdIds.length,
    closingBatchId:  batchId,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
   5. ADJUSTING ENTRIES
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Create an adjusting entry (accrual, deferral, year-end adjustment).
 * These are normal journal entries flagged with entryType='adjusting'.
 * They bypass period lock checks (service layer uses entryType to skip).
 */
async function createAdjustingEntry(businessId, {
  transactionDate,
  description,
  amount,
  debitAccountId,
  creditAccountId,
  adjustingType,
  fiscalYearId,
  periodId,
  notes,
}, userId) {
  const bizId = _validId(businessId);

  if (!adjustingType || !['accrual', 'deferral', 'year_end', 'depreciation'].includes(adjustingType)) {
    throw new ApiError(400, 'adjustingType must be: accrual | deferral | year_end | depreciation');
  }

  // Verify accounts belong to this business
  const [debitAcc, creditAcc] = await Promise.all([
    ChartOfAccount.findOne({ _id: _validId(debitAccountId), businessId: bizId }).lean(),
    ChartOfAccount.findOne({ _id: _validId(creditAccountId), businessId: bizId }).lean(),
  ]);
  if (!debitAcc)  throw new ApiError(400, 'Invalid debit account');
  if (!creditAcc) throw new ApiError(400, 'Invalid credit account');
  if (debitAcc._id.toString() === creditAcc._id.toString()) {
    throw new ApiError(400, 'Debit and credit accounts must be different');
  }

  const entry = await JournalEntry.create({
    businessId:       bizId,
    transactionDate:  new Date(transactionDate),
    description,
    transactionType:  TRANSACTION_TYPES.ADJUSTING_ENTRY,
    amount:           Number(amount),
    debitAccountId:   _validId(debitAccountId),
    creditAccountId:  _validId(creditAccountId),
    status:           JOURNAL_STATUS.POSTED,
    inputMethod:      INPUT_METHODS.FORM,
    createdBy:        _validId(userId),
    lastModifiedBy:   _validId(userId),
    entryType:        'adjusting',
    adjustingType,
    fiscalYearId:     fiscalYearId ? _validId(fiscalYearId) : null,
    periodId:         periodId     ? _validId(periodId)     : null,
    notes:            notes || null,
    transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
  });

  reportCache.invalidate(businessId.toString());
  logger.info(`Adjusting entry (${adjustingType}) created for business ${businessId}`);
  return entry;
}

/* ══════════════════════════════════════════════════════════════════════════════
   INTERNAL HELPERS
══════════════════════════════════════════════════════════════════════════════ */

async function _getDebitCreditTotals(businessId, asOfDate) {
  const bizId = _validId(businessId);
  const result = await JournalEntry.aggregate([
    {
      $match: {
        businessId: bizId,
        transactionDate: { $lte: new Date(asOfDate) },
        status: { $in: [JOURNAL_STATUS.POSTED, JOURNAL_STATUS.PARTIALLY_SETTLED, JOURNAL_STATUS.SETTLED] },
        isArchived: { $ne: true },
      },
    },
    {
      $facet: {
        debitTotals:  [{ $group: { _id: '$debitAccountId',  total: { $sum: '$amount' } } }],
        creditTotals: [{ $group: { _id: '$creditAccountId', total: { $sum: '$amount' } } }],
      },
    },
  ]);
  return result[0] || { debitTotals: [], creditTotals: [] };
}

/* ══════════════════════════════════════════════════════════════════════════════
   6. FISCAL YEAR LOCK
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Lock a closed fiscal year (CLOSED → LOCKED). Admin only.
 */
async function lockFiscalYear(businessId, fiscalYearId, userId, reason = '') {
  const bizId = _validId(businessId);
  const fy = await FiscalYear.findOne({ _id: _validId(fiscalYearId), businessId: bizId });
  if (!fy) throw new ApiError(404, 'Fiscal year not found');
  if (fy.status !== FISCAL_YEAR_STATUS.CLOSED) throw new ApiError(400, 'Only a CLOSED fiscal year can be locked');

  fy.status = FISCAL_YEAR_STATUS.LOCKED;
  fy.auditTrail.push({ action: AUDIT_ACTIONS.PERIOD_LOCKED, performedBy: _validId(userId), reason });
  await fy.save();

  // Lock all periods of this fiscal year
  await AccountingPeriod.updateMany(
    { fiscalYearId: fy._id },
    {
      $set:  { status: PERIOD_STATUS.LOCKED },
      $push: { auditTrail: { action: AUDIT_ACTIONS.PERIOD_LOCKED, performedBy: _validId(userId), reason: 'Locked with fiscal year' } },
    }
  );

  reportCache.invalidate(businessId.toString());
  return fy;
}

module.exports = {
  createFiscalYear,
  listFiscalYears,
  listPeriods,
  closePeriod,
  lockPeriod,
  reopenPeriod,
  runClosingEntries,
  createOpeningBalances,
  createAdjustingEntry,
  lockFiscalYear,
};
