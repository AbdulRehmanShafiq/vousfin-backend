// controllers/ai.controller.js
const aiAssistantService = require('../services/aiAssistant.service');
const aiPlaceholderService = require('../services/aiPlaceholder.service');
const anomalyDetectionService = require('../services/anomalyDetection.service');
const accountantSuggestionsService = require('../services/accountantSuggestions.service');
const parserService = require('../services/nlParser/services/parserService');
const { generateLSTMForecast } = require('../services/forecasting/lstmForecastService');
const { getFinancialInsights } = require('../services/financialIntelligence.service');
const { METRIC_API_TO_TARGET, formatForecastApiResponse } = require('../utils/forecastResponse.helper');
const ApiResponse = require('../utils/ApiResponse');
const { ApiError } = require('../utils/ApiError');

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
    const response = await aiAssistantService.chat(question, req.user.businessId, chatHistory);
    ApiResponse.success(res, response, 'AI response generated');
  } catch (error) {
    next(error);
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
    const results = await aiPlaceholderService.semanticSearch(query, req.user.businessId);
    ApiResponse.success(res, results, 'Search completed');
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

module.exports = {
  parseNaturalLanguage,
  ragQuery,
  cashflowRecommendations,
  forecast,
  anomalyScan,
  getAnomalyAlerts,
  reviewAnomalyAlert,
  getAnomalyStats,
  semanticSearch,
  preSaveCheck,
  financialInsights,
  healthScore,
  healthOutlook,
};
