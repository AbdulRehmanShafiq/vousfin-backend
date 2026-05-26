// services/report.service.js
const transactionRepository = require('../repositories/transaction.repository');
const accountRepository = require('../repositories/account.repository');
const { ApiError } = require('../utils/ApiError');
const { ACCOUNT_TYPES, TRANSACTION_TYPES } = require('../config/constants');
const logger = require('../config/logger');
const reportCache = require('../utils/reportCache');

class ReportService {
  /**
   * Generate Income Statement for a date range.
   */
  async getIncomeStatement(businessId, startDate, endDate) {
    if (!businessId || !startDate || !endDate) {
      throw new ApiError(400, 'Missing required parameters: businessId, startDate, endDate');
    }

    // ── Cache layer ────────────────────────────────────────────────────────────
    const _isParams = {
      start: new Date(startDate).toISOString(),
      end:   new Date(endDate).toISOString(),
    };
    const _isCached = reportCache.get('income-statement', businessId.toString(), _isParams);
    if (_isCached) return _isCached;

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

    const _isResult = {
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
    reportCache.set('income-statement', businessId.toString(), _isParams, _isResult);
    return _isResult;
  }

  /**
   * Generate Balance Sheet as of a specific date.
   */
  async getBalanceSheet(businessId, asOfDate) {
    if (!businessId || !asOfDate) {
      throw new ApiError(400, 'Missing required parameters: businessId, asOfDate');
    }

    // ── Cache layer ────────────────────────────────────────────────────────────
    const _bsParams = { asOf: new Date(asOfDate).toISOString() };
    const _bsCached = reportCache.get('balance-sheet', businessId.toString(), _bsParams);
    if (_bsCached) return _bsCached;

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

    const _bsResult = {
      assets: { accounts: assetAccounts, total: totalAssets },
      liabilities: { accounts: liabilityAccounts, total: totalLiabilities },
      equity: { accounts: equityAccounts, total: totalEquity },
      totalAssets,
      totalLiabilities,
      totalEquity,
      equationValid,
      asOfDate,
    };
    reportCache.set('balance-sheet', businessId.toString(), _bsParams, _bsResult);
    return _bsResult;
  }

  /**
   * Generate Cash Flow Statement (direct method) for a date range.
   * Classifies all cash movements into Operating / Investing / Financing sections.
   */
  async getCashFlowStatement(businessId, startDate, endDate) {
    if (!businessId || !startDate || !endDate) {
      throw new ApiError(400, 'Missing required parameters');
    }

    // ── Cache layer ────────────────────────────────────────────────────────────
    const _cfParams = {
      start: new Date(startDate).toISOString(),
      end:   new Date(endDate).toISOString(),
    };
    const _cfCached = reportCache.get('cash-flow', businessId.toString(), _cfParams);
    if (_cfCached) return _cfCached;

    // Find all Cash/Bank accounts by accountSubtype first, then fall back to name match
    const accounts = await accountRepository.findByBusiness(businessId);
    const cashAccounts = accounts.filter(
      acc =>
        acc.accountSubtype === 'Bank and Cash' ||
        /\b(cash|bank)\b/i.test(acc.accountName)
    );

    if (cashAccounts.length === 0) {
      throw new ApiError(500, 'No Cash or Bank account found. Ensure Chart of Accounts includes a Cash/Bank account.');
    }

    // Transaction types that classify as Investing or Financing activities
    const INVESTING_TYPES = new Set([
      TRANSACTION_TYPES.ASSET_PURCHASE,
      TRANSACTION_TYPES.DEPRECIATION,
    ]);
    const FINANCING_TYPES = new Set([
      TRANSACTION_TYPES.LOAN_DISBURSEMENT,
      TRANSACTION_TYPES.LOAN_REPAYMENT,
      TRANSACTION_TYPES.OWNER_INVESTMENT,
      TRANSACTION_TYPES.OWNER_WITHDRAWAL,
    ]);

    // Collect transactions from all cash accounts, deduplicated by _id
    const seenIds = new Set();
    const allCashTxns = [];
    await Promise.all(cashAccounts.map(async cashAcc => {
      const txns = await transactionRepository.getByAccount(businessId, cashAcc._id, startDate, endDate);
      for (const tx of txns) {
        const id = tx._id.toString();
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        allCashTxns.push({ tx, cashAccId: cashAcc._id.toString() });
      }
    }));

    const operatingItems = [];
    const investingItems = [];
    const financingItems = [];

    for (const { tx, cashAccId } of allCashTxns) {
      const isDebitCash = tx.debitAccountId.toString() === cashAccId;
      // Positive = inflow (cash received), negative = outflow (cash paid)
      const cashEffect = isDebitCash ? tx.amount : -tx.amount;
      const item = {
        description: tx.description || tx.transactionType || 'Transaction',
        amount: cashEffect,
        transactionType: tx.transactionType,
        date: tx.transactionDate,
      };

      if (INVESTING_TYPES.has(tx.transactionType)) {
        investingItems.push(item);
      } else if (FINANCING_TYPES.has(tx.transactionType)) {
        financingItems.push(item);
      } else {
        operatingItems.push(item);
      }
    }

    const sumItems = arr => arr.reduce((s, i) => s + i.amount, 0);
    const netOperating  = sumItems(operatingItems);
    const netInvesting  = sumItems(investingItems);
    const netFinancing  = sumItems(financingItems);

    const _cfResult = {
      operating:   { items: operatingItems,  total: netOperating  },
      investing:   { items: investingItems,  total: netInvesting  },
      financing:   { items: financingItems,  total: netFinancing  },
      netCashFlow: netOperating + netInvesting + netFinancing,
      period:      { startDate, endDate },
    };
    reportCache.set('cash-flow', businessId.toString(), _cfParams, _cfResult);
    return _cfResult;
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
   * Helper: Compute account balances as of a specific date.
   *
   * ── OPTIMISATION ─────────────────────────────────────────────────────────────
   * BEFORE: getByDateRange(epoch, asOfDate)
   *   → loads EVERY transaction document with full populate into Node.js memory
   *   → O(n) JS loop over potentially thousands of populated objects
   *   → 2 serial DB round-trips (range query + populate)
   *
   * AFTER: getDebitCreditTotals() + accountRepository.findByBusiness() in PARALLEL
   *   → single $facet aggregation: MongoDB groups all debits/credits per account ID
   *   → returns only the group sums (one tiny object, not thousands of documents)
   *   → O(accounts) JS arithmetic, all heavy math done in MongoDB
   *   → 2 PARALLEL DB round-trips → total latency ≈ max(aggregation, accounts find)
   *
   * @private
   */
  async _getBalancesAsOf(businessId, asOfDate) {
    const [{ debitTotals, creditTotals }, accounts] = await Promise.all([
      transactionRepository.getDebitCreditTotals(businessId, asOfDate),
      accountRepository.findByBusiness(businessId),
    ]);

    // Build a normalBalance lookup: accountId (string) → 'Debit' | 'Credit'
    const normalBalanceMap = new Map(
      accounts.map(acc => [acc._id.toString(), acc.normalBalance])
    );

    const balanceMap = new Map();

    // Apply debit-side totals
    // Debiting a Debit-normal account increases its balance (+)
    // Debiting a Credit-normal account decreases its balance (-)
    for (const { _id, total } of debitTotals) {
      const id    = _id.toString();
      const nb    = normalBalanceMap.get(id) || 'Debit';
      const delta = nb === 'Debit' ? total : -total;
      balanceMap.set(id, (balanceMap.get(id) || 0) + delta);
    }

    // Apply credit-side totals
    // Crediting a Credit-normal account increases its balance (+)
    // Crediting a Debit-normal account decreases its balance (-)
    for (const { _id, total } of creditTotals) {
      const id    = _id.toString();
      const nb    = normalBalanceMap.get(id) || 'Credit';
      const delta = nb === 'Credit' ? total : -total;
      balanceMap.set(id, (balanceMap.get(id) || 0) + delta);
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

    // ── Cache layer ────────────────────────────────────────────────────────────
    const _tbParams = { asOf: new Date(asOfDate).toISOString() };
    const _tbCached = reportCache.get('trial-balance', businessId.toString(), _tbParams);
    if (_tbCached) return _tbCached;

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

    const _tbResult = {
      rows,
      totalDebits,
      totalCredits,
      isBalanced,
      asOfDate,
    };
    reportCache.set('trial-balance', businessId.toString(), _tbParams, _tbResult);
    return _tbResult;
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
    // ── Cache layer ────────────────────────────────────────────────────────────
    const _kpiParams = {
      start: new Date(startDate).toISOString(),
      end:   new Date(endDate).toISOString(),
    };
    const _kpiCached = reportCache.get('kpi-summary', businessId.toString(), _kpiParams);
    if (_kpiCached) return _kpiCached;

    // ── Parallel fetch ─────────────────────────────────────────────────────────
    // incomeStatement is already cached after its first computation this window.
    // _getBalancesAsOf fires its own parallel internals (aggregation + account find).
    // The outer accountRepository.findByBusiness is a fast indexed scan and is needed
    // here to look up cash/AR/AP accounts by name.
    const [incomeStatement, balances, accounts] = await Promise.all([
      this.getIncomeStatement(businessId, startDate, endDate),
      this._getBalancesAsOf(businessId, endDate),
      accountRepository.findByBusiness(businessId),
    ]);

    const { totalRevenue, totalExpenses, netProfit } = incomeStatement;
    const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

    const cashAccount = accounts.find(
      acc => acc.accountName.toLowerCase() === 'cash' || acc.accountName.toLowerCase() === 'bank'
    );
    const arAccount = accounts.find(acc => acc.accountName.toLowerCase() === 'accounts receivable');
    const apAccount = accounts.find(acc => acc.accountName.toLowerCase() === 'accounts payable');

    const cashBalance        = cashAccount ? (balances[cashAccount._id.toString()] || 0) : 0;
    const accountsReceivable = arAccount   ? (balances[arAccount._id.toString()]   || 0) : 0;
    const accountsPayable    = apAccount   ? (balances[apAccount._id.toString()]   || 0) : 0;

    const _kpiResult = {
      revenue: totalRevenue,
      expenses: totalExpenses,
      netProfit,
      cashBalance,
      profitMargin: parseFloat(profitMargin.toFixed(2)),
      accountsReceivable,
      accountsPayable,
      period: { startDate, endDate },
    };
    reportCache.set('kpi-summary', businessId.toString(), _kpiParams, _kpiResult);
    return _kpiResult;
  }

  /**
   * Tax Summary Report — Phase 3.5 Step 4
   * Aggregates GST collected (output), GST paid (input), WHT deducted, etc.
   * Groups by taxType; supports optional date range.
   */
  async getTaxSummary(businessId, startDate, endDate) {
    if (!businessId) throw new ApiError(400, 'Business ID is required');
    const JournalEntry = require('../models/JournalEntry.model');
    const mongoose = require('mongoose');
    const businessObjId = new mongoose.Types.ObjectId(String(businessId));

    const matchStage = {
      businessId: businessObjId,
      isArchived: { $ne: true },
      taxAmount:  { $gt: 0 },
    };
    if (startDate) matchStage.transactionDate = { $gte: new Date(startDate) };
    if (endDate)   matchStage.transactionDate = { ...(matchStage.transactionDate || {}), $lte: new Date(endDate) };

    const rows = await JournalEntry.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: { taxType: '$taxType', transactionType: '$transactionType' },
          totalTaxAmount: { $sum: '$taxAmount' },
          count: { $sum: 1 },
          totalBaseAmount: { $sum: '$amount' },
        },
      },
      { $sort: { '_id.taxType': 1, '_id.transactionType': 1 } },
    ]);

    // Separate output tax (sales) from input tax (purchases)
    const SALES_TYPES = ['Cash Sale', 'Credit Sale', 'Inventory Sale', 'GST Collection', 'Income'];
    const outputTax = rows.filter(r => SALES_TYPES.includes(r._id.transactionType));
    const inputTax  = rows.filter(r => !SALES_TYPES.includes(r._id.transactionType));

    const totalOutput = outputTax.reduce((s, r) => s + r.totalTaxAmount, 0);
    const totalInput  = inputTax.reduce((s, r) => s + r.totalTaxAmount, 0);
    const netTaxLiability = Math.round((totalOutput - totalInput) * 100) / 100;

    return {
      outputTax,
      inputTax,
      totalOutputTax: Math.round(totalOutput * 100) / 100,
      totalInputTax:  Math.round(totalInput  * 100) / 100,
      netTaxLiability,
      period: { startDate, endDate },
    };
  }
}

module.exports = new ReportService();