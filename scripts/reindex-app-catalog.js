'use strict';

// One-shot: embed the global app catalog (data/app-catalog.json) + help corpus
// into the vector store. Run from vousfin-backend-main:
//   node scripts/reindex-app-catalog.js            (idempotent; hash-skips unchanged)
//   node scripts/reindex-app-catalog.js --purge    (delete global vectors first)
//
// Use --purge when the embedding PROVIDER changed (e.g. earlier docs fell back to
// local-hash because the Gemini quota was exhausted): the content hash is keyed on
// text, not the embedding, so a plain re-run would skip them. Purging forces a
// clean, consistent re-embed once real Gemini quota is available again.

require('dotenv').config();
const mongoose = require('mongoose');

const PURGE = process.argv.includes('--purge');

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI not set in .env');
  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected.\n');

  if (PURGE) {
    const VectorDocument = require('../models/VectorDocument.model');
    const { deletedCount } = await VectorDocument.deleteMany({ scope: 'global' });
    console.log(`--purge: deleted ${deletedCount} global-scope vector(s) — clean re-embed.\n`);
  }

  const { reindexAppCatalog } = require('../services/appCatalogIndex.service');
  const { reindexHelp } = require('../services/helpCorpus.service');
  console.log('Indexing the global app catalog...');
  const cat = await reindexAppCatalog();
  console.log(`  catalog: total=${cat.total} indexed=${cat.indexed} skipped=${cat.skipped}`);
  console.log('Indexing the global help corpus...');
  const help = await reindexHelp();
  console.log(`  help:    total=${help.total} indexed=${help.indexed} skipped=${help.skipped}`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('\nCatalog reindex failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
