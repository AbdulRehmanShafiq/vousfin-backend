/**
 * services/openItem.service.js — audit 2026-07-02 F3.
 *
 * ONE adjuster for the open-item balance carried on an AR/AP recognition
 * JOURNAL ENTRY (remainingBalance / paymentStatus / status).
 *
 * WHY: credit notes, vendor credits and write-offs adjusted the Invoice/Bill
 * DOCUMENT, posted the GL entry and moved the party balance — but never
 * touched the linked recognition JE. Everything that enforces or reports the
 * open position reads the JE:
 *   • payment.service validates allocations against JE.remainingBalance
 *     → a fully-credited invoice could still be collected in full;
 *   • the aging report buckets JE.remainingBalance → overstated after credits;
 *   • ledgerIntegrity.computeArApSubledgerDrift sums JE.remainingBalance
 *     → the VE-5/6 integrity gate drifted on every applied credit.
 *
 * Payments continue to settle through transaction.recordPartialPayment (which
 * also tracks partiallyPaidAmount and settlements[]); this adjuster is for
 * NON-CASH reductions/restorations of the open amount (credits, write-offs).
 *
 * The write is optimistically guarded on the remainingBalance that was read
 * (same pattern as the settlement engine, F5) so a concurrent payment or
 * credit can never both apply against the same opening balance.
 */
'use strict';

const { ApiError } = require('../utils/ApiError');
const {
  JOURNAL_STATUS, PAYMENT_STATUS, TRANSACTION_TYPES,
  OPEN_INVOICE_STATES, OPEN_BILL_STATES,
} = require('../config/constants');
const { toBaseAmount } = require('../utils/currency.util');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// JE statuses that still carry an outstanding balance in the ledger.
const OPEN_JE_STATUSES = [JOURNAL_STATUS.POSTED, JOURNAL_STATUS.PARTIALLY_SETTLED];

/**
 * Adjust the open-item balance on a recognition journal entry.
 *
 * @param {string} businessId
 * @param {string|Object|null} journalEntryId  linked recognition JE (may be null)
 * @param {number} delta      negative = credit/write-off reduces what's owed;
 *                            positive = restore (credit cancelled)
 * @param {Object} [opts]
 * @param {import('mongoose').ClientSession|null} [opts.session]
 * @returns {Promise<Object|null>} the updated JE, or null when there is nothing
 *   to adjust (no id, entry not found, entry doesn't track a balance, reversed)
 */
async function adjustOpenItem(businessId, journalEntryId, delta, { session = null } = {}) {
  if (!journalEntryId) return null;
  const amount = r2(delta);
  if (amount === 0) return null;

  const JournalEntry = require('../models/JournalEntry.model'); // lazy — avoid require cycles
  const jeId = journalEntryId._id || journalEntryId;

  const je = await JournalEntry.findOne({ _id: jeId, businessId })
    .session(session || null)
    .lean();
  if (!je) return null;
  if (je.remainingBalance === null || je.remainingBalance === undefined) return null; // not an open-item entry
  if (je.status === JOURNAL_STATUS.REVERSED) return null;

  const newRemaining = Math.max(0, r2(je.remainingBalance + amount));
  const paid = r2(je.partiallyPaidAmount || 0);
  const fullySettled = newRemaining === 0;

  const paymentStatus = fullySettled
    ? PAYMENT_STATUS.PAID
    : paid > 0
      ? PAYMENT_STATUS.PARTIALLY_PAID
      : (je.dueDate && new Date() > new Date(je.dueDate) ? PAYMENT_STATUS.OVERDUE : PAYMENT_STATUS.UNPAID);
  const status = fullySettled
    ? JOURNAL_STATUS.SETTLED
    : paid > 0 ? JOURNAL_STATUS.PARTIALLY_SETTLED : JOURNAL_STATUS.POSTED;

  const updated = await JournalEntry.findOneAndUpdate(
    // Optimistic guard (F5 pattern): only land if the balance is still what we read.
    { _id: jeId, businessId, remainingBalance: je.remainingBalance },
    { remainingBalance: newRemaining, paymentStatus, status },
    { new: true, session }
  );
  if (!updated) {
    throw new ApiError(
      409,
      'This document\'s balance changed while the credit was being applied. Refresh and try again.'
    );
  }
  return updated;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE OPEN-ITEM AUTHORITY LAYER — spec 2026-07-16 (AR/AP open-item closeout)
//
// Every AR/AP open item has exactly ONE authority:
//
//   JE.isProjection === true  ⟺  the DOCUMENT owns the money (invoice-first —
//                                 the M-refactor's ratified convention: the JE
//                                 is an immutable GL projection, never the master)
//   otherwise                 ⟺  the JE owns it (transaction-first, installments,
//                                 manual credit-sale/purchase journals — all
//                                 existing behavior, unchanged)
//
// This module is the only place that decision is made. The payment engine, the
// aging report, the outstanding lists and the sub-ledger reconciler all resolve
// through here — a reader that goes around this layer is re-introducing the
// split-brain this exists to close.
//
// UNIT DISCIPLINE (audit F2): JE.remainingBalance is BASE currency;
// Invoice/Bill.remainingBalance is DOCUMENT currency. Everything this layer
// returns is BASE (converted at the document's booking rate); document-side
// writes convert back to document units at the same rate.
// ═══════════════════════════════════════════════════════════════════════════

const _lean = (Model, filter, session) =>
  Model.findOne(filter).session(session || null).lean();

/**
 * Resolve an open item to its single authority.
 *
 * @param {string} businessId
 * @param {Object} ref  { journalEntryId } | { documentType, documentId }
 * @param {Object} [opts]
 * @param {import('mongoose').ClientSession|null} [opts.session]
 * @returns {Promise<Object>} OpenItem:
 *   { authority: 'document'|'journal', direction: 'receivable'|'payable',
 *     je, doc, documentType, number, partyId, partyType, dueDate,
 *     currencyCode, bookingRate, totalBase, paidBase, remainingBase }
 *
 * Error messages are kept byte-identical to the payment engine's historical
 * ones — callers delegate resolution here without changing their API surface.
 */
async function resolveOpenItem(businessId, ref = {}, { session = null } = {}) {
  const JournalEntry = require('../models/JournalEntry.model'); // lazy — avoid require cycles
  const Invoice = require('../models/Invoice.model');
  const Bill = require('../models/Bill.model');

  let je = null;
  let doc = null;
  let documentType = ref.documentType || null;

  if (ref.journalEntryId) {
    je = await _lean(JournalEntry, { _id: ref.journalEntryId, businessId }, session);
    if (!je) throw new ApiError(404, `Parent transaction ${ref.journalEntryId} not found`);
  } else if (ref.documentId && documentType) {
    const Model = documentType === 'invoice' ? Invoice : Bill;
    doc = await _lean(Model, { _id: ref.documentId, businessId }, session);
    if (!doc) throw new ApiError(404, `${documentType} ${ref.documentId} not found`);
    // Invoice-first documents anchor to the projection JE they posted;
    // transaction-first documents only mirror a JE via linkedJournalEntryId.
    const jeId = (documentType === 'invoice' ? doc.arJournalId : doc.apLiabilityJournalId)
      || doc.linkedJournalEntryId;
    if (!jeId) {
      const number = doc.invoiceNumber || doc.billNumber || doc._id;
      throw new ApiError(400, `${documentType} ${number} has no posted journal entry to settle`);
    }
    je = await _lean(JournalEntry, { _id: jeId, businessId }, session);
    if (!je) throw new ApiError(404, 'Linked journal entry not found for the document');
  } else {
    throw new ApiError(400, 'Each allocation needs either { documentType, documentId } or { parentTransactionId }');
  }

  const isAR = je.transactionType === TRANSACTION_TYPES.CREDIT_SALE;
  const isAP = je.transactionType === TRANSACTION_TYPES.CREDIT_PURCHASE;
  if (!isAR && !isAP) {
    throw new ApiError(400, 'Allocations must target a credit sale (invoice) or credit purchase (bill)');
  }
  const direction = isAR ? 'receivable' : 'payable';
  const partyType = isAR ? 'customer' : 'vendor';

  if (je.isProjection === true) {
    // ── Document authority ──────────────────────────────────────────────────
    if (!doc) {
      documentType = je.projectionOf?.documentType || (isAR ? 'invoice' : 'bill');
      const docId = je.projectionOf?.documentId || null;
      const Model = documentType === 'invoice' ? Invoice : Bill;
      doc = docId ? await _lean(Model, { _id: docId, businessId }, session) : null;
      if (!doc) {
        // A projection without its document is corruption — refuse, never skip.
        throw new ApiError(
          500,
          'This entry\'s source document is missing, so its balance can\'t be read safely. '
          + 'Nothing was changed — contact support.'
        );
      }
    }
    const bookingRate = Number(doc.exchangeRate) > 0 ? Number(doc.exchangeRate) : 1;
    const remainingDoc = doc.remainingBalance != null
      ? doc.remainingBalance
      : r2((doc.totalAmount || 0) - (doc.paidAmount || 0));
    return {
      authority: 'document',
      direction,
      je,
      doc,
      documentType,
      number: doc.invoiceNumber || doc.billNumber || null,
      partyId: (isAR ? doc.customerId : doc.vendorId) || null,
      partyType,
      dueDate: doc.dueDate || null,
      currencyCode: doc.currencyCode || null,
      bookingRate,
      totalBase: toBaseAmount(doc.totalAmount || 0, bookingRate),
      paidBase: toBaseAmount(doc.paidAmount || 0, bookingRate),
      remainingBase: toBaseAmount(remainingDoc, bookingRate),
    };
  }

  // ── Journal authority (all existing transaction-first behavior) ───────────
  if (je.remainingBalance === null || je.remainingBalance === undefined) {
    throw new ApiError(400, 'Target entry does not track an outstanding balance');
  }
  return {
    authority: 'journal',
    direction,
    je,
    doc: doc || null,
    documentType,
    number: je.invoiceNumber || null,
    partyId: (isAR ? je.customerId : je.vendorId) || null,
    partyType,
    dueDate: je.dueDate || null,
    currencyCode: je.currencyCode || null,
    bookingRate: Number(je.exchangeRate) > 0 ? Number(je.exchangeRate) : 1,
    totalBase: r2(je.amount || 0),
    paidBase: r2(je.partiallyPaidAmount || 0),
    remainingBase: r2(je.remainingBalance),
  };
}

/** Config shared by the union readers. */
function _sideCfg(direction) {
  const isAR = direction === 'receivable';
  return {
    isAR,
    Model: isAR ? require('../models/Invoice.model') : require('../models/Bill.model'),
    anchor: isAR ? 'arJournalId' : 'apLiabilityJournalId',
    states: isAR ? OPEN_INVOICE_STATES : OPEN_BILL_STATES,
    partyField: isAR ? 'customerId' : 'vendorId',
    txType: isAR ? TRANSACTION_TYPES.CREDIT_SALE : TRANSACTION_TYPES.CREDIT_PURCHASE,
  };
}

/**
 * Document-authority open items, shaped like the JE-derived outstanding rows so
 * every existing consumer (aging buckets, Receivables/Payables pages) reads
 * them without change. `_id` is the projection JE — a valid settlement anchor.
 *
 * DOUBLE-COUNT GUARD (by construction, not by assumption): a document only
 * qualifies when its anchor JE does NOT itself track a balance
 * (remainingBalance == null). If some legacy anchor JE carries its own open
 * item, the JE side counts it and this side skips it — an item can never
 * appear twice no matter what historical data looks like.
 */
async function documentOpenItems(businessId, direction) {
  const JournalEntry = require('../models/JournalEntry.model');
  const { isAR, Model, anchor, states } = _sideCfg(direction);

  const docs = await Model.find({
    businessId,
    isArchived: { $ne: true },
    [anchor]: { $ne: null },
    state: { $in: states },
    remainingBalance: { $gt: 0 },
  })
    .populate(
      isAR ? 'customerId' : 'vendorId',
      isAR ? 'fullName businessName' : 'vendorName contactPerson'
    )
    .sort({ issueDate: -1 })
    .lean();
  if (docs.length === 0) return [];

  const anchors = await JournalEntry.find({
    businessId, _id: { $in: docs.map((d) => d[anchor]) },
  }).select('remainingBalance').lean();
  const tracksOwnBalance = new Set(
    anchors.filter((j) => j.remainingBalance != null).map((j) => String(j._id))
  );

  const now = new Date();
  return docs
    .filter((d) => !tracksOwnBalance.has(String(d[anchor])))
    .map((d) => {
      const rate = Number(d.exchangeRate) > 0 ? Number(d.exchangeRate) : 1;
      const number = isAR ? d.invoiceNumber : d.billNumber;
      const paid = d.paidAmount || 0;
      const remainingDoc = d.remainingBalance != null
        ? d.remainingBalance
        : r2((d.totalAmount || 0) - paid);
      const overdue = d.dueDate && now > new Date(d.dueDate);
      return {
        _id: d[anchor],
        authority: 'document',
        documentType: isAR ? 'invoice' : 'bill',
        documentId: d._id,
        transactionType: isAR ? TRANSACTION_TYPES.CREDIT_SALE : TRANSACTION_TYPES.CREDIT_PURCHASE,
        transactionDate: d.issueDate,
        dueDate: d.dueDate || null,
        invoiceNumber: number,
        description: `${isAR ? 'Invoice' : 'Bill'} ${number}`,
        amount: toBaseAmount(d.totalAmount || 0, rate),
        remainingBalance: toBaseAmount(remainingDoc, rate),
        partiallyPaidAmount: toBaseAmount(paid, rate),
        paymentStatus: paid > 0
          ? PAYMENT_STATUS.PARTIALLY_PAID
          : overdue ? PAYMENT_STATUS.OVERDUE : PAYMENT_STATUS.UNPAID,
        status: paid > 0 ? JOURNAL_STATUS.PARTIALLY_SETTLED : JOURNAL_STATUS.POSTED,
        currencyCode: d.currencyCode || null,
        exchangeRate: rate,
        customerId: isAR ? (d.customerId || null) : undefined,
        vendorId: isAR ? undefined : (d.vendorId || null),
      };
    });
}

/**
 * THE open-items list — journal-authority rows (the existing repository
 * queries, untouched) ∪ document-authority rows. Base currency throughout.
 * Both the aging report and /transactions/outstanding read this.
 */
async function openItems(businessId, direction) {
  const transactionRepository = require('../repositories/transaction.repository');
  const [jeRows, docRows] = await Promise.all([
    direction === 'receivable'
      ? transactionRepository.getOutstandingReceivables(businessId)
      : transactionRepository.getOutstandingPayables(businessId),
    documentOpenItems(businessId, direction),
  ]);
  return [...jeRows, ...docRows].sort(
    (a, b) => new Date(b.transactionDate) - new Date(a.transactionDate)
  );
}

/**
 * THE open-items sum — the aggregation twin of openItems(), used by the
 * sub-ledger reconciler (partyLinkedOnly: true) and the M7 reconciliation view
 * (partyLinkedOnly: false). Reports and reconciler share this one definition
 * so they can never disagree on what "open" means.
 *
 * Returns BASE-currency totals: { journalSide, documentSide, total }.
 */
async function sumOpenLedger(businessId, direction, { partyLinkedOnly = false } = {}) {
  const mongoose = require('mongoose');
  const JournalEntry = require('../models/JournalEntry.model');
  const { Model, anchor, states, partyField, txType } = _sideCfg(direction);
  const bid = new mongoose.Types.ObjectId(String(businessId));

  const jeMatch = {
    businessId: bid,
    transactionType: txType,
    status: { $in: OPEN_JE_STATUSES },
    isProjection: { $ne: true },
  };
  if (partyLinkedOnly) jeMatch[partyField] = { $ne: null };

  const docMatch = {
    businessId: bid,
    isArchived: { $ne: true },
    [anchor]: { $ne: null },
    state: { $in: states },
  };
  if (partyLinkedOnly) docMatch[partyField] = { $ne: null };

  const [jeAgg, docAgg] = await Promise.all([
    JournalEntry.aggregate([
      { $match: jeMatch },
      { $group: { _id: null, sum: { $sum: '$remainingBalance' } } },
    ]),
    Model.aggregate([
      { $match: docMatch },
      // Same double-count guard as documentOpenItems: skip any document whose
      // anchor JE tracks its own balance (the JE side already counted it).
      {
        $lookup: {
          from: 'journalentries', localField: anchor, foreignField: '_id',
          as: '_anchorJe', pipeline: [{ $project: { remainingBalance: 1 } }],
        },
      },
      { $match: { '_anchorJe.remainingBalance': null } },
      {
        $group: {
          _id: null,
          // Document balances are DOCUMENT currency — convert to base at the
          // booking rate so both sides of the union speak the same unit (F2).
          sum: {
            $sum: {
              $multiply: [
                { $ifNull: ['$remainingBalance', 0] },
                { $ifNull: ['$exchangeRate', 1] },
              ],
            },
          },
        },
      },
    ]),
  ]);

  const journalSide = r2(jeAgg?.[0]?.sum || 0);
  const documentSide = r2(docAgg?.[0]?.sum || 0);
  return { journalSide, documentSide, total: r2(journalSide + documentSide) };
}

/**
 * Corruption detector for the discriminator itself:
 *   • a projection JE whose source document is gone
 *   • an invoice-first document whose anchor JE is gone
 * Surfaced through booksAssurance check 4 the day it happens, instead of
 * silently mis-summing forever.
 */
async function projectionLinkageBreaks(businessId) {
  const mongoose = require('mongoose');
  const JournalEntry = require('../models/JournalEntry.model');
  const Invoice = require('../models/Invoice.model');
  const Bill = require('../models/Bill.model');
  const bid = new mongoose.Types.ObjectId(String(businessId));
  const breaks = [];

  const projections = await JournalEntry.find({ businessId: bid, isProjection: true })
    .select('projectionOf invoiceNumber').lean();
  const wantInv = projections.filter((p) => p.projectionOf?.documentType === 'invoice');
  const wantBill = projections.filter((p) => p.projectionOf?.documentType === 'bill');
  const [haveInv, haveBill, firstInvoices, firstBills] = await Promise.all([
    wantInv.length
      ? Invoice.find({ businessId: bid, _id: { $in: wantInv.map((p) => p.projectionOf.documentId) } }).select('_id').lean()
      : [],
    wantBill.length
      ? Bill.find({ businessId: bid, _id: { $in: wantBill.map((p) => p.projectionOf.documentId) } }).select('_id').lean()
      : [],
    Invoice.find({ businessId: bid, arJournalId: { $ne: null } }).select('arJournalId invoiceNumber').lean(),
    Bill.find({ businessId: bid, apLiabilityJournalId: { $ne: null } }).select('apLiabilityJournalId billNumber').lean(),
  ]);

  const invSet = new Set(haveInv.map((d) => String(d._id)));
  const billSet = new Set(haveBill.map((d) => String(d._id)));
  for (const p of projections) {
    const t = p.projectionOf?.documentType;
    const id = p.projectionOf?.documentId ? String(p.projectionOf.documentId) : null;
    const ok = t === 'invoice' ? (id && invSet.has(id)) : t === 'bill' ? (id && billSet.has(id)) : false;
    if (!ok) breaks.push({ kind: 'projection_without_document', journalEntryId: p._id, number: p.invoiceNumber || null });
  }

  const anchorIds = [
    ...firstInvoices.map((d) => d.arJournalId),
    ...firstBills.map((d) => d.apLiabilityJournalId),
  ];
  const anchorJes = anchorIds.length
    ? await JournalEntry.find({ businessId: bid, _id: { $in: anchorIds } }).select('_id').lean()
    : [];
  const haveJe = new Set(anchorJes.map((j) => String(j._id)));
  for (const d of firstInvoices) {
    if (!haveJe.has(String(d.arJournalId))) {
      breaks.push({ kind: 'document_without_journal', documentType: 'invoice', documentId: d._id, number: d.invoiceNumber });
    }
  }
  for (const d of firstBills) {
    if (!haveJe.has(String(d.apLiabilityJournalId))) {
      breaks.push({ kind: 'document_without_journal', documentType: 'bill', documentId: d._id, number: d.billNumber });
    }
  }
  return breaks;
}

module.exports = {
  adjustOpenItem,
  resolveOpenItem,
  openItems,
  documentOpenItems,
  sumOpenLedger,
  projectionLinkageBreaks,
  OPEN_JE_STATUSES,
};
