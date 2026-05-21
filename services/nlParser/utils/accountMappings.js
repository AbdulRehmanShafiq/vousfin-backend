/**
 * @module accountMappings
 * @description Maps transaction types and subcategories to their corresponding
 * debit and credit accounts for journal entry generation.
 */

const { TRANSACTION_TYPES } = require('../constants/transactionTypes');

/**
 * Default journal entry templates per transaction type.
 * Each entry defines { debit, credit } account names.
 * 
 * The sourceAccount placeholder "__SOURCE__" is replaced at runtime
 * with the actual payment source (e.g., "Cash", "HBL Bank").
 */
const JOURNAL_TEMPLATES = Object.freeze({
  [TRANSACTION_TYPES.EXPENSE]: {
    debit: '__EXPENSE_ACCOUNT__',
    credit: '__SOURCE__',
    defaultCredit: 'Cash',
  },
  [TRANSACTION_TYPES.INCOME]: {
    debit: '__SOURCE__',
    credit: '__REVENUE_ACCOUNT__',
    defaultDebit: 'Cash',
  },
  [TRANSACTION_TYPES.ASSET_PURCHASE]: {
    debit: '__ASSET_ACCOUNT__',
    credit: '__SOURCE__',
    defaultCredit: 'Cash',
  },
  [TRANSACTION_TYPES.INVENTORY_PURCHASE]: {
    debit: 'Inventory',
    credit: '__SOURCE__',
    defaultCredit: 'Cash',
  },
  [TRANSACTION_TYPES.INVENTORY_SALE]: {
    debit: '__SOURCE__',
    credit: 'Sales Revenue',
    defaultDebit: 'Cash',
  },
  [TRANSACTION_TYPES.OWNER_INVESTMENT]: {
    debit: '__SOURCE__',
    credit: 'Owner Capital',
    defaultDebit: 'Cash',
  },
  [TRANSACTION_TYPES.OWNER_WITHDRAWAL]: {
    debit: 'Owner Drawings',
    credit: '__SOURCE__',
    defaultCredit: 'Cash',
  },
  [TRANSACTION_TYPES.LOAN_RECEIVED]: {
    debit: '__SOURCE__',
    credit: 'Loan Payable',
    defaultDebit: 'Cash',
  },
  [TRANSACTION_TYPES.LOAN_PAYMENT]: {
    debit: 'Loan Payable',
    credit: '__SOURCE__',
    defaultCredit: 'Cash',
  },
  [TRANSACTION_TYPES.LIABILITY_PAYMENT]: {
    debit: 'Accounts Payable',
    credit: '__SOURCE__',
    defaultCredit: 'Cash',
  },
  [TRANSACTION_TYPES.TRANSFER]: {
    debit: '__DESTINATION__',
    credit: '__SOURCE__',
    defaultDebit: 'Cash',
    defaultCredit: 'Cash',
  },
  [TRANSACTION_TYPES.REFUND]: {
    debit: '__SOURCE__',
    credit: '__EXPENSE_ACCOUNT__',
    defaultDebit: 'Cash',
    defaultCredit: 'Miscellaneous Expense',
  },
  [TRANSACTION_TYPES.SALARY]: {
    debit: 'Salary Expense',
    credit: '__SOURCE__',
    defaultCredit: 'Cash',
  },
  [TRANSACTION_TYPES.TAX]: {
    debit: 'Tax Expense',
    credit: '__SOURCE__',
    defaultCredit: 'Cash',
  },
  [TRANSACTION_TYPES.ACCOUNTS_RECEIVABLE]: {
    debit: 'Accounts Receivable',
    credit: '__REVENUE_ACCOUNT__',
    defaultCredit: 'Service Revenue',
  },
  [TRANSACTION_TYPES.ACCOUNTS_PAYABLE]: {
    debit: '__EXPENSE_ACCOUNT__',
    credit: 'Accounts Payable',
  },
  [TRANSACTION_TYPES.DEPRECIATION]: {
    debit: 'Depreciation Expense',
    credit: 'Accumulated Depreciation',
  },
  [TRANSACTION_TYPES.ADJUSTMENT]: {
    debit: '__ADJUSTMENT_DEBIT__',
    credit: '__ADJUSTMENT_CREDIT__',
  },
});

/**
 * Maps expense subcategories to their specific expense account names.
 */
const EXPENSE_ACCOUNT_MAP = Object.freeze({
  electricity: 'Electricity Expense',
  internet: 'Internet Expense',
  gas: 'Gas Expense',
  water: 'Water Expense',
  mobile_bill: 'Mobile Bill Expense',
  rent: 'Rent Expense',
  salary: 'Salary Expense',
  fuel: 'Fuel Expense',
  transport: 'Transport Expense',
  maintenance: 'Maintenance Expense',
  repairs: 'Repairs Expense',
  office_supplies: 'Office Supplies Expense',
  stationery: 'Stationery Expense',
  marketing: 'Marketing Expense',
  ads: 'Advertising Expense',
  hosting: 'Hosting Expense',
  software_subscription: 'Software Subscription Expense',
  cloud_services: 'Cloud Services Expense',
  domain: 'Domain Expense',
  printing: 'Printing Expense',
  insurance: 'Insurance Expense',
  bank_fee: 'Bank Charges',
  tax: 'Tax Expense',
});

/**
 * Maps income subcategories to their specific revenue account names.
 */
const REVENUE_ACCOUNT_MAP = Object.freeze({
  service_revenue: 'Service Revenue',
  product_sales: 'Sales Revenue',
  consulting: 'Service Revenue',
  commission: 'Commission Income',
  subscription_income: 'Subscription Income',
  investment_income: 'Investment Income',
});

/**
 * Maps asset subcategories to their specific asset account names.
 */
const ASSET_ACCOUNT_MAP = Object.freeze({
  equipment: 'Equipment',
  furniture: 'Furniture & Fixtures',
  laptop: 'Computer Equipment',
  vehicle: 'Vehicle',
  inventory: 'Inventory',
  machinery: 'Machinery',
});

/**
 * Normalize source account name against known payment accounts.
 */
const SOURCE_ACCOUNT_ALIASES = Object.freeze({
  cash: 'Cash',
  hbl: 'HBL Bank',
  'hbl bank': 'HBL Bank',
  'habib bank': 'HBL Bank',
  meezan: 'Meezan Bank',
  'meezan bank': 'Meezan Bank',
  ubl: 'UBL',
  'ubl bank': 'UBL',
  'united bank': 'UBL',
  allied: 'Allied Bank',
  'allied bank': 'Allied Bank',
  abl: 'Allied Bank',
  jazzcash: 'JazzCash',
  'jazz cash': 'JazzCash',
  easypaisa: 'EasyPaisa',
  'easy paisa': 'EasyPaisa',
  paypal: 'PayPal',
  stripe: 'Stripe',
  'credit card': 'Credit Card',
});

module.exports = {
  JOURNAL_TEMPLATES,
  EXPENSE_ACCOUNT_MAP,
  REVENUE_ACCOUNT_MAP,
  ASSET_ACCOUNT_MAP,
  SOURCE_ACCOUNT_ALIASES,
};
