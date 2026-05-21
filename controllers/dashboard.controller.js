// controllers/dashboard.controller.js
const dashboardService = require('../services/dashboard.service');
const ApiResponse = require('../utils/ApiResponse');
const { ApiError } = require('../utils/ApiError');

/**
 * Get KPI widget values.
 * GET /api/v1/dashboard/kpis
 * Query: startDate, endDate (optional, ISO date strings)
 */
const getKPIs = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;
    
    // If no dates provided, default to current month
    let effectiveStart = start;
    let effectiveEnd = end;
    if (!effectiveStart && !effectiveEnd) {
      const now = new Date();
      effectiveEnd = now;
      effectiveStart = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    
    const kpis = await dashboardService.getKPIs(req.user.businessId, effectiveStart, effectiveEnd);
    ApiResponse.success(res, kpis, 'Dashboard KPIs retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Get revenue vs expenses chart data.
 * GET /api/v1/dashboard/revenue-vs-expenses
 * Query: startDate, endDate, interval (day/week/month, default month)
 */
const getRevenueVsExpenses = async (req, res, next) => {
  try {
    const { startDate, endDate, interval = 'month' } = req.query;
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;
    
    let effectiveStart = start;
    let effectiveEnd = end;
    if (!effectiveStart && !effectiveEnd) {
      const now = new Date();
      effectiveEnd = now;
      effectiveStart = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    
    const chartData = await dashboardService.getRevenueVsExpensesChart(
      req.user.businessId,
      effectiveStart,
      effectiveEnd,
      interval
    );
    ApiResponse.success(res, chartData, 'Revenue vs expenses chart data retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Get cash flow trend chart data.
 * GET /api/v1/dashboard/cash-flow-trend
 * Query: startDate, endDate, interval (day/week/month, default month)
 */
const getCashFlowTrend = async (req, res, next) => {
  try {
    const { startDate, endDate, interval = 'month' } = req.query;
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;
    
    let effectiveStart = start;
    let effectiveEnd = end;
    if (!effectiveStart && !effectiveEnd) {
      const now = new Date();
      effectiveEnd = now;
      effectiveStart = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    
    const chartData = await dashboardService.getCashFlowTrend(
      req.user.businessId,
      effectiveStart,
      effectiveEnd,
      interval
    );
    ApiResponse.success(res, chartData, 'Cash flow trend chart data retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Get all dashboard data in one call (KPIs + both charts).
 * GET /api/v1/dashboard/all
 * Query: startDate, endDate, interval (optional)
 */
const getAllDashboardData = async (req, res, next) => {
  try {
    const { startDate, endDate, interval = 'month' } = req.query;
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;
    
    let effectiveStart = start;
    let effectiveEnd = end;
    if (!effectiveStart && !effectiveEnd) {
      const now = new Date();
      effectiveEnd = now;
      effectiveStart = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    
    const data = await dashboardService.getAllDashboardData(
      req.user.businessId,
      effectiveStart,
      effectiveEnd,
      interval
    );
    ApiResponse.success(res, data, 'Dashboard data retrieved');
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getKPIs,
  getRevenueVsExpenses,
  getCashFlowTrend,
  getAllDashboardData,
};