// services/report.service.js
const transactionRepository = require('../repositories/transaction.repository');
const accountRepository = require('../repositories/account.repository');
const { ApiError } = require('../utils/ApiError');
const { ACCOUNT_TYPES, ACCOUNT_SUBTYPES, TRANSACTION_TYPES } = require('../config/constants');
const logger = require('../config/logger');
const reportCache = require('../utils/reportCache');

// Non-cash expense keywords for EBITDA calculation
const DEPRECIATION_KEYWORDS = ['depreciation', 'amortization', 'amortisation'];
const INTEREST_KEYWORDS      = ['interest expense', 'interest payment', 'bank charges', 'finance cost'];
const COGS_KEYWORDS          = ['cost of goods sold', 'cogs', 'cost of sales', 'cost of revenue', 'direct cost'];
// Sales transaction types (for tax output classification)
const SALES_TYPES = new Set([
  'Cash Sale', 'Credit Sale', 'Inventory Sale', 'GST Collection', 'Income',
]);

class ReportService {

  // ──────────────────────────────────────────────────────────────────────────
  // 1. INCOME STATEMENT (Profit & Loss)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Professional P&L with Gross Profit, Operating Profit, EBITDA, Net Profit.
   * GAAP/IFRS structure:
   *   Revenue
   *   − COGS                 = Gross Profit
   *   − Operating Expenses   = Operating Profit (EBIT)
   *   + D&A (added back)     = EBITDA
   *   − Interest             = EBT
   *   − Tax                  = Net Profit
   */
  async getIncomeStatement(businessId, startDate, endDate) {
    if (!businessId || !startDate || !endDate)
      throw new ApiError(400, 'Missing required parameters: businessId, startDate, endDate');

    const cacheParams = {
      start: new Date(startDate).toISOString(),
      end:   new Date(endDate).toISOString(),
    };
    const cached = reportCache.get('income-statement', businessId.toString(), cacheParams);
    if (cached) return cached;

    const { revenue, expenses } = await transactionRepository.getIncomeStatementData(businessId, startDate, endDate);

    const revenueAccounts = revenue.map(i => ({ accountName: i.name, balance: i.amount }));
    const totalRevenue    = revenueAccounts.reduce((s, i) => s + i.balance, 0);

    // Split expenses: COGS / D&A / Interest / Operating
    const cogsAccounts  = [];
    const daAccounts    = [];
    const intAccounts   = [];
    const opexAccounts  = [];

    for (const e of expenses) {
      const name = e.name.toLowerCase();
      if (COGS_KEYWORDS.some(k => name.includes(k))) {
        cogsAccounts.push({ accountName: e.name, balance: e.amount });
      } else if (DEPRECIATION_KEYWORDS.some(k => name.includes(k))) {
        daAccounts.push({ accountName: e.name, balance: e.amount });
      } else if (INTEREST_KEYWORDS.some(k => name.includes(k))) {
        intAccounts.push({ accountName: e.name, balance: e.amount });
      } else {
        opexAccounts.push({ accountName: e.name, balance: e.amount });
      }
    }

    const sum = arr => arr.reduce((s, i) => s + i.balance, 0);
    const totalCogs     = sum(cogsAccounts);
    const totalDA       = sum(daAccounts);
    const totalInterest = sum(intAccounts);
    const totalOpex     = sum(opexAccounts);

    const grossProfit     = totalRevenue - totalCogs;
    const operatingProfit = grossProfit - totalOpex - totalDA; // EBIT
    const ebitda          = operatingProfit + totalDA;          // add back D&A
    const netIncome       = operatingProfit - totalInterest;    // after interest

    const result = {
      revenue:           { accounts: revenueAccounts, total: totalRevenue },
      cogs:              { accounts: cogsAccounts,    total: totalCogs },
      grossProfit,
      operatingExpenses: { accounts: opexAccounts,    total: totalOpex },
      depreciationAmortization: { accounts: daAccounts, total: totalDA },
      ebitda,
      operatingProfit,
      interestExpense:   { accounts: intAccounts,     total: totalInterest },
      netIncome,
      // backward-compat aliases kept for PDF/Excel exports
      totalRevenue,
      totalExpenses: totalCogs + totalOpex + totalDA + totalInterest,
      netProfit:     netIncome,
      period:        { startDate, endDate },
    };
    reportCache.set('income-statement', businessId.toString(), cacheParams, result);
    return result;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. BALANCE SHEET
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Balance Sheet grouped by accountSubtype (Current Assets / Non-current Assets /
   * Current Liabilities / Non-current Liabilities / Equity).
   * Supports comparative period via optional `compareDate`.
   */
  async getBalanceSheet(businessId, asOfDate, compareDate = null) {
    if (!businessId || !asOfDate)
      throw new ApiError(400, 'Missing required parameters: businessId, asOfDate');

    const cacheParams = {
      asOf:    new Date(asOfDate).toISOString(),
      compare: compareDate ? new Date(compareDate).toISOString() : null,
    };
    const cached = reportCache.get('balance-sheet', businessId.toString(), cacheParams);
    if (cached) return cached;

    const [accounts, balanceMap, compareMap] = await Promise.all([
      accountRepository.findByBusiness(businessId),
      this._getBalancesAsOf(businessId, asOfDate),
      compareDate ? this._getBalancesAsOf(businessId, compareDate) : Promise.resolve(null),
    ]);

    const mapAcc = (acc) => ({
      accountId:      acc._id,
      accountCode:    acc.accountCode || '',
      accountName:    acc.accountName,
      accountType:    acc.accountType,
      accountSubtype: acc.accountSubtype || '',
      balance:        balanceMap[acc._id.toString()] || 0,
      compareBalance: compareMap ? (compareMap[acc._id.toString()] || 0) : undefined,
    });

    // Group assets by subtype
    const assetAccounts = accounts.filter(a => a.accountType === 'Asset').map(mapAcc);
    const groupBySubtype = (list) => {
      const groups = {};
      for (const acc of list) {
        const key = acc.accountSubtype || 'Other';
        if (!groups[key]) groups[key] = { label: key, accounts: [], total: 0, compareTotal: compareMap ? 0 : undefined };
        groups[key].accounts.push(acc);
        groups[key].total += acc.balance;
        if (compareMap !== null) groups[key].compareTotal = (groups[key].compareTotal || 0) + (acc.compareBalance || 0);
      }
      return Object.values(groups);
    };

    const liabilityAccounts = accounts.filter(a => a.accountType === 'Liability').map(mapAcc);
    const equityAccounts    = accounts.filter(a => a.accountType === 'Equity').map(mapAcc);

    const assetGroups     = groupBySubtype(assetAccounts);
    const liabilityGroups = groupBySubtype(liabilityAccounts);
    const equityGroups    = groupBySubtype(equityAccounts);

    const totalAssets      = assetAccounts.reduce((s, a) => s + a.balance, 0);
    const totalLiabilities = liabilityAccounts.reduce((s, a) => s + a.balance, 0);
    const totalEquity      = equityAccounts.reduce((s, a) => s + a.balance, 0);
    const equationValid    = Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01;

    // Retained earnings = all net income accumulated to asOfDate
    const retainedEarnings = await this._getRetainedEarnings(businessId, asOfDate);

    const result = {
      assets:      { groups: assetGroups,     accounts: assetAccounts,     total: totalAssets },
      liabilities: { groups: liabilityGroups, accounts: liabilityAccounts, total: totalLiabilities },
      equity:      { groups: equityGroups,    accounts: equityAccounts,    total: totalEquity },
      retainedEarnings,
      totalAssets,
      totalLiabilities,
      totalEquity,
      totalLiabilitiesAndEquity: totalLiabilities + totalEquity,
      equationValid,
      asOfDate,
      compareDate: compareDate || null,
    };
    reportCache.set('balance-sheet', businessId.toString(), cacheParams, result);
    return result;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. CASH FLOW STATEMENT
  // ──────────────────────────────────────────────────────────────────────────

  async getCashFlowStatement(businessId, startDate, endDate) {
    if (!businessId || !startDate || !endDate)
      throw new ApiError(400, 'Missing required parameters');

    const cacheParams = {
      start: new Date(startDate).toISOString(),
      end:   new Date(endDate).toISOString(),
    };
    const cached = reportCache.get('cash-flow', businessId.toString(), cacheParams);
    if (cached) return cached;

    const accounts = await accountRepository.findByBusiness(businessId);
    const cashAccounts = accounts.filter(
      acc => acc.accountSubtype === ACCOUNT_SUBTYPES.BANK_AND_CASH ||
             /\b(cash|bank)\b/i.test(acc.accountName)
    );

    if (cashAccounts.length === 0)
      throw new ApiError(500, 'No Cash or Bank account found.');

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
      const cashEffect  = isDebitCash ? tx.amount : -tx.amount;
      const item = {
        description:     tx.description || tx.transactionType || 'Transaction',
        amount:          cashEffect,
        transactionType: tx.transactionType,
        date:            tx.transactionDate,
        reference:       tx.transactionReference || tx.invoiceNumber || '',
      };
      if (INVESTING_TYPES.has(tx.transactionType))  investingItems.push(item);
      else if (FINANCING_TYPES.has(tx.transactionType)) financingItems.push(item);
      else operatingItems.push(item);
    }

    const sumItems = arr => arr.reduce((s, i) => s + i.amount, 0);
    const netOperating = sumItems(operatingItems);
    const netInvesting = sumItems(investingItems);
    const netFinancing = sumItems(financingItems);

    const result = {
      operating:   { items: operatingItems,  total: netOperating },
      investing:   { items: investingItems,  total: netInvesting },
      financing:   { items: financingItems,  total: netFinancing },
      netCashFlow: netOperating + netInvesting + netFinancing,
      period:      { startDate, endDate },
    };
    reportCache.set('cash-flow', businessId.toString(), cacheParams, result);
    return result;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 4. TRIAL BALANCE — with opening balance, period movements, closing balance
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Full GAAP trial balance:
   *   Opening Balance | Period Debits | Period Credits | Closing Balance
   *
   * @param {string} businessId
   * @param {Date|string} asOfDate   — closing date
   * @param {Date|string} [fromDate] — opening date (optional; null = all time)
   */
  async getTrialBalance(businessId, asOfDate, fromDate = null) {
    if (!businessId || !asOfDate)
      throw new ApiError(400, 'Missing required parameters: businessId, asOfDate');

    const cacheParams = {
      asOf: new Date(asOfDate).toISOString(),
      from: fromDate ? new Date(fromDate).toISOString() : 'all-time',
    };
    const cached = reportCache.get('trial-balance', businessId.toString(), cacheParams);
    if (cached) return cached;

    // Get accounts and opening balance
    const openingDate = fromDate
      ? new Date(new Date(fromDate).getTime() - 86400000) // day before fromDate
      : null;

    const [accounts, closingBalMap, openingBalMap, periodMovements] = await Promise.all([
      accountRepository.findByBusiness(businessId),
      this._getBalancesAsOf(businessId, asOfDate),
      openingDate ? this._getBalancesAsOf(businessId, openingDate) : Promise.resolve({}),
      fromDate
        ? transactionRepository.getDebitCreditTotalsBetween(businessId, fromDate, asOfDate)
        : transactionRepository.getDebitCreditTotals(businessId, asOfDate),
    ]);

    // Build debit/credit movement maps from period movements
    const periodDebitMap  = new Map(periodMovements.debitTotals.map(r => [r._id.toString(), r.total]));
    const periodCreditMap = new Map(periodMovements.creditTotals.map(r => [r._id.toString(), r.total]));

    let totalOpeningDebit  = 0, totalOpeningCredit  = 0;
    let totalPeriodDebit   = 0, totalPeriodCredit   = 0;
    let totalClosingDebit  = 0, totalClosingCredit  = 0;

    const rows = accounts.map(acc => {
      const id = acc._id.toString();

      const openingBal = openingBalMap[id] || 0;
      const closingBal = closingBalMap[id] || 0;
      const periodDebit  = periodDebitMap.get(id)  || 0;
      const periodCredit = periodCreditMap.get(id) || 0;

      // Represent opening/closing as debit or credit column
      let openingDebit  = 0, openingCredit  = 0;
      let closingDebit  = 0, closingCredit  = 0;

      if (acc.normalBalance === 'Debit') {
        if (openingBal >= 0) openingDebit  = openingBal;  else openingCredit  = Math.abs(openingBal);
        if (closingBal >= 0) closingDebit  = closingBal;  else closingCredit  = Math.abs(closingBal);
      } else {
        if (openingBal >= 0) openingCredit = openingBal;  else openingDebit   = Math.abs(openingBal);
        if (closingBal >= 0) closingCredit = closingBal;  else closingDebit   = Math.abs(closingBal);
      }

      totalOpeningDebit  += openingDebit;
      totalOpeningCredit += openingCredit;
      totalPeriodDebit   += periodDebit;
      totalPeriodCredit  += periodCredit;
      totalClosingDebit  += closingDebit;
      totalClosingCredit += closingCredit;

      return {
        accountId:      acc._id,
        accountCode:    acc.accountCode || '',
        accountName:    acc.accountName,
        accountType:    acc.accountType,
        accountSubtype: acc.accountSubtype || '',
        normalBalance:  acc.normalBalance,
        openingDebit,
        openingCredit,
        periodDebit,
        periodCredit,
        closingDebit,
        closingCredit,
        // keep legacy debit/credit for existing frontend compatibility
        debit:  closingDebit,
        credit: closingCredit,
      };
    });

    const isBalanced = Math.abs(totalClosingDebit - totalClosingCredit) < 0.01;

    const result = {
      rows,
      totalDebits:  totalClosingDebit,
      totalCredits: totalClosingCredit,
      totals: {
        opening:  { debit: totalOpeningDebit,  credit: totalOpeningCredit },
        period:   { debit: totalPeriodDebit,   credit: totalPeriodCredit  },
        closing:  { debit: totalClosingDebit,  credit: totalClosingCredit },
      },
      isBalanced,
      asOfDate,
      fromDate: fromDate || null,
    };
    reportCache.set('trial-balance', businessId.toString(), cacheParams, result);
    return result;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 5. GENERAL LEDGER — per-account with running balance
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * General Ledger with running balance per account.
   * @param {string} businessId
   * @param {Date|string} startDate
   * @param {Date|string} endDate
   * @param {string} [accountId] — if provided, returns single-account ledger
   */
  async getGeneralLedger(businessId, startDate, endDate, accountId = null) {
    if (!businessId || !startDate || !endDate)
      throw new ApiError(400, 'Missing required parameters: businessId, startDate, endDate');

    const cacheParams = {
      start:  new Date(startDate).toISOString(),
      end:    new Date(endDate).toISOString(),
      accId:  accountId || 'all',
    };
    const cached = reportCache.get('general-ledger', businessId.toString(), cacheParams);
    if (cached) return cached;

    // Get opening balances (day before startDate)
    const openingDate = new Date(new Date(startDate).getTime() - 86400000);
    const [allAccounts, openingBalMap, txns] = await Promise.all([
      accountRepository.findByBusiness(businessId),
      this._getBalancesAsOf(businessId, openingDate),
      transactionRepository.getGeneralLedgerEntries(businessId, startDate, endDate, accountId),
    ]);

    // Build account lookup
    const accountLookup = new Map(allAccounts.map(a => [a._id.toString(), a]));

    // Group transactions by account, compute running balance per account
    const ledgerByAccount = new Map();

    for (const tx of txns) {
      const sides = [
        { acc: tx.debitAccountId,  side: 'debit'  },
        { acc: tx.creditAccountId, side: 'credit' },
      ];

      for (const { acc, side } of sides) {
        if (!acc) continue;
        const accId = acc._id ? acc._id.toString() : acc.toString();
        // If filtering by specific account, skip unrelated sides
        if (accountId && accId !== accountId.toString()) continue;

        if (!ledgerByAccount.has(accId)) {
          const accDoc = accountLookup.get(accId) || acc;
          ledgerByAccount.set(accId, {
            accountId:      accId,
            accountCode:    accDoc.accountCode || '',
            accountName:    accDoc.accountName || 'Unknown',
            accountType:    accDoc.accountType || '',
            normalBalance:  accDoc.normalBalance || 'Debit',
            openingBalance: openingBalMap[accId] || 0,
            entries:        [],
          });
        }

        const ledger       = ledgerByAccount.get(accId);
        const nb           = ledger.normalBalance;
        const lastBal      = ledger.entries.length > 0
          ? ledger.entries[ledger.entries.length - 1].runningBalance
          : ledger.openingBalance;

        // Effect on account balance
        let debitAmt = 0, creditAmt = 0, effect = 0;
        if (side === 'debit') {
          debitAmt = tx.amount;
          effect   = nb === 'Debit' ? tx.amount : -tx.amount;
        } else {
          creditAmt = tx.amount;
          effect    = nb === 'Credit' ? tx.amount : -tx.amount;
        }

        ledger.entries.push({
          date:            tx.transactionDate,
          description:     tx.description || tx.transactionType,
          reference:       tx.transactionReference || tx.invoiceNumber || '',
          transactionType: tx.transactionType,
          debit:           debitAmt,
          credit:          creditAmt,
          runningBalance:  Math.round((lastBal + effect) * 100) / 100,
        });
      }
    }

    // Convert map to array, compute closing balance
    const accounts = [];
    for (const [, ledger] of ledgerByAccount) {
      const closingBalance = ledger.entries.length > 0
        ? ledger.entries[ledger.entries.length - 1].runningBalance
        : ledger.openingBalance;
      const periodDebit  = ledger.entries.reduce((s, e) => s + e.debit,  0);
      const periodCredit = ledger.entries.reduce((s, e) => s + e.credit, 0);
      accounts.push({
        ...ledger,
        closingBalance,
        periodDebit,
        periodCredit,
      });
    }

    // Sort by accountCode then accountName
    accounts.sort((a, b) => (a.accountCode || a.accountName).localeCompare(b.accountCode || b.accountName));

    const result = {
      accounts,
      totalAccounts: accounts.length,
      period: { startDate, endDate },
      filteredAccountId: accountId || null,
    };
    reportCache.set('general-ledger', businessId.toString(), cacheParams, result);
    return result;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 6. AGING REPORTS — AR / AP with overdue indicators
  // ──────────────────────────────────────────────────────────────────────────

  async getAgingReport(businessId, type) {
    if (!['receivable', 'payable'].includes(type))
      throw new ApiError(400, 'Invalid aging report type. Use "receivable" or "payable"');

    let outstanding = type === 'receivable'
      ? await transactionRepository.getOutstandingReceivables(businessId)
      : await transactionRepository.getOutstandingPayables(businessId);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const buckets = {
      current:        { label: 'Current (Not Due)',  items: [], total: 0 },
      days_1_30:      { label: '1–30 Days',          items: [], total: 0 },
      days_31_60:     { label: '31–60 Days',         items: [], total: 0 },
      days_61_90:     { label: '61–90 Days',         items: [], total: 0 },
      days_over_90:   { label: 'Over 90 Days',       items: [], total: 0 },
    };

    let grandTotal = 0;

    for (const tx of outstanding) {
      if (!tx.remainingBalance || tx.remainingBalance <= 0) continue;

      const dueDate = tx.dueDate ? new Date(tx.dueDate) : new Date(tx.transactionDate);
      dueDate.setHours(0, 0, 0, 0);
      const diffDays = Math.ceil((today.getTime() - dueDate.getTime()) / 86400000);

      const balance = tx.remainingBalance;
      grandTotal += balance;

      const item = {
        transactionId:    tx._id,
        invoiceNumber:    tx.invoiceNumber || tx.transactionReference || '',
        date:             tx.transactionDate,
        dueDate:          tx.dueDate,
        description:      tx.description,
        party:            type === 'receivable'
          ? (tx.customerId?.fullName || tx.customerId?.businessName || 'Unknown Customer')
          : (tx.vendorId?.vendorName || 'Unknown Vendor'),
        partyId:          type === 'receivable' ? tx.customerId?._id : tx.vendorId?._id,
        originalAmount:   tx.amount,
        remainingBalance: balance,
        daysOverdue:      diffDays > 0 ? diffDays : 0,
        isOverdue:        diffDays > 0,
        severity:         diffDays <= 0 ? 'current' : diffDays <= 30 ? 'warning' : diffDays <= 60 ? 'medium' : 'critical',
      };

      let bucket;
      if (diffDays <= 0)       bucket = 'current';
      else if (diffDays <= 30) bucket = 'days_1_30';
      else if (diffDays <= 60) bucket = 'days_31_60';
      else if (diffDays <= 90) bucket = 'days_61_90';
      else                     bucket = 'days_over_90';

      item.bucket = bucket;
      buckets[bucket].items.push(item);
      buckets[bucket].total += balance;
    }

    return {
      type,
      buckets,
      grandTotal: Math.round(grandTotal * 100) / 100,
      totalItems: outstanding.filter(tx => tx.remainingBalance > 0).length,
      overdueTotal: Math.round(
        (buckets.days_1_30.total + buckets.days_31_60.total + buckets.days_61_90.total + buckets.days_over_90.total) * 100
      ) / 100,
      generatedAt: new Date(),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 7. TAX REPORTS — GST/VAT, WHT, Sales Tax
  // ──────────────────────────────────────────────────────────────────────────

  async getTaxSummary(businessId, startDate, endDate) {
    if (!businessId) throw new ApiError(400, 'Business ID is required');
    const JournalEntry = require('../models/JournalEntry.model');
    const mongoose     = require('mongoose');
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
          totalTaxAmount:  { $sum: '$taxAmount' },
          count:           { $sum: 1 },
          totalBaseAmount: { $sum: '$amount' },
        },
      },
      { $sort: { '_id.taxType': 1, '_id.transactionType': 1 } },
    ]);

    const outputTax = rows.filter(r => SALES_TYPES.has(r._id.transactionType));
    const inputTax  = rows.filter(r => !SALES_TYPES.has(r._id.transactionType));

    const totalOutput = outputTax.reduce((s, r) => s + r.totalTaxAmount, 0);
    const totalInput  = inputTax.reduce((s, r) => s + r.totalTaxAmount, 0);

    // GST/VAT breakdown
    const gstRows = rows.filter(r => ['GST', 'VAT', 'Sales Tax'].includes(r._id.taxType));
    const whtRows = rows.filter(r => ['WHT', 'Withholding Tax'].includes(r._id.taxType));

    return {
      outputTax,
      inputTax,
      gstSummary: {
        rows: gstRows,
        totalOutput: gstRows.filter(r => SALES_TYPES.has(r._id.transactionType)).reduce((s, r) => s + r.totalTaxAmount, 0),
        totalInput:  gstRows.filter(r => !SALES_TYPES.has(r._id.transactionType)).reduce((s, r) => s + r.totalTaxAmount, 0),
      },
      whtSummary: {
        rows: whtRows,
        total: whtRows.reduce((s, r) => s + r.totalTaxAmount, 0),
      },
      totalOutputTax:   Math.round(totalOutput * 100) / 100,
      totalInputTax:    Math.round(totalInput  * 100) / 100,
      netTaxLiability:  Math.round((totalOutput - totalInput) * 100) / 100,
      period: { startDate, endDate },
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 8. LIABILITY REPORTS — Loan schedules, EMI, accrued liabilities
  // ──────────────────────────────────────────────────────────────────────────

  async getLiabilityReport(businessId, asOfDate) {
    if (!businessId) throw new ApiError(400, 'Business ID is required');
    const date = asOfDate || new Date();

    const [accounts, balanceMap] = await Promise.all([
      accountRepository.findByBusiness(businessId, 'Liability'),
      this._getBalancesAsOf(businessId, date),
    ]);

    const currentLiabilities    = [];
    const nonCurrentLiabilities = [];
    const accruedLiabilities    = [];

    for (const acc of accounts) {
      const balance = balanceMap[acc._id.toString()] || 0;
      const entry   = {
        accountId:      acc._id,
        accountCode:    acc.accountCode || '',
        accountName:    acc.accountName,
        accountSubtype: acc.accountSubtype || '',
        balance,
      };

      const subtype = acc.accountSubtype || '';
      if (subtype === 'Current Liabilities') {
        if (/payable|accrued|wages|tax/i.test(acc.accountName)) {
          accruedLiabilities.push(entry);
        } else {
          currentLiabilities.push(entry);
        }
      } else {
        nonCurrentLiabilities.push(entry);
      }
    }

    const sum = arr => arr.reduce((s, a) => s + a.balance, 0);

    return {
      currentLiabilities:    { accounts: currentLiabilities,    total: sum(currentLiabilities) },
      nonCurrentLiabilities: { accounts: nonCurrentLiabilities, total: sum(nonCurrentLiabilities) },
      accruedLiabilities:    { accounts: accruedLiabilities,    total: sum(accruedLiabilities) },
      totalLiabilities: sum([...currentLiabilities, ...nonCurrentLiabilities, ...accruedLiabilities]),
      asOfDate: date,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 9. COMPARATIVE REPORTS — Month vs Month / Year vs Year / Custom range
  // ──────────────────────────────────────────────────────────────────────────

  async getComparativeIncomeStatement(businessId, currentStart, currentEnd, priorStart, priorEnd) {
    if (!businessId || !currentStart || !currentEnd || !priorStart || !priorEnd)
      throw new ApiError(400, 'All date parameters are required');

    const [current, prior] = await Promise.all([
      this.getIncomeStatement(businessId, currentStart, currentEnd),
      this.getIncomeStatement(businessId, priorStart, priorEnd),
    ]);

    const compareMetric = (curr, prev) => {
      const change    = curr - prev;
      const changePct = prev !== 0 ? Math.round((change / Math.abs(prev)) * 10000) / 100 : null;
      return { current: curr, prior: prev, change, changePct };
    };

    return {
      revenue:           compareMetric(current.totalRevenue, prior.totalRevenue),
      grossProfit:       compareMetric(current.grossProfit,  prior.grossProfit),
      operatingProfit:   compareMetric(current.operatingProfit, prior.operatingProfit),
      ebitda:            compareMetric(current.ebitda, prior.ebitda),
      netIncome:         compareMetric(current.netIncome, prior.netIncome),
      totalExpenses:     compareMetric(current.totalExpenses, prior.totalExpenses),
      currentPeriod:     { start: currentStart, end: currentEnd, data: current },
      priorPeriod:       { start: priorStart,   end: priorEnd,   data: prior },
    };
  }

  async getComparativeBalanceSheet(businessId, currentDate, priorDate) {
    if (!businessId || !currentDate || !priorDate)
      throw new ApiError(400, 'All date parameters are required');

    const [current, prior] = await Promise.all([
      this.getBalanceSheet(businessId, currentDate),
      this.getBalanceSheet(businessId, priorDate),
    ]);

    const compareMetric = (curr, prev) => {
      const change    = curr - prev;
      const changePct = prev !== 0 ? Math.round((change / Math.abs(prev)) * 10000) / 100 : null;
      return { current: curr, prior: prev, change, changePct };
    };

    return {
      totalAssets:      compareMetric(current.totalAssets,      prior.totalAssets),
      totalLiabilities: compareMetric(current.totalLiabilities, prior.totalLiabilities),
      totalEquity:      compareMetric(current.totalEquity,       prior.totalEquity),
      currentPeriod:    { asOf: currentDate, data: current },
      priorPeriod:      { asOf: priorDate,   data: prior },
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 10. KPI SUMMARY
  // ──────────────────────────────────────────────────────────────────────────

  async getKPISummary(businessId, startDate, endDate) {
    const cacheParams = {
      start: new Date(startDate).toISOString(),
      end:   new Date(endDate).toISOString(),
    };
    const cached = reportCache.get('kpi-summary', businessId.toString(), cacheParams);
    if (cached) return cached;

    const [incomeStatement, balances, accounts] = await Promise.all([
      this.getIncomeStatement(businessId, startDate, endDate),
      this._getBalancesAsOf(businessId, endDate),
      accountRepository.findByBusiness(businessId),
    ]);

    const { totalRevenue, totalExpenses, netProfit } = incomeStatement;
    const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

    const cashAcc = accounts.find(a =>
      a.accountSubtype === 'Bank and Cash' ||
      /^(cash|bank)/i.test(a.accountName)
    );
    const arAcc = accounts.find(a => /accounts?\s*receivable/i.test(a.accountName));
    const apAcc = accounts.find(a => /accounts?\s*payable/i.test(a.accountName));

    const cashBalance        = cashAcc ? (balances[cashAcc._id.toString()] || 0) : 0;
    const accountsReceivable = arAcc   ? (balances[arAcc._id.toString()]   || 0) : 0;
    const accountsPayable    = apAcc   ? (balances[apAcc._id.toString()]   || 0) : 0;

    const result = {
      revenue:          totalRevenue,
      expenses:         totalExpenses,
      netProfit,
      grossProfit:      incomeStatement.grossProfit,
      operatingProfit:  incomeStatement.operatingProfit,
      ebitda:           incomeStatement.ebitda,
      cashBalance,
      profitMargin:     parseFloat(profitMargin.toFixed(2)),
      accountsReceivable,
      accountsPayable,
      period:           { startDate, endDate },
    };
    reportCache.set('kpi-summary', businessId.toString(), cacheParams, result);
    return result;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────────

  async validateAccountingEquation(businessId, asOfDate) {
    const bs = await this.getBalanceSheet(businessId, asOfDate);
    return bs.equationValid;
  }

  /**
   * Compute running balance for each account as of a date.
   * Uses $facet aggregation — see inline optimisation notes.
   * @private
   */
  async _getBalancesAsOf(businessId, asOfDate) {
    const [{ debitTotals, creditTotals }, accounts] = await Promise.all([
      transactionRepository.getDebitCreditTotals(businessId, asOfDate),
      accountRepository.findByBusiness(businessId),
    ]);

    const normalBalanceMap = new Map(
      accounts.map(acc => [acc._id.toString(), acc.normalBalance])
    );
    const balanceMap = new Map();

    for (const { _id, total } of debitTotals) {
      const id    = _id.toString();
      const nb    = normalBalanceMap.get(id) || 'Debit';
      const delta = nb === 'Debit' ? total : -total;
      balanceMap.set(id, (balanceMap.get(id) || 0) + delta);
    }
    for (const { _id, total } of creditTotals) {
      const id    = _id.toString();
      const nb    = normalBalanceMap.get(id) || 'Credit';
      const delta = nb === 'Credit' ? total : -total;
      balanceMap.set(id, (balanceMap.get(id) || 0) + delta);
    }

    return Object.fromEntries(balanceMap);
  }

  /**
   * Compute retained earnings = cumulative net income (all revenue − all expenses) to asOfDate.
   * @private
   */
  async _getRetainedEarnings(businessId, asOfDate) {
    try {
      // Use getIncomeStatement from the start of time to asOfDate
      const epochStart = new Date('2000-01-01');
      const { netIncome } = await this.getIncomeStatement(businessId, epochStart, asOfDate);
      return Math.round(netIncome * 100) / 100;
    } catch {
      return 0;
    }
  }
}

module.exports = new ReportService();
