// controllers/ai.controller.js
const aiAssistantService = require('../services/aiAssistant.service');
const ragQueryService = require('../services/ragQuery.service');
const ragIndexer = require('../jobs/ragIndexer.job');
const anomalyDetectionService = require('../services/anomalyDetection.service');
const accountantSuggestionsService = require('../services/accountantSuggestions.service');
const parserService = require('../services/nlParser/services/parserService');
const { generateLSTMForecast } = require('../services/forecasting/lstmForecastService');
const { getFinancialInsights } = require('../services/financialIntelligence.service');
const { METRIC_API_TO_TARGET, formatForecastApiResponse } = require('../utils/forecastResponse.helper');
const ApiResponse = require('../utils/ApiResponse');
const { ApiError } = require('../utils/ApiError');

function shouldExposeRetrievalStats() {
  return process.env.NODE_ENV !== 'production' || process.env.AI_RETRIEVAL_STATS_ENABLED === 'true';
}

function publicAssistantResponse(response = {}) {
  if (shouldExposeRetrievalStats()) return response;
  const { retrievalStats, ...publicResponse } = response;
  return publicResponse;
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Parse natural language transaction description.
 * POST /api/v1/ai/parse-nl
 */
const parseNaturalLanguage = async (req, res, next) => {
  try {
    const { text } = req.body;
    if (!text || text.trim().length < 5) {
      throw new ApiError(400, 'Transaction description must be at least 5 characters');
    }
    const parsed = await parserService.parseTransaction(text);
    ApiResponse.success(res, parsed, 'Natural language parsed successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * AI assistant chat — powered by Groq (LLaMA) with live financial context.
 * POST /api/v1/ai/rag-query
 */
const ragQuery = async (req, res, next) => {
  try {
    const { question, chatHistory = [] } = req.body;
    if (!question || question.trim().length < 3) {
      throw new ApiError(400, 'Question must be at least 3 characters');
    }
    const response = await aiAssistantService.chat(question, req.user.businessId, chatHistory, {
      userId: req.user.id || req.user._id,
    });
    ApiResponse.success(res, publicAssistantResponse(response), 'AI response generated');
  } catch (error) {
    next(error);
  }
};

/**
 * Streaming AI assistant chat.
 * POST /api/v1/ai/rag-query/stream
 */
const ragQueryStream = async (req, res, next) => {
  try {
    const { question, chatHistory = [] } = req.body;
    if (!question || question.trim().length < 3) {
      throw new ApiError(400, 'Question must be at least 3 characters');
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    let metaSent = false;
    let emittedToken = false;
    const emitMeta = (payload) => {
      if (metaSent) return;
      metaSent = true;
      sendSse(res, 'meta', publicAssistantResponse(payload));
    };

    const response = await aiAssistantService.chatStream(
      question,
      req.user.businessId,
      chatHistory,
      {
        userId: req.user.id || req.user._id,
        onMeta: emitMeta,
        onToken: (delta) => {
          if (!metaSent) emitMeta({ mode: 'streaming', sources: [], confident: true });
          emittedToken = true;
          sendSse(res, 'token', { delta });
        },
      }
    );

    emitMeta({
      sources: response.sources || [],
      confident: response.confident !== false,
      mode: response.mode || 'unknown',
      retrievalStats: response.retrievalStats,
      provider: response.provider,
    });

    if (!emittedToken && response.answer) {
      sendSse(res, 'token', { delta: response.answer });
    }

    sendSse(res, 'done', publicAssistantResponse(response));
    res.end();
  } catch (error) {
    if (res.headersSent) {
      sendSse(res, 'error', { message: 'AI response failed. Please try again.' });
      return res.end();
    }
    return next(error);
  }
};

/**
 * AI-powered financial recommendations based on live accounting data.
 * POST /api/v1/ai/cashflow-recommendations
 */
const cashflowRecommendations = async (req, res, next) => {
  try {
    const recommendations = await aiAssistantService.generateRecommendations(req.user.businessId);
    ApiResponse.success(res, recommendations, 'Recommendations generated');
  } catch (error) {
    next(error);
  }
};

/**
 * Get financial forecast.
 * POST /api/v1/ai/forecast
 */
const forecast = async (req, res, next) => {
  try {
    const { metric, horizon } = req.body;
    if (!metric || !horizon) {
      throw new ApiError(400, 'Both metric and horizon are required');
    }
    const target = METRIC_API_TO_TARGET[metric] || 'Revenue';

    // LSTM forecast uses only this business's own accounting data — no static fallback
    const forecastResult = await generateLSTMForecast(req.user.businessId, target, horizon);

    const payload = formatForecastApiResponse(metric, horizon, forecastResult);
    ApiResponse.success(res, payload, 'Forecast generated');
  } catch (error) {
    next(error);
  }
};

/**
 * Run anomaly scan on recent transactions.
 * POST /api/v1/ai/anomaly-scan   body: { force?: boolean }
 *
 * When `force=true`, previously cleared (legit / ignored) transactions are
 * re-scored — used by admins for a full audit run.  Default: respect decisions.
 */
const anomalyScan = async (req, res, next) => {
  try {
    const force = Boolean(req.body?.force);
    const result = await anomalyDetectionService.runScan(req.user.businessId, { force });
    ApiResponse.success(res, result, 'Anomaly scan completed');
  } catch (error) {
    next(error);
  }
};

/**
 * Fetch stored anomaly alerts from the database.
 * GET /api/v1/ai/anomaly-alerts?status=pending&page=1&limit=25
 */
const getAnomalyAlerts = async (req, res, next) => {
  try {
    const { status = null, page = 1, limit = 25 } = req.query;
    const result = await anomalyDetectionService.getAlerts(
      req.user.businessId,
      status || null,
      { page: parseInt(page, 10), limit: parseInt(limit, 10) }
    );
    ApiResponse.success(res, result, 'Anomaly alerts retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Review / classify an anomaly alert.
 * PUT /api/v1/ai/anomaly-alerts/:id/review
 * Body: { action: "legitimate" | "fraud" | "ignore", notes?: string }
 */
const reviewAnomalyAlert = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { action, notes = '' } = req.body || {};
    const allowed = ['legitimate', 'fraud', 'ignore', 'legit', 'mark_legit',
                     'confirm_fraud', 'ignored', 'dismiss'];
    if (!action || !allowed.includes(action)) {
      throw new ApiError(400, 'action must be one of: legitimate | fraud | ignore');
    }
    const userId = req.user._id || req.user.id;
    const updated = await anomalyDetectionService.reviewAlert(id, action, userId, notes);
    ApiResponse.success(res, updated, 'Alert reviewed successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Get anomaly counts grouped by status (for dashboard stats).
 * GET /api/v1/ai/anomaly-stats
 */
const getAnomalyStats = async (req, res, next) => {
  try {
    const stats = await anomalyDetectionService.getStats(req.user.businessId);
    ApiResponse.success(res, stats, 'Anomaly statistics retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Semantic search on transactions.
 * POST /api/v1/ai/semantic-search
 */
const semanticSearch = async (req, res, next) => {
  try {
    const { query } = req.body;
    if (!query || query.trim().length < 2) {
      throw new ApiError(400, 'Search query must be at least 2 characters');
    }
    const results = await ragQueryService.semanticSearch(req.user.businessId, query);
    ApiResponse.success(res, results, 'Search completed');
  } catch (error) {
    next(error);
  }
};


/**
 * Admin-triggered RAG reindex.
 * POST /api/v1/ai/admin/reindex body: { businessId?: string, all?: boolean }
 */
const reindexRag = async (req, res, next) => {
  try {
    const { businessId, all = false } = req.body || {};
    const targetBusinessId = businessId || req.user.businessId;
    const isAdmin = req.user.role === 'admin';

    if ((all || String(targetBusinessId) !== String(req.user.businessId)) && !isAdmin) {
      throw new ApiError(403, 'Admin access required for cross-business RAG reindex');
    }

    const result = all
      ? await ragIndexer.runFullIndex()
      : await ragIndexer.indexBusinessById(targetBusinessId);
    ApiResponse.success(res, result, 'RAG reindex completed');
  } catch (error) {
    next(error);
  }
};

/**
 * Pre-save accountant check — duplicate, tax, party, amount warnings.
 * POST /api/v1/ai/pre-save-check
 */
const preSaveCheck = async (req, res, next) => {
  try {
    const result = await accountantSuggestionsService.preCheck(req.user.businessId, req.body);
    ApiResponse.success(res, result, 'Pre-save check complete');
  } catch (error) {
    next(error);
  }
};

/**
 * AI financial intelligence — unusual spending, tax risk, cash flow warnings.
 * GET /api/v1/ai/financial-insights
 */
const financialInsights = async (req, res, next) => {
  try {
    const result = await getFinancialInsights(req.user.businessId);
    ApiResponse.success(res, result, 'Financial insights generated');
  } catch (error) {
    next(error);
  }
};

/**
 * Business Health Score — auditable score from real ledger data.
 * GET /api/v1/ai/health-score
 */
const healthScore = async (req, res, next) => {
  try {
    const businessHealthService = require('../services/businessHealth.service');
    const result = await businessHealthService.getHealthScore(req.user.businessId);
    ApiResponse.success(res, result, 'Business health score computed');
  } catch (error) {
    next(error);
  }
};

/**
 * Health score over time + change vs last month (for the trend sparkline).
 * GET /api/v1/ai/health-history?days=90
 */
const healthHistory = async (req, res, next) => {
  try {
    const businessHealthService = require('../services/businessHealth.service');
    const days = Number(req.query.days) || 90;
    const result = await businessHealthService.getHealthHistory(req.user.businessId, days);
    ApiResponse.success(res, result, 'Business health history');
  } catch (error) {
    next(error);
  }
};

/**
 * Forward-looking outlook — projected runway, future margin, forward health
 * score and proactive signals, from the ensemble forecast.
 * GET /api/v1/ai/health-outlook?horizon=6
 */
const healthOutlook = async (req, res, next) => {
  try {
    const businessHealthService = require('../services/businessHealth.service');
    const horizonMonths = Number(req.query.horizon) || 6;
    const result = await businessHealthService.getForwardOutlook(req.user.businessId, { horizonMonths });
    ApiResponse.success(res, result, 'Business outlook computed');
  } catch (error) {
    next(error);
  }
};

/**
 * Unified "Needs attention" feed — merges financial insights, forecast signals
 * and anomalies into one ranked, de-duplicated action list.
 * GET /api/v1/ai/needs-attention
 */
const needsAttention = async (req, res, next) => {
  try {
    const proactiveInsights = require('../services/proactiveInsights.service');
    const result = await proactiveInsights.getNeedsAttention(req.user.businessId);
    ApiResponse.success(res, result, 'Needs-attention feed generated');
  } catch (error) {
    next(error);
  }
};

module.exports = {
  parseNaturalLanguage,
  ragQuery,
  ragQueryStream,
  cashflowRecommendations,
  forecast,
  anomalyScan,
  getAnomalyAlerts,
  reviewAnomalyAlert,
  getAnomalyStats,
  semanticSearch,
  reindexRag,
  preSaveCheck,
  financialInsights,
  healthScore,
  healthHistory,
  healthOutlook,
  needsAttention,
};
