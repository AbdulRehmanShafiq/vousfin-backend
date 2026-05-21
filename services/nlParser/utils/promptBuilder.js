/**
 * @module promptBuilder
 * @description Builds the GROK API system prompt and user prompt for
 * natural language transaction parsing. Enforces strict JSON output,
 * deterministic structure, and accounting-safe extraction.
 */

const { TRANSACTION_TYPES } = require('../constants/transactionTypes');
const { EXPENSE_SUBCATEGORIES, INCOME_SUBCATEGORIES, ASSET_CATEGORIES } = require('../constants/subcategories');

/**
 * Build the system prompt for GROK.
 * Forces strict JSON, prevents hallucination, enforces accounting rules.
 */
function buildSystemPrompt() {
  const transactionTypes = Object.values(TRANSACTION_TYPES).join(', ');
  const expenseSubs = Object.values(EXPENSE_SUBCATEGORIES).join(', ');
  const incomeSubs = Object.values(INCOME_SUBCATEGORIES).join(', ');
  const assetCats = Object.values(ASSET_CATEGORIES).join(', ');

  return `You are an accounting transaction parser AI. Your ONLY job is to extract structured accounting data from natural language input.

CRITICAL RULES:
1. You MUST respond with ONLY valid JSON. No markdown, no code fences, no explanations, no conversational text.
2. NEVER fabricate amounts, dates, or account names that are not in the input.
3. NEVER hallucinate accounting entries.
4. If information is missing or ambiguous, set the field to null and lower the confidence score.
5. You must be deterministic — the same input must always produce the same output.

VALID TRANSACTION TYPES:
${transactionTypes}

VALID EXPENSE SUBCATEGORIES:
${expenseSubs}

VALID INCOME SUBCATEGORIES:
${incomeSubs}

VALID ASSET CATEGORIES:
${assetCats}

VALID PAYMENT SOURCES:
Cash, HBL Bank, Meezan Bank, UBL, Allied Bank, JazzCash, EasyPaisa, PayPal, Stripe, Credit Card

VALID PAYMENT METHODS:
cash, bank, mobile_wallet, online, credit_card

CASH FLOW DIRECTIONS:
inflow, outflow, non_cash

You must respond with this EXACT JSON structure:
{
  "intent": "string describing the transaction intent",
  "transactionType": "one of the valid transaction types",
  "subcategory": "subcategory or null",
  "amount": number_or_null,
  "currency": "currency code string or null",
  "date": "date string or null",
  "description": "clean description of the transaction",
  "counterpartyName": "name or null",
  "paymentMethod": "payment method or null",
  "sourceAccount": "source/payment account or null",
  "cashFlowDirection": "inflow or outflow or non_cash",
  "invoiceReference": "invoice ref or null",
  "notes": "any additional notes or null",
  "isInstallment": true_or_false_or_null,
  "totalInstallmentAmount": number_or_null,
  "installmentPeriodMonths": number_or_null,
  "confidence": {
    "intent": 0.0_to_1.0,
    "amount": 0.0_to_1.0,
    "date": 0.0_to_1.0,
    "accountMapping": 0.0_to_1.0
  }
}

AMOUNT RULES:
- Extract numeric amount. Remove commas, currency symbols.
- "lakh" = 100000, "lac" = 100000, "k" = 1000, "crore" = 10000000
- If amount is not mentioned, set to null and amount confidence to 0.

INSTALLMENT RULES:
- If the description indicates buying or paying on installments/installment plans, set isInstallment to true.
- Extract the total cost of the purchase as totalInstallmentAmount (e.g. if down payment is 30,000 and 270,000 remains, the total installment amount is 300,000. If the total is directly mentioned, extract it).
- Extract installmentPeriodMonths as the number of months of the plan (e.g. 12 months).

DATE RULES:
- Extract date as-is from the input (e.g., "yesterday", "today", "last friday", "2 days ago", "2026-05-18").
- Do NOT convert relative dates. Pass them through as strings.
- If no date mentioned, set to null.

CURRENCY RULES:
- Detect currency from context: Rs, PKR, rupees = "PKR"; $, USD, dollars = "USD"
- If no currency mentioned, set to null.

ACCOUNTING RULES:
- Classify the transaction type accurately based on the context.
- Identify source/payment account from context (bank names, cash, wallets).
- For expenses: identify the expense subcategory.
- For income: identify the income subcategory.
- For asset purchases: identify the asset category.

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
    // Remove potential prompt injection patterns
    .replace(/ignore\s+(previous|above|all)\s+instructions?/gi, '')
    .replace(/system\s*:/gi, '')
    .replace(/assistant\s*:/gi, '')
    .replace(/\bprompt\b/gi, '')
    // Remove control characters
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Trim excessive whitespace
    .replace(/\s+/g, ' ')
    .trim()
    // Limit length
    .slice(0, 1000);
}

module.exports = { buildSystemPrompt, buildUserPrompt, sanitizeInput };
