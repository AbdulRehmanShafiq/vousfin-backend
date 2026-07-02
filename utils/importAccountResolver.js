// utils/importAccountResolver.js — deterministic account resolution for bulk
// imports (pure, DB-free).
//
// The enterprise resolution chain for an account cell in an imported file:
//   1. matchAccountByName (exact → substring → word overlap)   [accountMatcher]
//   2. matchByCode        ("3110", "3110 - Capital / Investment")
//   3. matchBySynonym     (curated bookkeeping vernacular → standard code)
//   4. inferAccountShape + nextAccountCode → auto-create        [service layer]
//
// Everything here is deterministic — no LLM, no guessing. The synonym table
// maps how real bookkeepers actually label accounts ("Owner Equity",
// "Debtors", "Creditors") onto the standard chart (3110, 1110, 2110, …), so an
// import never fails just because the wording differs from the seeded names.
'use strict';

/* ── 2. Code matching ──────────────────────────────────────────────────────── */

/** Resolve "3110", "3110 - Capital / Investment", "3110 Capital". */
function matchByCode(accounts, raw) {
  if (!raw || !Array.isArray(accounts)) return null;
  const m = String(raw).trim().match(/^(\d{3,6})\b/);
  if (!m) return null;
  const code = m[1];
  return accounts.find((a) => a.accountCode === code) || null;
}

/* ── 3. Synonym matching ───────────────────────────────────────────────────── */

// normalized synonym → standard accountCode (the seeded chart's codes).
// Keys are normalized: lowercase, letters+digits only, single-spaced.
const SYNONYM_TO_CODE = {
  // Equity — the reported bug: "Owner Equity" had no path to 3110
  'owner equity': '3110', 'owners equity': '3110', 'equity': '3110',
  'owner capital': '3110', 'owners capital': '3110', 'capital': '3110',
  'share capital': '3110', 'paid up capital': '3110', 'paid in capital': '3110',
  'owner investment': '3110', 'capital investment': '3110',
  'drawings': '3120', 'owner drawings': '3120', 'owners drawings': '3120',
  'owner withdrawal': '3120', 'withdrawals': '3120', 'distributions': '3120',
  'retained profit': '3210', 'accumulated profit': '3210',

  // Assets
  'bank': '1010', 'bank account': '1010', 'current account': '1010',
  'cash': '1020', 'cash in hand': '1020',
  'debtors': '1110', 'trade debtors': '1110', 'sundry debtors': '1110',
  'receivables': '1110', 'trade receivables': '1110', 'ar': '1110',
  'stock': '1150', 'stock in hand': '1150', 'merchandise inventory': '1150',
  'prepayments': '1120', 'prepaid': '1120',
  'furniture': '1210', 'fixtures and fittings': '1210',
  'equipment': '1220', 'office equipment': '1220',
  'vehicle': '1230', 'vehicles': '1230', 'motor vehicle': '1230', 'car': '1230',
  'computer': '1240', 'computers': '1240', 'laptops': '1240', 'it equipment': '1240',
  'machinery': '1258', 'plant and machinery': '1258', 'plant': '1258',
  'building': '1257',

  // Liabilities
  'creditors': '2110', 'trade creditors': '2110', 'sundry creditors': '2110',
  'payables': '2110', 'trade payables': '2110', 'ap': '2110',
  'loan': '2230', 'bank loan': '2230', 'loans payable': '2230',
  'overdraft': '2100', 'credit card': '2105',
  'gst': '2120', 'vat': '2198', 'sales tax': '2145', 'sales tax payable': '2145',
  'income tax': '2180', 'wht': '2125', 'withholding tax': '2125',
  'deferred revenue': '2170', 'customer advances': '2190', 'customer advance': '2190',
  'salaries payable': '2140', 'salary payable': '2140',

  // Revenue
  'sales revenue': '4110', 'revenue': '4110', 'income': '4110', 'turnover': '4110',
  'service revenue': '4150', 'service income': '4150', 'consulting income': '4150',
  'consultancy income': '4150', 'fees earned': '4150', 'professional fees earned': '4150',
  'other income': '4120', 'misc income': '4120', 'miscellaneous income': '4120',
  'interest earned': '4130', 'rent income': '4160', 'commission': '4170',
  'commission earned': '4170',

  // Expenses
  'rent expense': '6110', 'office rent': '6110',
  'salaries': '6180', 'salary': '6180', 'salaries expense': '6180',
  'wages': '6180', 'payroll': '6180', 'staff salaries': '6180',
  'utilities': '6150', 'electricity': '6150', 'electricity bill': '6150',
  'utilities expense': '6150', 'power and gas': '6150',
  'bank charges': '6120', 'bank fees': '6120',
  'interest expense': '6240', 'interest paid': '6240',
  'advertising': '6160', 'marketing': '6160', 'marketing expense': '6160',
  'freight out': '6170', 'delivery expense': '6170', 'carriage outwards': '6170',
  'office supplies': '6250', 'stationery': '6250',
  'legal fees': '6260', 'professional fees': '6260', 'accounting fees': '6260',
  'insurance expense': '6270', 'telephone': '6290', 'internet': '6290',
  'phone and internet': '6290', 'software': '6310', 'subscriptions': '6310',
  'fuel': '6130', 'petrol': '6130', 'vehicle expenses': '6130',
  'travel': '6280', 'travelling expense': '6280', 'entertainment': '6280',
  'meals': '6282', 'refreshments': '6282',
  'repairs': '6300', 'maintenance': '6300', 'repairs and maintenance': '6300',
  'depreciation': '6230', 'bad debts': '6370', 'bad debt': '6370',
  'donations': '6380', 'charity': '6380', 'misc expense': '6390',
  'miscellaneous expense': '6390', 'general expenses': '6390',
  'cogs': '5110', 'cost of sales': '5110', 'cost of goods sold': '5110',
  'purchases': '5110',
};

const normalizeName = (s) => String(s || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')   // "Owner's Equity" → "owner s equity"
  .replace(/\b s \b/g, ' ')      // drop orphaned possessive "s"
  .replace(/\s+/g, ' ')
  .trim();

/** Resolve a vernacular account name via the curated synonym table. */
function matchBySynonym(accounts, name) {
  if (!name || !Array.isArray(accounts)) return null;
  const code = SYNONYM_TO_CODE[normalizeName(name)];
  if (!code) return null;
  return accounts.find((a) => a.accountCode === code) || null;
}

/* ── 4a. Deterministic type inference for auto-creation ────────────────────── */

// Ordered: first matching rule wins (most specific class first).
const KEYWORD_RULES = [
  { re: /\b(cogs|cost of goods|cost of sales|direct (material|labou?r|cost))\b/, shape: { accountType: 'Expense', accountSubtype: 'Direct Cost', normalBalance: 'Debit' } },
  { re: /\b(payable|loan|overdraft|accrued|unearned|deferred revenue|mortgage|borrowing)s?\b/, shape: { accountType: 'Liability', accountSubtype: 'Current Liabilities', normalBalance: 'Credit' } },
  { re: /\b(drawings?|withdrawals?|distributions?)\b/, shape: { accountType: 'Equity', accountSubtype: 'Equity', normalBalance: 'Debit' } },
  { re: /\b(equity|capital|retained|reserve)s?\b/, shape: { accountType: 'Equity', accountSubtype: 'Equity', normalBalance: 'Credit' } },
  { re: /\b(revenue|income|sales|earned|turnover)\b/, shape: { accountType: 'Revenue', accountSubtype: 'Revenue', normalBalance: 'Credit' } },
  { re: /\b(receivable|prepaid|deposit|inventory|stock|goodwill|intangible)s?\b/, shape: { accountType: 'Asset', accountSubtype: 'Current Assets', normalBalance: 'Debit' } },
  { re: /\b(cash|bank)\b/, shape: { accountType: 'Asset', accountSubtype: 'Bank and Cash', normalBalance: 'Debit' } },
  { re: /\b(equipment|furniture|vehicle|machinery|building|land|premises|racking|tooling)s?\b/, shape: { accountType: 'Asset', accountSubtype: 'Non-current Assets', normalBalance: 'Debit' } },
  { re: /\b(expense|cost|fee|charge|rent|utilit|salar|wage|insurance|advertis|marketing|repair|fuel|travel|depreciat|subscription|donation)/, shape: { accountType: 'Expense', accountSubtype: 'Expenses', normalBalance: 'Debit' } },
];

// transactionType → what each side of the entry most plausibly is.
const TYPE_SIDE_MATRIX = {
  'Owner Investment':  { credit: { accountType: 'Equity', accountSubtype: 'Equity', normalBalance: 'Credit' }, debit: { accountType: 'Asset', accountSubtype: 'Bank and Cash', normalBalance: 'Debit' } },
  'Owner Withdrawal':  { debit:  { accountType: 'Equity', accountSubtype: 'Equity', normalBalance: 'Debit' },  credit: { accountType: 'Asset', accountSubtype: 'Bank and Cash', normalBalance: 'Debit' } },
  'Loan Disbursement': { credit: { accountType: 'Liability', accountSubtype: 'Non-current Liabilities', normalBalance: 'Credit' }, debit: { accountType: 'Asset', accountSubtype: 'Bank and Cash', normalBalance: 'Debit' } },
  'Loan Repayment':    { debit:  { accountType: 'Liability', accountSubtype: 'Non-current Liabilities', normalBalance: 'Credit' }, credit: { accountType: 'Asset', accountSubtype: 'Bank and Cash', normalBalance: 'Debit' } },
  'Asset Purchase':    { debit:  { accountType: 'Asset', accountSubtype: 'Non-current Assets', normalBalance: 'Debit' }, credit: { accountType: 'Asset', accountSubtype: 'Bank and Cash', normalBalance: 'Debit' } },
  'Income':            { credit: { accountType: 'Revenue', accountSubtype: 'Revenue', normalBalance: 'Credit' }, debit: { accountType: 'Asset', accountSubtype: 'Bank and Cash', normalBalance: 'Debit' } },
  'Cash Sale':         { credit: { accountType: 'Revenue', accountSubtype: 'Revenue', normalBalance: 'Credit' }, debit: { accountType: 'Asset', accountSubtype: 'Bank and Cash', normalBalance: 'Debit' } },
  'Credit Sale':       { credit: { accountType: 'Revenue', accountSubtype: 'Revenue', normalBalance: 'Credit' }, debit: { accountType: 'Asset', accountSubtype: 'Current Assets', normalBalance: 'Debit' } },
  'Expense':           { debit:  { accountType: 'Expense', accountSubtype: 'Expenses', normalBalance: 'Debit' }, credit: { accountType: 'Asset', accountSubtype: 'Bank and Cash', normalBalance: 'Debit' } },
  'Cash Purchase':     { debit:  { accountType: 'Expense', accountSubtype: 'Expenses', normalBalance: 'Debit' }, credit: { accountType: 'Asset', accountSubtype: 'Bank and Cash', normalBalance: 'Debit' } },
  'Credit Purchase':   { debit:  { accountType: 'Expense', accountSubtype: 'Expenses', normalBalance: 'Debit' }, credit: { accountType: 'Liability', accountSubtype: 'Current Liabilities', normalBalance: 'Credit' } },
};

/**
 * Deterministically infer the shape of an account to create. Never guesses via
 * LLM: keywords first, then the transaction-type/side matrix, then the classic
 * debit→Expense / credit→Revenue default.
 * @param {string} name
 * @param {{side?: 'debit'|'credit', transactionType?: string}} ctx
 * @returns {{accountType, accountSubtype, normalBalance}}
 */
function inferAccountShape(name, { side, transactionType } = {}) {
  const norm = normalizeName(name);
  for (const rule of KEYWORD_RULES) {
    if (rule.re.test(norm)) return { ...rule.shape };
  }
  const bySide = TYPE_SIDE_MATRIX[transactionType]?.[side];
  if (bySide) return { ...bySide };
  if (side === 'credit') return { accountType: 'Revenue', accountSubtype: 'Revenue', normalBalance: 'Credit' };
  return { accountType: 'Expense', accountSubtype: 'Expenses', normalBalance: 'Debit' };
}

/* ── 4b. Code allocation ───────────────────────────────────────────────────── */

const CODE_RANGES = {
  Asset:     [1000, 1999],
  Liability: [2000, 2999],
  Equity:    [3000, 3999],
  Revenue:   [4000, 4999],
  Expense:   [6000, 6999],   // operating expenses; Direct Cost overrides to 5xxx
};
const DIRECT_COST_RANGE = [5000, 5999];

/**
 * Next free code in the type's range: max existing + 10 (or range base + 110
 * for an empty range, matching the seeded convention of x110 first codes).
 */
function nextAccountCode(accounts, accountType, accountSubtype = null) {
  const [lo, hi] = accountSubtype === 'Direct Cost' ? DIRECT_COST_RANGE : (CODE_RANGES[accountType] || [9000, 9999]);
  const used = new Set(
    (accounts || [])
      .map((a) => parseInt(a.accountCode, 10))
      .filter((n) => Number.isFinite(n) && n >= lo && n <= hi),
  );
  let candidate = used.size === 0 ? lo + 110 : Math.max(...used) + 10;
  while (used.has(candidate) && candidate <= hi) candidate += 10;
  if (candidate > hi) { // range saturated — fall back to first gap
    candidate = lo;
    while (used.has(candidate) && candidate <= hi) candidate += 1;
  }
  return String(candidate);
}

module.exports = { matchByCode, matchBySynonym, inferAccountShape, nextAccountCode, SYNONYM_TO_CODE };
