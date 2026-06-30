'use strict';

const ApiResponse = require('../utils/ApiResponse');
const { searchCatalog } = require('../services/catalogSearch.service');
const appCatalogIndex = require('../services/appCatalogIndex.service');
const helpCorpus = require('../services/helpCorpus.service');

/**
 * GET /api/v1/search/catalog?q=&limit=&disabled=
 * Tier 2 semantic search over the global app catalog. `disabled` is a CSV of
 * module keys the caller's business has switched off (a UX filter, not a
 * security boundary — the catalog is non-sensitive app structure).
 */
async function catalogSearch(req, res, next) {
  try {
    const q = req.query.q || '';
    const limit = Math.min(parseInt(req.query.limit, 10) || 8, 25);
    const disabledModules = String(req.query.disabled || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const results = await searchCatalog(q, { disabledModules, limit });
    return ApiResponse.success(res, { results, count: results.length }, 'Catalog search');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/search/reindex — admin-only. Re-embeds the app catalog into the
 * global vector scope (idempotent; unchanged entries are skipped by hash).
 */
async function reindexCatalog(req, res, next) {
  try {
    const catalog = await appCatalogIndex.reindexAppCatalog();
    const help = await helpCorpus.reindexHelp();
    return ApiResponse.success(res, { catalog, help }, 'App catalog + help reindexed');
  } catch (err) {
    return next(err);
  }
}

module.exports = { catalogSearch, reindexCatalog };
