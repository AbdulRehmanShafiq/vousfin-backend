/**
 * @module journalGeneratorService
 * @description Generates double-entry journal entries from normalized transaction data
 * using the accounting rules engine and account mapping templates.
 */

const {
  JOURNAL_TEMPLATES,
  EXPENSE_ACCOUNT_MAP,
  REVENUE_ACCOUNT_MAP,
  ASSET_ACCOUNT_MAP,
} = require('../utils/accountMappings');
const { resolveAccount } = require('./accountingRulesService');

/**
 * Generate journal entries for a normalized transaction.
 * @param {object} parsedData - Normalized parsed transaction data.
 * @returns {Array<{ account: string, entryType: string, amount: number }>}
 */
function generateJournalEntries(parsedData) {
  const { transactionType, subcategory, amount, sourceAccount } = parsedData;

  if (!transactionType || !amount || amount <= 0) {
    return [];
  }

  const template = JOURNAL_TEMPLATES[transactionType];
  if (!template) {
    return buildFallbackEntries(parsedData);
  }

  const debitAccount = resolveDebitAccount(template, parsedData);
  const creditAccount = resolveCreditAccount(template, parsedData);

  if (!debitAccount || !creditAccount) {
    return buildFallbackEntries(parsedData);
  }

  const entries = [
    { account: debitAccount, entryType: 'debit', amount },
    { account: creditAccount, entryType: 'credit', amount },
  ];

  return entries;
}

/**
 * Resolve the debit account from a template.
 */
function resolveDebitAccount(template, parsedData) {
  const { subcategory, sourceAccount, transactionType } = parsedData;
  let account = template.debit;

  if (account === '__EXPENSE_ACCOUNT__') {
    account = resolveExpenseAccount(subcategory);
  } else if (account === '__ASSET_ACCOUNT__') {
    account = resolveAssetAccount(subcategory);
  } else if (account === '__REVENUE_ACCOUNT__') {
    account = resolveRevenueAccount(subcategory);
  } else if (account === '__SOURCE__') {
    account = sourceAccount || template.defaultDebit || 'Cash';
  } else if (account === '__DESTINATION__') {
    // For transfers, destination comes from context — fallback to template default
    account = template.defaultDebit || 'Cash';
  } else if (account === '__ADJUSTMENT_DEBIT__') {
    account = resolveAdjustmentAccount(parsedData, 'debit');
  }

  return account;
}

/**
 * Resolve the credit account from a template.
 */
function resolveCreditAccount(template, parsedData) {
  const { subcategory, sourceAccount, transactionType } = parsedData;
  let account = template.credit;

  if (account === '__SOURCE__') {
    account = sourceAccount || template.defaultCredit || 'Cash';
  } else if (account === '__EXPENSE_ACCOUNT__') {
    account = resolveExpenseAccount(subcategory);
  } else if (account === '__REVENUE_ACCOUNT__') {
    account = resolveRevenueAccount(subcategory);
  } else if (account === '__ASSET_ACCOUNT__') {
    account = resolveAssetAccount(subcategory);
  } else if (account === '__ADJUSTMENT_CREDIT__') {
    account = resolveAdjustmentAccount(parsedData, 'credit');
  }

  return account;
}

/**
 * Resolve expense account from subcategory.
 */
function resolveExpenseAccount(subcategory) {
  if (!subcategory) return 'Miscellaneous Expense';

  // Handle "utilities:electricity" format
  const sub = subcategory.includes(':')
    ? subcategory.split(':').pop().trim()
    : subcategory;

  return EXPENSE_ACCOUNT_MAP[sub] || 'Miscellaneous Expense';
}

/**
 * Resolve revenue account from subcategory.
 */
function resolveRevenueAccount(subcategory) {
  if (!subcategory) return 'Service Revenue';

  const sub = subcategory.includes(':')
    ? subcategory.split(':').pop().trim()
    : subcategory;

  return REVENUE_ACCOUNT_MAP[sub] || 'Service Revenue';
}

/**
 * Resolve asset account from subcategory.
 */
function resolveAssetAccount(subcategory) {
  if (!subcategory) return 'Equipment';

  const sub = subcategory.includes(':')
    ? subcategory.split(':').pop().trim()
    : subcategory;

  return ASSET_ACCOUNT_MAP[sub] || 'Equipment';
}

/**
 * Resolve adjustment account based on context.
 */
function resolveAdjustmentAccount(parsedData, side) {
  if (side === 'debit') {
    return parsedData.sourceAccount || 'Miscellaneous Expense';
  }
  return parsedData.sourceAccount || 'Cash';
}

/**
 * Build fallback journal entries when template is unavailable.
 */
function buildFallbackEntries(parsedData) {
  const { amount, sourceAccount } = parsedData;

  if (!amount || amount <= 0) return [];

  return [
    { account: 'Miscellaneous Expense', entryType: 'debit', amount },
    { account: sourceAccount || 'Cash', entryType: 'credit', amount },
  ];
}

module.exports = { generateJournalEntries };
