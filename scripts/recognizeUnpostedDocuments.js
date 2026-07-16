// scripts/recognizeUnpostedDocuments.js — spec 2026-07-16 (I-10 repair)
//
// Finds approved/sent invoices and bills that never reached the books (the
// below-threshold early-return bug's fingerprint — booksAssurance invariant 5
// flags exactly these) and, with --apply, re-runs recognition for each one.
//
// SAFE BY CONSTRUCTION:
//   • Dry-run by default — prints what it WOULD do and changes nothing.
//   • Uses the SAME query as booksAssurance's "everything recorded" check, so
//     this script and the product's own invariant can never disagree on what
//     "unposted" means.
//   • Recognition is idempotent (invoice-ar:{id} / bill:ap:{id} keys, and the
//     posters skip when arJournalId/apLiabilityJournalId is already set), so
//     re-running is harmless.
//
//   node scripts/recognizeUnpostedDocuments.js               # dry-run, all businesses
//   node scripts/recognizeUnpostedDocuments.js <businessId>  # dry-run, one business
//   node scripts/recognizeUnpostedDocuments.js <businessId> --apply
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const modelsDir = path.join(__dirname, '..', 'models');
  for (const f of fs.readdirSync(modelsDir).filter((f) => f.endsWith('.model.js'))) require(path.join(modelsDir, f));

  const apply = process.argv.includes('--apply');
  const target = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;

  const Business = require('../models/Business.model');
  const Invoice = require('../models/Invoice.model');
  const Bill = require('../models/Bill.model');
  const User = require('../models/User.model');
  const invoiceService = require('../services/invoice.service');
  const billService = require('../services/bill.service');

  const businesses = target
    ? await Business.find({ _id: target }).select('_id businessName userId').lean()
    : await Business.find({}).select('_id businessName userId').lean();

  let found = 0;
  let repaired = 0;
  let failed = 0;

  for (const b of businesses) {
    // The invariant-5 query — one definition, shared with booksAssurance.
    const [invoices, bills] = await Promise.all([
      Invoice.find({
        businessId: b._id,
        isArchived: { $ne: true },
        state: { $in: ['approved', 'sent', 'partially_paid', 'paid', 'overdue'] },
        arJournalId: null,
        linkedJournalEntryId: null,
      }),
      Bill.find({
        businessId: b._id,
        isArchived: { $ne: true },
        state: { $in: ['approved', 'partially_paid', 'paid', 'overdue'] },
        apLiabilityJournalId: null,
        linkedJournalEntryId: null,
      }),
    ]);
    if (invoices.length === 0 && bills.length === 0) continue;

    const owner = await User.findById(b.userId).select('_id fullName email').lean();
    const actor = {
      _id: owner?._id || b.userId,
      fullName: owner?.fullName || 'System repair',
      email: owner?.email || null,
      businessId: b._id,
    };

    console.log(`\n${b.businessName || b._id}: ${invoices.length} invoice(s), ${bills.length} bill(s) approved but missing from the books`);
    for (const doc of [...invoices, ...bills]) {
      const kind = doc.invoiceNumber ? 'invoice' : 'bill';
      const number = doc.invoiceNumber || doc.billNumber;
      found++;
      if (!apply) {
        console.log(`   would recognize ${kind} ${number} (${doc.state}, ${doc.totalAmount})`);
        continue;
      }
      try {
        if (kind === 'invoice') await invoiceService.postArJournal(doc, actor, 'repair-script');
        else await billService.postApLiabilityJournal(doc, actor, 'repair-script');
        repaired++;
        console.log(`   ✓ recognized ${kind} ${number} (${doc.totalAmount})`);
      } catch (e) {
        failed++;
        console.log(`   ✗ ${kind} ${number} refused: ${e.message}`);
      }
    }
  }

  console.log(`\nSummary: ${found} unposted document(s)${apply ? `, ${repaired} recognized, ${failed} refused` : ' (dry-run — pass --apply to recognize them)'}`);
  if (apply && found > 0) {
    console.log('Re-run scripts/ledgerDrift.js and GET /reports/books-assurance to confirm the books add up.');
  }
  await mongoose.disconnect();
})().catch((e) => { console.error('repair scan error:', e.message); process.exit(1); });
