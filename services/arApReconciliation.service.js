/**
 * arApReconciliation.service.js — AR/AP Domain Refactor, Milestone M1
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  LEDGER → DOCUMENT PAYMENT RECONCILIATION                                  │
 * │                                                                            │
 * │  Closes the split-brain (audit finding P1): payments recorded through      │
 * │  transaction.recordPartialPayment settle the parent JournalEntry but used  │
 * │  to leave the linked Invoice / Bill stale. This service PROJECTS the JE's  │
 * │  authoritative payment state onto its document.                            │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * NON-NEGOTIABLE DESIGN RULES (enterprise accounting):
 *   • The JournalEntry is the IMMUTABLE source of truth for money. This service
 *     only READS it and writes the result onto the document — never the reverse.
 *     We do NOT create a second payment authority.
 *   • IDEMPOTENT + REPLAY-SAFE: we always re-read the CURRENT ledger state and
 *     write ABSOLUTE values (paidAmount / remainingBalance / state), never deltas.
 *     Duplicate events, out-of-order delivery and the historical backfill all
 *     converge to the same document state; an already-synced document is a no-op.
 *   • SAFE: invoked fire-and-forget from the event engine; a failure here can
 *     never roll back or block the payment. State changes respect the document
 *     state machine (canTransition); money fields are corrected even when a legal
 *     state transition isn't available.
 *
 * Reused by: the PAYMENT_RECORDED subscriber (live) AND
 *            migrations/backfill_doc_payment_state.js (historical) — one code
 *            path, so live and backfill are guaranteed consistent.
 */

'use strict';

const Invoice = require('../models/Invoice.model');
const Bill = require('../models/Bill.model');
const JournalEntry = require('../models/JournalEntry.model');
const auditService = require('./audit.service');
const logger = require('../config/logger');
const {
  TRANSACTION_TYPES, INVOICE_STATES, BILL_STATES, ENTITY_TYPES, AUDIT_ACTIONS,
} = require('../config/constants');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

class ArApReconciliationService {
  /**
   * Reconcile the document linked to a parent JournalEntry, identified by id.
   * Re-reads the JE so the projection always reflects CURRENT ledger truth
   * (this is what makes replay / out-of-order delivery safe).
   *
   * @param {string} businessId
   * @param {string|ObjectId} journalEntryId  the SETTLED parent (CREDIT_SALE/PURCHASE)
   * @param {Object} [opts] { userId }
   * @returns {Promise<{reconciled:boolean, reason?:string, documentType?:string, documentId?:any}>}
   */
  async reconcileByJournalEntryId(businessId, journalEntryId, opts = {}) {
    if (!journalEntryId) return { reconciled: false, reason: 'no_journal_entry_id' };
    const je = await JournalEntry.findOne({ _id: journalEntryId, businessId }).lean();
    if (!je) return { reconciled: false, reason: 'journal_entry_not_found' };
    return this.reconcileFromJournal(je, opts);
  }

  /**
   * Reconcile from an already-loaded (lean) parent JournalEntry.
   * @param {Object} je    lean JournalEntry
   * @param {Object} [opts] { userId }
   */
  async reconcileFromJournal(je, opts = {}) {
    // Only AR/AP recognition entries have a document AND a tracked balance.
    const isAR = je.transactionType === TRANSACTION_TYPES.CREDIT_SALE;
    const isAP = je.transactionType === TRANSACTION_TYPES.CREDIT_PURCHASE;
    if (!isAR && !isAP) return { reconciled: false, reason: 'not_ar_ap' };
    if (je.remainingBalance == null) return { reconciled: false, reason: 'no_tracked_balance' };

    const Model = isAR ? Invoice : Bill;
    const kind = isAR ? 'invoice' : 'bill';
    const numberField = isAR ? 'invoiceNumber' : 'billNumber';

    // Strong link first (indexed); fall back to the human document number.
    let doc = await Model.findOne({ businessId: je.businessId, linkedJournalEntryId: je._id });
    if (!doc && je.invoiceNumber) {
      doc = await Model.findOne({ businessId: je.businessId, [numberField]: je.invoiceNumber });
    }
    if (!doc) return { reconciled: false, reason: 'document_not_found' };

    return this._project(doc, je, Model, kind, opts);
  }

  /**
   * Project the ledger's authoritative numbers onto the document. @private
   */
  async _project(doc, je, Model, kind, opts) {
    const remaining = r2(je.remainingBalance);
    const total = r2(doc.totalAmount || ((je.amount || 0) + (je.taxAmount || 0)));

    // Paid = ledger's partiallyPaidAmount (authoritative), clamped to [0, total].
    let paid = r2(je.partiallyPaidAmount != null ? je.partiallyPaidAmount : (total - remaining));
    paid = Math.max(0, Math.min(paid, total));

    const STATES = kind === 'invoice' ? INVOICE_STATES : BILL_STATES;

    // Desired lifecycle state derived purely from the ledger numbers.
    let targetState = doc.state;
    if (remaining <= 0) targetState = STATES.PAID;
    else if (paid > 0)  targetState = STATES.PARTIALLY_PAID;
    // else (nothing paid): leave the document's current state untouched.

    const canChangeState =
      targetState !== doc.state && Model.canTransition(doc.state, targetState);

    // ── Idempotency gate: skip the write entirely when nothing material changed.
    const moneyUnchanged =
      r2(doc.paidAmount) === paid && r2(doc.remainingBalance) === remaining;
    const stateAlreadyRight = targetState === doc.state || !canChangeState;
    if (moneyUnchanged && stateAlreadyRight) {
      return { reconciled: false, reason: 'already_in_sync', documentType: kind, documentId: doc._id };
    }

    const fromState = doc.state;
    doc.paidAmount = paid;
    doc.remainingBalance = remaining;

    if (canChangeState) {
      const actor = { _id: opts.userId || doc.createdBy || null, fullName: 'System · AR/AP reconciliation', email: 'system' };
      doc.recordStateChange(targetState, actor, 'Reconciled from ledger payment');
      doc.state = targetState;
    } else if (targetState !== doc.state) {
      logger.warn(`[arApReconcile] ${kind} ${doc._id}: cannot transition ${doc.state}→${targetState}; money fields corrected, state left as-is`);
    }

    await doc.save();

    // Best-effort audit — never fail reconciliation on an audit write.
    try {
      await auditService.log({
        businessId:      doc.businessId,
        entityType:      kind === 'invoice' ? ENTITY_TYPES.INVOICE : ENTITY_TYPES.BILL,
        entityId:        doc._id,
        action:          AUDIT_ACTIONS.STATE_CHANGED,
        performedBy:     opts.userId || doc.createdBy,
        performedByName: 'System · AR/AP reconciliation',
        beforeState:     { state: fromState, paidAmount: undefined },
        afterState:      { state: doc.state, paidAmount: paid, remainingBalance: remaining, reason: 'ledger_payment_reconcile' },
      });
    } catch (e) {
      logger.warn(`[arApReconcile] audit log failed for ${kind} ${doc._id}: ${e.message}`);
    }

    logger.info(`[arApReconcile] ${kind} ${doc[kind === 'invoice' ? 'invoiceNumber' : 'billNumber']} → state=${doc.state} paid=${paid} remaining=${remaining}`);
    return {
      reconciled: true, documentType: kind, documentId: doc._id,
      state: doc.state, paidAmount: paid, remainingBalance: remaining,
    };
  }
}

module.exports = new ArApReconciliationService();
