'use strict';

const ApiResponse = require('../utils/ApiResponse');
const { searchCatalog } = require('../services/catalogSearch.service');
const appCatalogIndex = require('../services/appCatalogIndex.service');
const helpCorpus = require('../services/helpCorpus.service');
const { answerHowTo } = require('../services/howTo.service');
const searchAnalytics = require('../services/searchAnalytics.service');

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

/**
 * POST /api/v1/search/howto  { q }
 * Tier 3 — a grounded "how do I…" answer over the global help corpus, with a
 * deep link to the relevant page. Refuses rather than hallucinate when the help
 * corpus does not cover the question.
 */
async function howToSearch(req, res, next) {
  try {
    const q = (req.body && req.body.q) || req.query.q || '';
    if (!String(q).trim()) {
      return ApiResponse.success(res, { grounded: false, answer: '', href: null, sources: [] }, 'How-to');
    }
    const result = await answerHowTo(String(q));
    return ApiResponse.success(res, result, 'How-to answer');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/search/log — record a command-bar event (fire-and-forget).
 * Never blocks: the analytics write runs without awaiting and the response is
 * returned immediately. No userId is stored (see searchAnalytics).
 */
function logSearch(req, res) {
  const businessId = req.user?.businessId;
  const { kind, query, resultClickedId, noResult } = req.body || {};
  searchAnalytics.logSearch({ businessId, kind, query, resultClickedId, noResult });
  return ApiResponse.success(res, { logged: true }, 'ok');
}

/**
 * GET /api/v1/search/insights?days= — admin-only. Top queries, CTR and the
 * no-result content-gap backlog for this business.
 */
async function searchInsights(req, res, next) {
  try {
    const businessId = req.user?.businessId;
    const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
    const data = await searchAnalytics.getInsights(businessId, { days });
    return ApiResponse.success(res, data, 'Search insights');
  } catch (err) {
    return next(err);
  }
}

module.exports = { catalogSearch, reindexCatalog, howToSearch, logSearch, searchInsights };
