// services/consistencyVerification.service.js
//
// AR/AP Refactor — Milestone M9 (consistency verification).
//
// Proves the post-dual-write invariant: the authoritative Invoice/Bill DOCUMENT
// and its immutable JournalEntry PROJECTION agree, and both agree with the GL
// control account. Three layers:
//
//   1. Control reconciliation (reuses M7): Σ document remaining  ==  GL control
//      (1110/2110)  ==  Σ open recognition-JE remaining.
//   2. Per-document cross-check: each open document's remainingBalance ==
//      its recognition JournalEntry's remainingBalance (the projection).
//   3. Projection tagging coverage: how many recognition JEs are marked as
//      projections of their document (isProjection / projectionOf).
//
// READ-ONLY — never writes. A discrepancy is reported, never silently "fixed"
// (use projectionRebuild to repair, deliberately).
//
'use strict';
const mongoose = require('mongoose');
const Invoice = require('../models/Invoice.model');
const Bill = require('../models/Bill.model');
const JournalEntry = require('../models/JournalEntry.model');
const reporting = require('../services/arApReporting.service');
const config = require('../config');
const { ApiError } = require('../utils/ApiError');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const OPEN_AR = ['approved', 'sent', 'partially_paid', 'overdue', 'disputed'];
const OPEN_AP = ['approved', 'scheduled', 'partially_paid', 'overdue'];
const EPSILON = 0.01;

class ConsistencyVerificationService {
  /** Per-document document↔projection cross-check for one side. @private */
  async _documentCrossCheck(businessId, kind) {
    const Model = kind === 'invoice' ? Invoice : Bill;
    const states = kind === 'invoice' ? OPEN_AR : OPEN_AP;
    const linkField = kind === 'invoice' ? 'arJournalId' : 'apLiabilityJournalId';
    const numberField = kind === 'invoice' ? 'invoiceNumber' : 'billNumber';

    const docs = await Model.find({
      businessId, state: { $in: states }, isArchived: { $ne: true },
    }).select(`_id ${numberField} remainingBalance ${linkField} linkedJournalEntryId`).lean();

    const discrepancies = [];
    let checked = 0;
    for (const d of docs) {
      const jeId = d[linkField] || d.linkedJournalEntryId;
      if (!jeId) {
        discrepancies.push({ documentId: d._id, number: d[numberField], issue: 'no_recognition_journal' });
        continue;
      }
      const je = await JournalEntry.findById(jeId).select('remainingBalance isProjection').lean();
      if (!je) {
        discrepancies.push({ documentId: d._id, number: d[numberField], issue: 'recognition_journal_missing' });
        continue;
      }
      checked += 1;
      // Spec 2026-07-16: a PROJECTION deliberately carries no balance — the
      // DOCUMENT is the authority, so there is nothing to cross-check against
      // (comparing doc remaining to a null-as-0 projection would flag every
      // open invoice-first document as a false discrepancy forever).
      if (je.isProjection === true) continue;
      const docRem = r2(d.remainingBalance);
      const jeRem = r2(je.remainingBalance);
      if (Math.abs(docRem - jeRem) > EPSILON) {
        discrepancies.push({
          documentId: d._id, number: d[numberField], issue: 'remaining_mismatch',
          documentRemaining: docRem, ledgerRemaining: jeRem, delta: r2(docRem - jeRem),
        });
      }
    }
    return { checked, total: docs.length, discrepancies };
  }

  /** Projection-tagging coverage for recognition JEs of one side. @private */
  async _projectionCoverage(businessId, kind) {
    const txnType = kind === 'invoice' ? 'CREDIT_SALE' : 'CREDIT_PURCHASE';
    const { TRANSACTION_TYPES } = require('../config/constants');
    const match = { businessId: new mongoose.Types.ObjectId(businessId), transactionType: TRANSACTION_TYPES[txnType] };
    const total = await JournalEntry.countDocuments(match);
    const tagged = await JournalEntry.countDocuments({ ...match, isProjection: true });
    return { recognitionEntries: total, taggedAsProjection: tagged };
  }

  /**
   * Full verification for a tenant.
   * @returns {{ inSync, mode, receivable, payable, generatedAt }}
   */
  async verify(businessId) {
    if (!mongoose.Types.ObjectId.isValid(businessId)) throw new ApiError(400, 'Invalid businessId');

    const [arRecon, apRecon, arDocs, apDocs, arCov, apCov] = await Promise.all([
      reporting.getReconciliation(businessId, 'receivable'),
      reporting.getReconciliation(businessId, 'payable'),
      this._documentCrossCheck(businessId, 'invoice'),
      this._documentCrossCheck(businessId, 'bill'),
      this._projectionCoverage(businessId, 'invoice'),
      this._projectionCoverage(businessId, 'bill'),
    ]);

    const receivable = { controlReconciliation: arRecon, documentCrossCheck: arDocs, projectionCoverage: arCov };
    const payable    = { controlReconciliation: apRecon, documentCrossCheck: apDocs, projectionCoverage: apCov };

    const inSync =
      (arRecon.inSync !== false) && (apRecon.inSync !== false) &&
      arDocs.discrepancies.length === 0 && apDocs.discrepancies.length === 0;

    return {
      inSync,
      mode: config.AR_AP_AUTHORITATIVE ? 'document_authoritative' : 'legacy_dual_write',
      receivable,
      payable,
      generatedAt: new Date(),
    };
  }
}

module.exports = new ConsistencyVerificationService();
