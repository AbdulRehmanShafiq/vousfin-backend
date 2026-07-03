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
    const cached = await reportCache.get('income-statement', businessId.toString(), cacheParams);
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
    const cached = await reportCache.get('balance-sheet', businessId.toString(), cacheParams);
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
    // Exclude any real account literally named "Current Year Earnings" — the
    // synthetic derived line below already represents this value correctly.
    // Showing both creates a duplicate row and double-counts unclosed earnings.
    const equityAccounts = accounts
      .filter(a => a.accountType === 'Equity')
      .filter(a => !/^current.?year.?earnings$/i.test(a.accountName.trim()))
      .map(mapAcc);

    // ── Current-year (unclosed) earnings ─────────────────────────────────────
    // The accounting identity guarantees (as-of balances):
    //     Assets − Liabilities − Equity  ≡  Revenue − Expenses
    // Net income not yet moved into a Retained Earnings equity account by a
    // fiscal-year close still sits in the Revenue/Expense accounts and MUST be
    // shown inside equity — otherwise the Balance Sheet cannot balance. We derive
    // it from the SAME balanceMap used for every other line (so it includes COGS
    // that lives only in journalLines) and present it as one synthetic equity
    // line.
    //
    // IMPORTANT: we use the ECONOMIC direction per account, exactly like sectionTotal.
    // Contra-revenue accounts (debit-normal, e.g. Sales Returns & Allowances) must
    // have their balance NEGATED when summing into the Revenue total — a debit-normal
    // account in a credit-dominated section REDUCES, not adds, to that section.
    // Similarly contra-expense accounts (credit-normal) negate inside the Expense total.
    //
    // Additionally: if a "Current Year Earnings" REAL equity account exists (from a
    // partial close that credited CYE rather than Retained Earnings), its balance is
    // excluded from equityAccounts above but must be included here so the synthetic
    // line captures total net income (closed + unclosed) and the equation balances.
    const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

    // Economic sum: debit-normal accounts in a credit-natural section are negated.
    const economicSum = (map, type) => {
      const creditNatural = (type === 'Revenue' || type === 'Liability' || type === 'Equity');
      return accounts
        .filter(a => a.accountType === type)
        .reduce((s, a) => {
          const bal = map[a._id.toString()] || 0;
          // If account's normalBalance opposes the section's natural direction, negate.
          const isOpposite = creditNatural
            ? a.normalBalance === 'Debit'    // debit-normal inside credit section
            : a.normalBalance === 'Credit';  // credit-normal inside debit section
          return s + (isOpposite ? -bal : bal);
        }, 0);
    };

    // Any real equity account literally named "Current Year Earnings" is excluded from
    // equityAccounts (to avoid double-counting with the synthetic line). Capture its
    // economic balance and roll it into the synthetic total so the equation holds even
    // when partial closing entries credit this account instead of Retained Earnings.
    const realCYEBalance = r2(
      accounts
        .filter(a => a.accountType === 'Equity' && /^current.?year.?earnings$/i.test(a.accountName.trim()))
        .reduce((s, a) => {
          const bal = balanceMap[a._id.toString()] || 0;
          return s + (a.normalBalance === 'Debit' ? -bal : bal);
        }, 0)
    );

    const currentEarnings = r2(economicSum(balanceMap, 'Revenue') - economicSum(balanceMap, 'Expense') + realCYEBalance);
    const compareEarnings = compareMap
      ? r2(economicSum(compareMap, 'Revenue') - economicSum(compareMap, 'Expense') +
          accounts
            .filter(a => a.accountType === 'Equity' && /^current.?year.?earnings$/i.test(a.accountName.trim()))
            .reduce((s, a) => {
              const bal = compareMap[a._id.toString()] || 0;
              return s + (a.normalBalance === 'Debit' ? -bal : bal);
            }, 0)
        )
      : undefined;

    // Inject as a synthetic equity account so the equity detail foots to its total.
    if (currentEarnings !== 0 || (compareEarnings && compareEarnings !== 0)) {
      equityAccounts.push({
        accountId:      null,
        accountCode:    '',
        accountName:    'Current Year Earnings',
        accountType:    'Equity',
        accountSubtype: 'Equity',
        balance:        currentEarnings,
        compareBalance: compareMap ? (compareEarnings || 0) : undefined,
        isDerived:      true,
      });
    }

    const assetGroups     = groupBySubtype(assetAccounts);
    const liabilityGroups = groupBySubtype(liabilityAccounts);
    const equityGroups    = groupBySubtype(equityAccounts);

    // For all three section totals, use the account's normalBalance to determine
    // whether a positive `balance` value INCREASES or DECREASES the section total.
    // • Credit-normal accounts (most liabilities, equity, revenue):  balance adds normally.
    // • Debit-normal accounts inside Liability / Equity sections:     balance reduces the total
    //   (e.g. Drawings reduces equity; an overpaid liability is effectively an asset).
    const sectionTotal = (accs) => accs.reduce((s, a) => {
      const nb = accounts.find(x => x._id?.toString() === a.accountId?.toString())?.normalBalance || 'Credit';
      // For the equity / liability sections the "natural" direction is Credit.
      // A debit-normal account in those sections (e.g. Drawings) moves in the opposite direction.
      return s + (nb === 'Debit' ? -a.balance : a.balance);
    }, 0);

    const totalAssets      = assetAccounts.reduce((s, a) => {
      // Most assets are Debit-normal; contra-assets (AccumDep) are Credit-normal.
      // `_getBalancesAsOf` already returns the right sign for both:
      // debit-normal balance = DR − CR  (positive when in normal direction)
      // credit-normal balance = CR − DR  (positive when in normal direction, e.g. AccumDep has CR credit)
      // But for assets: debit-normal positive → adds to assets;
      //                credit-normal positive → REDUCES assets (contra-asset).
      const nb = accounts.find(x => x._id?.toString() === a.accountId?.toString())?.normalBalance || 'Debit';
      return s + (nb === 'Credit' ? -a.balance : a.balance);
    }, 0);
    const totalLiabilities = sectionTotal(liabilityAccounts);
    const totalEquity      = sectionTotal(equityAccounts);
    const equationValid    = Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01;

    const result = {
      assets:      { groups: assetGroups,     accounts: assetAccounts,     total: totalAssets },
      liabilities: { groups: liabilityGroups, accounts: liabilityAccounts, total: totalLiabilities },
      equity:      { groups: equityGroups,    accounts: equityAccounts,    total: totalEquity },
      // Backward-compatible field — now the (correct) unclosed earnings, which are
      // ALSO already included inside `equity` / `totalEquity` above.
      retainedEarnings: currentEarnings,
      currentEarnings,
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

  /** Public wrapper so other services (reportBuilder) can read balances. */
  async getBalancesAsOf(businessId, asOfDate) {
    return this._getBalancesAsOf(businessId, asOfDate);
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  STATEMENT OF CHANGES IN EQUITY  (FR-02.4)
  // ──────────────────────────────────────────────────────────────────────────
  async getStatementOfChangesInEquity(businessId, startDate, endDate) {
    if (!businessId || !startDate || !endDate)
      throw new ApiError(400, 'Missing required parameters: businessId, startDate, endDate');

    const cacheParams = {
      start: new Date(startDate).toISOString(),
      end:   new Date(endDate).toISOString(),
    };
    const cached = await reportCache.get('equity-statement', businessId.toString(), cacheParams);
    if (cached) return cached;

    const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
    const openingDate = new Date(new Date(startDate).getTime() - 86400000);

    const [accounts, openMap, closeMap, movements] = await Promise.all([
      accountRepository.findByBusiness(businessId),
      this._getBalancesAsOf(businessId, openingDate),
      this._getBalancesAsOf(businessId, endDate),
      transactionRepository.getDebitCreditTotalsBetween(businessId, startDate, endDate),
    ]);

    const isCYE = (a) => /^current.?year.?earnings$/i.test((a.accountName || '').trim());
    const equityAccts = accounts.filter(a => a.accountType === 'Equity' && !isCYE(a));

    // Classify each real equity account into a component column.
    const classify = (a) => {
      const n = (a.accountName || '').toLowerCase();
      const c = a.accountCode || '';
      if (/capital|investment/.test(n) || c === '3110') return { key: 'capital', label: 'Owner capital' };
      if (/share premium/.test(n) || c === '3130')      return { key: 'sharePremium', label: 'Share premium' };
      if (/revaluation/.test(n) || c === '3140')        return { key: 'revaluation', label: 'Revaluation reserve' };
      if (/retained/.test(n) || c === '3210')           return { key: 'retainedEarnings', label: 'Retained earnings' };
      if (/distribution|drawing|dividend/.test(n) || c === '3120') return { key: 'capital', label: 'Owner capital' };
      return { key: 'other', label: 'Other equity' };
    };

    // Build ordered component list (only columns that have any account), + synthetic CYE.
    const compOrder = ['capital', 'sharePremium', 'revaluation', 'retainedEarnings', 'other'];
    const compLabels = {
      capital: 'Owner capital', sharePremium: 'Share premium', revaluation: 'Revaluation reserve',
      retainedEarnings: 'Retained earnings', other: 'Other equity',
    };
    // Helper: sign a raw balance (from _getBalancesAsOf) in the equity-contribution
    // direction. Debit-normal accounts (Drawings) accumulate by DEBITING, so a positive
    // raw balance REDUCES equity — flip the sign so the equity statement adds correctly.
    const equitySign = (acc, raw) => (acc.normalBalance === 'Debit' ? -raw : raw);

    const acctToComp = new Map();
    const compAccts  = {};  // key → array of account _id strings (for lookup)
    const compAcctObjs = {}; // key → array of account objects (for equitySign)
    for (const a of equityAccts) {
      const { key } = classify(a);
      acctToComp.set(a._id.toString(), key);
      (compAccts[key]     = compAccts[key]     || []).push(a._id.toString());
      (compAcctObjs[key]  = compAcctObjs[key]  || []).push(a);
    }
    const components = compOrder
      .filter(k => compAccts[k])
      .map(k => ({ key: k, label: compLabels[k], accountIds: compAccts[k] }));
    components.push({ key: 'currentYearEarnings', label: 'Current year earnings', isDerived: true });

    // Economic sum over Revenue/Expense for the synthetic CYE column.
    // Mirrors getBalanceSheet's economicSum: negate any account whose normalBalance
    // opposes the section's natural direction (Revenue natural = Credit; Expense natural = Debit).
    const realCYE = accounts.filter(a => a.accountType === 'Equity' && isCYE(a));
    const econ = (map, type) => {
      const creditNatural = (type === 'Revenue');
      return accounts
        .filter(a => a.accountType === type)
        .reduce((s, a) => {
          const bal = map[a._id.toString()] || 0;
          const isOpposite = creditNatural
            ? a.normalBalance === 'Debit'    // contra-revenue
            : a.normalBalance === 'Credit';  // contra-expense
          return s + (isOpposite ? -bal : bal);
        }, 0);
    };
    const realCYEsum = (map) => realCYE.reduce((s, a) => {
      const bal = map[a._id.toString()] || 0;
      return s + (a.normalBalance === 'Debit' ? -bal : bal);
    }, 0);
    const cyeAt = (map) => r2(econ(map, 'Revenue') - econ(map, 'Expense') + realCYEsum(map));

    // Per-component opening / closing — apply equitySign so debit-normal accounts
    // (Drawings) REDUCE the column total rather than adding to it.
    const colSum = (map, key) => r2((compAcctObjs[key] || [])
      .reduce((s, acc) => s + equitySign(acc, map[acc._id.toString()] || 0), 0));
    const opening = {}, closing = {};
    for (const c of components) {
      if (c.key === 'currentYearEarnings') { opening[c.key] = cyeAt(openMap); closing[c.key] = cyeAt(closeMap); }
      else { opening[c.key] = colSum(openMap, c.key); closing[c.key] = colSum(closeMap, c.key); }
    }

    // Period net movement per equity account (economic, signed by normalBalance).
    const dMap = new Map(movements.debitTotals.map(x => [x._id.toString(), x.total]));
    const cMap = new Map(movements.creditTotals.map(x => [x._id.toString(), x.total]));
    const netMove = (a) => {
      const d = dMap.get(a._id.toString()) || 0, c = cMap.get(a._id.toString()) || 0;
      return a.normalBalance === 'Debit' ? (d - c) : (c - d);
    };

    // Explicit movement rows (per component).
    const zero = () => Object.fromEntries(components.map(c => [c.key, 0]));
    const profit = zero(), capital = zero(), distributions = zero(), other = zero();

    // Profit for the period → synthetic CYE column.
    profit.currentYearEarnings = r2(
      (econ(closeMap, 'Revenue') - econ(openMap, 'Revenue')) -
      (econ(closeMap, 'Expense') - econ(openMap, 'Expense'))
    );

    // Capital injections and distributions — apply equitySign so movements from
    // debit-normal accounts (Drawings) reduce equity (negative contribution).
    // equitySign(acc, netMove(acc)) = periodCredits − periodDebits for every account:
    //   credit-normal: (c − d) → same sign
    //   debit-normal:  -(d − c) = (c − d) → negative when debits > credits (a draw)
    for (const a of equityAccts) {
      const key = acctToComp.get(a._id.toString());
      const mv = equitySign(a, netMove(a));
      const nm = (a.accountName || '').toLowerCase();
      if (/distribution|drawing|dividend/.test(nm) || a.accountCode === '3120') {
        distributions[key] = r2(distributions[key] + mv);
      } else if (/capital|investment|share premium/.test(nm) || ['3110', '3130'].includes(a.accountCode)) {
        capital[key] = r2(capital[key] + mv);
      }
    }

    // Other changes = residual per column so each column foots opening → closing exactly.
    for (const c of components) {
      const explained = profit[c.key] + capital[c.key] + distributions[c.key];
      other[c.key] = r2((closing[c.key] - opening[c.key]) - explained);
    }

    const rowTotal = (vals) => r2(components.reduce((s, c) => s + (vals[c.key] || 0), 0));
    const mkRow = (key, label, vals) => ({ key, label, values: vals, total: rowTotal(vals) });

    const rows = [
      mkRow('opening', 'Balance at start', opening),
      mkRow('profit', 'Profit for the period', profit),
      mkRow('capital', 'Money put in by owners', capital),
      mkRow('distributions', 'Money taken out / dividends', distributions),
      mkRow('other', 'Other changes', other),
      mkRow('closing', 'Balance at end', closing),
    ];

    const closingTotal = rowTotal(closing);
    // Reconcile to the real Balance Sheet so both statements agree by construction.
    // getBalanceSheet applies the same equitySign logic (via sectionTotal) and uses
    // economicSum for CYE — with fix #1 applied, closingTotal equals bs.totalEquity.
    const bs = await this.getBalanceSheet(businessId, endDate);
    const bsEquity = bs.totalEquity;
    const difference = r2(closingTotal - bsEquity);

    const result = {
      components,
      rows,
      reconciliation: {
        closingTotal,
        balanceSheetEquity: bsEquity,
        difference,
        reconciles: Math.abs(difference) < 0.01,
      },
      period: { startDate, endDate },
    };
    reportCache.set('equity-statement', businessId.toString(), cacheParams, result);
    return result;
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  IFRS-15 REVENUE NOTES  (revenue disaggregation + policy text)
  // ──────────────────────────────────────────────────────────────────────────
  async getRevenueNotes(businessId, startDate, endDate) {
    if (!businessId || !startDate || !endDate)
      throw new ApiError(400, 'Missing required parameters: businessId, startDate, endDate');

    const cacheParams = { start: new Date(startDate).toISOString(), end: new Date(endDate).toISOString() };
    const cached = await reportCache.get('revenue-notes', businessId.toString(), cacheParams);
    if (cached) return cached;

    const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

    // Disaggregate the SAME revenue the Income Statement reports, so the notes
    // reconcile to the P&L by construction. The Income Statement reports the
    // NET movement per Revenue account (credits − debits, excluding closing /
    // opening sweeps by entryType — audit F1); consuming its output here keeps
    // the notes in lock-step with that convention automatically.
    const is = await this.getIncomeStatement(businessId, startDate, endDate);

    const disaggregation = (is.revenue?.accounts || [])
      .map(a => ({ stream: a.accountName, amount: r2(a.balance) }))
      .filter(d => d.amount !== 0);

    const totalRevenue = r2(is.totalRevenue);
    disaggregation.forEach(d => { d.pct = totalRevenue !== 0 ? r2((d.amount / totalRevenue) * 100) : 0; });
    disaggregation.sort((a, b) => b.amount - a.amount);

    const policyText =
      'Revenue is recognised when control of goods or services passes to the customer, ' +
      'measured at the amount the business expects to receive (IFRS 15). For each sale the ' +
      'business identifies the customer agreement and what it has promised to deliver, sets the ' +
      'price, and records revenue as each promise is fulfilled — at a point in time for goods, ' +
      'and over time for services delivered across a period. The table below breaks total revenue ' +
      'down by source so readers can see where income comes from.';

    const result = { policyText, disaggregation, totalRevenue, period: { startDate, endDate } };
    reportCache.set('revenue-notes', businessId.toString(), cacheParams, result);
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
    const cached = await reportCache.get('cash-flow', businessId.toString(), cacheParams);
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

    // F15 — line-level aggregation over the SAME effective-lines normalisation
    // as the other statements: compound entries' cash legs (payroll, taxed
    // sales) are counted, cash→cash transfers net to zero, and reversal pairs
    // cancel out.
    const cashLineRows = await transactionRepository.getCashLineTotals(
      businessId, cashAccounts.map((a) => a._id), startDate, endDate
    );

    const TYPE_LABELS = {
      SALE:              'Collections from Customers',
      PURCHASE:          'Payments to Suppliers',
      EXPENSE:           'Operating Expenses Paid',
      SALARY:            'Salaries & Wages Paid',
      INCOME_TAX:        'Income Tax Paid',
      VAT:               'VAT / GST Paid',
      ASSET_PURCHASE:    'Purchase of Fixed Assets',
      DEPRECIATION:      'Depreciation Adjustment',
      LOAN_DISBURSEMENT: 'Proceeds from Loans',
      LOAN_REPAYMENT:    'Repayment of Loans',
      OWNER_INVESTMENT:  'Owner Capital Contribution',
      OWNER_WITHDRAWAL:  'Owner Withdrawals',
    };

    const operatingBuckets = {};
    const investingBuckets = {};
    const financingBuckets = {};

    const r2cf = (v) => Math.round((Number(v) || 0) * 100) / 100;
    for (const row of cashLineRows) {
      const key        = row._id || 'Other';
      const cashEffect = r2cf(row.cashIn - row.cashOut); // effective lines are already base currency
      if (cashEffect === 0) continue; // e.g. a cash→cash transfer nets out
      const label = TYPE_LABELS[key] || (String(key).charAt(0) + String(key).slice(1).toLowerCase().replace(/_/g, ' '));

      let buckets;
      if (INVESTING_TYPES.has(key))       buckets = investingBuckets;
      else if (FINANCING_TYPES.has(key))  buckets = financingBuckets;
      else                                buckets = operatingBuckets;

      if (!buckets[key]) buckets[key] = { description: label, amount: 0, transactionType: key };
      buckets[key].amount += cashEffect;
    }

    const operatingItems = Object.values(operatingBuckets).filter(i => i.amount !== 0);
    const investingItems = Object.values(investingBuckets).filter(i => i.amount !== 0);
    const financingItems = Object.values(financingBuckets).filter(i => i.amount !== 0);

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
    const cached = await reportCache.get('trial-balance', businessId.toString(), cacheParams);
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
    const cached = await reportCache.get('general-ledger', businessId.toString(), cacheParams);
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
      // Expand each entry into its EFFECTIVE lines — the same normalisation the
      // Trial Balance / Balance Sheet use (journalLines when present, else the
      // synthesised top-level pair). Previously the GL read only the top-level
      // debit/credit accounts, so the COGS / tax legs that live in journalLines
      // were missing from per-account ledgers and the GL disagreed with the TB.
      const hasLines = Array.isArray(tx.journalLines) && tx.journalLines.length > 0;
      const lines = hasLines
        ? tx.journalLines.map(l => ({
            accId:  l.accountId ? l.accountId.toString() : null,
            side:   l.type,
            amount: l.amount,
          }))
        : [
            { accId: tx.debitAccountId  ? (tx.debitAccountId._id  || tx.debitAccountId).toString()  : null, side: 'debit',  amount: tx.amount },
            { accId: tx.creditAccountId ? (tx.creditAccountId._id || tx.creditAccountId).toString() : null, side: 'credit', amount: tx.amount },
          ];

      for (const { accId, side, amount } of lines) {
        if (!accId) continue;
        // If filtering by specific account, skip unrelated lines
        if (accountId && accId !== accountId.toString()) continue;

        if (!ledgerByAccount.has(accId)) {
          const accDoc = accountLookup.get(accId) || {};
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
          debitAmt = amount;
          effect   = nb === 'Debit' ? amount : -amount;
        } else {
          creditAmt = amount;
          effect    = nb === 'Credit' ? amount : -amount;
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
    const cached = await reportCache.get('kpi-summary', businessId.toString(), cacheParams);
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
}

module.exports = new ReportService();
