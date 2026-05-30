/**
 * Migration / backfill — AR/AP Domain Refactor, Milestone M1.
 *
 * Brings EXISTING Invoice / Bill documents into line with their ledger after the
 * historical period when payments updated only the JournalEntry (the split-brain
 * described in docs/ar-ap-domain-refactor.md, finding P1).
 *
 * It reuses the SAME idempotent reconciliation used live (arApReconciliation),
 * so historical and real-time results are guaranteed consistent. Safe to re-run:
 * already-synced documents are skipped (no write).
 *
 * Run:  node migrations/backfill_doc_payment_state.js
 *   or  npm run migrate:backfill-payments
 */
'use strict';

const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/vousfin';

async function migrate() {
  console.log('[backfill] connecting to MongoDB…');
  await mongoose.connect(MONGO_URI);
  console.log('[backfill] connected.');

  const JournalEntry = require('../models/JournalEntry.model');
  const arApReconciliation = require('../services/arApReconciliation.service');
  const { TRANSACTION_TYPES } = require('../config/constants');

  // Candidate parents: AR/AP recognition entries that have seen at least one
  // payment (partiallyPaidAmount > 0) OR are fully settled (remainingBalance 0).
  const query = {
    transactionType: { $in: [TRANSACTION_TYPES.CREDIT_SALE, TRANSACTION_TYPES.CREDIT_PURCHASE] },
    remainingBalance: { $ne: null },
    $or: [{ partiallyPaidAmount: { $gt: 0 } }, { remainingBalance: 0 }],
  };

  const totalCandidates = await JournalEntry.countDocuments(query);
  console.log(`[backfill] ${totalCandidates} candidate settled AR/AP journal entries`);

  const cursor = JournalEntry.find(query).select('_id businessId').lean().cursor();

  let processed = 0, reconciled = 0, skipped = 0, errors = 0;
  for (let je = await cursor.next(); je != null; je = await cursor.next()) {
    processed++;
    try {
      const res = await arApReconciliation.reconcileByJournalEntryId(je.businessId, je._id, { userId: null });
      if (res.reconciled) reconciled++; else skipped++;
    } catch (e) {
      errors++;
      console.error(`[backfill] failed for JE ${je._id}: ${e.message}`);
    }
    if (processed % 500 === 0) console.log(`[backfill] …${processed}/${totalCandidates}`);
  }

  console.log(`[backfill] done — processed ${processed} · reconciled ${reconciled} · already-in-sync ${skipped} · errors ${errors}`);
  await mongoose.connection.close();
  console.log('[backfill] connection closed.');
}

if (require.main === module) {
  migrate().catch((err) => { console.error('[backfill] fatal:', err); process.exit(1); });
}

module.exports = migrate;
