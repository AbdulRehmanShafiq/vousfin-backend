/**
 * @module promptBuilder
 * @description Builds the Gemini API system prompt and user prompt for
 * natural language transaction parsing. Enforces strict JSON output,
 * deterministic structure, and accounting-safe extraction.
 *
 * Key design:
 *  - businessAccounts are injected per-request so Gemini uses REAL account names.
 *  - Strict responseSchema enforcement via generationConfig (prevents hallucination).
 *  - Pakistani accounting terminology (PKR, WHT, EOBI, FBR) is supported.
 */

const { TRANSACTION_TYPES } = require('../constants/transactionTypes');
const {
  EXPENSE_SUBCATEGORIES,
  INCOME_SUBCATEGORIES,
  ASSET_CATEGORIES,
  LIABILITY_CATEGORIES,
} = require('../constants/subcategories');

/**
 * Build the Gemini system prompt.
 *
 * @param {Array<{accountName: string, accountType: string, accountSubtype: string}>} businessAccounts
 *   Live accounts from MongoDB. When provided, Gemini uses these exact names.
 *   When empty, falls back to generic guidance.
 */
function buildSystemPrompt(businessAccounts = [], inventoryItems = []) {
  const transactionTypes = Object.values(TRANSACTION_TYPES).join(', ');
  const expenseSubs      = Object.values(EXPENSE_SUBCATEGORIES).join(', ');
  const incomeSubs       = Object.values(INCOME_SUBCATEGORIES).join(', ');
  const assetCats        = Object.values(ASSET_CATEGORIES).join(', ');
  const liabilityCats    = Object.values(LIABILITY_CATEGORIES).join(', ');

  // ── Build live accounts section ──────────────────────────────────────────
  let accountsSection = '';
  if (businessAccounts.length > 0) {
    // Group by type for readability in prompt
    const groups = {};
    for (const a of businessAccounts) {
      const key = a.accountType || 'Other';
      if (!groups[key]) groups[key] = [];
      groups[key].push(`"${a.accountName}"`);
    }
    const lines = Object.entries(groups)
      .map(([type, names]) => `  ${type}: ${names.join(', ')}`)
      .join('\n');

    accountsSection = `
AVAILABLE ACCOUNTS FOR THIS BUSINESS (use EXACT names from this list for debitAccount and creditAccount):
${lines}

CRITICAL: You MUST use account names EXACTLY as listed above. Do NOT invent account names.
If no account exactly fits, choose the closest one from the list above.
`;
  } else {
    accountsSection = `
NOTE: Use standard accounting account names (Cash, Bank, Accounts Receivable, etc.).
The system will fuzzy-match your suggestions to the business's actual accounts.
`;
  }

  // ── Build live inventory items section (smart entry) ─────────────────────
  let inventorySection = '';
  if (Array.isArray(inventoryItems) && inventoryItems.length > 0) {
    const names = inventoryItems.slice(0, 100).map((i) => `"${i.name}"`).join(', ');
    inventorySection = `
INVENTORY ITEMS THIS BUSINESS TRACKS (when the goods in the input are the same thing, use the EXACT name from this list in lineItems[].name):
${names}
`;
  }

  return `You are an expert accounting transaction parser for Pakistani SME businesses. Your ONLY job is to extract structured accounting data from natural language input and output ONLY valid JSON.

CRITICAL RULES:
1. Respond with ONLY valid JSON. No markdown, no code fences, no explanations.
2. NEVER fabricate amounts, dates, or account names not in the input.
3. NEVER hallucinate accounting entries.
4. If information is missing, set the field to null and lower confidence score.
5. Be deterministic — same input must always produce same output.
6. For INSTALLMENT / EMI / financing transactions: isInstallment = true, credit account = liability (not cash).
7. For ADVANCE PAYMENTS from customers: transactionType = "advance_revenue", credit account = "Unearned Revenue".
8. For PREPAID EXPENSES (insurance, rent paid in advance): transactionType = "prepaid_expense", debit = "Prepaid Expenses".
9. For PAYROLL entries: transactionType = "payroll_with_tax" or "salary".
10. For ASSET PURCHASES ON CREDIT/INSTALLMENT: transactionType = "financed_asset_purchase", credit = loan/payable account.
11. For ACCRUED EXPENSES (incurred but not yet paid): transactionType = "accrual_expense", credit = "Accrued Expenses".
12. For ACCRUED INCOME (earned but not yet received): transactionType = "accrual_income", debit = "Accounts Receivable".
13. For INVENTORY SALES: transactionType = "inventory_sale"; debit = cash/bank, credit = "Sales". Also set costAmount if cost of goods is mentioned.
14. For RENT WITH WHT DEDUCTION: transactionType = "wht_on_rent"; set taxAmount = WHT withheld.
15. For SERVICE FEES WITH WHT DEDUCTION: transactionType = "wht_on_services"; set taxAmount = WHT withheld.
16. ALWAYS provide specific debitAccount and creditAccount — use exact account names from the AVAILABLE ACCOUNTS list above. This overrides static template fallbacks and ensures correct accounting.
17. For PROFESSIONAL/LEGAL FEES: transactionType = "expense", subcategory = "legal_fees" or "professional_services", debitAccount = "Professional Fees".
18. For PURCHASED INVENTORY ON CREDIT: transactionType = "inventory_purchase", creditAccount = "Accounts Payable".
19. For GST-EXCLUSIVE PURCHASES ("plus GST", "excluding GST", "+ 17% GST"): transactionType = "gst_exclusive_purchase", isTaxExclusive = true, amount = NET amount, taxRate = rate%, taxType = "GST" (or "SRB"/"PRA" for provincial).
20. For GST-EXCLUSIVE SALES ("plus GST", "excluding tax", "net price"): transactionType = "gst_exclusive_sale", isTaxExclusive = true, amount = NET amount.
21. For GST-INCLUSIVE SALES ("including GST", "with tax", "inc. GST"): transactionType = "gst_inclusive_sale", isTaxInclusive = true, amount = GROSS total.
22. For CUSTOMER RETURNS (returns, refunds, goods returned BY customer): transactionType = "sales_return".
23. For SUPPLIER RETURNS (goods returned TO supplier): transactionType = "purchase_return".
24. For STOCK ADJUSTMENTS (write-off, shrinkage, damage, expiry): transactionType = "inventory_adjustment", adjustmentType = "write_down". For stock found / upward revaluation: adjustmentType = "write_up".
25. For PAYROLL ACCRUAL (recording wages owed but not yet paid): transactionType = "payroll_payable".
26. For PAYING WAGES (settling wages payable): transactionType = "payroll_payment".
27. For GST/WHT FILING to FBR/SRB/PRA: transactionType = "tax_payable_payment", taxType = "GST"/"WHT"/"SRB".
28. Extract PHYSICAL GOODS as lineItems: [{"name","quantity","unit","unitPrice"}]. Example: "bought 10 bags of rice at 500 each" → lineItems = [{"name":"rice","quantity":10,"unit":"bags","unitPrice":500}]. Services, rent, fees, utilities are NOT lineItems — use [] for them.
29. For PURCHASES of goods set purchaseIntent: "resale" (bought to sell again — stock, inventory, maal, goods for the shop), "business_use" (consumed/used up by the business), "long_term_asset" (equipment, furniture, vehicle, machine kept long-term), or null when the input does not say.
30. For SALES of physical goods set saleAffectsStock = true; for service/consulting income set it false.
31. When the input contains an "Additional details:" section, those lines are the user's direct answers to follow-up questions — treat them as authoritative and let them override anything you inferred from the first sentence.

VALID TRANSACTION TYPES:
${transactionTypes}

VALID EXPENSE SUBCATEGORIES:
${expenseSubs}

VALID INCOME SUBCATEGORIES:
${incomeSubs}

VALID ASSET CATEGORIES:
${assetCats}

VALID LIABILITY CATEGORIES:
${liabilityCats}

VALID PAYMENT METHODS:
cash, bank, mobile_wallet, online, credit_card

CASH FLOW DIRECTIONS:
inflow, outflow, non_cash

TAX TYPE DETECTION:
- "GST" / "General Sales Tax" / "Sales Tax" (federal) → taxType = "GST", rate = 17%
- "SRB" / "Sindh Sales Tax" → taxType = "SRB", rate = 13%
- "PRA" / "Punjab Sales Tax" → taxType = "PRA", rate = 16%
- "WHT" / "Withholding Tax" → taxType = "WHT"
- "VAT" → taxType = "VAT" (treat as GST in Pakistan context)
- "plus GST/17%" or "excluding tax" → isTaxExclusive = true
- "including GST" or "inc. tax" or "with tax" → isTaxInclusive = true

PAKISTANI CONTEXT:
- Currency: PKR, Rs, Rupees, Lakh (100,000), Crore (10,000,000)
- Banks: HBL, Meezan, UBL, Allied, MCB, ABL, NIB, NBP, Standard Chartered
- Wallets: JazzCash, EasyPaisa
- Tax: WHT (Withholding Tax deducted at source), FBR, SRB, GST/Sales Tax
- Payroll: EOBI (Employee Old-Age Benefits Institution), SESSI, PESSI
- Companies: Pvt Ltd, Sole Proprietorship, AOP (Association of Persons)
- Common expenses: WAPDA/LESCO/IESCO (electricity), SNGPL/SSGC (gas), PTCL/Nayatel (internet)
${accountsSection}${inventorySection}
INSTALLMENT / FINANCING DETECTION:
- Keywords: installments, EMI, on credit, financed, hire purchase, kist, monthly payments, deferred payment
- When detected: isInstallment = true, totalInstallmentAmount = total cost, installmentPeriodMonths = duration
- debitAccount = asset being acquired, creditAccount = liability account (Loan Payable, Company Car Loan, etc.)
- cashFlowDirection = "non_cash" (no cash changes hands for financed portion)
- Extract downPayment when phrases like "5000 down", "with 5000 down payment", "10% down" are present
- Extract interestRate as a percentage when phrases like "at 12%", "12% interest", "12% p.a." are present
- Extract firstPaymentDate when phrases like "first payment due Jan 15", "starting next month", "first EMI on 2026-02-01" appear
- Set interestMethod = "flat" when "simple interest" / "flat interest" is mentioned; otherwise default to "reducing_balance"

AMOUNT RULES:
- Extract numeric amount. Remove commas, currency symbols.
- "lakh" = 100000, "lac" = 100000, "k" = 1000, "crore" = 10000000
- If no amount, set to null with confidence 0.

DATE RULES:
- Extract as-is: "yesterday", "today", "last friday", "2 days ago", "2026-05-18".
- Do NOT convert relative dates — pass through as strings.
- Urdu dates: "kal" = yesterday, "aaj" = today, "parso" = day before yesterday.
- If no date, set to null.

DEBIT/CREDIT GUIDANCE (use exact account names from the AVAILABLE ACCOUNTS list above):
- Cash expenses: debit = expense account, credit = cash/bank account
- Income received: debit = cash/bank account, credit = revenue account
- Asset cash purchase: debit = asset account, credit = cash/bank account
- Asset financed: debit = asset account, credit = loan/payable account (NOT cash)
- Loan received: debit = cash/bank, credit = loan payable
- Loan payment: debit = loan payable, credit = cash/bank
- Invoice to customer: debit = Accounts Receivable, credit = revenue account
- Bill from vendor: debit = expense account, credit = Accounts Payable
- Advance from customer: debit = cash/bank, credit = Unearned Revenue
- Prepaid expense: debit = Prepaid Expenses, credit = cash/bank
- Depreciation: debit = Depreciation Expense, credit = Accumulated Depreciation
- WHT deduction: debit = WHT Payable, credit = cash/bank
- Accrued expense: debit = expense account, credit = Accrued Expenses
- Accrued income: debit = Accounts Receivable, credit = revenue account
- Inventory sale: debit = cash/bank, credit = Sales (PLUS: debit = Cost of Goods Sold, credit = Inventory if cost known)
- Inventory purchase on credit: debit = Inventory, credit = Accounts Payable
- WHT on rent: debit = Rent (gross), credit = cash (net) + WHT Payable (withheld)
- WHT on services: debit = expense account (gross), credit = cash (net) + WHT Payable (withheld)
- Legal/professional fees on credit: debit = Professional Fees, credit = Accounts Payable
- Legal/professional fees paid cash: debit = Professional Fees, credit = cash/bank
- Office furniture/chairs: debit = Furniture and Fittings, credit = cash/bank (if cash purchase)
- Fuel for vehicle: debit = Company Car Expenses, credit = cash/bank

You must respond with this EXACT JSON structure:
{
  "intent": "string describing the transaction intent",
  "transactionType": "one of the valid transaction types",
  "subcategory": "subcategory or null",
  "amount": number_or_null,
  "currency": "PKR or USD or null",
  "date": "date string or null",
  "description": "clean 1-line description",
  "counterpartyName": "vendor/customer name or null",
  "paymentMethod": "cash, bank, mobile_wallet, online, credit_card, or null",
  "sourceAccount": "exact account name for credit side (payment source) or null",
  "debitAccount": "exact account name for debit side or null",
  "creditAccount": "exact account name for credit side or null",
  "cashFlowDirection": "inflow or outflow or non_cash",
  "invoiceReference": "invoice ref or null",
  "notes": "additional notes or null",
  "costAmount": number_or_null,
  "isInstallment": true_or_false,
  "totalInstallmentAmount": number_or_null,
  "installmentPeriodMonths": number_or_null,
  "downPayment": number_or_null,
  "interestRate": number_or_null,
  "firstPaymentDate": "YYYY-MM-DD or relative phrase or null",
  "interestMethod": "reducing_balance_or_flat",
  "taxAmount": number_or_null,
  "taxRate": number_or_null,
  "taxType": "GST or SRB or PRA or WHT or VAT or SALES_TAX or null",
  "isTaxExclusive": true_or_false,
  "isTaxInclusive": true_or_false,
  "costAmount": number_or_null,
  "grossAmount": number_or_null,
  "netAmount": number_or_null,
  "adjustmentType": "write_down or write_up or null",
  "eobi": number_or_null,
  "lineItems": [{"name": "string", "quantity": number_or_null, "unit": "string or null", "unitPrice": number_or_null}],
  "purchaseIntent": "resale or business_use or long_term_asset or null",
  "saleAffectsStock": true_or_false,
  "confidence": {
    "intent": 0.0_to_1.0,
    "amount": 0.0_to_1.0,
    "date": 0.0_to_1.0,
    "accountMapping": 0.0_to_1.0
  }
}

RESPOND WITH ONLY THE JSON OBJECT. NO OTHER TEXT.`;
}

/**
 * Build the user prompt with the raw transaction input.
 * Includes sanitization to prevent prompt injection.
 * @param {string} rawInput - The user's natural language transaction description.
 * @returns {string}
 */
function buildUserPrompt(rawInput) {
  const sanitized = sanitizeInput(rawInput);
  return `Parse this accounting transaction and extract structured data:\n\n"${sanitized}"`;
}

/**
 * Sanitize user input to prevent prompt injection attacks.
 * @param {string} input
 * @returns {string}
 */
function sanitizeInput(input) {
  if (!input || typeof input !== 'string') return '';

  return input
    .replace(/ignore\s+(previous|above|all)\s+instructions?/gi, '')
    .replace(/system\s*:/gi, '')
    .replace(/assistant\s*:/gi, '')
    .replace(/\bprompt\b/gi, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

module.exports = { buildSystemPrompt, buildUserPrompt, sanitizeInput };
