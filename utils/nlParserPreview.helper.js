/**
 * @module nlParserPreview.helper
 * @description Maps NL parser pipeline output to the transaction preview shape
 * expected by the frontend.
 *
 * Phase 2 fixes:
 *  1. NL snake_case types now map to semantically correct API Title Case types
 *     (was: salary → 'Expense', depreciation → 'Expense', refund → 'Expense').
 *  2. Installment metadata is now passed through to the frontend preview instead
 *     of being silently dropped.
 *  3. Gemini-suggested debitAccount / creditAccount are exposed in the preview
 *     so the account resolver can try to find their MongoDB IDs.
 *  4. Confidence and reviewReasons are surfaced to the frontend.
 */

/**
 * Maps NLP snake_case types → API Title Case types stored in MongoDB.
 *
 * Rules:
 *  - Every key is a possible parsedData.transactionType from the NL pipeline.
 *  - Every value must be a valid entry in config/constants.js TRANSACTION_TYPES.
 *  - Mappings must be SEMANTICALLY accurate — no lossy generalizations.
 */
const NL_TYPE_TO_API = {
  // ── Core ──────────────────────────────────────────────────────────────────
  income:                  'Income',
  expense:                 'Expense',
  transfer:                'Transfer',

  // ── Sales & Revenue ───────────────────────────────────────────────────────
  cash_sale:               'Cash Sale',
  credit_sale:             'Credit Sale',
  inventory_sale:          'Inventory Sale',
  gst_inclusive_sale:      'GST Collection',    // was 'Income' — loses tax classification
  accounts_receivable:     'Credit Sale',

  // ── Purchases & Cost ──────────────────────────────────────────────────────
  cash_purchase:           'Cash Purchase',
  credit_purchase:         'Credit Purchase',
  inventory_purchase:      'Inventory Purchase', // was 'Credit Purchase' — loses inventory flag
  accounts_payable:        'Credit Purchase',

  // ── Payments ──────────────────────────────────────────────────────────────
  payment_received:        'Payment Received',
  liability_payment:       'Payment Made',
  payment_made:            'Payment Made',

  // ── Payroll & Tax ─────────────────────────────────────────────────────────
  salary:                  'Salary',            // was 'Expense' — loses payroll classification
  payroll_with_tax:        'Salary',            // was 'Expense' — same reason
  wht_payment:             'WHT Payment',       // was 'Expense'
  tax:                     'WHT Payment',       // generic tax → WHT (most common in SME context)
  gst_payment:             'GST Payment',
  gst_collection:          'GST Collection',

  // ── Financing & Capital ───────────────────────────────────────────────────
  loan_received:           'Loan Disbursement',
  loan_payment:            'Loan Repayment',
  owner_investment:        'Owner Investment',
  owner_withdrawal:        'Owner Withdrawal',

  // ── Assets & Depreciation ─────────────────────────────────────────────────
  asset_purchase:          'Asset Purchase',
  financed_asset_purchase: 'Asset Purchase',    // mode=installment handled in entryData
  depreciation:            'Depreciation',      // was 'Transfer' — loses non-cash classification
  amortization:            'Depreciation',      // intangible assets share the same journal

  // ── Working-Capital Items ─────────────────────────────────────────────────
  prepaid_expense:         'Prepaid Expense',   // was 'Expense' — incorrect (it's an asset first)
  advance_revenue:         'Advance from Customer', // was 'Income' — it's a liability until earned

  // ── Financing Cost ────────────────────────────────────────────────────────
  interest_payment:        'Interest Payment',

  // ── Phase 3 — Accounting Intelligence Types ──────────────────────────────
  accrual_expense:         'Journal Entry',     // accrual — DR Expense / CR Accrued Expenses
  accrual_income:          'Journal Entry',     // accrual — DR AR / CR Revenue
  cogs_recognition:        'Journal Entry',     // COGS — DR COGS / CR Inventory
  wht_on_rent:             'WHT Payment',       // rent with WHT deducted at source
  wht_on_services:         'WHT Payment',       // service fee with WHT deducted at source
  // ── Phase 3 Step 4 — Tax + Liability + Inventory ─────────────────────────
  gst_exclusive_purchase:  'Credit Purchase',   // purchase + input tax (amount is net)
  gst_exclusive_sale:      'Cash Sale',         // sale + output tax (amount is net)
  sales_return:            'Refund',            // customer returns goods
  purchase_return:         'Refund',            // business returns goods to supplier
  inventory_adjustment:    'Journal Entry',     // stock write-off / write-up
  payroll_payable:         'Journal Entry',     // accrue payroll liability
  payroll_payment:         'Payment Made',      // pay wages payable
  tax_payable_payment:     'WHT Payment',       // pay GST/WHT/SRB to FBR

  // ── Catch-alls ────────────────────────────────────────────────────────────
  refund:                  'Refund',            // was 'Income' — semantically a separate type
  bank_transfer:           'Bank Transfer',     // inter-account movement
  adjustment:              'Journal Entry',     // was 'Transfer' — clearer accounting label
  journal_entry:           'Journal Entry',
  installment_payment:     'Installment Payment',
};

function mapTransactionTypeForApi(nlType) {
  if (!nlType) return 'Expense';
  const key = String(nlType).toLowerCase().trim().replace(/[\s-]+/g, '_');
  return NL_TYPE_TO_API[key] || nlType;
}

/**
 * Maps NL parser pipeline output to the transaction preview shape expected by the frontend.
 *
 * @param {object} parsed   - Full pipeline result from parserService.parseTransaction()
 * @param {string} rawText  - Original user input (for fallback description)
 * @returns {object}        - Preview shape for frontend consumption
 */
function mapParserToPreview(parsed, rawText) {
  if (!parsed?.parsedData) {
    return parsed;
  }

  const {
    parsedData,
    journalEntries = [],
    confidence,
    requiresReview,
    reviewReasons,
    clarification = null,
    needsClarification = false,
    success,
  } = parsed;

  const debitEntry  = journalEntries.find((e) => e.entryType === 'debit');
  const creditEntry = journalEntries.find((e) => e.entryType === 'credit');

  // Prefer Gemini's explicit account suggestions; fall back to journal generator results
  const debitAccountName  = parsedData.debitAccount  || debitEntry?.account  || null;
  const creditAccountName = parsedData.creditAccount || creditEntry?.account || null;

  return {
    // Core fields (backward compatible)
    success,
    amount:          parsedData.amount,
    transactionDate: parsedData.date,
    transactionType: mapTransactionTypeForApi(parsedData.transactionType),
    description:     parsedData.description || parsedData.intent || rawText,
    counterpartyName:parsedData.counterpartyName || null,

    // Account suggestions (names only — IDs resolved by controller fuzzy matching)
    debitAccount:    debitAccountName,
    creditAccount:   creditAccountName,

    // AI confidence metadata — exposed to frontend so UX can show review warnings
    confidence:      confidence?.overall ?? null,
    requiresReview,
    reviewReasons,
    // Optional single follow-up question when a critical field is unclear.
    clarification,
    needsClarification,

    // Phase 2: Installment / financing metadata — must NOT be dropped
    isInstallment:           parsedData.isInstallment             || false,
    totalInstallmentAmount:  parsedData.totalInstallmentAmount     || null,
    installmentPeriodMonths: parsedData.installmentPeriodMonths    || null,
    // Phase 3: expose down payment + frequency so frontend can pre-fill the panel
    downPayment:             parsedData.downPayment                || 0,
    installmentFrequency:    parsedData.installmentFrequency       || 'monthly',
    // Phase 3: interest rate (% p.a.) — Gemini may extract from phrases like "at 12% interest"
    interestRate:            parsedData.interestRate               || 0,
    // First payment date — Gemini may extract from phrases like "starting next month" or specific dates
    firstPaymentDate:        parsedData.firstPaymentDate           || null,
    // Interest method (reducing_balance default; flat for simple loans)
    interestMethod:          parsedData.interestMethod             || 'reducing_balance',

    // Tax metadata — preserved from normalization for multi-line journal generation
    taxAmount:               parsedData.taxAmount                  || null,
    taxRate:                 parsedData.taxRate                    || null,
    // Currency metadata — preserved for multi-currency support
    currency:                parsedData.currency                   || null,
    // Vendor / customer (counterparty hint) — preserved so frontend can pre-fill
    vendorName:              parsedData.counterpartyName           || null,
    customerName:            parsedData.counterpartyName           || null,
    // Payment method (cash / bank / credit_card / etc.) — preserved for form pre-fill
    paymentMethod:           parsedData.paymentMethod              || null,
    // Notes — preserved so user sees the AI's interpretation
    notes:                   parsedData.notes                      || null,
    // Invoice reference if detected (e.g., "INV-123" in the input)
    invoiceNumber:           parsedData.invoiceReference           || null,

    // Raw data passthrough (for debugging and manual correction flow)
    rawText,
    parsedData,
    journalEntries,
  };
}

module.exports = { mapParserToPreview, mapTransactionTypeForApi };
