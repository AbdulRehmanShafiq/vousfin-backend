/**
 * arApReporting.service.js — AR/AP Domain Refactor, Milestone M7.
 *
 * The single, reconciled AR/AP reporting read model. Replaces the fragmented
 * JournalEntry-derived outstanding-balances view.
 *
 *   SOURCE OF TRUTH : the Invoice (AR) / Bill (AP) documents.
 *   LEDGER          : used for VERIFICATION only — reconciliation compares the
 *                     document outstanding against the GL control account and the
 *                     open recognition entries, surfacing any discrepancy.
 *
 * Produces aging buckets, per-customer / per-vendor aging, and a reconciliation
 * summary. Pure read; never mutates.
 */

'use strict';

const mongoose = require('mongoose');
const Invoice = require('../models/Invoice.model');
const Bill = require('../models/Bill.model');
const JournalEntry = require('../models/JournalEntry.model');
const ChartOfAccount = require('../models/ChartOfAccount.model');
const { TRANSACTION_TYPES } = require('../config/constants');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const oid = (id) => new mongoose.Types.ObjectId(String(id));

// Open = recognized in the ledger and still owed (excludes draft/pending/paid/voided/cancelled).
const OPEN_AR_STATES = ['approved', 'sent', 'partially_paid', 'overdue', 'disputed'];
const OPEN_AP_STATES = ['approved', 'scheduled', 'partially_paid', 'overdue'];
const BUCKET_KEYS = ['current', '1-30', '31-60', '61-90', '90+'];

function bucketOf(dueDate, asOf) {
  if (!dueDate) return 'current';
  const days = Math.floor((asOf.getTime() - new Date(dueDate).getTime()) / 86400000);
  if (days <= 0) return 'current';
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}
const emptyBuckets = () => {
  const b = {};
  for (const k of BUCKET_KEYS) b[k] = { count: 0, amount: 0 };
  b.total = { count: 0, amount: 0 };
  return b;
};

class ArApReportingService {
  _cfg(kind) {
    const isAR = kind === 'receivable';
    return {
      isAR,
      Model: isAR ? Invoice : Bill,
      states: isAR ? OPEN_AR_STATES : OPEN_AP_STATES,
      partyField: isAR ? 'customerId' : 'vendorId',
      numberField: isAR ? 'invoiceNumber' : 'billNumber',
      snapField: isAR ? 'customerSnapshot' : 'vendorSnapshot',
      txType: isAR ? TRANSACTION_TYPES.CREDIT_SALE : TRANSACTION_TYPES.CREDIT_PURCHASE,
      controlCode: isAR ? '1110' : '2110',
    };
  }

  /** Aging buckets + per-party aging, sourced from the documents. */
  async getAging(businessId, kind) {
    const { Model, states, partyField, snapField } = this._cfg(kind);
    const docs = await Model.find({
      businessId, isArchived: { $ne: true },
      remainingBalance: { $gt: 0 }, state: { $in: states },
    }).select(`remainingBalance dueDate ${partyField} ${snapField}`).lean();

    const asOf = new Date();
    const buckets = emptyBuckets();
    const parties = new Map();

    for (const d of docs) {
      const amt = r2(d.remainingBalance);
      const b = bucketOf(d.dueDate, asOf);
      buckets[b].count++;       buckets[b].amount = r2(buckets[b].amount + amt);
      buckets.total.count++;    buckets.total.amount = r2(buckets.total.amount + amt);

      const pid = d[partyField] ? String(d[partyField]) : 'unassigned';
      if (!parties.has(pid)) {
        const snap = d[snapField] || {};
        parties.set(pid, {
          partyId: pid === 'unassigned' ? null : pid,
          name: snap.fullName || snap.businessName || snap.vendorName || (pid === 'unassigned' ? 'Unassigned' : pid),
          ...Object.fromEntries(BUCKET_KEYS.map((k) => [k, 0])), total: 0,
        });
      }
      const p = parties.get(pid);
      p[b] = r2(p[b] + amt);
      p.total = r2(p.total + amt);
    }

    return { kind, asOf, buckets, parties: [...parties.values()].sort((a, b) => b.total - a.total) };
  }

  /**
   * Reconcile the document outstanding (source of truth) against the ledger:
   *   • GL control account running balance (1110 AR / 2110 AP)
   *   • sum of open recognition journal entries' remaining balances
   */
  async getReconciliation(businessId, kind) {
    const { Model, states, controlCode } = this._cfg(kind);
    const bid = oid(businessId);

    const [docAgg, openLedger, control] = await Promise.all([
      Model.aggregate([
        { $match: { businessId: bid, isArchived: { $ne: true }, remainingBalance: { $gt: 0 }, state: { $in: states } } },
        // Document balances are DOCUMENT currency; the ledger is base — convert
        // at each document's booking rate so the comparison is unit-honest (F2).
        { $group: { _id: null, total: { $sum: { $multiply: [{ $ifNull: ['$remainingBalance', 0] }, { $ifNull: ['$exchangeRate', 1] }] } } } },
      ]),
      // The ledger's open-item view is THE union (spec 2026-07-16): summing only
      // JE.remainingBalance made every invoice-first item read as a discrepancy.
      require('./openItem.service').sumOpenLedger(businessId, kind, { partyLinkedOnly: false }),
      ChartOfAccount.findOne({ businessId, accountCode: controlCode }).lean(),
    ]);

    const documentTotal     = r2(docAgg[0]?.total || 0);
    const ledgerEntriesTotal = openLedger.total;
    const ledgerControl     = r2(control?.runningBalance || 0);
    const discrepancyVsEntries = r2(documentTotal - ledgerEntriesTotal);
    const discrepancyVsControl = r2(documentTotal - ledgerControl);

    return {
      kind, documentTotal, ledgerEntriesTotal, ledgerControl,
      discrepancyVsEntries, discrepancyVsControl,
      inSync: Math.abs(discrepancyVsEntries) < 0.01 && Math.abs(discrepancyVsControl) < 0.01,
    };
  }

  /** The full reconciled report for one side (receivable | payable). */
  async getReport(businessId, kind) {
    const [aging, reconciliation] = await Promise.all([
      this.getAging(businessId, kind),
      this.getReconciliation(businessId, kind),
    ]);
    return { ...aging, reconciliation };
  }
}

module.exports = new ArApReportingService();
module.exports.bucketOf = bucketOf; // exposed for unit tests
