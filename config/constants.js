// config/constants.js
// Centralized application constants – change only here

module.exports = {
  // ===============================
  // User & Role Constants
  // ===============================
  USER_ROLES: {
    CUSTOMER: 'customer',
    ADMIN: 'admin',
  },

  USER_STATUS: {
    PENDING: 'pending',
    ACTIVE: 'active',
    SUSPENDED: 'suspended',
    DELETED: 'deleted',
  },

  AUTH_PROVIDERS: {
    LOCAL: 'local',
    GOOGLE: 'google',
  },

  // ===============================
  // Business Constants
  // ===============================
  BUSINESS_TYPES: [
    'Sole Proprietorship',
    'Partnership',
    'Private Limited',
    'Freelancer',
  ],

  DEFAULT_CURRENCY: 'PKR',
  FISCAL_YEAR_START_MONTH_DEFAULT: 1, // January

  // ===============================
  // Chart of Accounts Constants
  // ===============================
  ACCOUNT_TYPES: {
    ASSET: 'Asset',
    LIABILITY: 'Liability',
    EQUITY: 'Equity',
    REVENUE: 'Revenue',
    EXPENSE: 'Expense',
  },

  NORMAL_BALANCE: {
    DEBIT: 'Debit',
    CREDIT: 'Credit',
  },

  /**
   * Account sub-categories used for grouping accounts in dropdowns,
   * Balance Sheet sections, and P&L sections. These are organizational
   * labels — they do not affect debit/credit logic.
   *
   * Mapping to top-level accountType:
   *   Asset      → 'Bank and Cash' | 'Current Assets' | 'Non-current Assets'
   *   Liability  → 'Current Liabilities' | 'Non-current Liabilities'
   *   Equity     → 'Equity'
   *   Revenue    → 'Revenue'
   *   Expense    → 'Direct Cost' | 'Expenses'
   */
  ACCOUNT_SUBTYPES: {
    BANK_AND_CASH: 'Bank and Cash',
    CURRENT_ASSETS: 'Current Assets',
    NON_CURRENT_ASSETS: 'Non-current Assets',
    CURRENT_LIABILITIES: 'Current Liabilities',
    NON_CURRENT_LIABILITIES: 'Non-current Liabilities',
    EQUITY: 'Equity',
    REVENUE: 'Revenue',
    DIRECT_COST: 'Direct Cost',
    EXPENSES: 'Expenses',
  },

  /**
   * Default Chart of Accounts seeded for every new business.
   * Structure mirrors the Gimbla / Australian SME template:
   *   1xxx Assets, 2xxx Liabilities, 3xxx Equity, 4xxx Revenue,
   *   5xxx Direct Cost (COGS), 6xxx Expenses.
   *
   * Each entry: { accountCode, accountName, accountType, accountSubtype,
   *               normalBalance, isDefault }
   */
  DEFAULT_ACCOUNTS: [
    // 1000s — Assets / Bank and Cash
    { accountCode: '1010', accountName: 'Cash at Bank',                accountType: 'Asset',     accountSubtype: 'Bank and Cash',          normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1020', accountName: 'Cash on Hand',                accountType: 'Asset',     accountSubtype: 'Bank and Cash',          normalBalance: 'Debit',  isDefault: true },

    // 1100s — Current Assets
    { accountCode: '1110', accountName: 'Accounts Receivable',         accountType: 'Asset',     accountSubtype: 'Current Assets',         normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1120', accountName: 'Prepaid Expenses',            accountType: 'Asset',     accountSubtype: 'Current Assets',         normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1150', accountName: 'Inventory',                   accountType: 'Asset',     accountSubtype: 'Current Assets',         normalBalance: 'Debit',  isDefault: true },

    // 1200s — Non-current Assets
    { accountCode: '1210', accountName: 'Furniture and Fittings',      accountType: 'Asset',     accountSubtype: 'Non-current Assets',     normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1220', accountName: 'Office Equipment',            accountType: 'Asset',     accountSubtype: 'Non-current Assets',     normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1230', accountName: 'Company Car',                 accountType: 'Asset',     accountSubtype: 'Non-current Assets',     normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1250', accountName: 'Accumulated Depreciation',    accountType: 'Asset',     accountSubtype: 'Non-current Assets',     normalBalance: 'Credit', isDefault: true },

    // 2100s — Current Liabilities
    { accountCode: '2110', accountName: 'Accounts Payable',            accountType: 'Liability', accountSubtype: 'Current Liabilities',    normalBalance: 'Credit', isDefault: true },
    { accountCode: '2120', accountName: 'GST Payable',                 accountType: 'Liability', accountSubtype: 'Current Liabilities',    normalBalance: 'Credit', isDefault: true },
    { accountCode: '2125', accountName: 'WHT Payable',                 accountType: 'Liability', accountSubtype: 'Current Liabilities',    normalBalance: 'Credit', isDefault: true },
    { accountCode: '2130', accountName: "Director's Loan",             accountType: 'Liability', accountSubtype: 'Current Liabilities',    normalBalance: 'Credit', isDefault: true },
    { accountCode: '2140', accountName: 'Wages Payable',               accountType: 'Liability', accountSubtype: 'Current Liabilities',    normalBalance: 'Credit', isDefault: true },
    { accountCode: '2150', accountName: 'PAYG Withholding Payable',    accountType: 'Liability', accountSubtype: 'Current Liabilities',    normalBalance: 'Credit', isDefault: true },
    { accountCode: '2160', accountName: 'Superannuation Payable',      accountType: 'Liability', accountSubtype: 'Current Liabilities',    normalBalance: 'Credit', isDefault: true },
    { accountCode: '2170', accountName: 'Unearned Revenue',            accountType: 'Liability', accountSubtype: 'Current Liabilities',    normalBalance: 'Credit', isDefault: true },

    // 2200s — Non-current Liabilities
    { accountCode: '2210', accountName: 'Company Car Loan',            accountType: 'Liability', accountSubtype: 'Non-current Liabilities', normalBalance: 'Credit', isDefault: true },
    { accountCode: '2220', accountName: 'Equipment Loan',              accountType: 'Liability', accountSubtype: 'Non-current Liabilities', normalBalance: 'Credit', isDefault: true },
    { accountCode: '2230', accountName: 'Loan Payable',               accountType: 'Liability', accountSubtype: 'Non-current Liabilities', normalBalance: 'Credit', isDefault: true },

    // 3000s — Equity
    { accountCode: '3110', accountName: 'Capital / Investment',        accountType: 'Equity',    accountSubtype: 'Equity',                 normalBalance: 'Credit', isDefault: true },
    { accountCode: '3120', accountName: 'Distributions / Drawings',    accountType: 'Equity',    accountSubtype: 'Equity',                 normalBalance: 'Debit',  isDefault: true },
    { accountCode: '3210', accountName: 'Retained Earnings',           accountType: 'Equity',    accountSubtype: 'Equity',                 normalBalance: 'Credit', isDefault: true },
    { accountCode: '3310', accountName: 'Current Year Earnings',       accountType: 'Equity',    accountSubtype: 'Equity',                 normalBalance: 'Credit', isDefault: true },

    // 4000s — Revenue
    { accountCode: '4110', accountName: 'Sales',                       accountType: 'Revenue',   accountSubtype: 'Revenue',                normalBalance: 'Credit', isDefault: true },
    { accountCode: '4120', accountName: 'Other Revenue',               accountType: 'Revenue',   accountSubtype: 'Revenue',                normalBalance: 'Credit', isDefault: true },
    { accountCode: '4130', accountName: 'Interest Income',             accountType: 'Revenue',   accountSubtype: 'Revenue',                normalBalance: 'Credit', isDefault: true },

    // 5000s — Direct Cost (COGS)
    { accountCode: '5110', accountName: 'Cost of Goods Sold',          accountType: 'Expense',   accountSubtype: 'Direct Cost',            normalBalance: 'Debit',  isDefault: true },

    // 6000s — Expenses
    { accountCode: '6110', accountName: 'Rent',                        accountType: 'Expense',   accountSubtype: 'Expenses',               normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6120', accountName: 'Bank Fees',                   accountType: 'Expense',   accountSubtype: 'Expenses',               normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6130', accountName: 'Company Car Expenses',        accountType: 'Expense',   accountSubtype: 'Expenses',               normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6140', accountName: 'Website Hosting',             accountType: 'Expense',   accountSubtype: 'Expenses',               normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6150', accountName: 'Utilities',                   accountType: 'Expense',   accountSubtype: 'Expenses',               normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6160', accountName: 'Advertising',                 accountType: 'Expense',   accountSubtype: 'Expenses',               normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6170', accountName: 'Freight',                     accountType: 'Expense',   accountSubtype: 'Expenses',               normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6180', accountName: 'Wages and Salaries',          accountType: 'Expense',   accountSubtype: 'Expenses',               normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6190', accountName: 'Superannuation',              accountType: 'Expense',   accountSubtype: 'Expenses',               normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6200', accountName: 'Realised Currency Gains',     accountType: 'Expense',   accountSubtype: 'Expenses',               normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6210', accountName: 'Unrealised Currency Gains',   accountType: 'Expense',   accountSubtype: 'Expenses',               normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6220', accountName: 'Bank Currency Revaluations',  accountType: 'Expense',   accountSubtype: 'Expenses',               normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6230', accountName: 'Depreciation Expense',        accountType: 'Expense',   accountSubtype: 'Expenses',               normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6240', accountName: 'Interest Expense',            accountType: 'Expense',   accountSubtype: 'Expenses',               normalBalance: 'Debit',  isDefault: true },
  ],

  // ===============================
  // Transaction & Journal Entry Constants
  // ===============================
  TRANSACTION_TYPES: {
    // ── Core types (backward-compatible) ─────────────────────────────────────
    INCOME:               'Income',
    EXPENSE:              'Expense',
    TRANSFER:             'Transfer',

    // ── Sales & Revenue ───────────────────────────────────────────────────────
    CASH_SALE:            'Cash Sale',          // immediate cash/bank revenue
    CREDIT_SALE:          'Credit Sale',        // AR created — payment expected later
    INVENTORY_SALE:       'Inventory Sale',     // sale that reduces inventory

    // ── Purchases & Cost ──────────────────────────────────────────────────────
    CASH_PURCHASE:        'Cash Purchase',      // immediate cash/bank expense
    CREDIT_PURCHASE:      'Credit Purchase',    // AP created — payment due later
    INVENTORY_PURCHASE:   'Inventory Purchase', // purchase that increases inventory

    // ── Payments & Settlements ────────────────────────────────────────────────
    PAYMENT_RECEIVED:     'Payment Received',   // customer settles an AR balance
    PAYMENT_MADE:         'Payment Made',       // business settles an AP balance
    INSTALLMENT_PAYMENT:  'Installment Payment',

    // ── Payroll & Tax ─────────────────────────────────────────────────────────
    SALARY:               'Salary',             // wages / payroll disbursement
    GST_COLLECTION:       'GST Collection',     // GST collected on sales
    GST_PAYMENT:          'GST Payment',        // GST remitted to authority
    WHT_PAYMENT:          'WHT Payment',        // withholding tax remitted

    // ── Financing & Capital ───────────────────────────────────────────────────
    LOAN_DISBURSEMENT:    'Loan Disbursement',
    LOAN_REPAYMENT:       'Loan Repayment',
    OWNER_INVESTMENT:     'Owner Investment',
    OWNER_WITHDRAWAL:     'Owner Withdrawal',

    // ── Assets & Depreciation ─────────────────────────────────────────────────
    ASSET_PURCHASE:       'Asset Purchase',
    DEPRECIATION:         'Depreciation',       // non-cash expense

    // ── Working-Capital Items ─────────────────────────────────────────────────
    PREPAID_EXPENSE:      'Prepaid Expense',    // expense paid in advance (asset)
    ADVANCE_FROM_CUSTOMER:'Advance from Customer', // customer pays before delivery

    // ── Financing Cost ────────────────────────────────────────────────────────
    INTEREST_PAYMENT:     'Interest Payment',

    // ── Catch-alls ────────────────────────────────────────────────────────────
    REFUND:               'Refund',             // cash returned to customer or from vendor
    BANK_TRANSFER:        'Bank Transfer',      // inter-account movement (no P&L impact)
    JOURNAL_ENTRY:        'Journal Entry',      // manual adjusting entry

    // ── Accounting Period Engine (Phase 5.1) ──────────────────────────────────
    CLOSING_ENTRY:        'Closing Entry',      // year-end close revenue/expense to retained earnings
    OPENING_BALANCE:      'Opening Balance',    // carry-forward balance at start of new fiscal year
    ADJUSTING_ENTRY:      'Adjusting Entry',    // accrual, deferral, or year-end adjustment
  },

  // Transaction mode abstraction (reduces type explosion)
  TRANSACTION_MODES: {
    CASH: 'cash',
    CREDIT: 'credit',
    INSTALLMENT: 'installment',
    PARTIAL_SETTLEMENT: 'partial_settlement',
  },

  INPUT_METHODS: {
    FORM: 'form',
    EXCEL: 'excel',
    NLP: 'nlp',
  },

  // Transaction source tracking (for AI/analytics)
  TRANSACTION_SOURCES: {
    MANUAL: 'manual',
    IMPORT: 'import',
    SYSTEM_GENERATED: 'system_generated',
    INSTALLMENT_ENGINE: 'installment_engine',
    PAYMENT_SETTLEMENT: 'payment_settlement',
  },

  // Extended journal lifecycle statuses
  JOURNAL_STATUS: {
    DRAFT: 'draft',
    POSTED: 'posted',
    REVERSED: 'reversed',
    PARTIALLY_SETTLED: 'partially_settled',
    SETTLED: 'settled',
    OVERDUE: 'overdue',
    CANCELLED: 'cancelled',
  },

  // Payment tracking status
  PAYMENT_STATUS: {
    UNPAID: 'unpaid',
    PARTIALLY_PAID: 'partially_paid',
    PAID: 'paid',
    OVERDUE: 'overdue',
  },

  // Installment plan statuses
  INSTALLMENT_STATUS: {
    ACTIVE:        'active',
    COMPLETED:     'completed',
    DEFAULTED:     'defaulted',
    CANCELLED:     'cancelled',
    // ── New lifecycle statuses (Phase Advanced) ───────────────────────────
    OVERDUE:       'overdue',        // plan-level: at least 1 EMI past due
    RESTRUCTURED:  'restructured',   // repayment terms were modified mid-term
    SETTLED_EARLY: 'settled_early',  // borrower paid off entire remaining balance early
  },

  // Installment frequencies
  INSTALLMENT_FREQUENCY: {
    WEEKLY: 'weekly',
    BIWEEKLY: 'biweekly',
    MONTHLY: 'monthly',
    QUARTERLY: 'quarterly',
  },

  // Transaction categories (for reporting classification)
  TRANSACTION_CATEGORIES: {
    OPERATING: 'operating',
    INVESTING: 'investing',
    FINANCING: 'financing',
  },

  // ===============================
  // Accounting Period Engine (Phase 5.1)
  // ===============================
  FISCAL_YEAR_STATUS: {
    OPEN:   'open',
    CLOSED: 'closed',
    LOCKED: 'locked',
  },

  PERIOD_STATUS: {
    OPEN:   'open',
    CLOSED: 'closed',
    LOCKED: 'locked',
  },

  PERIOD_TYPE: {
    MONTHLY:   'monthly',
    QUARTERLY: 'quarterly',
    YEARLY:    'yearly',
  },

  ENTRY_TYPE: {
    NORMAL:          'normal',
    CLOSING:         'closing',
    OPENING_BALANCE: 'opening_balance',
    ADJUSTING:       'adjusting',
  },

  ADJUSTING_TYPE: {
    ACCRUAL:      'accrual',
    DEFERRAL:     'deferral',
    YEAR_END:     'year_end',
    DEPRECIATION: 'depreciation',
  },

  // ===============================
  // Audit Log Constants
  // ===============================
  AUDIT_ACTIONS: {
    CREATED:       'Created',
    EDITED:        'Edited',
    DELETED:       'Deleted',
    REVERSED:      'Reversed',
    SUSPENDED:     'Suspended',
    EXPORTED:      'Exported',
    PERIOD_CLOSED: 'Period Closed',
    PERIOD_LOCKED: 'Period Locked',
    PERIOD_REOPENED: 'Period Reopened',
    YEAR_CLOSED:   'Fiscal Year Closed',
  },

  ENTITY_TYPES: {
    JOURNAL_ENTRY:     'journalEntry',
    USER:              'user',
    BUSINESS:          'business',
    ACCOUNT:           'account',
    REPORT:            'report',
    CUSTOMER:          'customer',
    VENDOR:            'vendor',
    INSTALLMENT_PLAN:  'installmentPlan',
    FISCAL_YEAR:       'fiscalYear',
    ACCOUNTING_PERIOD: 'accountingPeriod',
  },

  // ===============================
  // Anomaly Alert Constants
  // ===============================
  // Lifecycle:
  //   pending          → initial state when first flagged by ML scan
  //   pending_review   → alias for pending (kept for clarity)
  //   marked_legit     → user reviewed and confirmed it is legitimate (suppresses future re-flag)
  //   confirmed_fraud  → user reviewed and confirmed it is fraudulent (kept tracked)
  //   ignored          → user dismissed without verdict (do not re-flag within X days)
  //   rescanned        → previously reviewed but transaction has changed materially → re-eligible
  //
  // Legacy (kept for backward-compat with already-saved documents):
  //   valid            → DEPRECATED alias for marked_legit
  //   confirmed_issue  → DEPRECATED alias for confirmed_fraud
  ANOMALY_STATUS: {
    PENDING:          'pending',
    PENDING_REVIEW:   'pending_review',
    MARKED_LEGIT:     'marked_legit',
    CONFIRMED_FRAUD:  'confirmed_fraud',
    IGNORED:          'ignored',
    RESCANNED:        'rescanned',
    // Legacy
    VALID:            'valid',
    CONFIRMED_ISSUE:  'confirmed_issue',
  },

  // Statuses that should SUPPRESS the same transaction from being re-flagged in future scans
  ANOMALY_SUPPRESS_STATUSES: ['marked_legit', 'valid', 'ignored'],
  // Statuses that count as "user reviewed" (any verdict given)
  ANOMALY_REVIEWED_STATUSES: ['marked_legit', 'confirmed_fraud', 'valid', 'confirmed_issue', 'ignored'],

  // ===============================
  // API & Pagination Constants
  // ===============================
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 25,
  MAX_LIMIT: 100,

  // Excel import limits
  MAX_EXCEL_ROWS: 5000,
  MAX_EXCEL_FILE_SIZE_MB: 10,

  // Password & JWT
  PASSWORD_MIN_LENGTH: 8,
  PASSWORD_REGEX: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/,
  JWT_EXPIRY: '24h',
  LOGIN_ATTEMPTS_LOCKOUT: 5,        // after 5 failed attempts
  LOCKOUT_DURATION_MINUTES: 15,

  // AI Feature Data Requirements
  MIN_TRANSACTIONS_FOR_ANOMALY: 20,
  MIN_MONTHS_FOR_FORECAST: 3,
  MIN_MONTHS_FOR_RECOMMENDATIONS: 3,

  // Email Verification
  EMAIL_VERIFICATION_TOKEN_EXPIRY_HOURS: 24,

  // ===============================
  // HTTP Status Codes (optional)
  // ===============================
  HTTP_STATUS: {
    OK: 200,
    CREATED: 201,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    UNPROCESSABLE_ENTITY: 422,
    TOO_MANY_REQUESTS: 429,
    INTERNAL_SERVER_ERROR: 500,
  },
};