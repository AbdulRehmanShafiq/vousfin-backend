/**
 * @module accountTypes
 * @description Account type classifications for the chart of accounts.
 */

const ACCOUNT_TYPES = Object.freeze({
  ASSET: 'asset',
  LIABILITY: 'liability',
  EQUITY: 'equity',
  REVENUE: 'revenue',
  EXPENSE: 'expense',
  CONTRA_ASSET: 'contra_asset',
});

/** Normal balance direction per account type */
const NORMAL_BALANCES = Object.freeze({
  [ACCOUNT_TYPES.ASSET]: 'debit',
  [ACCOUNT_TYPES.LIABILITY]: 'credit',
  [ACCOUNT_TYPES.EQUITY]: 'credit',
  [ACCOUNT_TYPES.REVENUE]: 'credit',
  [ACCOUNT_TYPES.EXPENSE]: 'debit',
  [ACCOUNT_TYPES.CONTRA_ASSET]: 'credit',
});

module.exports = { ACCOUNT_TYPES, NORMAL_BALANCES };
