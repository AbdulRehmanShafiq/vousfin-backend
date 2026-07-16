// migrations/20260716-je-invoice-number-not-unique.js
/**
 * Spec 2026-07-16 (AR/AP open-item authority closeout) — journal entries may
 * SHARE a document number; only documents may not.
 *
 * Several journal entries are legitimately chapters of one document's story:
 * the AR recognition leg and its output-tax leg, the COGS entry, a write-off,
 * a debit-note charge. The Phase-0 index resurrection made
 * idx_je_invoice_number UNIQUE, which turned every tax-bearing invoice-first
 * approval and every post-recognition write-off into an E11000 the moment a
 * second leg posted. The live test tier caught it the first time the tax leg
 * actually ran against a real database.
 *
 * Document-number uniqueness is a DOCUMENT invariant and stays enforced where
 * the document lives: the unique indexes on invoices.invoiceNumber and
 * bills.billNumber (which, since the dual-write mirror commits in the same
 * unit as the ledger entry, protect the ledger path atomically as well).
 *
 * Safe on live data: dropping a unique index never touches documents; the
 * replacement non-unique lookup index preserves query performance.
 *
 * @param {import('mongodb').Db} db
 */
module.exports = {
  async up(db) {
    try {
      await db.collection('journalentries').dropIndex('idx_je_invoice_number');
      console.log('[up] dropped unique idx_je_invoice_number');
    } catch (e) {
      if (e.codeName === 'IndexNotFound' || /index not found/i.test(e.message)) {
        console.log('[up] idx_je_invoice_number not present — nothing to drop');
      } else {
        throw e;
      }
    }
    await db.collection('journalentries').createIndex(
      { businessId: 1, invoiceNumber: 1 },
      {
        name: 'idx_je_invoice_number_lookup',
        partialFilterExpression: { invoiceNumber: { $type: 'string' } },
      }
    );
    console.log('[up] created non-unique idx_je_invoice_number_lookup');
  },

  async down(db) {
    await db.collection('journalentries').dropIndex('idx_je_invoice_number_lookup');
    // Restoring the unique version is deliberately NOT done: it re-arms the
    // E11000 on multi-leg recognitions. Recreate manually only after verifying
    // no document has more than one journal leg.
    console.log('[down] dropped idx_je_invoice_number_lookup (unique version intentionally not restored)');
  },
};
