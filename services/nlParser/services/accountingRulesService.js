/**
 * @module accountingRulesService
 * @description Enforces accounting rules including debit/credit mapping,
 * normal balance validation, and account type verification.
 * This layer ensures AI output never bypasses accounting integrity.
 */

const { ACCOUNT_ALIAS_MAP } = require('../constants/chartOfAccounts');
const { NORMAL_BALANCES } = require('../constants/accountTypes');
const { REVERSAL_TYPES } = require('../constants/transactionTypes');

/**
 * Resolve an account name/alias to a valid chart-of-accounts entry.
 * @param {string} accountRef - Account name or alias from AI or mapping.
 * @returns {{ account: object|null, resolved: boolean }}
 */
function resolveAccount(accountRef) {
  if (!accountRef) return { account: null, resolved: false };

  const key = accountRef.toString().toLowerCase().trim();
  const account = ACCOUNT_ALIAS_MAP.get(key);

  if (account) {
    return { account, resolved: true };
  }

  return { account: null, resolved: false };
}

/**
 * Validate that a journal entry respects normal balance rules.
 * Assets and Expenses normally increase via debit.
 * Liabilities, Equity, and Revenue normally increase via credit.
 *
 * @param {string} accountName - The account being debited/credited.
 * @param {string} entryType - 'debit' or 'credit'.
 * @param {string} transactionType - The classified transaction type.
 * @returns {{ valid: boolean, warning: string|null }}
 */
function validateNormalBalance(accountName, entryType, transactionType) {
  const { account } = resolveAccount(accountName);
  if (!account) {
    return { valid: true, warning: 'Account not found in chart of accounts' };
  }

  const expectedNormal = NORMAL_BALANCES[account.type];
  if (!expectedNormal) {
    return { valid: true, warning: null };
  }

  // For reversal-type transactions, opposite entries are expected
  if (REVERSAL_TYPES.has(transactionType)) {
    return { valid: true, warning: null };
  }

  // Check if this entry increases the account (matches normal balance)
  // or decreases it (opposite of normal balance).
  // Both are valid in proper accounting — we only flag truly anomalous patterns.
  // For example, crediting an expense account outside of a refund/adjustment.
  const isIncreasing = entryType === expectedNormal;
  const isDecreasing = entryType !== expectedNormal;

  // Flag unusual: decreasing an expense (credit) or decreasing revenue (debit)
  // when transaction is not a reversal
  if (isDecreasing) {
    if (account.type === 'expense' && entryType === 'credit') {
      return {
        valid: true,
        warning: `Crediting expense account "${accountName}" — verify this is intentional`,
      };
    }
    if (account.type === 'revenue' && entryType === 'debit') {
      return {
        valid: true,
        warning: `Debiting revenue account "${accountName}" — verify this is intentional`,
      };
    }
  }

  return { valid: true, warning: null };
}

/**
 * Validate that all accounts in journal entries are accounting-valid.
 * @param {Array<{ account: string, entryType: string, amount: number }>} entries
 * @param {string} transactionType
 * @returns {{ valid: boolean, warnings: string[], unresolvedAccounts: string[] }}
 */
function validateJournalAccounts(entries, transactionType) {
  const warnings = [];
  const unresolvedAccounts = [];

  for (const entry of entries) {
    const { account, resolved } = resolveAccount(entry.account);

    if (!resolved) {
      unresolvedAccounts.push(entry.account);
      warnings.push(`Account "${entry.account}" not found in chart of accounts`);
    }

    const balanceCheck = validateNormalBalance(entry.account, entry.entryType, transactionType);
    if (balanceCheck.warning) {
      warnings.push(balanceCheck.warning);
    }
  }

  return {
    valid: unresolvedAccounts.length === 0,
    warnings,
    unresolvedAccounts,
  };
}

module.exports = {
  resolveAccount,
  validateNormalBalance,
  validateJournalAccounts,
};
