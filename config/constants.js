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
    { accountCode: '4140', accountName: 'FX Gain on Exchange',          accountType: 'Revenue',   accountSubtype: 'Revenue',                normalBalance: 'Credit', isDefault: true },
    { accountCode: '6200', accountName: 'FX Loss on Exchange',         accountType: 'Expense',   accountSubtype: 'Expenses',               normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6210', accountName: 'Unrealised FX Gain/Loss',     accountType: 'Expense',   accountSubtype: 'Expenses',               normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6220', accountName: 'Bank Currency Revaluations',  accountType: 'Expense',   accountSubtype: 'Expenses',               normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6230', accountName: 'Depreciation Expense',        accountType: 'Expense',   accountSubtype: 'Expenses',               normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6240', accountName: 'Interest Expense',            accountType: 'Expense',   accountSubtype: 'Expenses',               normalBalance: 'Debit',  isDefault: true },

    // ── Tax Engine accounts (Phase 5.4) ── seeded only when business enables tax ──
    // Codes 1170–1177 (receivable / input tax assets) and 2121–2130 (payable liabilities)
    // are created by taxEngine.ensureTaxAccounts() at runtime; they are NOT seeded here
    // to preserve zero impact on businesses that never enable tax.
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

    // ── Multi-Currency Engine (Phase 5.3 — IAS 21) ───────────────────────────
    FX_GAIN:              'FX Gain',            // realised foreign-currency gain
    FX_LOSS:              'FX Loss',            // realised foreign-currency loss
    FX_REVALUATION:       'FX Revaluation',     // month-end unrealised revaluation

    // ── Tax Engine (Phase 5.4) ─────────────────────────────────────────────
    GST_COLLECTION:       'GST Collection',     // GST/VAT collected on sales (kept for compatibility)
    VAT_COLLECTION:       'VAT Collection',     // VAT collected on sales (AE/SA/GB)
    VAT_PAYMENT:          'VAT Payment',        // VAT remitted to authority
    REVERSE_CHARGE:       'Reverse Charge',     // Buyer accounts for both input and output tax
    WHT_DEDUCTION:        'WHT Deduction',      // Withholding tax deducted at source
    TDS_DEDUCTION:        'TDS Deduction',      // India TDS at source
    TAX_FILING:           'Tax Filing',         // Tax authority payment (GST/VAT filing)
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
    // ── Phase 1: Invoice / Bill workflow actions ──────────────────────────────
    SUBMITTED:     'Submitted for Approval',
    APPROVED:      'Approved',
    REJECTED:      'Rejected',
    SENT:          'Sent',
    CANCELLED:     'Cancelled',
    DISPUTED:      'Disputed',
    WRITTEN_OFF:   'Written Off',
    STATE_CHANGED: 'State Changed',
    SCHEDULED:     'Scheduled',
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
    // ── Phase 1: First-class Invoice / Bill domain entities ───────────────────
    INVOICE:           'invoice',
    BILL:              'bill',
    // ── Phase 3.1: Procurement entities ──────────────────────────────────────
    PURCHASE_ORDER:    'purchaseOrder',
    GOODS_RECEIPT:     'goodsReceipt',
    VENDOR_CREDIT:     'vendorCredit',
  },

  // ===============================
  // Phase 1 — Invoice State Machine
  // (first-class AR document built on top of JournalEntry ledger)
  // Lifecycle: draft → pending_approval → approved → sent → partially_paid → paid
  //                 ↘ cancelled / disputed / written_off (terminal)
  //                 ↘ overdue (auto-set when dueDate passed & not paid)
  // ===============================
  INVOICE_STATES: {
    DRAFT:             'draft',
    PENDING_APPROVAL:  'pending_approval',
    APPROVED:          'approved',
    SENT:              'sent',
    PARTIALLY_PAID:    'partially_paid',
    PAID:              'paid',
    OVERDUE:           'overdue',
    CANCELLED:         'cancelled',
    DISPUTED:          'disputed',
    WRITTEN_OFF:       'written_off',
  },

  /**
   * Allowed forward state transitions for Invoice.
   * Each key is the CURRENT state; the value is an array of states the
   * invoice may legally move to next.  Used by service-layer guards.
   */
  INVOICE_TRANSITIONS: {
    draft:             ['pending_approval', 'approved', 'cancelled'],
    pending_approval:  ['approved', 'rejected', 'draft', 'cancelled'],
    approved:          ['sent', 'partially_paid', 'paid', 'cancelled', 'disputed', 'overdue'],
    sent:              ['partially_paid', 'paid', 'overdue', 'disputed', 'cancelled'],
    partially_paid:    ['paid', 'overdue', 'disputed', 'written_off'],
    paid:              [], // terminal
    overdue:           ['partially_paid', 'paid', 'disputed', 'written_off', 'cancelled'],
    cancelled:         [], // terminal
    disputed:          ['approved', 'sent', 'partially_paid', 'paid', 'written_off', 'cancelled'],
    written_off:       [], // terminal
    rejected:          ['draft', 'cancelled'],
  },

  // ===============================
  // Phase 1 — Bill State Machine
  // Lifecycle: draft → awaiting_approval → approved → scheduled → partially_paid → paid
  //                 ↘ cancelled (terminal)
  //                 ↘ overdue (auto-set when dueDate passed & not paid)
  // ===============================
  BILL_STATES: {
    DRAFT:               'draft',
    AWAITING_APPROVAL:   'awaiting_approval',
    APPROVED:            'approved',
    SCHEDULED:           'scheduled',
    PARTIALLY_PAID:      'partially_paid',
    PAID:                'paid',
    OVERDUE:             'overdue',
    CANCELLED:           'cancelled',
  },

  BILL_TRANSITIONS: {
    draft:               ['awaiting_approval', 'approved', 'cancelled'],
    awaiting_approval:   ['approved', 'rejected', 'draft', 'cancelled'],
    approved:            ['scheduled', 'partially_paid', 'paid', 'cancelled', 'overdue'],
    scheduled:           ['partially_paid', 'paid', 'overdue', 'cancelled'],
    partially_paid:      ['paid', 'overdue', 'cancelled'],
    paid:                [], // terminal
    overdue:             ['partially_paid', 'paid', 'cancelled'],
    cancelled:           [], // terminal
    rejected:            ['draft', 'cancelled'],
  },

  /**
   * Approval workflow constants — shared by Invoice and Bill.
   * approvalThreshold drives whether a document requires approval based on amount.
   * approverRoles defines who is permitted to approve.
   */
  APPROVAL_STATUS: {
    NOT_REQUIRED: 'not_required',
    PENDING:      'pending',
    APPROVED:     'approved',
    REJECTED:     'rejected',
  },

  APPROVER_ROLES: {
    OWNER:      'owner',          // business owner — can approve any amount
    ACCOUNTANT: 'accountant',     // accountant role — standard approval
    MANAGER:    'manager',        // manager — mid-tier approval
    ADMIN:      'admin',          // platform admin — override approval
  },

  /**
   * Default approval threshold (base currency).
   * Documents above this amount default to requiring approval.
   * Per-business overrides live on Business.approvalConfig (future phase).
   */
  DEFAULT_APPROVAL_THRESHOLD: 50000,


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
  // Phase 5.4 — Tax Engine Constants
  // ===============================

  /** Canonical tax type identifiers — used in DB records and journal entries */
  TAX_TYPES: {
    // Pakistan
    GST:          'GST',
    GST_INPUT:    'GST_INPUT',
    SRB:          'SRB',
    PRA:          'PRA',
    KPRA:         'KPRA',
    BRA:          'BRA',
    WHT:          'WHT',
    // UAE / SA / GB
    VAT:          'VAT',
    VAT_INPUT:    'VAT_INPUT',
    VAT_ZERO:     'VAT_ZERO',
    VAT_EXEMPT:   'VAT_EXEMPT',
    VAT_REVERSE_CHARGE: 'VAT_REVERSE_CHARGE',
    // India
    CGST:         'CGST',
    SGST:         'SGST',
    IGST:         'IGST',
    GST_5:        'GST_5',
    GST_12:       'GST_12',
    TDS:          'TDS',
    // US
    SALES_TAX:    'SALES_TAX',
  },

  /** Tax calculation modes */
  TAX_CALCULATION_MODES: {
    INCLUSIVE: 'inclusive',  // entered amount includes tax (default for PK)
    EXCLUSIVE: 'exclusive',  // entered amount is before tax
  },

  /** Tax side: which leg of the transaction bears the tax */
  TAX_SIDES: {
    OUTPUT: 'output',  // collected from customer (sales)
    INPUT:  'input',   // paid to vendor (purchases, recoverable)
    BOTH:   'both',    // both sides (India CGST+SGST; RC)
  },

  /** Filing frequency options for taxConfig.filingFrequency */
  TAX_FILING_FREQUENCIES: ['monthly', 'quarterly', 'annual'],

  /** Countries with full tax engine support (ISO 3166-1 alpha-2) */
  SUPPORTED_COUNTRIES: ['PK', 'AE', 'SA', 'IN', 'US', 'GB'],

  // ===============================
  // Phase 3.1 — Purchase Order State Machine
  // Lifecycle:
  //   draft → pending_approval → approved → partially_received / fully_received → billed → closed
  //                                       → cancelled (terminal)
  // ===============================
  PO_STATES: {
    DRAFT:               'draft',
    PENDING_APPROVAL:    'pending_approval',
    APPROVED:            'approved',
    PARTIALLY_RECEIVED:  'partially_received',
    FULLY_RECEIVED:      'fully_received',
    BILLED:              'billed',
    CLOSED:              'closed',
    CANCELLED:           'cancelled',
  },

  PO_TRANSITIONS: {
    draft:               ['pending_approval', 'approved', 'cancelled'],
    pending_approval:    ['approved', 'draft', 'cancelled'],          // draft = rejected back
    approved:            ['partially_received', 'fully_received', 'cancelled'],
    partially_received:  ['fully_received', 'billed', 'cancelled'],
    fully_received:      ['billed', 'closed', 'cancelled'],
    billed:              ['closed', 'cancelled'],
    closed:              [],   // terminal
    cancelled:           [],   // terminal
  },

  // ===============================
  // Phase 3.1 — Goods Receipt Note (GRN) State Machine
  // Lifecycle: draft → confirmed → discrepancy_reported / reconciled
  // ===============================
  GRN_STATES: {
    DRAFT:                'draft',
    CONFIRMED:            'confirmed',
    DISCREPANCY_REPORTED: 'discrepancy_reported',
    RECONCILED:           'reconciled',
    CANCELLED:            'cancelled',
  },

  GRN_TRANSITIONS: {
    // draft can directly reach discrepancy_reported when confirm() detects issues
    draft:                ['confirmed', 'discrepancy_reported', 'cancelled'],
    confirmed:            ['discrepancy_reported', 'reconciled', 'cancelled'],
    discrepancy_reported: ['reconciled', 'cancelled'],
    reconciled:           [],  // terminal
    cancelled:            [],  // terminal
  },

  // ===============================
  // Phase 3.1 — Vendor Credit State Machine
  // ===============================
  VENDOR_CREDIT_STATES: {
    OPEN:      'open',
    PARTIALLY_APPLIED: 'partially_applied',
    FULLY_APPLIED:     'fully_applied',
    CANCELLED:         'cancelled',
  },

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