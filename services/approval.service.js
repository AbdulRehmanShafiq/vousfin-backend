// services/approval.service.js
//
// Feature #6 — Approval workflow.
//
// The ONE gate every "create a transaction" path can call. Given a fully-built
// transaction-data object it decides:
//
//   • approval NOT required → post immediately via transactionService.createTransaction
//   • approval required      → park a PendingTransaction (review queue), post nothing
//
// On approve() it posts the parked payload through the exact same authoritative
// path, so tax / AR-AP / period-locks all still apply, and links the resulting
// immutable JournalEntry back to the request. Reject / cancel never post.
//
'use strict';
const mongoose = require('mongoose');
const Business = require('../models/Business.model');
const PendingTransaction = require('../models/PendingTransaction.model');
const pendingRepository = require('../repositories/pendingTransaction.repository');
const transactionService = require('./transaction.service');
const auditService = require('./audit.service');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const {
  PENDING_TRANSACTION_STATUS, ENTITY_TYPES, AUDIT_ACTIONS, TRANSACTION_ENTRY_SOURCES,
} = require('../config/constants');

const DEFAULT_SETTINGS = { enabled: false, threshold: 0, allowSelfApproval: true };

class ApprovalService {
  _validateId(id, label = 'id') {
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(400, `Invalid ${label}`);
    }
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  async getSettings(businessId) {
    const biz = await Business.findById(businessId).select('approvalSettings').lean();
    return { ...DEFAULT_SETTINGS, ...(biz?.approvalSettings || {}) };
  }

  async updateSettings(businessId, data, actor) {
    const update = {};
    if (data.enabled !== undefined)           update['approvalSettings.enabled'] = !!data.enabled;
    if (data.threshold !== undefined) {
      const t = Number(data.threshold);
      if (!Number.isFinite(t) || t < 0) throw new ApiError(400, 'threshold must be a non-negative number');
      update['approvalSettings.threshold'] = t;
    }
    if (data.allowSelfApproval !== undefined)  update['approvalSettings.allowSelfApproval'] = !!data.allowSelfApproval;

    const biz = await Business.findByIdAndUpdate(
      businessId, { $set: update }, { new: true }
    ).select('approvalSettings').lean();
    if (!biz) throw new ApiError(404, 'Business not found');

    try {
      await auditService.log({
        businessId, entityType: ENTITY_TYPES.BUSINESS, entityId: businessId,
        action: AUDIT_ACTIONS.EDITED, performedBy: actor.id, performedByName: actor.fullName,
        afterState: { approvalSettings: biz.approvalSettings },
      });
    } catch (e) { /* best-effort: audit-log write; settings were already saved */ logger.warn(`[approval] settings audit failed: ${e.message}`); }

    return { ...DEFAULT_SETTINGS, ...(biz.approvalSettings || {}) };
  }

  /** Decide whether an amount needs approval for this business. */
  async evaluate(businessId, amount) {
    const s = await this.getSettings(businessId);
    const required = !!s.enabled && Number(amount) > Number(s.threshold || 0);
    return { required, enabled: !!s.enabled, threshold: Number(s.threshold || 0) };
  }

  /** Whether `actor` is allowed to approve/reject for this business. */
  _canApprove(actor, business, pending) {
    const isOwner = String(business.userId) === String(actor.id);
    const isAdmin = actor.role === 'admin';
    if (!isOwner && !isAdmin) return false;
    // Segregation of duties: optionally block approving your own submission.
    const settings = { ...DEFAULT_SETTINGS, ...(business.approvalSettings || {}) };
    if (!settings.allowSelfApproval && pending &&
        String(pending.submittedBy) === String(actor.id) && !isAdmin) {
      return false;
    }
    return true;
  }

  // ── The gate ────────────────────────────────────────────────────────────────
  /**
   * Post the transaction now, or park it for approval.
   * @returns {Promise<{pendingApproval:boolean, transaction?:Object, pendingTransaction?:Object, threshold?:number}>}
   */
  async submitOrPost(txData, actor, ipAddress, opts = {}) {
    const businessId = txData.businessId;
    if (!businessId) throw new ApiError(400, 'businessId is required');
    const amount = Number(txData.amount) || 0;

    const decision = await this.evaluate(businessId, amount);
    if (!decision.required) {
      const transaction = await transactionService.createTransaction(txData, actor.id, ipAddress);
      return { pendingApproval: false, transaction };
    }

    const pending = await pendingRepository.create({
      businessId,
      description:     txData.description,
      amount,
      transactionDate: txData.transactionDate || new Date(),
      transactionType: txData.transactionType || null,
      debitAccountId:  txData.debitAccountId  || null,
      creditAccountId: txData.creditAccountId || null,
      payload:         txData,
      source:          opts.source || TRANSACTION_ENTRY_SOURCES.FORM,
      recurringTemplateId: opts.recurringTemplateId || null,
      status:          PENDING_TRANSACTION_STATUS.PENDING,
      submittedBy:     actor.id,
      submittedAt:     new Date(),
    });

    try {
      await auditService.log({
        businessId, entityType: ENTITY_TYPES.PENDING_TRANSACTION, entityId: pending._id,
        action: AUDIT_ACTIONS.SUBMITTED, performedBy: actor.id, performedByName: actor.fullName,
        ipAddress, afterState: { amount, description: txData.description, threshold: decision.threshold },
      });
    } catch (e) { /* best-effort: audit-log write; the pending transaction was already parked */ logger.warn(`[approval] submit audit failed: ${e.message}`); }

    logger.info(`[approval] parked pending ${pending._id} (amount=${amount} > threshold=${decision.threshold})`);
    return { pendingApproval: true, pendingTransaction: pending, threshold: decision.threshold };
  }

  // ── Queue read ────────────────────────────────────────────────────────────
  async list(businessId, opts = {}) {
    return pendingRepository.findByBusiness(businessId, opts);
  }

  async pendingCount(businessId) {
    return pendingRepository.countByStatus(businessId, PENDING_TRANSACTION_STATUS.PENDING);
  }

  async getById(id, businessId) {
    this._validateId(id, 'pendingTransactionId');
    const p = await pendingRepository.findOneByBusinessAndId(businessId, id);
    if (!p) throw new ApiError(404, 'Pending transaction not found');
    return p;
  }

  // ── Decisions ───────────────────────────────────────────────────────────────
  async approve(id, businessId, actor, ipAddress, note = null) {
    const pending = await this.getById(id, businessId);
    if (!PendingTransaction.canTransition(pending.status, PENDING_TRANSACTION_STATUS.APPROVED)) {
      throw new ApiError(409, `Cannot approve a transaction that is already ${pending.status}`);
    }

    const business = await Business.findById(businessId).select('userId approvalSettings').lean();
    if (!business) throw new ApiError(404, 'Business not found');
    if (!this._canApprove(actor, business, pending)) {
      throw new ApiError(403, 'You are not allowed to approve this transaction');
    }

    // Post through the one authoritative path. Preserve the original author as
    // createdBy; stamp the approver into metadata for the audit trail.
    const payload = {
      ...pending.payload,
      businessId,
      metadata: {
        ...(pending.payload?.metadata || {}),
        approvedBy: String(actor.id),
        approvedByName: actor.fullName,
        pendingTransactionId: String(pending._id),
      },
    };
    const transaction = await transactionService.createTransaction(payload, pending.submittedBy, ipAddress);
    const jeId = transaction?._id || transaction?.id;

    // Atomic, idempotent flip pending → approved (guard against a double-click race).
    const updated = await PendingTransaction.findOneAndUpdate(
      { _id: pending._id, status: PENDING_TRANSACTION_STATUS.PENDING },
      {
        $set: {
          status: PENDING_TRANSACTION_STATUS.APPROVED,
          reviewedBy: actor.id, reviewedAt: new Date(),
          decisionNote: note || null, postedJournalEntryId: jeId || null,
        },
      },
      { new: true }
    );
    if (!updated) {
      // Lost the race — another approver already posted. The JE we just created
      // would be a duplicate, so reverse it to keep the ledger correct.
      if (jeId) {
        try {
          await transactionService.reverseTransaction(jeId, businessId,
            { reason: 'Duplicate approval — auto-reversed' }, actor.id, ipAddress);
        } catch (e) { logger.error(`[approval] duplicate-approval reversal failed: ${e.message}`); }
      }
      throw new ApiError(409, 'This transaction was already processed by someone else');
    }

    try {
      await auditService.log({
        businessId, entityType: ENTITY_TYPES.PENDING_TRANSACTION, entityId: pending._id,
        action: AUDIT_ACTIONS.APPROVED, performedBy: actor.id, performedByName: actor.fullName,
        ipAddress, beforeState: { status: 'pending' },
        afterState: { status: 'approved', journalEntryId: jeId },
      });
    } catch (e) { /* best-effort: audit-log write; the approval and JE were already committed */ logger.warn(`[approval] approve audit failed: ${e.message}`); }

    logger.info(`[approval] approved ${pending._id} → posted JE ${jeId}`);
    return { pendingTransaction: updated.toJSON(), transaction };
  }

  async reject(id, businessId, actor, ipAddress, reason = null) {
    const pending = await this.getById(id, businessId);
    if (!PendingTransaction.canTransition(pending.status, PENDING_TRANSACTION_STATUS.REJECTED)) {
      throw new ApiError(409, `Cannot reject a transaction that is already ${pending.status}`);
    }
    const business = await Business.findById(businessId).select('userId approvalSettings').lean();
    if (!business) throw new ApiError(404, 'Business not found');
    if (!this._canApprove(actor, business, pending)) {
      throw new ApiError(403, 'You are not allowed to reject this transaction');
    }

    pending.status = PENDING_TRANSACTION_STATUS.REJECTED;
    pending.reviewedBy = actor.id;
    pending.reviewedAt = new Date();
    pending.decisionNote = reason || null;
    await pending.save();

    try {
      await auditService.log({
        businessId, entityType: ENTITY_TYPES.PENDING_TRANSACTION, entityId: pending._id,
        action: AUDIT_ACTIONS.REJECTED, performedBy: actor.id, performedByName: actor.fullName,
        ipAddress, beforeState: { status: 'pending' }, afterState: { status: 'rejected', reason },
      });
    } catch (e) { /* best-effort: audit-log write; the rejection state was already persisted */ logger.warn(`[approval] reject audit failed: ${e.message}`); }

    logger.info(`[approval] rejected ${pending._id}`);
    return pending.toJSON();
  }

  /** The submitter withdraws their own request before a decision. */
  async cancel(id, businessId, actor) {
    const pending = await this.getById(id, businessId);
    if (!PendingTransaction.canTransition(pending.status, PENDING_TRANSACTION_STATUS.CANCELLED)) {
      throw new ApiError(409, `Cannot cancel a transaction that is already ${pending.status}`);
    }
    const business = await Business.findById(businessId).select('userId').lean();
    const isSubmitter = String(pending.submittedBy) === String(actor.id);
    const isOwnerOrAdmin = actor.role === 'admin' || String(business?.userId) === String(actor.id);
    if (!isSubmitter && !isOwnerOrAdmin) {
      throw new ApiError(403, 'Only the submitter (or the owner) can cancel this request');
    }

    pending.status = PENDING_TRANSACTION_STATUS.CANCELLED;
    pending.reviewedBy = actor.id;
    pending.reviewedAt = new Date();
    await pending.save();
    logger.info(`[approval] cancelled ${pending._id}`);
    return pending.toJSON();
  }
}

module.exports = new ApprovalService();
