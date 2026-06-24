// controllers/thirteenWeekCashFlow.controller.js — Phase 8 FR-06.3
'use strict';
const service = require('../services/thirteenWeekCashFlow.service');
const ApiResponse = require('../utils/ApiResponse');

exports.getForecast = async (req, res, next) => {
  try {
    const floor = req.query.floor ?? 0; // Joi-validated & defaulted
    const data  = await service.buildForecast(req.user.businessId, { floorAmount: Number(floor) });
    ApiResponse.success(res, data, '13-week cash flow forecast generated');
  } catch (e) { next(e); }
};

exports.getAlerts = async (req, res, next) => {
  try {
    const floor = req.query.floor ?? 0; // Joi-validated & defaulted
    const data  = await service.getLiquidityAlerts(req.user.businessId, floor);
    ApiResponse.success(res, data, 'Liquidity alerts retrieved');
  } catch (e) { next(e); }
};
