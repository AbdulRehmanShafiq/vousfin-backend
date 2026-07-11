/**
 * tests/unit/services/transaction.newInventoryItem.test.js
 *
 * Smart entry — a consented NEW inventory item is created (or linked, when a
 * same-name item already exists) INSIDE the persist session, stock is applied,
 * and the journal entry is stamped with the linkage — all-or-nothing with the
 * ledger insert. Mock scaffolding mirrors transaction.createAtomicity.test.js.
 */
'use strict';

jest.mock('../../../utils/withTransaction', () => ({
  withTransaction: jest.fn((fn) => fn('TXN-SESSION')),
}));
jest.mock('../../../repositories/transaction.repository');
jest.mock('../../../repositories/account.repository');
jest.mock('../../../repositories/customer.repository');
jest.mock('../../../repositories/vendor.repository');
jest.mock('../../../repositories/inventoryItem.repository', () => ({
  model: { findOne: jest.fn(), create: jest.fn() },
}));
jest.mock('../../../models/ChartOfAccount.model', () => ({
  findOne: jest.fn(),
}));
jest.mock('../../../models/JournalEntry.model', () => ({
  findOne: jest.fn(),
  updateOne: jest.fn().mockResolvedValue({}),
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
const inventoryItemRepository = require('../../../repositories/inventoryItem.repository');
const inventoryService = require('../../../services/inventory.service');
const auditService = require('../../../services/audit.service');
const JournalEntry = require('../../../models/JournalEntry.model');
const { TRANSACTION_TYPES } = require('../../../config/constants');

const makeAccount = (id) => ({
  _id: id, normalBalance: 'Debit', accountName: 'Test Account', accountType: 'Asset', runningBalance: 0,
});

const CREATED_TX = {
  _id: 'tx1', businessId: 'biz1', transactionType: TRANSACTION_TYPES.INVENTORY_PURCHASE,
  amount: 5000, toObject: function () { return { ...this }; },
};

beforeEach(() => {
  jest.clearAllMocks();
  auditService.logCreate = jest.fn().mockResolvedValue(undefined);
  accountRepository.findOneByBusinessAndId.mockImplementation((_b, id) => Promise.resolve(makeAccount(id)));
  accountRepository.findById.mockImplementation((id) => Promise.resolve(makeAccount(id)));
  accountRepository.updateRunningBalance.mockResolvedValue(undefined);
  transactionRepository.createTransaction.mockResolvedValue(CREATED_TX);
  inventoryService.applyPurchaseStock.mockResolvedValue({});
  inventoryService.reduceStock.mockResolvedValue({});
  // no same-name item exists by default
  inventoryItemRepository.model.findOne.mockReturnValue({ session: jest.fn().mockResolvedValue(null) });
  inventoryItemRepository.model.create.mockResolvedValue([{ _id: 'new-item-1', name: 'Flour' }]);
  JournalEntry.updateOne.mockResolvedValue({});
});

const PURCHASE = {
  businessId: 'biz1', transactionDate: new Date().toISOString(), description: 'Stock purchase',
  transactionType: TRANSACTION_TYPES.INVENTORY_PURCHASE, amount: 5000,
  debitAccountId: 'a-inv', creditAccountId: 'a-cash', inputMethod: 'nlp',
  newInventoryItem: { name: 'Flour', unit: 'bags', quantity: 20, unitCostPrice: 250 },
};

describe('createTransaction — consented new inventory item', () => {
  test('creates the item, applies stock, stamps the JE — all in the persist session', async () => {
    await transactionService.createTransaction({ ...PURCHASE }, 'u1', '127.0.0.1');
    expect(inventoryItemRepository.model.create).toHaveBeenCalledWith(
      [expect.objectContaining({ businessId: 'biz1', name: 'Flour', unit: 'bags', unitCostPrice: 0, currentStock: 0 })],
      { session: 'TXN-SESSION' }
    );
    expect(inventoryService.applyPurchaseStock).toHaveBeenCalledWith(
      'biz1', 'new-item-1', 20, 250, expect.objectContaining({ session: 'TXN-SESSION' })
    );
    expect(JournalEntry.updateOne).toHaveBeenCalledWith(
      { _id: 'tx1' },
      { $set: { inventoryItemId: 'new-item-1', inventoryQty: 20 } },
      { session: 'TXN-SESSION' }
    );
  });

  test('same-name item already exists → LINKS instead of creating (retry-safe)', async () => {
    inventoryItemRepository.model.findOne.mockReturnValue({
      session: jest.fn().mockResolvedValue({ _id: 'existing-9', name: 'Flour' }),
    });
    await transactionService.createTransaction({ ...PURCHASE }, 'u1', '127.0.0.1');
    expect(inventoryItemRepository.model.create).not.toHaveBeenCalled();
    expect(inventoryService.applyPurchaseStock).toHaveBeenCalledWith(
      'biz1', 'existing-9', 20, 250, expect.anything()
    );
  });

  test('journal insert failure → NO item created, NO stock applied (atomicity)', async () => {
    transactionRepository.createTransaction.mockRejectedValue(new Error('insert failed'));
    await expect(
      transactionService.createTransaction({ ...PURCHASE }, 'u1', '127.0.0.1')
    ).rejects.toThrow('insert failed');
    expect(inventoryItemRepository.model.create).not.toHaveBeenCalled();
    expect(inventoryService.applyPurchaseStock).not.toHaveBeenCalled();
  });

  test('missing unitCostPrice derives cost from amount / quantity', async () => {
    await transactionService.createTransaction({
      ...PURCHASE, newInventoryItem: { name: 'Flour', unit: 'bags', quantity: 20, unitCostPrice: null },
    }, 'u1', '127.0.0.1');
    expect(inventoryService.applyPurchaseStock).toHaveBeenCalledWith(
      'biz1', 'new-item-1', 20, 250, expect.anything() // 5000 / 20
    );
  });

  test('rejects a nameless or zero-quantity newInventoryItem', async () => {
    await expect(transactionService.createTransaction({
      ...PURCHASE, newInventoryItem: { name: ' ', unit: 'bags', quantity: 20 },
    }, 'u1', '127.0.0.1')).rejects.toThrow(/name/i);
    await expect(transactionService.createTransaction({
      ...PURCHASE, newInventoryItem: { name: 'Flour', unit: 'bags', quantity: 0 },
    }, 'u1', '127.0.0.1')).rejects.toThrow(/quantity/i);
  });

  test('existing inventoryItemId takes precedence — newInventoryItem ignored', async () => {
    await transactionService.createTransaction({
      ...PURCHASE, inventoryItemId: 'i1', inventoryQty: 10,
      newInventoryItem: { name: 'Flour', unit: 'bags', quantity: 20, unitCostPrice: 250 },
    }, 'u1', '127.0.0.1');
    expect(inventoryItemRepository.model.create).not.toHaveBeenCalled();
    // block 7a handles the existing item path
    expect(inventoryService.applyPurchaseStock).toHaveBeenCalledWith(
      'biz1', 'i1', 10, expect.any(Number), expect.anything()
    );
  });
});
