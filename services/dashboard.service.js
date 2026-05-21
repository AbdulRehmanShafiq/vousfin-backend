// services/dashboard.service.js
const reportService = require('./report.service');
const transactionRepository = require('../repositories/transaction.repository');
const { ApiError } = require('../utils/ApiError');
const { TRANSACTION_TYPES } = require('../config/constants');
const logger = require('../config/logger');

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
   * @param {string} businessId
   * @param {Date} startDate
   * @param {Date} endDate
   * @param {string} interval - 'day', 'week', 'month' (default 'month')
   * @returns {Promise<Array>} Array of { period, revenue, expenses }
   */
  async getRevenueVsExpensesChart(businessId, startDate, endDate, interval = 'month') {
    if (!businessId) throw new ApiError(400, 'Business ID required');
    
    // Fetch all transactions within date range (only Income and Expense types)
    const transactions = await transactionRepository.getByDateRange(businessId, startDate, endDate);
    
    // Group by interval
    const grouped = this._groupTransactionsByInterval(transactions, interval);
    
    // Format for chart: each entry has period label, revenue, expenses
    const chartData = [];
    for (const [periodKey, group] of grouped) {
      let revenue = 0, expenses = 0;
      for (const tx of group) {
        if (tx.transactionType === TRANSACTION_TYPES.INCOME) {
          revenue += tx.amount;
        } else if (tx.transactionType === TRANSACTION_TYPES.EXPENSE) {
          expenses += tx.amount;
        }
      }
      chartData.push({ period: periodKey, revenue, expenses });
    }
    
    // Sort by period (chronologically)
    chartData.sort((a, b) => new Date(a.period) - new Date(b.period));
    return chartData;
  }

  /**
   * Get net cash flow trend over time.
   * @param {string} businessId
   * @param {Date} startDate
   * @param {Date} endDate
   * @param {string} interval - 'day', 'week', 'month'
   * @returns {Promise<Array>} Array of { period, netCashFlow }
   */
  async getCashFlowTrend(businessId, startDate, endDate, interval = 'month') {
    if (!businessId) throw new ApiError(400, 'Business ID required');
    
    // Get all transactions affecting cash (debit or credit to Cash account)
    // First find Cash account ID
    const accountRepository = require('../repositories/account.repository');
    const accounts = await accountRepository.findByBusiness(businessId);
    const cashAccount = accounts.find(acc => acc.accountName.toLowerCase() === 'cash');
    if (!cashAccount) {
      logger.warn(`No Cash account found for business ${businessId}`);
      return [];
    }
    
    // Get all transactions where cash is either debit or credit
    const cashTransactions = await transactionRepository.getByAccount(
      businessId, cashAccount._id, startDate, endDate
    );
    
    // Group by interval and sum net cash flow (inflow - outflow)
    const grouped = new Map();
    for (const tx of cashTransactions) {
      const periodKey = this._getPeriodKey(tx.transactionDate, interval);
      if (!grouped.has(periodKey)) grouped.set(periodKey, { inflow: 0, outflow: 0 });
      const entry = grouped.get(periodKey);
      const isDebit = tx.debitAccountId._id.toString() === cashAccount._id.toString();
      if (isDebit) {
        entry.inflow += tx.amount;
      } else {
        entry.outflow += tx.amount;
      }
    }
    
    const chartData = [];
    for (const [periodKey, { inflow, outflow }] of grouped) {
      chartData.push({ period: periodKey, netCashFlow: inflow - outflow });
    }
    chartData.sort((a, b) => new Date(a.period) - new Date(b.period));
    return chartData;
  }

  /**
   * Get all dashboard data in one call (KPIs + both charts).
   * @param {string} businessId
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {Promise<Object>}
   */
  async getAllDashboardData(businessId, startDate, endDate) {
    const [kpis, revenueVsExpenses, cashFlowTrend] = await Promise.all([
      this.getKPIs(businessId, startDate, endDate),
      this.getRevenueVsExpensesChart(businessId, startDate, endDate),
      this.getCashFlowTrend(businessId, startDate, endDate),
    ]);
    return {
      kpis,
      revenueVsExpenses,
      cashFlowTrend,
    };
  }

  // ===============================
  // Private helpers
  // ===============================

  /**
   * Group transactions by period (day, week, month).
   * @private
   */
  _groupTransactionsByInterval(transactions, interval) {
    const grouped = new Map();
    for (const tx of transactions) {
      const key = this._getPeriodKey(tx.transactionDate, interval);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(tx);
    }
    return grouped;
  }

  /**
   * Generate a period key string based on date and interval.
   * @private
   */
  _getPeriodKey(date, interval) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const day = d.getDate();
    if (interval === 'day') {
      return `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    } else if (interval === 'week') {
      // Get week number (simple approximation)
      const firstDayOfYear = new Date(year, 0, 1);
      const pastDays = (d - firstDayOfYear) / 86400000;
      const weekNo = Math.ceil((pastDays + firstDayOfYear.getDay() + 1) / 7);
      return `${year}-W${weekNo.toString().padStart(2, '0')}`;
    } else { // month
      return `${year}-${month.toString().padStart(2, '0')}`;
    }
  }
}

module.exports = new DashboardService();