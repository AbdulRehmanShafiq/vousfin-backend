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
const { JOURNAL_STATUS, PAYMENT_STATUS } = require('../config/constants');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

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

module.exports = { adjustOpenItem };
