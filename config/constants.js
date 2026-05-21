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

  // Default Chart of Accounts (19 accounts)
  // Format: { accountName, accountType, normalBalance, isDefault: true }
  DEFAULT_ACCOUNTS: [
    // Assets
    { accountName: 'Cash', accountType: 'Asset', normalBalance: 'Debit', isDefault: true },
    { accountName: 'Bank', accountType: 'Asset', normalBalance: 'Debit', isDefault: true },
    { accountName: 'Accounts Receivable', accountType: 'Asset', normalBalance: 'Debit', isDefault: true },
    { accountName: 'Prepaid Expenses', accountType: 'Asset', normalBalance: 'Debit', isDefault: true },
    { accountName: 'Fixed Assets', accountType: 'Asset', normalBalance: 'Debit', isDefault: true },
    // Liabilities
    { accountName: 'Accounts Payable', accountType: 'Liability', normalBalance: 'Credit', isDefault: true },
    { accountName: 'Loan Payable', accountType: 'Liability', normalBalance: 'Credit', isDefault: true },
    { accountName: 'Tax Payable', accountType: 'Liability', normalBalance: 'Credit', isDefault: true },
    // Equity
    { accountName: "Owner's Equity", accountType: 'Equity', normalBalance: 'Credit', isDefault: true },
    // Revenue
    { accountName: 'Sales Revenue', accountType: 'Revenue', normalBalance: 'Credit', isDefault: true },
    { accountName: 'Service Revenue', accountType: 'Revenue', normalBalance: 'Credit', isDefault: true },
    { accountName: 'Other Income', accountType: 'Revenue', normalBalance: 'Credit', isDefault: true },
    { accountName: 'Interest Income', accountType: 'Revenue', normalBalance: 'Credit', isDefault: true },
    // Expenses
    { accountName: 'Cost of Goods Sold', accountType: 'Expense', normalBalance: 'Debit', isDefault: true },
    { accountName: 'Rent Expense', accountType: 'Expense', normalBalance: 'Debit', isDefault: true },
    { accountName: 'Utilities Expense', accountType: 'Expense', normalBalance: 'Debit', isDefault: true },
    { accountName: 'Salaries Expense', accountType: 'Expense', normalBalance: 'Debit', isDefault: true },
    { accountName: 'Marketing Expense', accountType: 'Expense', normalBalance: 'Debit', isDefault: true },
    { accountName: 'Miscellaneous Expense', accountType: 'Expense', normalBalance: 'Debit', isDefault: true },
  ],

  // ===============================
  // Transaction & Journal Entry Constants
  // ===============================
  TRANSACTION_TYPES: {
    // Original types (preserved for backward compatibility)
    INCOME: 'Income',
    EXPENSE: 'Expense',
    TRANSFER: 'Transfer',
    // Advanced transaction types
    CREDIT_SALE: 'Credit Sale',
    CREDIT_PURCHASE: 'Credit Purchase',
    PAYMENT_RECEIVED: 'Payment Received',
    PAYMENT_MADE: 'Payment Made',
    INSTALLMENT_PAYMENT: 'Installment Payment',
    LOAN_DISBURSEMENT: 'Loan Disbursement',
    LOAN_REPAYMENT: 'Loan Repayment',
    OWNER_INVESTMENT: 'Owner Investment',
    OWNER_WITHDRAWAL: 'Owner Withdrawal',
    ASSET_PURCHASE: 'Asset Purchase',
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
    ACTIVE: 'active',
    COMPLETED: 'completed',
    DEFAULTED: 'defaulted',
    CANCELLED: 'cancelled',
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
  // Audit Log Constants
  // ===============================
  AUDIT_ACTIONS: {
    CREATED: 'Created',
    EDITED: 'Edited',
    DELETED: 'Deleted',
    REVERSED: 'Reversed',
    SUSPENDED: 'Suspended',
    EXPORTED: 'Exported',
  },

  ENTITY_TYPES: {
    JOURNAL_ENTRY: 'journalEntry',
    USER: 'user',
    BUSINESS: 'business',
    ACCOUNT: 'account',
    REPORT: 'report',
    CUSTOMER: 'customer',
    VENDOR: 'vendor',
    INSTALLMENT_PLAN: 'installmentPlan',
  },

  // ===============================
  // Anomaly Alert Constants
  // ===============================
  ANOMALY_STATUS: {
    PENDING: 'pending',
    VALID: 'valid',
    CONFIRMED_ISSUE: 'confirmed_issue',
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