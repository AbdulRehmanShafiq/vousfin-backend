// services/recognitionSchedule.service.js
//
// Phase 4 — Accrual accounting engine.
//
// Creates and runs revenue/expense recognition schedules (deferred revenue +
// prepaid expenses). Each schedule pre-computes straight-line period slices; a
// daily job posts each slice's adjusting journal entry once its date arrives,
// through the atomic ledgerPosting.postBalancedJournal so the running balances
// and the journal always commit together.
//
//   deferred_revenue:  DR Unearned Revenue (liability)  CR Revenue
//   prepaid_expense:   DR Expense                       CR Prepaid Expenses (asset)
//
'use strict';

const mongoose = require('mongoose');
const RecognitionSchedule = require('../models/RecognitionSchedule.model');
const ChartOfAccount = require('../models/ChartOfAccount.model');
const { postBalancedJournal } = require('./ledgerPosting.service');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const {
  TRANSACTION_TYPES, TRANSACTION_SOURCES, JOURNAL_STATUS, INPUT_METHODS,
} = require('../config/constants');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// Default holding accounts (seeded in DEFAULT_ACCOUNTS) used when the caller
// doesn't specify one.
const DEFAULT_DEFERRAL_CODE = { deferred_revenue: '2170', prepaid_expense: '1120' };
// What account types each side must be — enforced so the schedule can't post a
// nonsensical entry (e.g. recognizing deferred revenue into an asset account).
const REQUIRED_TYPES = {
  deferred_revenue: { deferral: 'Liability', recognition: 'Revenue' },
  prepaid_expense:  { deferral: 'Asset',     recognition: 'Expense' },
};

function addMonths(date, n) {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + n);
  // Guard month-overflow (e.g. Jan 31 + 1mo): clamp to last day of target month.
  if (d.getDate() < day) d.setDate(0);
  return d;
}

class RecognitionScheduleService {
  _validateId(id, label = 'id') {
    if (!id || !mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, `Invalid ${label}`);
  }

  /**
   * Split a total into `periods` straight-line slices (2dp). Every slice is
   * equal except the LAST, which absorbs the rounding remainder so the slices
   * sum back to exactly totalAmount.
   */
  buildLines(totalAmount, startDate, periods) {
    const total = r2(totalAmount);
    const per = r2(total / periods);
    const lines = [];
    let allocated = 0;
    for (let i = 1; i <= periods; i++) {
      const isLast = i === periods;
      const amount = isLast ? r2(total - allocated) : per;
      allocated = r2(allocated + amount);
      lines.push({
        periodNumber: i,
        scheduledDate: addMonths(startDate, i - 1), // first slice on startDate
        amount,
        status: 'pending',
        journalEntryId: null,
        postedAt: null,
      });
    }
    return lines;
  }

  async _resolveAccount(businessId, accountId, code) {
    if (accountId) {
      this._validateId(accountId, 'accountId');
      return ChartOfAccount.findOne({ _id: accountId, businessId }).lean();
    }
    if (code) return ChartOfAccount.findOne({ businessId, accountCode: code }).lean();
    return null;
  }

  /**
   * Create a recognition schedule.
   * @param {string} businessId
   * @param {Object} data { type, description, totalAmount, startDate, periods,
   *                        recognitionAccountId, deferralAccountId?, currencyCode?,
   *                        sourceType?, sourceId? }
   * @param {Object} actor { _id }
   */
  async createSchedule(businessId, data, actor) {
    this._validateId(businessId, 'businessId');
    const type = data.type;
    if (!REQUIRED_TYPES[type]) {
      throw new ApiError(400, `type must be one of: ${Object.keys(REQUIRED_TYPES).join(', ')}`);
    }
    const totalAmount = r2(data.totalAmount);
    if (!(totalAmount > 0)) throw new ApiError(400, 'totalAmount must be greater than zero');
    const periods = parseInt(data.periods, 10);
    if (!(periods >= 1)) throw new ApiError(400, 'periods must be at least 1');
    const startDate = data.startDate ? new Date(data.startDate) : new Date();
    if (Number.isNaN(startDate.getTime())) throw new ApiError(400, 'startDate is invalid');

    // Resolve + validate the two accounts.
    const deferralAcc = await this._resolveAccount(businessId, data.deferralAccountId, DEFAULT_DEFERRAL_CODE[type]);
    if (!deferralAcc) throw new ApiError(400, `Holding account not found (expected ${REQUIRED_TYPES[type].deferral}). Provide deferralAccountId or seed default ${DEFAULT_DEFERRAL_CODE[type]}.`);
    const recognitionAcc = await this._resolveAccount(businessId, data.recognitionAccountId, null);
    if (!recognitionAcc) throw new ApiError(400, 'recognitionAccountId is required and must belong to this business');

    if (String(deferralAcc._id) === String(recognitionAcc._id)) {
      throw new ApiError(400, 'Holding and recognition accounts must be different');
    }
    if (deferralAcc.accountType !== REQUIRED_TYPES[type].deferral) {
      throw new ApiError(400, `Holding account must be of type ${REQUIRED_TYPES[type].deferral} for ${type}`);
    }
    if (recognitionAcc.accountType !== REQUIRED_TYPES[type].recognition) {
      throw new ApiError(400, `Recognition account must be of type ${REQUIRED_TYPES[type].recognition} for ${type}`);
    }

    const lines = this.buildLines(totalAmount, startDate, periods);

    const schedule = await RecognitionSchedule.create({
      businessId,
      type,
      description: (data.description || '').trim() || `${type === 'deferred_revenue' ? 'Deferred revenue' : 'Prepaid expense'} schedule`,
      sourceType: data.sourceType || 'manual',
      sourceId:   data.sourceId || null,
      totalAmount,
      currencyCode: (data.currencyCode || 'PKR').toUpperCase(),
      startDate,
      periods,
      deferralAccountId:    deferralAcc._id,
      recognitionAccountId: recognitionAcc._id,
      status: 'active',
      lines,
      recognizedAmount: 0,
      createdBy: actor?._id || null,
      lastModifiedBy: actor?._id || null,
    });
    logger.info(`[recognition] created ${type} schedule ${schedule._id} (${periods} periods, ${totalAmount})`);
    return schedule;
  }

  /**
   * Post every recognition line that is due (scheduledDate <= asOf) and still
   * pending, across active schedules. Safe to run repeatedly — only pending
   * lines are posted, so it never double-recognizes.
   *
   * @param {string|null} businessId  limit to one business, or null for all
   * @param {Date} asOf
   * @returns {Promise<{schedules:number, linesPosted:number, errors:number}>}
   */
  async postDueRecognitions(businessId = null, asOf = new Date()) {
    const query = { status: 'active', 'lines.status': 'pending', 'lines.scheduledDate': { $lte: asOf } };
    if (businessId) query.businessId = businessId;

    const schedules = await RecognitionSchedule.find(query);
    let linesPosted = 0;
    let errors = 0;

    for (const schedule of schedules) {
      const isDeferredRev = schedule.type === 'deferred_revenue';
      let touched = false;

      for (const line of schedule.lines) {
        if (line.status !== 'pending') continue;
        if (new Date(line.scheduledDate) > asOf) continue;
        if (!(line.amount > 0)) { line.status = 'posted'; line.postedAt = new Date(); touched = true; continue; }

        try {
          const je = await postBalancedJournal({
            businessId:        schedule.businessId,
            transactionDate:   line.scheduledDate,
            description:       `${isDeferredRev ? 'Revenue recognition' : 'Expense amortization'} — ${schedule.description} (${line.periodNumber}/${schedule.periods})`,
            transactionType:   TRANSACTION_TYPES.JOURNAL_ENTRY, // adjusting entry
            amount:            line.amount,
            // deferred revenue: DR holding(liability) → CR revenue
            // prepaid expense:  DR expense            → CR holding(asset)
            debitAccountId:    isDeferredRev ? schedule.deferralAccountId : schedule.recognitionAccountId,
            creditAccountId:   isDeferredRev ? schedule.recognitionAccountId : schedule.deferralAccountId,
            status:            JOURNAL_STATUS.POSTED,
            transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
            inputMethod:       INPUT_METHODS.FORM,
            currencyCode:      schedule.currencyCode,
            createdBy:         schedule.createdBy,
            lastModifiedBy:    schedule.createdBy,
            // One journal per schedule line, forever. This runs on a cron: a
            // re-run, or a crash between posting and saving line.status, would
            // otherwise recognise the same period's revenue (or amortise the
            // same prepaid) a second time.
            idempotencyKey:    `recognition:${schedule._id}:${line.periodNumber}`,
          });
          line.status = 'posted';
          line.journalEntryId = je._id;
          line.postedAt = new Date();
          schedule.recognizedAmount = r2(schedule.recognizedAmount + line.amount);
          linesPosted += 1;
          touched = true;
        } catch (e) {
          errors += 1;
          logger.error(`[recognition] failed to post line ${line.periodNumber} of schedule ${schedule._id}: ${e.message}`);
          // Leave the line pending so the next run retries it; keep going.
        }
      }

      if (touched) {
        if (schedule.lines.every((l) => l.status === 'posted')) schedule.status = 'completed';
        try { await schedule.save(); }
        catch (e) { errors += 1; logger.error(`[recognition] failed to save schedule ${schedule._id}: ${e.message}`); }
      }
    }

    if (linesPosted > 0 || errors > 0) {
      logger.info(`[recognition] postDueRecognitions: ${linesPosted} lines posted, ${errors} errors across ${schedules.length} schedules`);
    }
    return { schedules: schedules.length, linesPosted, errors };
  }

  async cancelSchedule(businessId, id, actor) {
    this._validateId(id, 'scheduleId');
    const schedule = await RecognitionSchedule.findOne({ _id: id, businessId });
    if (!schedule) throw new ApiError(404, 'Recognition schedule not found');
    if (schedule.status === 'cancelled') return schedule;
    schedule.status = 'cancelled';
    schedule.lastModifiedBy = actor?._id || null;
    await schedule.save();
    logger.info(`[recognition] cancelled schedule ${id} (already-posted lines retained)`);
    return schedule;
  }

  async getById(businessId, id) {
    this._validateId(id, 'scheduleId');
    const schedule = await RecognitionSchedule.findOne({ _id: id, businessId }).lean();
    if (!schedule) throw new ApiError(404, 'Recognition schedule not found');
    return schedule;
  }

  async list(businessId, { type = null, status = null } = {}) {
    this._validateId(businessId, 'businessId');
    const q = { businessId };
    if (type) q.type = type;
    if (status) q.status = status;
    return RecognitionSchedule.find(q).sort({ createdAt: -1 }).lean();
  }
}

module.exports = new RecognitionScheduleService();
