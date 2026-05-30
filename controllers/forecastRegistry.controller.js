// controllers/forecastRegistry.controller.js — Forecast Platform F3
'use strict';
const mongoose = require('mongoose');
const ForecastRun = require('../models/ForecastRun.model');
const ModelRegistry = require('../models/ModelRegistry.model');
const ForecastAccuracy = require('../models/ForecastAccuracy.model');
const forecastStore = require('../services/forecasting/forecastStore.service');
const classical = require('../services/forecasting/classical');
const ensembleForecast = require('../services/forecasting/ensembleForecast.service');
const lstm = require('../services/forecasting/lstmForecastService');
const { runAccuracyCapture } = require('../jobs/forecastAccuracy.job');
const ApiResponse = require('../utils/ApiResponse');

const biz = (req) => req.user.businessId;
const METRIC_KEY = { Revenue: 'revenue', Expenses: 'expenses', 'Net Cash Flow': 'profit' };

// GET /forecast-registry/runs — recent persisted forecasts (audit trail).
exports.listRuns = async (req, res, next) => {
  try {
    const q = { businessId: biz(req) };
    if (req.query.target) q.target = req.query.target;
    if (req.query.granularity) q.granularity = req.query.granularity;
    const rows = await ForecastRun.find(q).sort({ generatedAt: -1 }).limit(Number(req.query.limit) || 50).lean();
    ApiResponse.success(res, rows, 'Forecast runs');
  } catch (err) { next(err); }
};

// GET /forecast-registry/models — registered model versions + gate verdicts.
exports.listModels = async (req, res, next) => {
  try {
    const q = { businessId: biz(req) };
    if (req.query.key) q.key = req.query.key;
    const rows = await ModelRegistry.find(q).sort({ createdAt: -1 }).limit(Number(req.query.limit) || 50).lean();
    ApiResponse.success(res, rows, 'Model registry');
  } catch (err) { next(err); }
};

// GET /forecast-registry/accuracy — realized out-of-sample accuracy summary.
exports.accuracySummary = async (req, res, next) => {
  try {
    const match = { businessId: new mongoose.Types.ObjectId(biz(req)) };
    if (req.query.target) match.target = req.query.target;
    const rows = await ForecastAccuracy.aggregate([
      { $match: match },
      { $group: {
        _id: '$target',
        points: { $sum: 1 },
        avgAbsError: { $avg: '$absError' },
        avgPctError: { $avg: '$pctError' },
        coverage:    { $avg: { $cond: ['$withinInterval', 1, 0] } },
      } },
    ]);
    ApiResponse.success(res, rows.map((r) => ({
      target: r._id, points: r.points,
      avgAbsError: Math.round(r.avgAbsError),
      mape: r.avgPctError != null ? Math.round(r.avgPctError * 10) / 10 : null,
      intervalCoverage: Math.round(r.coverage * 100) / 100,
    })), 'Realized forecast accuracy');
  } catch (err) { next(err); }
};

// POST /forecast-registry/backtest — backtest the classical model vs seasonal-naive now.
exports.backtest = async (req, res, next) => {
  try {
    const target = req.body?.target || 'Revenue';
    const granularity = req.body?.granularity || 'monthly';
    const horizon = Number(req.body?.horizon) || 1;
    const monthsBack = Number(req.body?.monthsBack) || 24;
    const metric = METRIC_KEY[target] || 'revenue';

    const monthly = await lstm.fetchMonthlyData(biz(req), monthsBack);
    const series = monthly.map((m) => m[metric]).filter((v) => v != null);
    if (series.length < 4) return ApiResponse.success(res, { insufficient: true, points: series.length }, 'Insufficient history to backtest');

    const period = series.length >= 6 ? 3 : 2;
    const verdict = await forecastStore.evaluateAndRegister(biz(req), {
      target, granularity, series, period, horizon,
      forecastFn: (tr, h) => classical.holtWintersForecaster(tr, h, { period }),
      modelType: 'Holt-Winters', createdBy: req.user._id,
    });
    ApiResponse.success(res, verdict, 'Backtest complete');
  } catch (err) { next(err); }
};

// GET /forecast-registry/ensemble — standalone multi-model ensemble forecast
// with conformal-calibrated intervals + member weights + gate verdict.
exports.ensemble = async (req, res, next) => {
  try {
    const target = req.query.target || 'Revenue';
    const granularity = req.query.granularity || 'monthly';
    const horizon = Number(req.query.horizon) || 6;
    const result = await ensembleForecast.forecast(biz(req), target, granularity, horizon);
    ApiResponse.success(res, result, 'Ensemble forecast');
  } catch (err) { next(err); }
};

// POST /forecast-registry/accuracy/run — capture realized accuracy now (admin).
exports.runAccuracy = async (req, res, next) => {
  try { ApiResponse.success(res, await runAccuracyCapture(), 'Accuracy capture complete'); }
  catch (err) { next(err); }
};
