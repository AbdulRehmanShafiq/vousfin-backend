/**
 * @module chartOfAccounts
 * @description Default chart of accounts for journal entry generation and validation.
 */

const { ACCOUNT_TYPES } = require('./accountTypes');

const acct = (name, type, normalBalance, aliases) => ({
  name, type, normalBalance, aliases,
});

const A = ACCOUNT_TYPES.ASSET;
const L = ACCOUNT_TYPES.LIABILITY;
const E = ACCOUNT_TYPES.EQUITY;
const R = ACCOUNT_TYPES.REVENUE;
const X = ACCOUNT_TYPES.EXPENSE;
const CA = ACCOUNT_TYPES.CONTRA_ASSET;

const CHART_OF_ACCOUNTS = Object.freeze([
  // ── Assets ──
  acct('Cash', A, 'debit', ['cash', 'cash in hand', 'petty cash']),
  acct('HBL Bank', A, 'debit', ['hbl', 'hbl bank', 'habib bank']),
  acct('Meezan Bank', A, 'debit', ['meezan', 'meezan bank']),
  acct('UBL', A, 'debit', ['ubl', 'ubl bank', 'united bank']),
  acct('Allied Bank', A, 'debit', ['allied', 'allied bank', 'abl']),
  acct('JazzCash', A, 'debit', ['jazzcash', 'jazz cash']),
  acct('EasyPaisa', A, 'debit', ['easypaisa', 'easy paisa']),
  acct('PayPal', A, 'debit', ['paypal']),
  acct('Stripe', A, 'debit', ['stripe']),
  acct('Accounts Receivable', A, 'debit', ['accounts receivable', 'receivables', 'a/r']),
  acct('Inventory', A, 'debit', ['inventory', 'stock', 'merchandise']),
  acct('Computer Equipment', A, 'debit', ['computer', 'laptop', 'computer equipment']),
  acct('Furniture & Fixtures', A, 'debit', ['furniture', 'fixtures', 'office furniture']),
  acct('Vehicle', A, 'debit', ['vehicle', 'car', 'bike', 'motorcycle']),
  acct('Equipment', A, 'debit', ['equipment', 'office equipment', 'tools']),
  acct('Machinery', A, 'debit', ['machinery', 'machine', 'plant']),
  acct('Prepaid Expenses', A, 'debit', ['prepaid', 'advance payment']),

  // ── Liabilities ──
  acct('Credit Card', L, 'credit', ['credit card', 'cc', 'visa', 'mastercard']),
  acct('Accounts Payable', L, 'credit', ['accounts payable', 'payables', 'creditors']),
  acct('Loan Payable', L, 'credit', ['loan', 'loan payable', 'bank loan']),
  acct('Tax Payable', L, 'credit', ['tax payable', 'taxes payable']),
  acct('Salary Payable', L, 'credit', ['salary payable', 'wages payable']),
  acct('Accrued Liabilities', L, 'credit', ['accrued liabilities', 'accrued expenses']),

  // ── Equity ──
  acct('Owner Capital', E, 'credit', ['owner capital', 'capital', 'equity', 'invested capital']),
  acct('Owner Drawings', E, 'debit', ['drawings', 'owner drawings', 'withdrawal']),
  acct('Retained Earnings', E, 'credit', ['retained earnings']),

  // ── Revenue ──
  acct('Service Revenue', R, 'credit', ['service revenue', 'service income', 'consulting revenue']),
  acct('Sales Revenue', R, 'credit', ['sales', 'sales revenue', 'product sales', 'revenue']),
  acct('Commission Income', R, 'credit', ['commission', 'commission income']),
  acct('Subscription Income', R, 'credit', ['subscription income', 'recurring revenue']),
  acct('Investment Income', R, 'credit', ['investment income', 'dividend', 'interest income']),

  // ── Expenses ──
  acct('Electricity Expense', X, 'debit', ['electricity', 'electric bill', 'light bill', 'power bill']),
  acct('Internet Expense', X, 'debit', ['internet', 'wifi', 'broadband']),
  acct('Gas Expense', X, 'debit', ['gas', 'gas bill', 'sui gas']),
  acct('Water Expense', X, 'debit', ['water', 'water bill']),
  acct('Mobile Bill Expense', X, 'debit', ['mobile bill', 'phone bill']),
  acct('Rent Expense', X, 'debit', ['rent', 'office rent', 'shop rent']),
  acct('Salary Expense', X, 'debit', ['salary', 'salary expense', 'wages', 'payroll']),
  acct('Fuel Expense', X, 'debit', ['fuel', 'petrol', 'diesel']),
  acct('Transport Expense', X, 'debit', ['transport', 'travel', 'uber', 'careem']),
  acct('Maintenance Expense', X, 'debit', ['maintenance']),
  acct('Repairs Expense', X, 'debit', ['repairs', 'repair']),
  acct('Office Supplies Expense', X, 'debit', ['office supplies', 'supplies']),
  acct('Stationery Expense', X, 'debit', ['stationery']),
  acct('Marketing Expense', X, 'debit', ['marketing', 'promotion']),
  acct('Advertising Expense', X, 'debit', ['ads', 'advertising', 'ad spend']),
  acct('Hosting Expense', X, 'debit', ['hosting', 'web hosting']),
  acct('Software Subscription Expense', X, 'debit', ['software subscription', 'software', 'saas']),
  acct('Cloud Services Expense', X, 'debit', ['cloud services', 'cloud', 'aws', 'azure']),
  acct('Domain Expense', X, 'debit', ['domain', 'domain name']),
  acct('Printing Expense', X, 'debit', ['printing']),
  acct('Insurance Expense', X, 'debit', ['insurance', 'insurance premium']),
  acct('Bank Charges', X, 'debit', ['bank fee', 'bank charges', 'service charges']),
  acct('Tax Expense', X, 'debit', ['tax', 'tax expense', 'income tax']),
  acct('Cost of Goods Sold', X, 'debit', ['cogs', 'cost of goods sold', 'cost of sales']),
  acct('Depreciation Expense', X, 'debit', ['depreciation', 'depreciation expense']),
  acct('Miscellaneous Expense', X, 'debit', ['miscellaneous', 'misc', 'sundry']),

  // ── Contra ──
  acct('Accumulated Depreciation', CA, 'credit', ['accumulated depreciation']),
]);

// Quick lookup: lowercase alias → account object
const ACCOUNT_ALIAS_MAP = new Map();
for (const account of CHART_OF_ACCOUNTS) {
  ACCOUNT_ALIAS_MAP.set(account.name.toLowerCase(), account);
  for (const alias of account.aliases) {
    ACCOUNT_ALIAS_MAP.set(alias.toLowerCase(), account);
  }
}

const VALID_ACCOUNT_NAMES = new Set(CHART_OF_ACCOUNTS.map((a) => a.name));

module.exports = { CHART_OF_ACCOUNTS, ACCOUNT_ALIAS_MAP, VALID_ACCOUNT_NAMES };
