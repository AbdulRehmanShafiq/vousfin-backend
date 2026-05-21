/** NL parser uses snake_case types; API/DB use Title Case from config/constants. */
const NL_TYPE_TO_API = {
  income: 'Income',
  expense: 'Expense',
  transfer: 'Transfer',
  asset_purchase: 'Asset Purchase',
  inventory_purchase: 'Credit Purchase',
  inventory_sale: 'Credit Sale',
  owner_investment: 'Owner Investment',
  owner_withdrawal: 'Owner Withdrawal',
  loan_received: 'Loan Disbursement',
  loan_payment: 'Loan Repayment',
  liability_payment: 'Payment Made',
  refund: 'Expense',
  salary: 'Expense',
  tax: 'Expense',
  accounts_receivable: 'Credit Sale',
  accounts_payable: 'Credit Purchase',
  depreciation: 'Expense',
  adjustment: 'Expense',
};

function mapTransactionTypeForApi(nlType) {
  if (!nlType) return 'Expense';
  const key = String(nlType).toLowerCase().trim().replace(/[\s-]+/g, '_');
  return NL_TYPE_TO_API[key] || nlType;
}

/**
 * Maps NL parser pipeline output to the transaction preview shape expected by the frontend.
 */
function mapParserToPreview(parsed, rawText) {
  if (!parsed?.parsedData) {
    return parsed;
  }

  const { parsedData, journalEntries = [], confidence, requiresReview, reviewReasons, success } = parsed;
  const debitEntry = journalEntries.find((e) => e.entryType === 'debit');
  const creditEntry = journalEntries.find((e) => e.entryType === 'credit');

  return {
    success,
    amount: parsedData.amount,
    transactionDate: parsedData.date,
    transactionType: mapTransactionTypeForApi(parsedData.transactionType),
    description: parsedData.description || parsedData.intent || rawText,
    debitAccount: debitEntry?.account,
    creditAccount: creditEntry?.account,
    confidence: confidence?.overall,
    requiresReview,
    reviewReasons,
    rawText,
    parsedData,
    journalEntries,
  };
}

module.exports = { mapParserToPreview, mapTransactionTypeForApi };
