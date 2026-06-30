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

  await verifyRetrieval();

  await mongoose.disconnect();
}

// Self-check: a few known queries must resolve to the expected entry. This
// catches an embedding-space mismatch (e.g. some docs embedded by Gemini and
// others by the local fallback when the quota was exhausted mid-run) which the
// counts above cannot detect.
async function verifyRetrieval() {
  const embeddingService = require('../services/embeddingService');
  const vectorStore = require('../services/vectorStore.service');
  const { GLOBAL_CATALOG_BUSINESS_ID } = require('../config/constants');

  const canaries = [
    { q: 'who owes me money', dataType: 'app_catalog', expectPrefix: 'sales.receivables' },
    { q: 'how do i create an invoice', dataType: 'app_help', expectPrefix: 'help.sales' },
    { q: 'how do i run payroll', dataType: 'app_help', expectPrefix: 'help.payroll' },
  ];

  console.log('\nVerifying retrieval…');
  let failures = 0;
  for (const c of canaries) {
    const vec = await embeddingService.embedQuery(c.q);
    const hits = await vectorStore.searchSimilar(vec, GLOBAL_CATALOG_BUSINESS_ID, 2, { dataTypes: [c.dataType], queryText: c.q });
    const top = hits[0];
    const ok = top && String(top.recordId).startsWith(c.expectPrefix) && Number(top.vectorScore) >= 0.6;
    console.log(`  ${ok ? 'PASS' : 'WARN'}  "${c.q}" -> ${top ? `${top.recordId} (${Number(top.vectorScore).toFixed(2)})` : 'NONE'}`);
    if (!ok) failures += 1;
  }
  if (failures) {
    console.warn(`\n⚠  ${failures} canary(ies) failed — embeddings may be inconsistent (e.g. a Gemini quota fallback`);
    console.warn('   left some docs as local-hash vectors). Re-run "node scripts/reindex-app-catalog.js --purge"');
    console.warn('   once real Gemini embedding quota is available.');
  } else {
    console.log('  All canaries passed — retrieval is healthy.');
  }
}

main().catch(async (err) => {
  console.error('\nCatalog reindex failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
