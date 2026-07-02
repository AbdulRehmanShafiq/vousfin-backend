// migrations/20260702-add-idempotency-unique-index.js
/**
 * Audit 2026-07-02 F7 — DB-enforced posting idempotency.
 *
 * The posting paths (postCompoundJournal / createTransaction) guarded on
 * metadata.idempotencyKey with a findOne before inserting — a check-then-insert
 * race that lets two concurrent retries double-post a journal. This index makes
 * MongoDB the arbiter. Partial: only entries that actually carry a string key
 * are constrained, so ordinary entries are unaffected.
 *
 * Safe to run on live data: the key is written once at posting time and never
 * reused across businesses; any pre-existing duplicate (none expected — the
 * app-level guard catches sequential repeats) would fail the build loudly,
 * which is the correct outcome to investigate.
 *
 * @param {import('mongodb').Db} db
 */
module.exports = {
  async up(db) {
    await db.collection('journalentries').createIndex(
      { businessId: 1, 'metadata.idempotencyKey': 1 },
      {
        unique: true,
        name: 'idx_je_idempotency_key',
        partialFilterExpression: { 'metadata.idempotencyKey': { $type: 'string' } },
      }
    );
    console.log('[up] created unique partial index idx_je_idempotency_key');
  },

  async down(db) {
    await db.collection('journalentries').dropIndex('idx_je_idempotency_key');
    console.log('[down] dropped idx_je_idempotency_key');
  },
};
