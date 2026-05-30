// controllers/forecastPlatform.controller.js
// Forecast Platform — Foundation (F1) API.
'use strict';
const datasetBuilder = require('../services/forecasting/platform/datasetBuilder.service');
const featureStore = require('../services/forecasting/platform/featureStore.service');
const ForecastDatasetRegistry = require('../models/ForecastDatasetRegistry.model');
const ApiResponse = require('../utils/ApiResponse');

const biz = (req) => req.user.businessId;

// Parse shared build options from the request body.
function buildOpts(body = {}) {
  return {
    granularity:     body.granularity || 'monthly',
    sources:         Array.isArray(body.sources) && body.sources.length ? body.sources : ['journal_entries', 'invoices', 'bills'],
    monthsBack:      body.monthsBack != null ? Number(body.monthsBack) : 24,
    tzOffsetMinutes: body.tzOffsetMinutes != null ? Number(body.tzOffsetMinutes) : 0,
    datasetKey:      body.datasetKey || 'core-financials',
  };
}

// POST /forecast-platform/datasets/build — build + validate (no persistence; preview).
exports.buildDataset = async (req, res, next) => {
  try {
    const { meta, rows, validation, contentHash } = await datasetBuilder.buildDataset(biz(req), buildOpts(req.body));
    ApiResponse.success(res, { meta, validation, contentHash, preview: rows.slice(-6), rowCount: rows.length }, 'Dataset built');
  } catch (err) { next(err); }
};

// POST /forecast-platform/features/materialize — build → engineer → persist → register.
exports.materialize = async (req, res, next) => {
  try {
    const result = await featureStore.materialize(biz(req), buildOpts(req.body), req.user);
    ApiResponse.success(res, result, 'Feature snapshots materialized');
  } catch (err) { next(err); }
};

// GET /forecast-platform/features — persisted point-in-time features ("as known on" asOf).
exports.listFeatures = async (req, res, next) => {
  try {
    const rows = await featureStore.getSnapshots(biz(req), {
      datasetKey: req.query.datasetKey, granularity: req.query.granularity, asOf: req.query.asOf,
    });
    ApiResponse.success(res, rows, 'Feature snapshots');
  } catch (err) { next(err); }
};

// GET /forecast-platform/datasets — registry (lineage) list.
exports.listRegistry = async (req, res, next) => {
  try {
    const rows = await ForecastDatasetRegistry.find({ businessId: biz(req) })
      .sort({ createdAt: -1 }).limit(100).lean();
    ApiResponse.success(res, rows, 'Dataset registry');
  } catch (err) { next(err); }
};

// GET /forecast-platform/sources — declared source contract (live vs pending).
exports.listSources = async (req, res, next) => {
  try {
    ApiResponse.success(res, datasetBuilder.sources, 'Forecast platform sources');
  } catch (err) { next(err); }
};
