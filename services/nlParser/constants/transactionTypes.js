/**
 * @module transactionTypes
 * @description Supported transaction type constants for the NL Parser module.
 * These map to the high-level accounting transaction classifications
 * used throughout the vousFin system.
 */

const TRANSACTION_TYPES = Object.freeze({
  INCOME: 'income',
  EXPENSE: 'expense',
  ASSET_PURCHASE: 'asset_purchase',
  INVENTORY_PURCHASE: 'inventory_purchase',
  INVENTORY_SALE: 'inventory_sale',
  OWNER_INVESTMENT: 'owner_investment',
  OWNER_WITHDRAWAL: 'owner_withdrawal',
  LOAN_RECEIVED: 'loan_received',
  LOAN_PAYMENT: 'loan_payment',
  LIABILITY_PAYMENT: 'liability_payment',
  TRANSFER: 'transfer',
  REFUND: 'refund',
  SALARY: 'salary',
  TAX: 'tax',
  ACCOUNTS_RECEIVABLE: 'accounts_receivable',
  ACCOUNTS_PAYABLE: 'accounts_payable',
  DEPRECIATION: 'depreciation',
  ADJUSTMENT: 'adjustment',
});

/**
 * Set of all valid transaction type values for quick lookup.
 */
const VALID_TRANSACTION_TYPES = new Set(Object.values(TRANSACTION_TYPES));

/**
 * Cash flow direction mapping for each transaction type.
 * Used to determine if a transaction is an inflow, outflow, or non-cash event.
 */
const CASH_FLOW_MAP = Object.freeze({
  [TRANSACTION_TYPES.INCOME]: 'inflow',
  [TRANSACTION_TYPES.EXPENSE]: 'outflow',
  [TRANSACTION_TYPES.ASSET_PURCHASE]: 'outflow',
  [TRANSACTION_TYPES.INVENTORY_PURCHASE]: 'outflow',
  [TRANSACTION_TYPES.INVENTORY_SALE]: 'inflow',
  [TRANSACTION_TYPES.OWNER_INVESTMENT]: 'inflow',
  [TRANSACTION_TYPES.OWNER_WITHDRAWAL]: 'outflow',
  [TRANSACTION_TYPES.LOAN_RECEIVED]: 'inflow',
  [TRANSACTION_TYPES.LOAN_PAYMENT]: 'outflow',
  [TRANSACTION_TYPES.LIABILITY_PAYMENT]: 'outflow',
  [TRANSACTION_TYPES.TRANSFER]: 'non_cash',
  [TRANSACTION_TYPES.REFUND]: 'inflow',
  [TRANSACTION_TYPES.SALARY]: 'outflow',
  [TRANSACTION_TYPES.TAX]: 'outflow',
  [TRANSACTION_TYPES.ACCOUNTS_RECEIVABLE]: 'non_cash',
  [TRANSACTION_TYPES.ACCOUNTS_PAYABLE]: 'non_cash',
  [TRANSACTION_TYPES.DEPRECIATION]: 'non_cash',
  [TRANSACTION_TYPES.ADJUSTMENT]: 'non_cash',
});

/**
 * Transactions that represent reversals or corrections where normal
 * debit/credit behavior may be intentionally reversed.
 */
const REVERSAL_TYPES = new Set([
  TRANSACTION_TYPES.REFUND,
  TRANSACTION_TYPES.ADJUSTMENT,
]);

module.exports = {
  TRANSACTION_TYPES,
  VALID_TRANSACTION_TYPES,
  CASH_FLOW_MAP,
  REVERSAL_TYPES,
};
