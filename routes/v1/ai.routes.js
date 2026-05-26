const express = require('express');
const router = express.Router();
const aiController = require('../../controllers/ai.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
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
router.post('/rag-query',               validate(ragQuerySchema),        aiController.ragQuery);
router.post('/cashflow-recommendations',                                 aiController.cashflowRecommendations);
router.post('/forecast',                validate(forecastSchema),        aiController.forecast);
router.post('/semantic-search',         validate(semanticSearchSchema),  aiController.semanticSearch);

// Pre-save accountant suggestions
router.post('/pre-save-check',                                           aiController.preSaveCheck);

// Anomaly detection
router.post('/anomaly-scan',                                             aiController.anomalyScan);
router.get('/anomaly-alerts',                                            aiController.getAnomalyAlerts);
router.get('/anomaly-stats',                                             aiController.getAnomalyStats);
router.put('/anomaly-alerts/:id/review', validate(reviewAlertSchema),   aiController.reviewAnomalyAlert);

module.exports = router;
