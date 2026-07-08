'use strict';

// One-shot script: index all businesses into the RAG vector store.
// Run from vousfin-backend-main: node scripts/run-rag-reindex.js [--force]
//
// --force  clears IndexerState so ALL records are re-indexed, not just new ones.
//          Use this when re-generating embeddings with a different model.

require('dotenv').config();
const mongoose = require('mongoose');

const FORCE = process.argv.includes('--force');
const PURGE_VECTORS = process.argv.includes('--purge-vectors');

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI not set in .env');

  console.log('ℹ  Embeddings are always local/deterministic (no embeddings API is used) — see services/embeddingService.js.\n');

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected.\n');

  if (PURGE_VECTORS) {
    const VectorDocument = require('../models/VectorDocument.model');
    const deleted = await VectorDocument.deleteMany({});
    console.log(`--purge-vectors: deleted ${deleted.deletedCount} existing vector document(s) — embeddings will be fully regenerated.\n`);
  }

  if (FORCE) {
    const IndexerState = require('../models/IndexerState.model');
    const deleted = await IndexerState.deleteMany({});
    console.log(`--force: cleared ${deleted.deletedCount} IndexerState record(s) — full re-index of all data.\n`);
  }

  const { runFullIndex } = require('../jobs/ragIndexer.job');
  console.log('Starting full RAG index (all businesses)...\n');

  const result = await runFullIndex();

  console.log(`\nDone. Indexed ${result.businesses} business(es).`);
  for (const r of result.results) {
    if (r.error) {
      console.log(`  [FAIL] ${r.businessId}: ${r.error}`);
    } else {
      const s = r.stats;
      console.log(`  [OK]   ${r.businessId}: indexed=${s.indexed} skipped=${s.skipped} errors=${s.errors}${s.errors ? ' failed=' + s.failedTypes.join(',') : ''}`);
    }
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('\nReindex failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
