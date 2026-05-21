// services/report.service.js
const transactionRepository = require('../repositories/transaction.repository');
const accountRepository = require('../repositories/account.repository');
const { ApiError } = require('../utils/ApiError');
const { ACCOUNT_TYPES } = require('../config/constants');
const logger = require('../config/logger');

class ReportService {
  /**
   * Generate Income Statement for a date range.
   */
  async getIncomeStatement(businessId, startDate, endDate) {
    if (!businessId || !startDate || !endDate) {
      throw new ApiError(400, 'Missing required parameters: businessId, startDate, endDate');
    }

    const { revenue, expenses } = await transactionRepository.getIncomeStatementData(businessId, startDate, endDate);

    // Normalize to {accountName, balance} shape expected by frontend
    const revenueAccounts = revenue.map(item => ({ accountName: item.name, balance: item.amount }));
    const totalRevenue = revenueAccounts.reduce((sum, item) => sum + item.balance, 0);

    // Split expenses into COGS and Operating Expenses
    const cogsKeywords = ['cost of goods sold', 'cogs', 'cost of sales', 'cost of revenue'];
    const cogsItems = expenses.filter(e => cogsKeywords.some(k => e.name.toLowerCase().includes(k)));
    const opexItems = expenses.filter(e => !cogsKeywords.some(k => e.name.toLowerCase().includes(k)));

    const cogsAccounts = cogsItems.map(item => ({ accountName: item.name, balance: item.amount }));
    const opexAccounts = opexItems.map(item => ({ accountName: item.name, balance: item.amount }));

    const totalCogs = cogsAccounts.reduce((sum, item) => sum + item.balance, 0);
    const totalOpex = opexAccounts.reduce((sum, item) => sum + item.balance, 0);
    const grossProfit = totalRevenue - totalCogs;
    const netIncome = grossProfit - totalOpex;

    return {
      revenue: { accounts: revenueAccounts, total: totalRevenue },
      cogs: { accounts: cogsAccounts, total: totalCogs },
      operatingExpenses: { accounts: opexAccounts, total: totalOpex },
      grossProfit,
      netIncome,
      // Kept for backward compat (PDF export uses these)
      totalRevenue,
      totalExpenses: totalCogs + totalOpex,
      netProfit: netIncome,
      operatingProfit: netIncome,
      period: { startDate, endDate },
    };
  }

  /**
   * Generate Balance Sheet as of a specific date.
   */
  async getBalanceSheet(businessId, asOfDate) {
    if (!businessId || !asOfDate) {
      throw new ApiError(400, 'Missing required parameters: businessId, asOfDate');
    }

    const accounts = await accountRepository.getGroupedByType(businessId);
    const balanceMap = await this._getBalancesAsOf(businessId, asOfDate);
    
    // Map to {accountName, balance} shape expected by frontend
    const mapAccounts = (list, accountType) =>
      list.map(acc => ({
        accountId: acc._id,
        accountName: acc.accountName,
        accountType: acc.accountType || accountType,
        balance: balanceMap[acc._id.toString()] || 0,
      }));

    const assetAccounts = mapAccounts(accounts.Asset || [], 'Asset');
    const liabilityAccounts = mapAccounts(accounts.Liability || [], 'Liability');
    const equityAccounts = mapAccounts(accounts.Equity || [], 'Equity');

    const totalAssets = assetAccounts.reduce((sum, a) => sum + a.balance, 0);
    const totalLiabilities = liabilityAccounts.reduce((sum, l) => sum + l.balance, 0);
    const totalEquity = equityAccounts.reduce((sum, e) => sum + e.balance, 0);
    const equationValid = Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01;

    return {
      assets: { accounts: assetAccounts, total: totalAssets },
      liabilities: { accounts: liabilityAccounts, total: totalLiabilities },
      equity: { accounts: equityAccounts, total: totalEquity },
      totalAssets,
      totalLiabilities,
      totalEquity,
      equationValid,
      asOfDate,
    };
  }

  /**
   * Generate Cash Flow Statement (indirect method) for a date range.
   */
  async getCashFlowStatement(businessId, startDate, endDate) {
    if (!businessId || !startDate || !endDate) {
      throw new ApiError(400, 'Missing required parameters');
    }

    const accounts = await accountRepository.findByBusiness(businessId);
    const cashAccount = accounts.find(acc => acc.accountName.toLowerCase() === 'cash' || acc.accountName.toLowerCase() === 'bank');
    
    if (!cashAccount) {
      throw new ApiError(500, 'Cash or Bank account not found. Please ensure chart of accounts includes Cash/Bank.');
    }

    const cashTransactions = await transactionRepository.getByAccount(businessId, cashAccount._id, startDate, endDate);
    let cashInflow = 0, cashOutflow = 0;
    for (const tx of cashTransactions) {
      const isDebitCash = tx.debitAccountId._id.toString() === cashAccount._id.toString();
      if (isDebitCash) {
        cashInflow += tx.amount;
      } else {
        cashOutflow += tx.amount;
      }
    }
    const netOperatingCashFlow = cashInflow - cashOutflow;

    const investing = [];
    const financing = [];
    const netCashFlow = netOperatingCashFlow;

    // Map to {description, amount} shape expected by frontend
    const operatingItems = [{ description: 'Net Cash from Operations', amount: netOperatingCashFlow }];
    const investingItems = investing.map(i => ({ description: i.name || i.description, amount: i.amount }));
    const financingItems = financing.map(i => ({ description: i.name || i.description, amount: i.amount }));

    return {
      operating: { items: operatingItems, total: netOperatingCashFlow },
      investing: { items: investingItems, total: investingItems.reduce((s, i) => s + i.amount, 0) },
      financing: { items: financingItems, total: financingItems.reduce((s, i) => s + i.amount, 0) },
      netCashFlow,
      period: { startDate, endDate },
    };
  }

  /**
   * Get Aging Report for Receivables or Payables.
   * Groups outstanding balances by aging buckets (0-30, 31-60, 61-90, 90+ days).
   * @param {string} businessId 
   * @param {string} type - 'receivable' or 'payable'
   * @returns {Promise<Object>}
   */
  async getAgingReport(businessId, type) {
    let outstanding = [];
    if (type === 'receivable') {
      outstanding = await transactionRepository.getOutstandingReceivables(businessId);
    } else if (type === 'payable') {
      outstanding = await transactionRepository.getOutstandingPayables(businessId);
    } else {
      throw new ApiError(400, 'Invalid aging report type. Use "receivable" or "payable"');
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const report = {
      current: 0,
      days_1_30: 0,
      days_31_60: 0,
      days_61_90: 0,
      days_over_90: 0,
      total: 0,
      details: []
    };

    outstanding.forEach(tx => {
      if (!tx.remainingBalance || tx.remainingBalance <= 0) return;

      const dueDate = tx.dueDate ? new Date(tx.dueDate) : new Date(tx.transactionDate);
      dueDate.setHours(0, 0, 0, 0);

      const diffTime = today.getTime() - dueDate.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      
      const balance = tx.remainingBalance;
      report.total += balance;

      const detailItem = {
        transactionId: tx._id,
        date: tx.transactionDate,
        dueDate: tx.dueDate,
        description: tx.description,
        party: type === 'receivable' ? tx.customerId?.fullName : tx.vendorId?.vendorName,
        partyId: type === 'receivable' ? tx.customerId?._id : tx.vendorId?._id,
        amount: tx.amount,
        remainingBalance: balance,
        daysOverdue: diffDays > 0 ? diffDays : 0
      };

      if (diffDays <= 0) {
        report.current += balance;
        detailItem.bucket = 'current';
      } else if (diffDays <= 30) {
        report.days_1_30 += balance;
        detailItem.bucket = 'days_1_30';
      } else if (diffDays <= 60) {
        report.days_31_60 += balance;
        detailItem.bucket = 'days_31_60';
      } else if (diffDays <= 90) {
        report.days_61_90 += balance;
        detailItem.bucket = 'days_61_90';
      } else {
        report.days_over_90 += balance;
        detailItem.bucket = 'days_over_90';
      }

      report.details.push(detailItem);
    });

    return report;
  }

  /**
   * Helper: Get account balances as of a specific date by summing all posted transactions up to that date.
   * @private
   */
  async _getBalancesAsOf(businessId, asOfDate) {
    const allTransactions = await transactionRepository.getByDateRange(businessId, new Date(0), asOfDate);
    const balanceMap = new Map();

    for (const tx of allTransactions) {
      const debitId = tx.debitAccountId._id.toString();
      const creditId = tx.creditAccountId._id.toString();
      const debitAccount = tx.debitAccountId;
      const creditAccount = tx.creditAccountId;

      const debitDelta = debitAccount.normalBalance === 'Debit' ? tx.amount : -tx.amount;
      balanceMap.set(debitId, (balanceMap.get(debitId) || 0) + debitDelta);

      const creditDelta = creditAccount.normalBalance === 'Credit' ? tx.amount : -tx.amount;
      balanceMap.set(creditId, (balanceMap.get(creditId) || 0) + creditDelta);
    }

    return Object.fromEntries(balanceMap);
  }

  /**
   * Generate Trial Balance as of a specific date.
   */
  async getTrialBalance(businessId, asOfDate) {
    if (!businessId || !asOfDate) {
      throw new ApiError(400, 'Missing required parameters: businessId, asOfDate');
    }

    const accounts = await accountRepository.findByBusiness(businessId);
    const balanceMap = await this._getBalancesAsOf(businessId, asOfDate);

    let totalDebits = 0;
    let totalCredits = 0;

    const rows = accounts.map(acc => {
      const balance = balanceMap[acc._id.toString()] || 0;
      let debit = 0;
      let credit = 0;
      if (acc.normalBalance === 'Debit') {
        if (balance >= 0) debit = balance;
        else credit = Math.abs(balance);
      } else {
        if (balance >= 0) credit = balance;
        else debit = Math.abs(balance);
      }
      totalDebits += debit;
      totalCredits += credit;
      return {
        accountId: acc._id,
        accountName: acc.accountName,
        accountType: acc.accountType,
        normalBalance: acc.normalBalance,
        debit,
        credit,
      };
    });

    const isBalanced = Math.abs(totalDebits - totalCredits) < 0.01;

    return {
      rows,
      totalDebits,
      totalCredits,
      isBalanced,
      asOfDate,
    };
  }

  /**
   * Validate accounting equation as of a specific date.
   */
  async validateAccountingEquation(businessId, asOfDate) {
    const balanceSheet = await this.getBalanceSheet(businessId, asOfDate);
    return balanceSheet.equationValid;
  }

  /**
   * Get KPI summary for dashboard.
   */
  async getKPISummary(businessId, startDate, endDate) {
    const incomeStatement = await this.getIncomeStatement(businessId, startDate, endDate);
    const { totalRevenue, totalExpenses, netProfit } = incomeStatement;
    const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

    const balances = await this._getBalancesAsOf(businessId, endDate);
    const accounts = await accountRepository.findByBusiness(businessId);
    const cashAccount = accounts.find(acc => acc.accountName.toLowerCase() === 'cash' || acc.accountName.toLowerCase() === 'bank');
    const cashBalance = cashAccount ? (balances[cashAccount._id.toString()] || 0) : 0;

    const arAccount = accounts.find(acc => acc.accountName.toLowerCase() === 'accounts receivable');
    const apAccount = accounts.find(acc => acc.accountName.toLowerCase() === 'accounts payable');
    const accountsReceivable = arAccount ? (balances[arAccount._id.toString()] || 0) : 0;
    const accountsPayable = apAccount ? (balances[apAccount._id.toString()] || 0) : 0;

    return {
      revenue: totalRevenue,
      expenses: totalExpenses,
      netProfit,
      cashBalance,
      profitMargin: parseFloat(profitMargin.toFixed(2)),
      accountsReceivable,
      accountsPayable,
      period: { startDate, endDate },
    };
  }
}

module.exports = new ReportService();