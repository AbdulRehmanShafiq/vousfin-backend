'use strict';

/**
 * appCatalogIndex.service.js — index the app module/help catalog into the GLOBAL
 * vector scope (Tier 2 of the command-bar design).
 *
 * The catalog is identical for every tenant, so it is embedded ONCE under the
 * reserved GLOBAL_CATALOG_BUSINESS_ID sentinel (scope: 'global'). The existing
 * businessId vector-search filter then isolates it from every tenant's financial
 * search automatically. Content is read from data/app-catalog.json, a committed
 * artifact generated from the frontend nav.config (npm run catalog:export).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { GLOBAL_CATALOG_BUSINESS_ID } = require('../config/constants');
const embeddingService = require('./embeddingService');
const vectorStore = require('./vectorStore.service');
const logger = require('../config/logger');

const CATALOG_DATA_TYPE = 'app_catalog';
const CATALOG_PERIOD = 'static';
const MANIFEST_PATH = path.join(__dirname, '..', 'data', 'app-catalog.json');

/** Text we embed + keyword-match: title, breadcrumb and plain-language synonyms. */
function catalogSearchText(entry) {
  return [entry.title, ...(entry.path || []), ...(entry.synonyms || [])]
    .filter(Boolean)
    .join(' ');
}

function buildCatalogDocs(entries) {
  return entries.map((e) => {
    const summary = catalogSearchText(e);
    return {
      businessId: GLOBAL_CATALOG_BUSINESS_ID,
      scope: 'global',
      dataType: CATALOG_DATA_TYPE,
      recordId: e.id,
      period: CATALOG_PERIOD,
      summary,
      summaryHash: crypto.createHash('sha256').update(summary).digest('hex'),
      metadata: {
        title: e.title,
        href: e.href,
        type: e.type,
        path: e.path,
        moduleKey: e.moduleKey,
        enablementKey: e.enablementKey,
      },
    };
  });
}

function loadManifest() {
  const raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  return Array.isArray(raw.entries) ? raw.entries : [];
}

/**
 * Embed and upsert every catalog entry. Idempotent: upsertEmbedding skips
 * unchanged docs by summaryHash, so re-running only re-embeds what changed.
 * @param {{ entries?: Array }} [opts]  inject entries for tests; defaults to the manifest
 */
async function reindexAppCatalog({ entries } = {}) {
  const list = entries || loadManifest();
  const docs = buildCatalogDocs(list);
  const embeddings = await embeddingService.embedDocuments(docs.map((d) => d.summary));

  const stats = { total: docs.length, indexed: 0, skipped: 0 };
  for (let i = 0; i < docs.length; i += 1) {
    const res = await vectorStore.upsertEmbedding({ ...docs[i], embedding: embeddings[i] });
    if (res.skipped) stats.skipped += 1; else stats.indexed += 1;
  }
  logger.info(`[appCatalog] reindex complete: ${JSON.stringify(stats)}`);
  return stats;
}

module.exports = {
  buildCatalogDocs,
  catalogSearchText,
  loadManifest,
  reindexAppCatalog,
  CATALOG_DATA_TYPE,
  CATALOG_PERIOD,
};
