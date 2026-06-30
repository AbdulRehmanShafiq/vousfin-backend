'use strict';

/**
 * catalogSearch.service.js — Tier 2 semantic search over the GLOBAL app catalog.
 *
 * Isolation: it always queries the reserved GLOBAL_CATALOG_BUSINESS_ID sentinel
 * with the app_catalog dataType, so the existing businessId vector-search filter
 * makes it physically impossible to read a tenant's financial vectors (and the
 * financial RAG, which filters by a real businessId, can never read these).
 */

const { GLOBAL_CATALOG_BUSINESS_ID } = require('../config/constants');
const embeddingService = require('./embeddingService');
const vectorStore = require('./vectorStore.service');
const { CATALOG_DATA_TYPE } = require('./appCatalogIndex.service');

const MIN_SCORE = Number(process.env.CATALOG_SEARCH_MIN_SCORE || 0.15);

/**
 * @param {string} query
 * @param {{ disabledModules?: string[], limit?: number }} [opts]
 * @returns {Promise<Array<{id,type,title,path,href,moduleKey,enablementKey,score}>>}
 */
async function searchCatalog(query, { disabledModules = [], limit = 8 } = {}) {
  if (!query || !String(query).trim()) return [];

  const queryVector = await embeddingService.embedQuery(query);
  const hits = await vectorStore.searchSimilar(
    queryVector,
    GLOBAL_CATALOG_BUSINESS_ID,
    Math.max(limit * 3, 24),
    { dataTypes: [CATALOG_DATA_TYPE], queryText: query }
  );

  const disabled = new Set(disabledModules);
  return hits
    .filter((h) => Number(h.vectorScore) >= MIN_SCORE)
    .map((h) => ({
      id: h.recordId,
      type: h.metadata?.type || null,
      title: h.metadata?.title || h.recordId,
      path: h.metadata?.path || [],
      href: h.metadata?.href || null,
      moduleKey: h.metadata?.moduleKey || null,
      enablementKey: h.metadata?.enablementKey ?? null,
      score: Number(h.vectorScore),
    }))
    .filter((e) => e.enablementKey == null || !disabled.has(e.enablementKey))
    .slice(0, limit);
}

module.exports = { searchCatalog, MIN_SCORE };
