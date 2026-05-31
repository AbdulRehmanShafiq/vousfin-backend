// controllers/forecastDomain.controller.js — Forecast Platform F6
'use strict';
const domainForecast = require('../services/forecasting/domainForecast.service');
const ApiResponse = require('../utils/ApiResponse');

const VALID = ['profitability', 'liquidity-stress', 'debt-exposure', 'ar-payment-behavior', 'inventory-demand', 'macro-sensitivity'];

exports.forecast = async (req, res, next) => {
  try {
    const { domain } = req.params;
    if (!VALID.includes(domain)) return next(Object.assign(new Error(`Unknown domain. Valid: ${VALID.join(', ')}`), { statusCode: 400 }));
    const horizon = Number(req.query.horizon) || 6;
    const result = await domainForecast.forecast(req.user.businessId, domain, horizon);
    ApiResponse.success(res, result, `${domain} forecast`);
  } catch (err) { next(err); }
};

exports.list = async (req, res, next) => {
  try { ApiResponse.success(res, { domains: VALID }, 'Available forecast domains'); }
  catch (err) { next(err); }
};
