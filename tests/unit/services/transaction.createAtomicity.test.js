/**
 * tests/unit/services/transaction.createAtomicity.test.js
 *
 * Audit 2026-07-02 F6 — createTransaction's side-effects must live INSIDE the
 * same atomic unit as the journal-entry insert.
 *
 * Previously the AR/AP party-balance adjustment (steps 6/7) and the inventory
 * stock mutations (steps 7/7a) executed BEFORE — and outside — the
 * withTransaction that persists the entry. A failed persist (validation,
 * period lock, unbalanced lines, infra error) left the customer/vendor balance
 * and the physical stock moved with NO journal entry: sub-ledgers diverged
 * from a ledger that never changed.
 */
'use strict';

const SESSION = 'TXN-SESSION';

jest.mock('../../../utils/withTransaction', () => ({
  withTransaction: jest.fn((fn) => fn('TXN-SESSION')),
}));
jest.mock('../../../repositories/transaction.repository');
jest.mock('../../../repositories/account.repository');
jest.mock('../../../repositories/customer.repository');
jest.mock('../../../repositories/vendor.repository');
jest.mock('../../../repositories/inventoryItem.repository', () => ({
  model: { findOne: jest.fn() },
}));
jest.mock('../../../models/ChartOfAccount.model', () => ({
  findOne: jest.fn(),
}));
jest.mock('../../../services/audit.service');
jest.mock('../../../services/inventory.service');
jest.mock('../../../services/invoice.service', () => ({ syncFromJournalEntry: jest.fn() }));
jest.mock('../../../services/bill.service', () => ({ syncFromJournalEntry: jest.fn() }));
jest.mock('../../../services/partyBalance.service', () => ({
  adjustReceivable: jest.fn().mockResolvedValue({}),
  adjustPayable: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../../services/taxEngine.service', () => ({
  isTaxEnabled: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../../models/AccountingPeriod.model', () => ({
  findCoveringPeriod: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../models/InvoiceCounter.model', () => ({
  findOneAndUpdate: jest.fn().mockResolvedValue({ seq: 1 }),
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const transactionService = require('../../../services/transaction.service');
const transactionRepository = require('../../../repositories/transaction.repository');
const accountRepository = require('../../../repositories/account.repository');
const customerRepository = require('../../../repositories/customer.repository');
const inventoryItemRepository = require('../../../repositories/inventoryItem.repository');
const ChartOfAccount = require('../../../models/ChartOfAccount.model');
const inventoryService = require('../../../services/inventory.service');
const partyBalanceService = require('../../../services/partyBalance.service');
const auditService = require('../../../services/audit.service');
const { TRANSACTION_TYPES } = require('../../../config/constants');

const makeAccount = (id, normalBalance = 'Debit', name = 'Test Account') => ({
  _id: id, normalBalance, accountName: name, accountType: 'Asset', runningBalance: 0,
});

const CREATED_TX = {
  _id: 'tx1', businessId: 'biz1', transactionType: TRANSACTION_TYPES.CREDIT_SALE,
  amount: 1000, toObject: function () { return { ...this }; },
};

beforeEach(() => {
  jest.clearAllMocks();
  auditService.logCreate = jest.fn().mockResolvedValue(undefined);
  accountRepository.findOneByBusinessAndId.mockImplementation((_b, id) =>
    Promise.resolve(makeAccount(id, id === 'accAR' ? 'Debit' : 'Credit',
      id === 'accAR' ? 'Accounts Receivable' : 'Sales Revenue'))
  );
  accountRepository.findById.mockImplementation((id) => Promise.resolve(makeAccount(id)));
  accountRepository.updateRunningBalance.mockResolvedValue(undefined);
  customerRepository.findByBusinessAndId.mockResolvedValue({ _id: 'cust1' });
  transactionRepository.createTransaction.mockResolvedValue(CREATED_TX);
  inventoryService.reduceStock.mockResolvedValue({});
  inventoryService.applyPurchaseStock.mockResolvedValue({});
});

const CREDIT_SALE = {
  businessId: 'biz1',
  transactionDate: new Date().toISOString(),
  description: 'Credit sale',
  transactionType: TRANSACTION_TYPES.CREDIT_SALE,
  amount: 1000,
  debitAccountId: 'accAR',
  creditAccountId: 'accREV',
  customerId: 'cust1',
  inputMethod: 'form',
};

describe('F6 — createTransaction side-effect atomicity', () => {
  test('party balance is NOT adjusted when the journal insert fails', async () => {
    transactionRepository.createTransaction.mockRejectedValue(new Error('insert failed'));

    await expect(
      transactionService.createTransaction({ ...CREDIT_SALE }, 'u1', '127.0.0.1')
    ).rejects.toThrow('insert failed');

    expect(partyBalanceService.adjustReceivable).not.toHaveBeenCalled();
  });

  test('party balance adjustment joins the persist transaction session', async () => {
    await transactionService.createTransaction({ ...CREDIT_SALE }, 'u1', '127.0.0.1');

    expect(partyBalanceService.adjustReceivable).toHaveBeenCalledTimes(1);
    const ctx = partyBalanceService.adjustReceivable.mock.calls[0][3];
    expect(ctx.session).toBe(SESSION);
  });

  test('inventory reduceStock is NOT executed when the journal insert fails', async () => {
    inventoryItemRepository.model.findOne.mockResolvedValue({
      _id: 'item1', currentStock: 10, unitCostPrice: 5, name: 'Widget', unit: 'pcs',
    });
    ChartOfAccount.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: 'auxAcc' }) });
    transactionRepository.createTransaction.mockRejectedValue(new Error('insert failed'));

    await expect(
      transactionService.createTransaction(
        {
          ...CREDIT_SALE,
          transactionType: TRANSACTION_TYPES.CASH_SALE,
          debitAccountId: 'accCASH',
          creditAccountId: 'accREV',
          inventoryItemId: 'item1',
          inventoryQty: 2,
        },
        'u1', '127.0.0.1'
      )
    ).rejects.toThrow('insert failed');

    expect(inventoryService.reduceStock).not.toHaveBeenCalled();
  });

  test('inventory reduceStock runs inside the persist transaction (session threaded)', async () => {
    inventoryItemRepository.model.findOne.mockResolvedValue({
      _id: 'item1', currentStock: 10, unitCostPrice: 5, name: 'Widget', unit: 'pcs',
    });
    ChartOfAccount.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: 'auxAcc' }) });

    await transactionService.createTransaction(
      {
        ...CREDIT_SALE,
        transactionType: TRANSACTION_TYPES.CASH_SALE,
        debitAccountId: 'accCASH',
        creditAccountId: 'accREV',
        inventoryItemId: 'item1',
        inventoryQty: 2,
      },
      'u1', '127.0.0.1'
    );

    expect(inventoryService.reduceStock).toHaveBeenCalledWith('biz1', 'item1', 2, SESSION);
  });

  test('purchase stock increment joins the persist transaction and skips on insert failure', async () => {
    transactionRepository.createTransaction.mockRejectedValue(new Error('insert failed'));

    await expect(
      transactionService.createTransaction(
        {
          ...CREDIT_SALE,
          transactionType: TRANSACTION_TYPES.CASH_PURCHASE,
          debitAccountId: 'accINV',
          creditAccountId: 'accCASH',
          customerId: null,
          inventoryItemId: 'item1',
          inventoryQty: 4,
          unitCostPrice: 25,
        },
        'u1', '127.0.0.1'
      )
    ).rejects.toThrow('insert failed');

    expect(inventoryService.applyPurchaseStock).not.toHaveBeenCalled();
  });

  test('purchase stock increment receives the session when the insert succeeds', async () => {
    await transactionService.createTransaction(
      {
        ...CREDIT_SALE,
        transactionType: TRANSACTION_TYPES.CASH_PURCHASE,
        debitAccountId: 'accINV',
        creditAccountId: 'accCASH',
        customerId: null,
        inventoryItemId: 'item1',
        inventoryQty: 4,
        unitCostPrice: 25,
      },
      'u1', '127.0.0.1'
    );

    expect(inventoryService.applyPurchaseStock).toHaveBeenCalledWith(
      'biz1', 'item1', 4, 25, expect.objectContaining({ session: SESSION })
    );
  });
});
