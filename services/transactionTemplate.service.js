// services/transactionTemplate.service.js
//
// Feature #5 — Recurring / Template transactions.
//
// Responsibilities:
//   1. CRUD for TransactionTemplate documents.
//   2. applyTemplate()        — turn a template into a real transaction NOW
//                               (routed through the approval gate).
//   3. generateDueRecurring() — cron: post transactions for every due recurring
//                               template, then advance nextRunDate.
//
// All posting goes through approvalService.submitOrPost → which either posts via
// transactionService.createTransaction or parks a PendingTransaction for review.
// The template never writes to the ledger directly.
//
'use strict';
const mongoose = require('mongoose');
const templateRepository = require('../repositories/transactionTemplate.repository');
const accountRepository = require('../repositories/account.repository');
const auditService = require('./audit.service');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const {
  RECURRENCE_PATTERNS, ENTITY_TYPES, AUDIT_ACTIONS, TRANSACTION_ENTRY_SOURCES,
} = require('../config/constants');

class TransactionTemplateService {
  _validateId(id, label = 'id') {
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(400, `Invalid ${label}`);
    }
  }

  /** Advance a date by one recurrence period. */
  computeNextRunDate(pattern, from) {
    const d = new Date(from);
    switch (pattern) {
      case RECURRENCE_PATTERNS.WEEKLY:    d.setDate(d.getDate() + 7);          break;
      case RECURRENCE_PATTERNS.BIWEEKLY:  d.setDate(d.getDate() + 14);         break;
      case RECURRENCE_PATTERNS.MONTHLY:   d.setMonth(d.getMonth() + 1);        break;
      case RECURRENCE_PATTERNS.QUARTERLY: d.setMonth(d.getMonth() + 3);        break;
      case RECURRENCE_PATTERNS.ANNUAL:    d.setFullYear(d.getFullYear() + 1);  break;
      default: throw new ApiError(400, `Unknown recurrence pattern: ${pattern}`);
    }
    return d;
  }

  /** Validate that both accounts exist for the business and differ. */
  async _validateAccounts(businessId, debitAccountId, creditAccountId) {
    if (!debitAccountId || !creditAccountId) {
      throw new ApiError(400, 'Both a debit and a credit account are required');
    }
    if (String(debitAccountId) === String(creditAccountId)) {
      throw new ApiError(400, 'Debit and credit accounts must be different');
    }
    const [debit, credit] = await Promise.all([
      accountRepository.findOneByBusinessAndId(businessId, debitAccountId),
      accountRepository.findOneByBusinessAndId(businessId, creditAccountId),
    ]);
    if (!debit || !credit) throw new ApiError(400, 'Invalid account(s) for this business');
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────
  async create(businessId, data, actor) {
    this._validateId(businessId, 'businessId');
    if (!data.name)        throw new ApiError(400, 'Template name is required');
    if (!data.description) throw new ApiError(400, 'Description is required');
    if (!(Number(data.amount) > 0)) throw new ApiError(400, 'Amount must be greater than zero');
    await this._validateAccounts(businessId, data.debitAccountId, data.creditAccountId);

    const isRecurring = !!data.isRecurring;
    let startDate = null, nextRunDate = null;
    if (isRecurring) {
      if (!data.recurrencePattern || !Object.values(RECURRENCE_PATTERNS).includes(data.recurrencePattern)) {
        throw new ApiError(400, 'A valid recurrencePattern is required for a recurring template');
      }
      startDate   = data.startDate ? new Date(data.startDate) : new Date();
      nextRunDate = startDate;
    }

    const tpl = await templateRepository.create({
      businessId,
      name:        data.name,
      description: data.description,
      transactionType: data.transactionType || null,
      amount:      Number(data.amount),
      debitAccountId:  data.debitAccountId,
      creditAccountId: data.creditAccountId,
      partyType:   data.partyType || null,
      partyName:   data.partyName ? String(data.partyName).trim() : null,
      paymentMethod:        data.paymentMethod || null,
      transactionReference: data.transactionReference || null,
      notes:                data.notes || null,
      currencyCode:         data.currencyCode || null,
      isRecurring,
      recurrencePattern: isRecurring ? data.recurrencePattern : null,
      startDate,
      endDate:     data.endDate ? new Date(data.endDate) : null,
      nextRunDate,
      isActive:    true,
      createdBy:   actor.id,
      lastModifiedBy: actor.id,
    });

    try {
      await auditService.log({
        businessId, entityType: ENTITY_TYPES.TRANSACTION_TEMPLATE, entityId: tpl._id,
        action: AUDIT_ACTIONS.CREATED, performedBy: actor.id, performedByName: actor.fullName,
        afterState: { name: tpl.name, isRecurring, recurrencePattern: tpl.recurrencePattern },
      });
    } catch (e) { /* best-effort: audit-log write; the template was already persisted */ logger.warn(`[template] audit failed: ${e.message}`); }

    logger.info(`[template] created ${tpl._id} (recurring=${isRecurring})`);
    return tpl;
  }

  async list(businessId, { isActive } = {}) {
    return templateRepository.findByBusiness(businessId, { isActive });
  }

  async getById(id, businessId) {
    this._validateId(id, 'templateId');
    const tpl = await templateRepository.findOneByBusinessAndId(businessId, id);
    if (!tpl) throw new ApiError(404, 'Template not found');
    return tpl;
  }

  async update(id, businessId, data, actor) {
    const tpl = await this.getById(id, businessId);

    if (data.debitAccountId || data.creditAccountId) {
      await this._validateAccounts(
        businessId,
        data.debitAccountId  || tpl.debitAccountId,
        data.creditAccountId || tpl.creditAccountId,
      );
    }

    const editable = [
      'name', 'description', 'transactionType', 'amount',
      'debitAccountId', 'creditAccountId', 'partyType', 'partyName',
      'paymentMethod', 'transactionReference', 'notes', 'currencyCode',
      'endDate', 'isActive',
    ];
    for (const k of editable) if (data[k] !== undefined) tpl[k] = data[k];

    // Recurrence changes
    if (data.isRecurring !== undefined) {
      tpl.isRecurring = !!data.isRecurring;
      if (tpl.isRecurring) {
        const pattern = data.recurrencePattern || tpl.recurrencePattern;
        if (!pattern || !Object.values(RECURRENCE_PATTERNS).includes(pattern)) {
          throw new ApiError(400, 'A valid recurrencePattern is required for a recurring template');
        }
        tpl.recurrencePattern = pattern;
        if (!tpl.startDate)   tpl.startDate   = data.startDate ? new Date(data.startDate) : new Date();
        if (!tpl.nextRunDate) tpl.nextRunDate = tpl.startDate;
      } else {
        tpl.recurrencePattern = null;
        tpl.nextRunDate = null;
      }
    } else if (data.recurrencePattern && tpl.isRecurring) {
      tpl.recurrencePattern = data.recurrencePattern;
    }

    tpl.lastModifiedBy = actor.id;
    await tpl.save();
    return tpl.toJSON();
  }

  async remove(id, businessId) {
    this._validateId(id, 'templateId');
    const tpl = await templateRepository.findOneByBusinessAndId(businessId, id);
    if (!tpl) throw new ApiError(404, 'Template not found');
    await tpl.deleteOne();
    return { _id: id, deleted: true };
  }

  /**
   * Build the transaction-data object createTransaction expects from a template,
   * merging any per-apply overrides (date, amount, description, party).
   */
  buildTransactionData(tpl, overrides = {}) {
    const data = {
      businessId:      tpl.businessId,
      transactionDate: overrides.transactionDate || new Date(),
      description:     overrides.description || tpl.description,
      amount:          overrides.amount != null ? Number(overrides.amount) : tpl.amount,
      debitAccountId:  tpl.debitAccountId,
      creditAccountId: tpl.creditAccountId,
      inputMethod:     'form',
      ...(tpl.transactionType      ? { transactionType: tpl.transactionType } : {}),
      ...(tpl.paymentMethod        ? { paymentMethod: tpl.paymentMethod } : {}),
      ...(tpl.transactionReference ? { transactionReference: tpl.transactionReference } : {}),
      ...(tpl.notes                ? { notes: tpl.notes } : {}),
      ...(tpl.currencyCode         ? { currencyCode: tpl.currencyCode } : {}),
    };
    // Party — map stored partyType/partyName to the field createTransaction
    // find-or-creates from. Per-apply override wins.
    const partyName = overrides.partyName || tpl.partyName;
    const partyType = overrides.partyType || tpl.partyType;
    if (partyName && partyType === 'customer') data.customerName = partyName;
    if (partyName && partyType === 'vendor')   data.vendorName   = partyName;
    return data;
  }

  /**
   * Apply a template NOW — posts a real transaction (or parks it for approval).
   * Returns whatever approvalService.submitOrPost returns
   * ({ pendingApproval, ... } or the posted transaction).
   */
  async applyTemplate(id, businessId, actor, ipAddress, overrides = {}) {
    const tpl = await this.getById(id, businessId);
    if (!tpl.isActive) throw new ApiError(400, 'This template is inactive');
    const txData = this.buildTransactionData(tpl, overrides);
    const approvalService = require('./approval.service'); // lazy — avoid require cycle
    return approvalService.submitOrPost(txData, actor, ipAddress, {
      source: TRANSACTION_ENTRY_SOURCES.FORM,
    });
  }

  // ── Cron: generate due recurring transactions ────────────────────────────────
  /**
   * For every active recurring template whose nextRunDate has arrived, post a
   * transaction (through the approval gate) and advance nextRunDate. A failure
   * on one template never aborts the rest. Idempotent at the template level via
   * the nextRunDate guard.
   * @returns {Promise<{generated:number, pending:number, scanned:number}>}
   */
  async generateDueRecurring(now = new Date()) {
    const approvalService = require('./approval.service');
    const TransactionTemplate = require('../models/TransactionTemplate.model');

    // Find IDs of all potentially due templates (just IDs — quick scan)
    const candidates = await TransactionTemplate.find(
      {
        isActive: true,
        isRecurring: true,
        nextRunDate: { $ne: null, $lte: now },
        $or: [{ endDate: null }, { endDate: { $gte: now } }],
      },
      { _id: 1, nextRunDate: 1, recurrencePattern: 1 }
    ).lean();

    let generated = 0, pending = 0, scanned = candidates.length;

    for (const candidate of candidates) {
      // Atomically claim this template by advancing nextRunDate.
      // If another process already claimed it, findOneAndUpdate returns null → skip.
      const tpl = await TransactionTemplate.findOneAndUpdate(
        {
          _id: candidate._id,
          isActive: true,
          isRecurring: true,
          nextRunDate: candidate.nextRunDate, // exact match — prevents double-claim
        },
        {
          $set: {
            nextRunDate: this.computeNextRunDate(candidate.recurrencePattern, candidate.nextRunDate),
            lastRunDate: now,
          },
          $inc: { runCount: 1 },
        },
        { new: false } // return the OLD doc so we process it with its original values
      );

      if (!tpl) {
        // Another process claimed this template — skip
        logger.info(`[recurring] Template ${candidate._id} already claimed — skipping`);
        continue;
      }

      try {
        const actor = { id: tpl.createdBy, fullName: 'Recurring Scheduler' };
        const txData = this.buildTransactionData(tpl, { transactionDate: now });
        const result = await approvalService.submitOrPost(txData, actor, null, {
          source: TRANSACTION_ENTRY_SOURCES.RECURRING,
          recurringTemplateId: tpl._id,
        });
        if (result.pendingApproval) pending++; else generated++;

        try {
          await auditService.log({
            businessId: tpl.businessId, entityType: ENTITY_TYPES.TRANSACTION_TEMPLATE, entityId: tpl._id,
            action: AUDIT_ACTIONS.RECURRING_GENERATED, performedBy: tpl.createdBy,
            performedByName: 'Recurring Scheduler',
            afterState: { posted: !result.pendingApproval },
          });
        } catch (_) { /* audit best-effort */ }
      } catch (err) {
        logger.error(`[recurring] Failed to post template ${tpl._id}: ${err.message}`);
        // On failure, roll back the nextRunDate so it retries next cron run
        try {
          await TransactionTemplate.findByIdAndUpdate(tpl._id, {
            $set: { nextRunDate: tpl.nextRunDate }, // restore original nextRunDate
            $inc: { runCount: -1 },
          });
        } catch (rollbackErr) {
          logger.warn(`[recurring] Rollback failed for template ${tpl._id}: ${rollbackErr.message}`);
        }
      }
    }

    logger.info(`[recurring] scanned=${scanned} generated=${generated} pending=${pending}`);
    return { generated, pending, scanned };
  }
}

module.exports = new TransactionTemplateService();
