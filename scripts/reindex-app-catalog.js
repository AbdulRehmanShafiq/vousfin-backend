'use strict';

// One-shot: embed the global app catalog (data/app-catalog.json) into the
// vector store. Run from vousfin-backend-main: node scripts/reindex-app-catalog.js
// Idempotent — unchanged entries are skipped by content hash.

require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI not set in .env');
  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected.\n');

  const { reindexAppCatalog } = require('../services/appCatalogIndex.service');
  console.log('Indexing the global app catalog...');
  const stats = await reindexAppCatalog();
  console.log(`\nDone. total=${stats.total} indexed=${stats.indexed} skipped=${stats.skipped}`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('\nCatalog reindex failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
