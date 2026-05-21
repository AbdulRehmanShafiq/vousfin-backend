/**
 * @module validationService
 * @description Final validation layer for generated journal entries.
 * Ensures accounting integrity: balanced debits/credits, valid amounts,
 * required fields present, and proper account mappings.
 */

const { validateJournalAccounts } = require('./accountingRulesService');

/**
 * Validate the complete parsed result before returning to the client.
 * @param {object} parsedData - Normalized transaction data.
 * @param {Array<{ account: string, entryType: string, amount: number }>} journalEntries
 * @returns {object} Validation result with balance info and any issues.
 */
function validateResult(parsedData, journalEntries) {
  const errors = [];
  const warnings = [];

  // 1. Validate journal entries exist
  if (!journalEntries || journalEntries.length === 0) {
    errors.push('No journal entries generated');
  }

  // 2. Validate minimum entries (at least one debit and one credit)
  if (journalEntries && journalEntries.length > 0) {
    const hasDebit = journalEntries.some((e) => e.entryType === 'debit');
    const hasCredit = journalEntries.some((e) => e.entryType === 'credit');

    if (!hasDebit) errors.push('Missing debit entry');
    if (!hasCredit) errors.push('Missing credit entry');
  }

  // 3. Calculate and validate balance
  const { totalDebits, totalCredits, isBalanced } = calculateBalance(journalEntries);

  if (!isBalanced) {
    errors.push(`Debits (${totalDebits}) do not equal Credits (${totalCredits})`);
  }

  // 4. Validate amount
  if (!parsedData.amount || parsedData.amount <= 0) {
    errors.push('Amount must be greater than 0');
  }

  // 5. Validate date exists
  if (!parsedData.date) {
    warnings.push('Date is missing — will need manual entry');
  }

  // 6. Validate transaction type exists
  if (!parsedData.transactionType) {
    errors.push('Transaction type is missing');
  }

  // 7. Validate individual entry amounts
  if (journalEntries) {
    for (const entry of journalEntries) {
      if (!entry.amount || entry.amount <= 0) {
        errors.push(`Invalid amount in ${entry.entryType} entry for "${entry.account}"`);
      }
      if (!entry.account) {
        errors.push(`Missing account name in ${entry.entryType} entry`);
      }
      if (!['debit', 'credit'].includes(entry.entryType)) {
        errors.push(`Invalid entry type "${entry.entryType}" — must be "debit" or "credit"`);
      }
    }
  }

  // 8. Validate accounts against chart of accounts
  const accountValidation = journalEntries
    ? validateJournalAccounts(journalEntries, parsedData.transactionType)
    : { valid: false, warnings: [], unresolvedAccounts: [] };

  if (accountValidation.unresolvedAccounts.length > 0) {
    warnings.push(
      `Unresolved accounts: ${accountValidation.unresolvedAccounts.join(', ')}`
    );
  }
  warnings.push(...accountValidation.warnings);

  return {
    validation: {
      isBalanced,
      totalDebits,
      totalCredits,
    },
    errors,
    warnings,
    isValid: errors.length === 0,
  };
}

/**
 * Calculate debit and credit totals and check balance.
 * @param {Array<{ entryType: string, amount: number }>} entries
 * @returns {{ totalDebits: number, totalCredits: number, isBalanced: boolean }}
 */
function calculateBalance(entries) {
  if (!entries || entries.length === 0) {
    return { totalDebits: 0, totalCredits: 0, isBalanced: false };
  }

  let totalDebits = 0;
  let totalCredits = 0;

  for (const entry of entries) {
    if (entry.entryType === 'debit') {
      totalDebits += entry.amount || 0;
    } else if (entry.entryType === 'credit') {
      totalCredits += entry.amount || 0;
    }
  }

  // Round to 2 decimal places to avoid floating point issues
  totalDebits = Math.round(totalDebits * 100) / 100;
  totalCredits = Math.round(totalCredits * 100) / 100;

  return {
    totalDebits,
    totalCredits,
    isBalanced: totalDebits === totalCredits && totalDebits > 0,
  };
}

module.exports = { validateResult, calculateBalance };
