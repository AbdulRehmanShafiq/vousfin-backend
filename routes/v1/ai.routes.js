const express = require('express');
const router = express.Router();
const aiController = require('../../controllers/ai.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const adminMiddleware = require('../../middleware/admin.middleware');
const validate = require('../../middleware/validate.middleware');
const Joi = require('joi');

// ─── Validation schemas ────────────────────────────────────────────────────────

const parseNLSchema = Joi.object({
  text: Joi.string().min(5).max(1000).required(),
});

const ragQuerySchema = Joi.object({
  question: Joi.string().min(3).max(500).required(),
  chatHistory: Joi.array().items(Joi.object()).optional(),
});

const forecastSchema = Joi.object({
  metric: Joi.string().valid('revenue', 'expenses', 'netCashFlow').required(),
  horizon: Joi.number().valid(1, 3, 6).required(),
});

const semanticSearchSchema = Joi.object({
  query: Joi.string().min(2).max(200).required(),
});

const reindexSchema = Joi.object({
  businessId: Joi.string().optional(),
  all: Joi.boolean().optional(),
});

const reviewAlertSchema = Joi.object({
  action: Joi.string()
    .valid('legitimate', 'fraud', 'ignore', 'legit', 'mark_legit',
           'confirm_fraud', 'ignored', 'dismiss')
    .required(),
  notes: Joi.string().max(1000).optional().allow(''),
});

// ─── All AI routes require auth + business context ─────────────────────────────

router.use(authMiddleware, requireBusiness);

// NLP / assistant
router.post('/parse-nl',                validate(parseNLSchema),        aiController.parseNaturalLanguage);
router.post('/rag-query/stream',        validate(ragQuerySchema),        aiController.ragQueryStream);
router.post('/rag-query',               validate(ragQuerySchema),        aiController.ragQuery);
router.post('/cashflow-recommendations',                                 aiController.cashflowRecommendations);
router.post('/forecast',                validate(forecastSchema),        aiController.forecast);
router.post('/semantic-search',         validate(semanticSearchSchema),  aiController.semanticSearch);
router.post('/admin/reindex',           adminMiddleware, validate(reindexSchema), aiController.reindexRag);

// Pre-save accountant suggestions
router.post('/pre-save-check',                                           aiController.preSaveCheck);

// Anomaly detection
router.post('/anomaly-scan',                                             aiController.anomalyScan);
router.get('/anomaly-alerts',                                            aiController.getAnomalyAlerts);
router.get('/anomaly-stats',                                             aiController.getAnomalyStats);
router.put('/anomaly-alerts/:id/review', validate(reviewAlertSchema),   aiController.reviewAnomalyAlert);

// AI Financial Intelligence
router.get('/financial-insights',                                        aiController.financialInsights);

// Business Health Score (auditable, server-side)
router.get('/health-score',                                              aiController.healthScore);

// Business Health history + trend (sparkline + change vs last month)
router.get('/health-history',                                            aiController.healthHistory);

// Forward-looking outlook (projected runway / margin / forward health)
router.get('/health-outlook',                                            aiController.healthOutlook);

// Unified "Needs attention" feed (merged + ranked insights/forecast/anomalies)
router.get('/needs-attention',                                           aiController.needsAttention);

module.exports = router;
