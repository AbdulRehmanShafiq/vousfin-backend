// services/dashboard.service.js
const reportService = require('./report.service');
const transactionRepository = require('../repositories/transaction.repository');
const accountRepository = require('../repositories/account.repository');
const { ApiError } = require('../utils/ApiError');
const { TRANSACTION_TYPES, JOURNAL_STATUS } = require('../config/constants');
const mongoose = require('mongoose');
const JournalEntry = require('../models/JournalEntry.model');
const logger = require('../config/logger');
const reportCache = require('../utils/reportCache');

class DashboardService {
  /**
   * Get KPI values for dashboard.
   * @param {string} businessId
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {Promise<Object>}
   */
  async getKPIs(businessId, startDate, endDate) {
    if (!businessId) throw new ApiError(400, 'Business ID is required');
    const kpis = await reportService.getKPISummary(businessId, startDate, endDate);
    return {
      revenue: kpis.revenue,
      expenses: kpis.expenses,
      netProfit: kpis.netProfit,
      cashBalance: kpis.cashBalance,
      profitMargin: kpis.profitMargin,
      accountsReceivable: kpis.accountsReceivable,
      accountsPayable: kpis.accountsPayable,
      period: { startDate, endDate },
    };
  }

  /**
   * Get revenue vs expenses time-series data for chart.
   * Uses a single MongoDB $group aggregation — no Node.js memory accumulation.
   * @param {string} businessId
   * @param {Date} startDate
   * @param {Date} endDate
   * @param {string} interval - 'day', 'week', 'month' (default 'month')
   * @returns {Promise<Array>} Array of { period, revenue, expenses }
   */
  async getRevenueVsExpensesChart(businessId, startDate, endDate, interval = 'month') {
    if (!businessId) throw new ApiError(400, 'Business ID required');

    const validId = mongoose.Types.ObjectId.isValid(businessId)
      ? new mongoose.Types.ObjectId(businessId)
      : businessId;

    const REVENUE_TYPES = [
      TRANSACTION_TYPES.INCOME, TRANSACTION_TYPES.CASH_SALE,
      TRANSACTION_TYPES.CREDIT_SALE, TRANSACTION_TYPES.INVENTORY_SALE,
    ];
    const EXPENSE_TYPES = [
      TRANSACTION_TYPES.EXPENSE, TRANSACTION_TYPES.CASH_PURCHASE,
      TRANSACTION_TYPES.CREDIT_PURCHASE, TRANSACTION_TYPES.INVENTORY_PURCHASE,
      TRANSACTION_TYPES.SALARY,
    ];

    const groupId = interval === 'day'
      ? { year: { $year: '$transactionDate' }, month: { $month: '$transactionDate' }, day: { $dayOfMonth: '$transactionDate' } }
      : interval === 'week'
        ? { year: { $year: '$transactionDate' }, week: { $week: '$transactionDate' } }
        : { year: { $year: '$transactionDate' }, month: { $month: '$transactionDate' } };

    const rows = await JournalEntry.aggregate([
      {
        $match: {
          businessId: validId,
          transactionDate: { $gte: new Date(startDate), $lte: new Date(endDate) },
          status: { $in: [JOURNAL_STATUS.POSTED, JOURNAL_STATUS.PARTIALLY_SETTLED, JOURNAL_STATUS.SETTLED] },
          isArchived: { $ne: true },
        },
      },
      {
        $group: {
          _id: groupId,
          revenue:  { $sum: { $cond: [{ $in: ['$transactionType', REVENUE_TYPES] }, '$amount', 0] } },
          expenses: { $sum: { $cond: [{ $in: ['$transactionType', EXPENSE_TYPES] }, '$amount', 0] } },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1, '_id.week': 1 } },
    ]);

    return rows.map(r => {
      let period;
      if (interval === 'day') {
        period = `${r._id.year}-${String(r._id.month).padStart(2,'0')}-${String(r._id.day).padStart(2,'0')}`;
      } else if (interval === 'week') {
        period = `${r._id.year}-W${String(r._id.week).padStart(2,'0')}`;
      } else {
        period = `${r._id.year}-${String(r._id.month).padStart(2,'0')}`;
      }
      return { period, revenue: r.revenue || 0, expenses: r.expenses || 0 };
    });
  }

  /**
   * Get net cash flow trend over time.
   * Uses MongoDB $group aggregation — no document hydration into Node.js memory.
   * Handles multiple Cash/Bank accounts (petty cash + bank).
   * @param {string} businessId
   * @param {Date} startDate
   * @param {Date} endDate
   * @param {string} interval - 'day', 'week', 'month'
   * @returns {Promise<Array>} Array of { period, netCashFlow }
   */
  async getCashFlowTrend(businessId, startDate, endDate, interval = 'month') {
    if (!businessId) throw new ApiError(400, 'Business ID required');

    const validId = mongoose.Types.ObjectId.isValid(businessId)
      ? new mongoose.Types.ObjectId(businessId)
      : businessId;

    const accounts = (await accountRepository.findByBusiness(businessId)) || [];
    const cashAccounts = accounts.filter(
      acc => acc.accountSubtype === 'Bank and Cash' || /\b(cash|bank)\b/i.test(acc.accountName)
    );

    if (cashAccounts.length === 0) {
      logger.warn(`No Cash/Bank account found for business ${businessId}`);
      return [];
    }

    const cashAccountIds = cashAccounts.map(a => a._id);

    const groupId = interval === 'day'
      ? { year: { $year: '$transactionDate' }, month: { $month: '$transactionDate' }, day: { $dayOfMonth: '$transactionDate' } }
      : interval === 'week'
        ? { year: { $year: '$transactionDate' }, week: { $week: '$transactionDate' } }
        : { year: { $year: '$transactionDate' }, month: { $month: '$transactionDate' } };

    const rows = await JournalEntry.aggregate([
      {
        $match: {
          businessId: validId,
          transactionDate: { $gte: new Date(startDate), $lte: new Date(endDate) },
          status: { $in: [JOURNAL_STATUS.POSTED, JOURNAL_STATUS.PARTIALLY_SETTLED, JOURNAL_STATUS.SETTLED] },
          isArchived: { $ne: true },
          $or: [
            { debitAccountId:  { $in: cashAccountIds } },
            { creditAccountId: { $in: cashAccountIds } },
          ],
        },
      },
      {
        $group: {
          _id: groupId,
          // Inflow: cash debited (received); Outflow: cash credited (paid out)
          inflow:  { $sum: { $cond: [{ $in: ['$debitAccountId',  cashAccountIds] }, '$amount', 0] } },
          outflow: { $sum: { $cond: [{ $in: ['$creditAccountId', cashAccountIds] }, '$amount', 0] } },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1, '_id.week': 1 } },
    ]);

    return rows.map(r => {
      let period;
      if (interval === 'day') {
        period = `${r._id.year}-${String(r._id.month).padStart(2,'0')}-${String(r._id.day).padStart(2,'0')}`;
      } else if (interval === 'week') {
        period = `${r._id.year}-W${String(r._id.week).padStart(2,'0')}`;
      } else {
        period = `${r._id.year}-${String(r._id.month).padStart(2,'0')}`;
      }
      return { period, netCashFlow: (r.inflow || 0) - (r.outflow || 0) };
    });
  }

  /**
   * Get all dashboard data in one call (KPIs + both charts).
   * @param {string} businessId
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {Promise<Object>}
   */
  async getAllDashboardData(businessId, startDate, endDate) {
    // ── Cache layer ────────────────────────────────────────────────────────────
    // The dashboard aggregates KPIs + 2 chart series — all expensive operations.
    // Cache is invalidated by transaction writes, so data is always fresh after a write.
    const _dashParams = {
      start: new Date(startDate).toISOString(),
      end:   new Date(endDate).toISOString(),
    };
    const _dashCached = await reportCache.get('dashboard-all', businessId.toString(), _dashParams);
    if (_dashCached) return _dashCached;

    const [kpis, revenueVsExpenses, cashFlowTrend] = await Promise.all([
      this.getKPIs(businessId, startDate, endDate),
      this.getRevenueVsExpensesChart(businessId, startDate, endDate),
      this.getCashFlowTrend(businessId, startDate, endDate),
    ]);

    const _dashResult = { kpis, revenueVsExpenses, cashFlowTrend };
    reportCache.set('dashboard-all', businessId.toString(), _dashParams, _dashResult);
    return _dashResult;
  }

}


module.exports = new DashboardService();
