// config/constants.js
// Centralized application constants – change only here

module.exports = {
  // Reserved sentinel businessId for GLOBAL-scope vectors (the app module/help
  // catalog, identical for every tenant). Real businesses get random ObjectIds,
  // so this fixed low value never collides; storing catalog vectors under it
  // means the existing businessId vector-search filter isolates them from every
  // tenant's financial search automatically. See VectorDocument.scope.
  GLOBAL_CATALOG_BUSINESS_ID: '000000000000000000000001',

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
    // ── Legal Entity Types (original — kept for backward compatibility) ────────
    'Sole Proprietorship',
    'Partnership',
    'Private Limited',
    'Freelancer',
    // ── Legal Entity Types (expanded) ─────────────────────────────────────────
    'Private Limited Company',
    'Public Limited Company',
    'Non-Profit / NGO',
    'Cooperative Society',
    'Branch Office',
    'Freelancer / Self-Employed',
    // ── Technology & Digital ──────────────────────────────────────────────────
    'IT Services / Software Development',
    'SaaS / Software Product',
    'Digital Agency / Marketing',
    'E-commerce / Online Retail',
    // ── Trade & Commerce ──────────────────────────────────────────────────────
    'Retail Store',
    'Wholesale / Distribution',
    'Import & Export',
    // ── Professional Services ─────────────────────────────────────────────────
    'Consulting / Advisory',
    'Accounting / Audit Firm',
    'Law Firm / Legal Services',
    'Healthcare / Medical Practice',
    'Education & Training',
    // ── Production & Industry ─────────────────────────────────────────────────
    'Manufacturing',
    'Construction / Contracting',
    'Agriculture / Farming',
    // ── Hospitality & Food ────────────────────────────────────────────────────
    'Restaurant / Food Service',
    'Hotel & Hospitality',
    // ── Other ─────────────────────────────────────────────────────────────────
    'Logistics & Transportation',
    'Real Estate',
    'Media & Entertainment',
    'Other',
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
    // ─── 1000s — Assets: Bank & Cash ─────────────────────────────────────────
    { accountCode: '1010', accountName: 'Cash at Bank',                  accountType: 'Asset',     accountSubtype: 'Bank and Cash',           normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1020', accountName: 'Cash on Hand',                  accountType: 'Asset',     accountSubtype: 'Bank and Cash',           normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1030', accountName: 'Petty Cash',                    accountType: 'Asset',     accountSubtype: 'Bank and Cash',           normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1040', accountName: 'Savings Account',               accountType: 'Asset',     accountSubtype: 'Bank and Cash',           normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1045', accountName: 'Foreign Currency Account',      accountType: 'Asset',     accountSubtype: 'Bank and Cash',           normalBalance: 'Debit',  isDefault: true },

    // ─── 1100s — Assets: Current ──────────────────────────────────────────────
    { accountCode: '1110', accountName: 'Accounts Receivable',           accountType: 'Asset',     accountSubtype: 'Current Assets',          normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1120', accountName: 'Prepaid Expenses',              accountType: 'Asset',     accountSubtype: 'Current Assets',          normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1130', accountName: 'Short-term Deposits',           accountType: 'Asset',     accountSubtype: 'Current Assets',          normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1140', accountName: 'Other Receivables',             accountType: 'Asset',     accountSubtype: 'Current Assets',          normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1150', accountName: 'Inventory',                     accountType: 'Asset',     accountSubtype: 'Current Assets',          normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1156', accountName: 'Vendor Credit Clearing',        accountType: 'Asset',     accountSubtype: 'Current Assets',          normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1157', accountName: 'Landed Cost Clearing',          accountType: 'Asset',     accountSubtype: 'Current Assets',          normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1158', accountName: 'Stock in Transit',              accountType: 'Asset',     accountSubtype: 'Current Assets',          normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1160', accountName: 'Advance Payments to Suppliers', accountType: 'Asset',     accountSubtype: 'Current Assets',          normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1165', accountName: 'Employee Loans & Advances',     accountType: 'Asset',     accountSubtype: 'Current Assets',          normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1167', accountName: 'Notes Receivable',              accountType: 'Asset',     accountSubtype: 'Current Assets',          normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1168', accountName: 'Accrued Income',                accountType: 'Asset',     accountSubtype: 'Current Assets',          normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1169', accountName: 'Work in Progress',              accountType: 'Asset',     accountSubtype: 'Current Assets',          normalBalance: 'Debit',  isDefault: true },

    // ─── 1200s — Assets: Non-current ─────────────────────────────────────────
    { accountCode: '1210', accountName: 'Furniture and Fittings',        accountType: 'Asset',     accountSubtype: 'Non-current Assets',      normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1220', accountName: 'Office Equipment',              accountType: 'Asset',     accountSubtype: 'Non-current Assets',      normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1230', accountName: 'Company Car',                   accountType: 'Asset',     accountSubtype: 'Non-current Assets',      normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1240', accountName: 'Computer & IT Equipment',       accountType: 'Asset',     accountSubtype: 'Non-current Assets',      normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1245', accountName: 'Leasehold Improvements',        accountType: 'Asset',     accountSubtype: 'Non-current Assets',      normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1250', accountName: 'Accumulated Depreciation',      accountType: 'Asset',     accountSubtype: 'Non-current Assets',      normalBalance: 'Credit', isDefault: true },
    { accountCode: '1255', accountName: 'Land',                          accountType: 'Asset',     accountSubtype: 'Non-current Assets',      normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1257', accountName: 'Buildings',                     accountType: 'Asset',     accountSubtype: 'Non-current Assets',      normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1258', accountName: 'Plant & Machinery',             accountType: 'Asset',     accountSubtype: 'Non-current Assets',      normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1260', accountName: 'Security Deposit (Refundable)', accountType: 'Asset',     accountSubtype: 'Non-current Assets',      normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1265', accountName: 'Intangible Assets',             accountType: 'Asset',     accountSubtype: 'Non-current Assets',      normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1267', accountName: 'Accumulated Amortization',      accountType: 'Asset',     accountSubtype: 'Non-current Assets',      normalBalance: 'Credit', isDefault: true },
    { accountCode: '1268', accountName: 'Goodwill',                      accountType: 'Asset',     accountSubtype: 'Non-current Assets',      normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1269', accountName: 'Right-of-Use Asset (IFRS 16)',  accountType: 'Asset',     accountSubtype: 'Non-current Assets',      normalBalance: 'Debit',  isDefault: true },
    { accountCode: '1270', accountName: 'Long-term Investments',         accountType: 'Asset',     accountSubtype: 'Non-current Assets',      normalBalance: 'Debit',  isDefault: true },

    // ─── 2000s — Liabilities: Current ────────────────────────────────────────
    { accountCode: '2100', accountName: 'Bank Overdraft',                accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },
    { accountCode: '2105', accountName: 'Credit Card Payable',           accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },
    { accountCode: '2110', accountName: 'Accounts Payable',              accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },
    { accountCode: '2115', accountName: 'Goods Received Not Invoiced',  accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },
    { accountCode: '2120', accountName: 'GST Payable',                   accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },
    { accountCode: '2125', accountName: 'WHT Payable',                   accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },
    { accountCode: '2130', accountName: "Director's Loan",               accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },
    { accountCode: '2135', accountName: 'Accrued Expenses',              accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },
    { accountCode: '2137', accountName: 'Accrued Interest Payable',      accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },
    { accountCode: '2140', accountName: 'Wages Payable',                 accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },
    { accountCode: '2141', accountName: 'Salary Tax Withheld Payable',   accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },
    { accountCode: '2142', accountName: 'EOBI / Social Security Payable',accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },
    { accountCode: '2143', accountName: 'Provident Fund Payable',        accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },
    { accountCode: '2145', accountName: 'Sales Tax (PST/SST) Payable',   accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },
    { accountCode: '2148', accountName: 'Employee Benefits Payable',     accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },
    { accountCode: '2150', accountName: 'PAYG Withholding Payable',      accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },
    { accountCode: '2160', accountName: 'Superannuation Payable',        accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },
    { accountCode: '2170', accountName: 'Unearned Revenue',              accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },
    { accountCode: '2180', accountName: 'Income Tax Payable',            accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },
    { accountCode: '2190', accountName: 'Advance from Customers',        accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },
    { accountCode: '2195', accountName: 'Other Payables & Accruals',     accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },
    { accountCode: '2197', accountName: 'Workers Welfare Fund Payable',  accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },
    { accountCode: '2198', accountName: 'VAT Payable',                   accountType: 'Liability', accountSubtype: 'Current Liabilities',     normalBalance: 'Credit', isDefault: true },

    // ─── 2200s — Liabilities: Non-current ────────────────────────────────────
    { accountCode: '2210', accountName: 'Company Car Loan',              accountType: 'Liability', accountSubtype: 'Non-current Liabilities', normalBalance: 'Credit', isDefault: true },
    { accountCode: '2220', accountName: 'Equipment Loan',                accountType: 'Liability', accountSubtype: 'Non-current Liabilities', normalBalance: 'Credit', isDefault: true },
    { accountCode: '2230', accountName: 'Loan Payable',                  accountType: 'Liability', accountSubtype: 'Non-current Liabilities', normalBalance: 'Credit', isDefault: true },
    { accountCode: '2240', accountName: 'Mortgage / Property Loan',      accountType: 'Liability', accountSubtype: 'Non-current Liabilities', normalBalance: 'Credit', isDefault: true },
    { accountCode: '2245', accountName: 'Finance Lease Liability',       accountType: 'Liability', accountSubtype: 'Non-current Liabilities', normalBalance: 'Credit', isDefault: true },
    { accountCode: '2250', accountName: 'Deferred Tax Liability',        accountType: 'Liability', accountSubtype: 'Non-current Liabilities', normalBalance: 'Credit', isDefault: true },

    // ─── 3000s — Equity ───────────────────────────────────────────────────────
    { accountCode: '3110', accountName: 'Capital / Investment',          accountType: 'Equity',    accountSubtype: 'Equity',                  normalBalance: 'Credit', isDefault: true },
    { accountCode: '3120', accountName: 'Distributions / Drawings',      accountType: 'Equity',    accountSubtype: 'Equity',                  normalBalance: 'Debit',  isDefault: true },
    { accountCode: '3130', accountName: 'Share Premium',                 accountType: 'Equity',    accountSubtype: 'Equity',                  normalBalance: 'Credit', isDefault: true },
    { accountCode: '3140', accountName: 'Revaluation Reserve',           accountType: 'Equity',    accountSubtype: 'Equity',                  normalBalance: 'Credit', isDefault: true },
    { accountCode: '3210', accountName: 'Retained Earnings',             accountType: 'Equity',    accountSubtype: 'Equity',                  normalBalance: 'Credit', isDefault: true },
    { accountCode: '3310', accountName: 'Current Year Earnings',         accountType: 'Equity',    accountSubtype: 'Equity',                  normalBalance: 'Credit', isDefault: true },

    // ─── 4000s — Revenue ──────────────────────────────────────────────────────
    { accountCode: '4110', accountName: 'Sales',                         accountType: 'Revenue',   accountSubtype: 'Revenue',                 normalBalance: 'Credit', isDefault: true },
    { accountCode: '4115', accountName: 'Sales Returns & Allowances',    accountType: 'Revenue',   accountSubtype: 'Revenue',                 normalBalance: 'Debit',  isDefault: true },
    { accountCode: '4120', accountName: 'Other Revenue',                 accountType: 'Revenue',   accountSubtype: 'Revenue',                 normalBalance: 'Credit', isDefault: true },
    { accountCode: '4130', accountName: 'Interest Income',               accountType: 'Revenue',   accountSubtype: 'Revenue',                 normalBalance: 'Credit', isDefault: true },
    { accountCode: '4140', accountName: 'FX Gain on Exchange',           accountType: 'Revenue',   accountSubtype: 'Revenue',                 normalBalance: 'Credit', isDefault: true },
    { accountCode: '4150', accountName: 'Service / Consultancy Revenue', accountType: 'Revenue',   accountSubtype: 'Revenue',                 normalBalance: 'Credit', isDefault: true },
    { accountCode: '4160', accountName: 'Rental Income',                 accountType: 'Revenue',   accountSubtype: 'Revenue',                 normalBalance: 'Credit', isDefault: true },
    { accountCode: '4170', accountName: 'Commission Income',             accountType: 'Revenue',   accountSubtype: 'Revenue',                 normalBalance: 'Credit', isDefault: true },
    { accountCode: '4180', accountName: 'Discount Received',             accountType: 'Revenue',   accountSubtype: 'Revenue',                 normalBalance: 'Credit', isDefault: true },
    { accountCode: '4185', accountName: 'Dividend Income',               accountType: 'Revenue',   accountSubtype: 'Revenue',                 normalBalance: 'Credit', isDefault: true },
    { accountCode: '4190', accountName: 'Royalty Income',                accountType: 'Revenue',   accountSubtype: 'Revenue',                 normalBalance: 'Credit', isDefault: true },
    { accountCode: '4195', accountName: 'Grant / Subsidy Income',        accountType: 'Revenue',   accountSubtype: 'Revenue',                 normalBalance: 'Credit', isDefault: true },
    { accountCode: '4200', accountName: 'Subscription Revenue',          accountType: 'Revenue',   accountSubtype: 'Revenue',                 normalBalance: 'Credit', isDefault: true },
    { accountCode: '4205', accountName: 'Scrap & Salvage Revenue',       accountType: 'Revenue',   accountSubtype: 'Revenue',                 normalBalance: 'Credit', isDefault: true },
    { accountCode: '4210', accountName: 'Late Payment Fee Income',       accountType: 'Revenue',   accountSubtype: 'Revenue',                 normalBalance: 'Credit', isDefault: true },
    { accountCode: '4215', accountName: 'Franchise Fee Income',          accountType: 'Revenue',   accountSubtype: 'Revenue',                 normalBalance: 'Credit', isDefault: true },
    { accountCode: '4220', accountName: 'Gain on Asset Disposal',        accountType: 'Revenue',   accountSubtype: 'Revenue',                 normalBalance: 'Credit', isDefault: true },

    // ─── 5000s — Direct Cost (COGS) ───────────────────────────────────────────
    { accountCode: '5110', accountName: 'Cost of Goods Sold',            accountType: 'Expense',   accountSubtype: 'Direct Cost',             normalBalance: 'Debit',  isDefault: true },
    { accountCode: '5115', accountName: 'Purchase Price Variance',       accountType: 'Expense',   accountSubtype: 'Direct Cost',             normalBalance: 'Debit',  isDefault: true },
    { accountCode: '5120', accountName: 'Direct Labour',                 accountType: 'Expense',   accountSubtype: 'Direct Cost',             normalBalance: 'Debit',  isDefault: true },
    { accountCode: '5130', accountName: 'Direct Materials',              accountType: 'Expense',   accountSubtype: 'Direct Cost',             normalBalance: 'Debit',  isDefault: true },
    { accountCode: '5140', accountName: 'Subcontractor Costs',           accountType: 'Expense',   accountSubtype: 'Direct Cost',             normalBalance: 'Debit',  isDefault: true },
    { accountCode: '5150', accountName: 'Freight-in & Import Duties',    accountType: 'Expense',   accountSubtype: 'Direct Cost',             normalBalance: 'Debit',  isDefault: true },
    { accountCode: '5160', accountName: 'Packaging & Raw Consumables',   accountType: 'Expense',   accountSubtype: 'Direct Cost',             normalBalance: 'Debit',  isDefault: true },
    { accountCode: '5170', accountName: 'Manufacturing Overhead',        accountType: 'Expense',   accountSubtype: 'Direct Cost',             normalBalance: 'Debit',  isDefault: true },

    // ─── 6000s — Expenses: Occupancy & Utilities ─────────────────────────────
    { accountCode: '6110', accountName: 'Rent',                          accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6112', accountName: 'Rent — Equipment & Machinery',  accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6150', accountName: 'Utilities (Electricity & Gas)', accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6152', accountName: 'Water & Sewage',                accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6154', accountName: 'Generator Fuel & Running',      accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6300', accountName: 'Repairs & Maintenance',         accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6350', accountName: 'Security Services',             accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6360', accountName: 'Cleaning & Janitorial',         accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },

    // ─── 6000s — Expenses: Payroll & HR ─────────────────────────────────────
    { accountCode: '6180', accountName: 'Wages and Salaries',            accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6182', accountName: 'Allowances & Bonuses',          accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6184', accountName: 'Overtime Pay',                  accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6186', accountName: 'Commissions Paid',              accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6190', accountName: 'Superannuation',                accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6192', accountName: 'EOBI Contribution',             accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6194', accountName: 'Provident Fund Contribution',   accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6196', accountName: 'Workers Welfare Fund',          accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6198', accountName: 'Recruitment & Hiring Costs',    accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6340', accountName: 'Training & Development',        accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6342', accountName: 'Uniforms & Staff Clothing',     accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6344', accountName: 'Staff Welfare & Benefits',      accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6346', accountName: 'Medical & Health Expenses',     accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },

    // ─── 6000s — Expenses: Finance & Banking ─────────────────────────────────
    { accountCode: '6120', accountName: 'Bank Fees & Charges',           accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6240', accountName: 'Interest Expense',              accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6242', accountName: 'Finance Lease Interest',        accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6200', accountName: 'FX Loss on Exchange',           accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6210', accountName: 'Unrealised FX Gain/Loss',       accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6220', accountName: 'Bank Currency Revaluations',    accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },

    // ─── 6000s — Expenses: Selling & Marketing ───────────────────────────────
    { accountCode: '6160', accountName: 'Advertising & Marketing',       accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6162', accountName: 'Discount Allowed',              accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6170', accountName: 'Freight & Delivery (Outbound)', accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6172', accountName: 'Packaging & Dispatch Costs',    accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6174', accountName: 'Customer Refunds & Returns',    accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },

    // ─── 6000s — Expenses: Administration ────────────────────────────────────
    { accountCode: '6250', accountName: 'Office Supplies & Stationery',  accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6260', accountName: 'Professional / Legal Fees',     accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6262', accountName: 'Audit Fees',                    accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6264', accountName: 'Brokerage & Agent Fees',        accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6270', accountName: 'Insurance',                     accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6290', accountName: 'Telephone & Internet',          accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6310', accountName: 'Software & Subscriptions',      accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6312', accountName: 'Website Hosting',               accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6320', accountName: 'Printing & Postage',            accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6460', accountName: 'Business Licenses & Permits',   accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6462', accountName: 'Regulatory & Filing Fees',      accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },

    // ─── 6000s — Expenses: Travel & Transport ────────────────────────────────
    { accountCode: '6130', accountName: 'Company Car Expenses',          accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6280', accountName: 'Travel & Entertainment',        accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6282', accountName: 'Meals & Staff Refreshments',    accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6284', accountName: 'Transportation & Conveyance',   accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6286', accountName: 'Parking, Tolls & Commuting',    accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },

    // ─── 6000s — Expenses: Asset-related ─────────────────────────────────────
    { accountCode: '6230', accountName: 'Depreciation Expense',          accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6232', accountName: 'Amortization (Intangibles)',     accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6490', accountName: 'Loss on Asset Disposal',        accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6495', accountName: 'Inventory Write-off',           accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },

    // ─── 6000s — Expenses: Other ─────────────────────────────────────────────
    { accountCode: '6370', accountName: 'Bad Debt Expense',              accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6380', accountName: 'Donation & Charitable Giving',  accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6440', accountName: 'Research & Development',        accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6450', accountName: 'Safety & Compliance',           accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6455', accountName: 'Penalties & Regulatory Fines',  accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },
    { accountCode: '6390', accountName: 'Miscellaneous Expenses',        accountType: 'Expense',   accountSubtype: 'Expenses',                normalBalance: 'Debit',  isDefault: true },

    // ── Tax Engine accounts (Phase 5.4) ── seeded only when business enables tax ──
    // Codes 1170–1177 (receivable / input tax assets) and 2121–2130 (payable liabilities)
    // are created by taxEngine.ensureTaxAccounts() at runtime; they are NOT seeded here
    // to preserve zero impact on businesses that never enable tax.
  ],

  /**
   * Control accounts — summarize a subsystem (AR/AP documents, the tax engine)
   * and must never receive a direct manual/AI posting. Codes here are seeded via
   * DEFAULT_ACCOUNTS; the dynamic tax-engine range (1170-1177, 2121-2130, see
   * countryTaxProfiles.js) is covered separately by isTaxEngineControlCode() below.
   */
  CONTROL_ACCOUNT_CODES: ['1110', '2110', '2120', '2125', '2145', '2198'],

  /** True for any accountCode in the tax engine's dynamic receivable/payable ranges. */
  isTaxEngineControlCode(accountCode) {
    const n = Number(accountCode);
    if (!Number.isFinite(n)) return false;
    return (n >= 1170 && n <= 1177) || (n >= 2121 && n <= 2130);
  },

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
    BATCH: 'batch',   // #9 — server-side batch posting
  },

  // Transaction source tracking (for AI/analytics)
  TRANSACTION_SOURCES: {
    MANUAL: 'manual',
    IMPORT: 'import',
    SYSTEM_GENERATED: 'system_generated',
    INSTALLMENT_ENGINE: 'installment_engine',
    PAYMENT_SETTLEMENT: 'payment_settlement',
    BANK_RECONCILIATION: 'bank_reconciliation',   // #7 — entry posted from a bank statement line
    AI_AUTO_POSTED: 'ai_auto_posted',             // NL parse at >=98% confidence, exact account match, opt-in enabled
  },

  // AI Decision Ledger (Intelligence Roadmap Phase 0) — the kind of AI action
  // that produced a decision record, and the user's eventual verdict on it.
  AI_DECISION_KINDS: {
    PARSE:      'parse',       // NL / form parse → suggested transaction
    CLASSIFY:   'classify',    // Excel/document row classification
    MATCH:      'match',       // 3-way / bill / bank match
    RECONCILE:  'reconcile',   // bank/AR/AP reconciliation
    AUTOPOST:   'autopost',    // zero-click auto-post decision
    ANOMALY:    'anomaly',     // anomaly verdict
    FORECAST:   'forecast',    // forecast produced
    RECOMMEND:  'recommend',   // advisory recommendation
  },
  AI_DECISION_OUTCOMES: {
    PENDING:   'pending',    // recorded; user has not acted yet
    ACCEPTED:  'accepted',   // user accepted the AI decision as-is
    CORRECTED: 'corrected',  // user changed it before accepting (correctedTo captures the change)
    REVERSED:  'reversed',   // a posted AI decision was later reversed
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

  // Payroll run lifecycle (SRS FR-08.2/.3 — locked after posting; amendments require reversal)
  PAYROLL_RUN_STATUS: {
    DRAFT: 'draft', PROCESSED: 'processed', POSTED: 'posted', PAID: 'paid', REVERSED: 'reversed',
  },
  PAYROLL_RUN_TRANSITIONS: {
    draft:     ['processed'],
    processed: ['draft', 'posted'],
    posted:    ['paid', 'reversed'],
    paid:      ['reversed'],
    reversed:  [],
  },

  // Budgeting (SRS FR-04.1 / FR-04.2) — versioned, immutable once active
  BUDGET_STATUS: {
    DRAFT: 'draft', PENDING_APPROVAL: 'pending_approval', ACTIVE: 'active',
    REJECTED: 'rejected', ARCHIVED: 'archived',
  },
  BUDGET_STATUS_TRANSITIONS: {
    draft:            ['pending_approval'],
    pending_approval: ['active', 'rejected'],
    rejected:         ['draft'],
    active:           ['archived'],
    archived:         [],
  },
  BUDGET_SCENARIOS: ['base', 'optimistic', 'pessimistic'],

  // Job costing (SRS FR-07.2)
  JOB_STATUS: {
    OPEN: 'open', IN_PROGRESS: 'in_progress', COMPLETED: 'completed', CANCELLED: 'cancelled',
  },
  JOB_STATUS_TRANSITIONS: {
    open:        ['in_progress', 'cancelled'],
    in_progress: ['completed', 'cancelled'],
    completed:   [],
    cancelled:   [],
  },
  JOB_COST_CATEGORIES: ['material', 'labour', 'overhead'],

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

  // Audit-trail action verbs for fiscal-year / accounting-period lifecycle
  // (stored on the free-string `auditTrail.action` of both models).
  PERIOD_ACTION: {
    OPENED:   'opened',
    CLOSED:   'closed',
    LOCKED:   'locked',
    REOPENED: 'reopened',
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
    // ── AR/AP Refactor M2 ─────────────────────────────────────────────────────
    PAYMENT_APPLIED: 'Payment Applied',
    PAYMENT_VOIDED:  'Payment Voided',
    // ── AR/AP Refactor M5 ─────────────────────────────────────────────────────
    VOIDED:          'Voided',
    CREDIT_APPLIED:  'Credit Memo Applied',
    // ── AR/AP Refactor M8 — enterprise extras ─────────────────────────────────
    RECURRING_GENERATED: 'Recurring Document Generated',
    DUNNING_ESCALATED:   'Dunning Escalated',
    // ── FR-04.3: Tax return filing ────────────────────────────────────────────
    FILED:               'Filed',
    STATEMENT_GENERATED: 'Statement Generated',
    DISCOUNT_APPLIED:    'Early Payment Discount Applied',
    // ── AR/AP Refactor M9 — event sourcing / projection integrity ─────────────
    EVENT_REPLAYED:      'Event Replayed',
    PROJECTION_REBUILT:  'Projection Rebuilt',
    // ── Phase 6A: Team & RBAC foundation ──────────────────────────────────────
    MEMBER_INVITED:      'Member Invited',
    MEMBER_JOINED:       'Member Joined',
    MEMBER_ROLES_CHANGED: 'Member Roles Changed',
    MEMBER_REMOVED:      'Member Removed',
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
    // ── AR/AP Refactor M2: first-class Payment entity ────────────────────────
    PAYMENT:           'payment',
    // ── AR/AP Refactor M8: recurring invoice schedule ────────────────────────
    INVOICE_SCHEDULE:  'invoiceSchedule',
    // ── AR/AP Refactor M9: durable event log ──────────────────────────────────
    EVENT_LOG:         'eventLog',
    // ── Recurring (#5) + Approval workflow (#6) ───────────────────────────────
    TRANSACTION_TEMPLATE: 'transactionTemplate',
    PENDING_TRANSACTION:  'pendingTransaction',
    // ── Bank reconciliation (#7) ──────────────────────────────────────────────
    BANK_STATEMENT:       'bankStatement',
    // ── FR-04.3: Tax return ───────────────────────────────────────────────────
    TAX_RETURN:           'taxReturn',
    // ── Autonomy Phase 0: proposed action ─────────────────────────────────────
    PROPOSED_ACTION:      'proposedAction',
    // ── Autonomy Phase 2: ingested source document (Bookkeeper agent) ─────────
    SOURCE_DOCUMENT:      'sourceDocument',
    // ── Phase 6A: Team & RBAC foundation ──────────────────────────────────────
    MEMBERSHIP:           'membership',
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
    // AR/AP M3 — promote to real enum members (were referenced by the transition
    // map but missing from the enum). `voided` = GL-correct void (M5).
    REJECTED:          'rejected',
    VOIDED:            'voided',
  },

  /**
   * Allowed forward state transitions for Invoice.
   * Each key is the CURRENT state; the value is an array of states the
   * invoice may legally move to next.  Used by service-layer guards.
   */
  INVOICE_TRANSITIONS: {
    draft:             ['pending_approval', 'approved', 'cancelled', 'rejected', 'voided'],
    pending_approval:  ['approved', 'rejected', 'draft', 'cancelled', 'voided'],
    approved:          ['sent', 'partially_paid', 'paid', 'cancelled', 'disputed', 'overdue', 'voided'],
    sent:              ['partially_paid', 'paid', 'overdue', 'disputed', 'cancelled', 'voided'],
    partially_paid:    ['paid', 'overdue', 'disputed', 'written_off', 'voided'],
    paid:              ['voided'], // terminal except a GL-correct void (M5)
    overdue:           ['partially_paid', 'paid', 'disputed', 'written_off', 'cancelled', 'voided'],
    cancelled:         [], // terminal
    disputed:          ['approved', 'sent', 'partially_paid', 'paid', 'written_off', 'cancelled', 'voided'],
    written_off:       [], // terminal
    rejected:          ['draft', 'cancelled', 'voided'],
    voided:            [], // terminal (GL-correct void — M5)
  },

  // States in which a document still carries an OPEN receivable/payable —
  // recognized in the books and not yet fully settled, credited away, written
  // off or voided. THE one definition: the open-items union (openItem.service),
  // the AR/AP sub-ledger reconciler and the M7 document view all read these
  // lists, so no two surfaces can ever disagree on what "open" means.
  OPEN_INVOICE_STATES: ['approved', 'sent', 'partially_paid', 'overdue', 'disputed'],
  // Bill-side equivalent (bills have no disputed state; scheduled is open).
  OPEN_BILL_STATES: ['approved', 'scheduled', 'partially_paid', 'overdue'],

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
    // AR/AP M3 — real enum members (rejected was referenced but missing).
    REJECTED:            'rejected',
    VOIDED:              'voided',
  },

  BILL_TRANSITIONS: {
    draft:               ['awaiting_approval', 'approved', 'cancelled', 'rejected', 'voided'],
    awaiting_approval:   ['approved', 'rejected', 'draft', 'cancelled', 'voided'],
    approved:            ['scheduled', 'partially_paid', 'paid', 'cancelled', 'overdue', 'voided'],
    scheduled:           ['partially_paid', 'paid', 'overdue', 'cancelled', 'voided'],
    partially_paid:      ['paid', 'overdue', 'cancelled', 'voided'],
    paid:                ['voided'], // terminal except a GL-correct void (M5)
    overdue:             ['partially_paid', 'paid', 'cancelled', 'voided'],
    cancelled:           [], // terminal
    rejected:            ['draft', 'cancelled', 'voided'],
    voided:              [], // terminal (GL-correct void — M5)
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

  // ===============================
  // Phase 6A — Team & RBAC Foundation
  // ===============================
  BUSINESS_ROLES: { OWNER: 'owner', ACCOUNTANT: 'accountant', APPROVER: 'approver', VIEWER: 'viewer' },

  MEMBERSHIP_STATUS: { ACTIVE: 'active', INVITED: 'invited', SUSPENDED: 'suspended' },

  // RBAC permission catalog (action strings).
  PERMISSIONS: {
    MEMBER_MANAGE:       'member:manage',
    SETTINGS_MANAGE:     'settings:manage',
    TRANSACTION_CREATE:  'transaction:create',
    TRANSACTION_APPROVE: 'transaction:approve',
    TRANSACTION_REVERSE: 'transaction:reverse',
    // Higher-risk than a normal approval: forcing a bill past a BLOCKED 3-way
    // match (goods/PO mismatch or suspected duplicate). Gated separately so a
    // plain approver cannot override a match discrepancy — only roles granted
    // match:override (owner by default) may. See bill.routes / bill.service.
    MATCH_OVERRIDE:      'match:override',
    // Post/reverse into a CLOSED or LOCKED accounting period — a hard override of
    // period integrity. Owner-only by default; never granted to accountant/approver.
    PERIOD_OVERRIDE:     'period:override',
    REPORT_VIEW:         'report:view',
    REPORT_MANAGE:       'report:manage',
    AUDIT_MANAGE:        'audit:manage',
    SOD_MANAGE:          'sod:manage',
    COMPLIANCE_MANAGE:   'compliance:manage',
    AI_REVIEW:           'ai:review',   // view the AI Decision Ledger (lineage of AI actions)
  },

  // role -> permission strings. '*' = all permissions.
  ROLE_PERMISSIONS: {
    owner:      ['*'],
    accountant: ['transaction:create', 'transaction:reverse', 'report:view', 'report:manage', 'ai:review'],
    approver:   ['transaction:approve', 'report:view'],
    viewer:     ['report:view'],
  },

  /**
   * Default approval threshold (base currency).
   * Documents above this amount default to requiring approval.
   * Per-business overrides live on Business.approvalConfig (future phase).
   */
  DEFAULT_APPROVAL_THRESHOLD: 50000,

  // ===============================
  // AR/AP Refactor M6 — Multi-level approval ladder
  // ===============================
  APPROVAL_LEVELS: {
    LEVEL_1:    { key: 'level_1',    name: 'Level 1',    rank: 1 },
    LEVEL_2:    { key: 'level_2',    name: 'Level 2',    rank: 2 },
    FINANCE:    { key: 'finance',    name: 'Finance',    rank: 3 },
    CONTROLLER: { key: 'controller', name: 'Controller', rank: 4 },
    CFO:        { key: 'cfo',        name: 'CFO',        rank: 5 },
  },

  // Amount tiers → which approval levels the chain requires (first match by maxAmount).
  // Business overrides can be supplied at runtime; this is the sensible default.
  APPROVAL_TIERS: [
    { maxAmount: 50000,    levels: ['level_1'] },
    { maxAmount: 250000,   levels: ['level_1', 'level_2'] },
    { maxAmount: 1000000,  levels: ['level_1', 'finance', 'controller'] },
    { maxAmount: Infinity, levels: ['level_1', 'finance', 'controller', 'cfo'] },
  ],

  APPROVAL_STEP_STATUS: {
    PENDING:    'pending',
    APPROVED:   'approved',
    REJECTED:   'rejected',
    REASSIGNED: 'reassigned',
    ESCALATED:  'escalated',
    SKIPPED:    'skipped',
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
  // FR-04.3 — Tax Return State Machine
  // Lifecycle: draft → validated → submitted → filed ; any → rejected
  // ===============================
  TAX_RETURN_STATUS: {
    DRAFT:     'draft',
    VALIDATED: 'validated',
    SUBMITTED: 'submitted',
    FILED:     'filed',
    REJECTED:  'rejected',
  },

  TAX_RETURN_TYPES: {
    GST01:     'GST-01',
    WHT165:    'WHT-165',
    IT_RETURN: 'IT-RETURN',
    EOBI:      'EOBI',
    SESSI:     'SESSI',
  },

  RETURN_TRANSITIONS: {
    draft:     ['validated', 'rejected'],
    validated: ['submitted', 'draft', 'rejected'],  // back to draft to re-edit
    submitted: ['filed', 'rejected'],
    filed:     [],            // terminal
    rejected:  ['draft'],     // fix and retry
  },

  // ===============================
  // Autonomy roadmap Phase 0 — Autonomy Engine + Action Framework
  // ===============================
  // How much the system is trusted to act, per capability. Earned gradually.
  AUTONOMY_LEVELS: {
    OBSERVE:   'observe',    // watch + log proposals only; nothing surfaced to act on
    SUGGEST:   'suggest',    // proposals go to the inbox for human approval (default)
    COPILOT:   'copilot',    // auto-execute high-confidence within limits; queue the rest
    AUTOPILOT: 'autopilot',  // auto-execute within limits; only escalate exceptions
  },

  // The agent capabilities the autonomy dial governs.
  AUTONOMY_CAPABILITIES: [
    'bookkeeping', 'reconciliation', 'collections', 'payments', 'tax', 'close', 'advisory',
  ],

  // Lifecycle of a proposed action flowing through the router.
  PROPOSED_ACTION_STATUS: {
    OBSERVED:  'observed',   // logged only (observe level)
    QUEUED:    'queued',     // waiting for human approval in the inbox
    APPROVED:  'approved',   // human approved; awaiting/!executed
    EXECUTED:  'executed',   // carried out (auto or after approval)
    REJECTED:  'rejected',   // human declined
    FAILED:    'failed',     // execution errored
    REVERSED:  'reversed',   // undone after execution
  },

  // The action types agents emit through the router (the `type` on a ProposedAction).
  PROPOSED_ACTION_TYPES: {
    POST_JOURNAL:     'post_journal',     // Bookkeeper — record a document as a journal entry
    CLEAR_BANK_MATCH: 'clear_bank_match', // Reconciler — link a statement line to a ledger entry
    ESCALATE_DUNNING: 'escalate_dunning', // Collector — chase an overdue customer (next dunning step)
    MAKE_PAYMENT:     'make_payment',     // Cash & Payments — pay a bill (cash-aware payment run)
    CLOSE_MONTH:      'close_month',      // Controller/Close — month-end close + CFO narrative
  },

  // Autonomy Phase 2 — Bookkeeper agent. Where an ingested document came from.
  SOURCE_DOCUMENT_SOURCES: {
    MANUAL:    'manual',     // typed / pasted into the ingest box
    EMAIL:     'email',      // forwarded to the business inbox
    UPLOAD:    'upload',     // an uploaded receipt / bill (text already extracted)
    BANK_FEED: 'bank_feed',  // a line from an imported bank statement
  },

  // Lifecycle of an ingested source document.
  SOURCE_DOCUMENT_STATUS: {
    RECEIVED:  'received',   // captured, not yet read
    PROPOSED:  'proposed',   // read → a journal action is waiting / was auto-posted
    POSTED:    'posted',     // the journal entry is in the ledger
    FAILED:    'failed',     // could not be read into a journal entry
    DISMISSED: 'dismissed',  // the owner declined the proposed entry
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
  // Phase 3.2 — 3-Way Match Engine
  // ===============================

  /**
   * Granular match statuses stored on Bill.threeWayMatchStatus.
   *
   *   none           — no PO/GRN linked; match cannot be run
   *   pending        — PO/GRN linked but match not yet executed
   *   matched        — all checks pass within tolerance (safe to pay)
   *   partial_match  — some lines match; others have acceptable warnings
   *   over_billed    — bill amount exceeds GRN received value beyond tolerance
   *   under_received — goods received are less than ordered by more than tolerance
   *   mismatch       — price or quantity variance exceeds warn threshold
   *   blocked        — variance exceeds block threshold; payment prevented
   *
   * 'discrepancy' kept as legacy alias for 'mismatch'.
   */
  THREE_WAY_MATCH_STATUSES: {
    NONE:            'none',
    PENDING:         'pending',
    MATCHED:         'matched',
    PARTIAL_MATCH:   'partial_match',
    OVER_BILLED:     'over_billed',
    UNDER_RECEIVED:  'under_received',
    MISMATCH:        'mismatch',
    BLOCKED:         'blocked',
    DISCREPANCY:     'discrepancy', // legacy alias — treated the same as mismatch
  },

  /**
   * Default tolerance configuration for 3-way match.
   * All values are percentages (0–100).
   * Each tolerance has two thresholds:
   *   warn  — show a warning badge but allow proceeding
   *   block — hard-block approval/payment until resolved
   */
  THREE_WAY_MATCH_TOLERANCE_DEFAULTS: {
    quantity: { warn: 5,  block: 15 },  // received qty vs ordered qty
    price:    { warn: 3,  block: 10 },  // unit price on bill vs on PO
    total:    { warn: 5,  block: 15 },  // bill total vs GRN total received value
    tax:      { warn: 2,  block: 10 },  // tax amount vs expected tax from PO
  },

  /** Window (days) used for duplicate invoice detection. */
  DUPLICATE_INVOICE_WINDOW_DAYS: 90,

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
  // Phase 3.3 — Vendor Portal & AP Automation
  // ===============================

  /** Document types stored in BillDocument */
  DOCUMENT_TYPES: {
    PDF_INVOICE:    'pdf_invoice',
    ATTACHMENT:     'attachment',
    RECEIPT:        'receipt',
    CONTRACT:       'contract',
    PURCHASE_ORDER: 'purchase_order',
    GOODS_RECEIPT:  'goods_receipt',
    OTHER:          'other',
  },

  /** Document processing states (OCR pipeline) */
  DOCUMENT_STATES: {
    PENDING:     'pending',    // just uploaded, awaiting OCR
    PROCESSING:  'processing', // OCR in progress
    AVAILABLE:   'available',  // OCR done / ready
    FAILED:      'failed',     // OCR failed, raw file still accessible
  },

  /** Bill reminder states — driven by dueDate proximity */
  REMINDER_STATES: {
    UPCOMING:         'upcoming',          // due in 1–7 days
    DUE_TODAY:        'due_today',         // due today
    OVERDUE:          'overdue',           // 1–30 days past due
    CRITICAL_OVERDUE: 'critical_overdue',  // >30 days past due
  },

  /** Recurrence patterns for scheduled/recurring bills */
  RECURRENCE_PATTERNS: {
    WEEKLY:    'weekly',
    BIWEEKLY:  'biweekly',
    MONTHLY:   'monthly',
    QUARTERLY: 'quarterly',
    ANNUAL:    'annual',
  },

  // ===============================
  // Approval Workflow (#6)
  // A PendingTransaction is a *request* to post a journal entry. It is NOT a
  // ledger record. Only on approval is the authoritative JournalEntry created
  // (via transactionService.createTransaction). This keeps journal entries
  // immutable and the ledger the single source of truth.
  // Lifecycle: pending → approved (terminal, posted) | rejected | cancelled
  // ===============================
  PENDING_TRANSACTION_STATUS: {
    PENDING:   'pending',
    APPROVED:  'approved',
    REJECTED:  'rejected',
    CANCELLED: 'cancelled',
  },

  PENDING_TRANSACTION_TRANSITIONS: {
    pending:   ['approved', 'rejected', 'cancelled'],
    approved:  [], // terminal — a posted JE can only be reversed, never un-approved
    rejected:  [], // terminal
    cancelled: [], // terminal
  },

  /** Where a pending/recorded transaction originated (for the review queue UI). */
  TRANSACTION_ENTRY_SOURCES: {
    FORM:      'form',
    RECURRING: 'recurring',
    NL:        'nl',
    EXCEL:     'excel',
    AI:        'ai',
    BANK_RECONCILIATION: 'bank_reconciliation',
    BATCH:     'batch',   // #9 — server-side batch posting
  },

  // ===============================
  // Bank Reconciliation (#7)
  // A bank statement line is matched to an existing journal entry that touches
  // the bank account. Reconciliation state lives ONLY on the statement line —
  // the journal entry is never mutated (rule: journal entries are immutable).
  // ===============================
  // Direction of a bank statement line from the BANK's perspective:
  //   'in'  = money received (deposit/credit on statement) → JE debits the bank
  //   'out' = money paid out (withdrawal/debit on statement) → JE credits the bank
  BANK_LINE_DIRECTION: {
    IN:  'in',
    OUT: 'out',
  },

  BANK_LINE_STATUS: {
    UNMATCHED: 'unmatched',  // no ledger entry linked yet
    MATCHED:   'matched',    // linked to an existing journal entry
    CREATED:   'created',    // a new journal entry was posted from this line, then linked
    CLEARED:   'cleared',    // manually marked as reconciled without a ledger link
  },

  BANK_STATEMENT_STATUS: {
    IN_PROGRESS: 'in_progress',
    COMPLETED:   'completed',
  },

  // Auto-match scoring thresholds (0–100). Tuned conservative so we only
  // auto-link when we are confident; everything else is a human suggestion.
  RECONCILIATION_MATCH: {
    AUTO_MIN_SCORE:  85,   // best candidate must reach this to auto-link
    AUTO_MIN_GAP:    15,   // …and beat the runner-up by at least this much
    SUGGEST_MIN_SCORE: 35, // below this we don't even suggest a candidate
  },

  // ===============================
  // AR/AP Refactor M8 — Enterprise extras
  // ===============================

  /**
   * Structured payment terms (data-driven so the terms engine in
   * utils/paymentTerms.js can derive dueDate + early-payment discount windows
   * without hard-coding). `netDays` drives dueDate; `discountPct`/`discountDays`
   * model "X/Y net Z" early-payment-discount terms (e.g. 2/10 net 30).
   */
  PAYMENT_TERMS: {
    DUE_ON_RECEIPT: { code: 'DUE_ON_RECEIPT', label: 'Due on Receipt', netDays: 0,  discountPct: 0, discountDays: 0 },
    NET_7:          { code: 'NET_7',          label: 'Net 7',          netDays: 7,  discountPct: 0, discountDays: 0 },
    NET_15:         { code: 'NET_15',         label: 'Net 15',         netDays: 15, discountPct: 0, discountDays: 0 },
    NET_30:         { code: 'NET_30',         label: 'Net 30',         netDays: 30, discountPct: 0, discountDays: 0 },
    NET_45:         { code: 'NET_45',         label: 'Net 45',         netDays: 45, discountPct: 0, discountDays: 0 },
    NET_60:         { code: 'NET_60',         label: 'Net 60',         netDays: 60, discountPct: 0, discountDays: 0 },
    NET_90:         { code: 'NET_90',         label: 'Net 90',         netDays: 90, discountPct: 0, discountDays: 0 },
    '1_10_NET_30':  { code: '1_10_NET_30',    label: '1/10 Net 30',    netDays: 30, discountPct: 1, discountDays: 10 },
    '2_10_NET_30':  { code: '2_10_NET_30',    label: '2/10 Net 30',    netDays: 30, discountPct: 2, discountDays: 10 },
    '2_10_NET_60':  { code: '2_10_NET_60',    label: '2/10 Net 60',    netDays: 60, discountPct: 2, discountDays: 10 },
  },

  /**
   * Dunning (collections) ladder for overdue receivables. Each level has a
   * `minDaysOverdue` threshold; the daily dunning job advances an invoice to the
   * highest level whose threshold it has crossed (idempotent per level).
   */
  DUNNING_LEVELS: {
    NONE:          { level: 0, key: 'none',          label: 'None',                minDaysOverdue: null },
    REMINDER:      { level: 1, key: 'reminder',      label: 'Friendly Reminder',   minDaysOverdue: 1  },
    FIRST_NOTICE:  { level: 2, key: 'first_notice',  label: 'First Notice',        minDaysOverdue: 15 },
    SECOND_NOTICE: { level: 3, key: 'second_notice', label: 'Second Notice',       minDaysOverdue: 30 },
    FINAL_NOTICE:  { level: 4, key: 'final_notice',  label: 'Final Notice',        minDaysOverdue: 45 },
    COLLECTIONS:   { level: 5, key: 'collections',   label: 'Sent to Collections', minDaysOverdue: 60 },
  },

  /** Vendor risk levels */
  VENDOR_RISK_LEVELS: {
    LOW:      'low',      // score 0–25
    MEDIUM:   'medium',   // score 26–50
    HIGH:     'high',     // score 51–75
    CRITICAL: 'critical', // score 76–100
  },

  /** Risk factor keys */
  VENDOR_RISK_FACTORS: {
    LATE_PAYMENT:      'late_payment',      // bills frequently paid late
    DISPUTE_FREQUENCY: 'dispute_frequency', // many bills disputed
    DUPLICATE_BILLING: 'duplicate_billing', // duplicate invoices detected
    PRICE_ANOMALY:     'price_anomaly',     // unit prices vary abnormally
    OVER_BILLING:      'over_billing',      // 3-way match blocked repeatedly
  },

  /** Cost-centre/dimension types for expense allocation */
  COST_CENTER_TYPES: {
    DEPARTMENT:  'department',
    BRANCH:      'branch',
    PROJECT:     'project',
    COST_CENTER: 'cost_center',
    LOCATION:    'location',
  },

  /** Bill aging brackets (days past due) */
  BILL_AGING_BRACKETS: {
    CURRENT:   'current',   // not yet due
    DAYS_1_30:  '1_30',    // 1–30 days overdue
    DAYS_31_60: '31_60',   // 31–60 days overdue
    DAYS_61_90: '61_90',   // 61–90 days overdue
    DAYS_90_PLUS: '90_plus', // >90 days overdue
  },

  /** AP Kanban workflow stages */
  AP_WORKFLOW_STAGES: {
    INBOX:            'inbox',            // new / draft bills
    UNDER_REVIEW:     'under_review',     // submitted, being checked
    PENDING_APPROVAL: 'pending_approval', // awaiting approver
    APPROVED:         'approved',         // approved, ready to pay
    SCHEDULED:        'scheduled',        // payment date set
    PAID:             'paid',             // fully paid
    BLOCKED:          'blocked',          // match/duplicate issue
  },

  /** Allocation methods for expense splitting */
  ALLOCATION_METHODS: {
    EQUAL:      'equal',      // split equally across all lines
    PERCENTAGE: 'percentage', // each line has explicit %
    AMOUNT:     'amount',     // each line has explicit amount
  },

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