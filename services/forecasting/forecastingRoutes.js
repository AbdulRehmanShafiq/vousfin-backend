/**
 * @file forecastingRoutes.js
 * @description Express router for the vousFin Forecasting API.
 *
 * Endpoints:
 *   POST /api/forecasting/predict    → Run a forecast for a given target & horizon
 *   GET  /api/forecasting/metrics    → Model performance metrics
 *   GET  /api/forecasting/categories → Category breakdown
 *   GET  /api/forecasting/health     → Module health check
 */

const express = require('express');
const router = express.Router();
const {
  generateForecast,
  generateInsights,
  getModelMetrics,
  getCategoryBreakdown,
} = require('./forecastingService');
const { getData } = require('./dataLoader');

/* ═══════════════════════════════════════════════════════
   POST /api/forecasting/predict
   Body: { target: "Revenue"|"Expenses"|"Net Cash Flow", months: 1-12 }
═══════════════════════════════════════════════════════ */
router.post('/predict', (req, res) => {
  try {
    const { target = 'Revenue', months = 6, transactions = [] } = req.body;

    // Validate inputs
    const validTargets = ['Revenue', 'Expenses', 'Net Cash Flow'];
    if (!validTargets.includes(target)) {
      return res.status(400).json({
        success: false,
        error: `Invalid target. Must be one of: ${validTargets.join(', ')}`,
      });
    }

    const numMonths = parseInt(months);
    if (isNaN(numMonths) || numMonths < 1 || numMonths > 12) {
      return res.status(400).json({
        success: false,
        error: 'Months must be between 1 and 12.',
      });
    }

    // Generate forecast
    const forecast = generateForecast(target, numMonths);
    const insights = generateInsights(forecast);

    res.json({
      success: true,
      data: {
        ...forecast,
        insights,
      },
    });
  } catch (err) {
    console.error('[Forecasting] Prediction error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to generate forecast. ' + err.message,
    });
  }
});

/* ═══════════════════════════════════════════════════════
   GET /api/forecasting/metrics
   Returns model performance metrics
═══════════════════════════════════════════════════════ */
router.get('/metrics', (_req, res) => {
  try {
    const metrics = getModelMetrics();
    res.json({ success: true, data: metrics });
  } catch (err) {
    console.error('[Forecasting] Metrics error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════
   GET /api/forecasting/categories
   Returns category-level forecast breakdown
═══════════════════════════════════════════════════════ */
router.get('/categories', (_req, res) => {
  try {
    const categories = getCategoryBreakdown();
    res.json({ success: true, data: categories });
  } catch (err) {
    console.error('[Forecasting] Categories error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════
   GET /api/forecasting/health
   Module health check
═══════════════════════════════════════════════════════ */
router.get('/health', (_req, res) => {
  try {
    const data = getData();
    res.json({
      success: true,
      module: 'vousFin Forecasting Engine',
      status: 'operational',
      dataLoaded: !!data,
      predictions: data?.raw?.futureForecast?.length || 0,
      stores: data?.raw?.forecastByStore?.length || 0,
      categories: data?.raw?.forecastByFamily?.length || 0,
      modelInfo: data?.modelMeta || null,
      loadedAt: data?.loadedAt || null,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      module: 'vousFin Forecasting Engine',
      status: 'error',
      error: err.message,
    });
  }
});

module.exports = router;
