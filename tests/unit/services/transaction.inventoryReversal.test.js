/**
 * tests/unit/services/transaction.inventoryReversal.test.js
 *
 * Audit 2026-07-02 F8 — reversing an inventory-linked transaction must restore
 * the PHYSICAL stock, not just the GL.
 *
 * Reversing an inventory sale flips the journal lines (the GL inventory value
 * comes back) but the item's currentStock stayed reduced — the quantity
 * subledger drifted below the ledger forever. The mirror holds for inventory
 * purchases (stock stayed added after the funding entry was reversed).
 *
 * Sale reversals restore stock at the ORIGINAL COGS unit cost (derived from
 * the entry's own inventory credit leg) so qty × cost re-syncs with the GL
 * flip; purchase reversals remove the quantity through the normal costing
 * method. Everything runs inside the reversal's transaction session.
 */
'use strict';

const SESSION = { __sentinel: 'txn-session' };

jest.mock('../../../utils/withTransaction', () => ({
  withTransaction: jest.fn((fn) => fn({ __sentinel: 'txn-session' })),
}));
jest.mock('../../../repositories/transaction.repository');
jest.mock('../../../repositories/account.repository');
jest.mock('../../../services/audit.service');
jest.mock('../../../services/inventory.service', () => ({
  applyPurchaseStock: jest.fn().mockResolvedValue({}),
  reduceStock: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../../services/partyBalance.service', () => ({
  adjustReceivable: jest.fn().mockResolvedValue({}),
  adjustPayable: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../../models/ChartOfAccount.model', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/AccountingPeriod.model', () => ({
  findCoveringPeriod: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const transactionService    = require('../../../services/transaction.service');
const transactionRepository = require('../../../repositories/transaction.repository');
const accountRepository     = require('../../../repositories/account.repository');
const inventoryService      = require('../../../services/inventory.service');
const ChartOfAccount        = require('../../../models/ChartOfAccount.model');
const auditService          = require('../../../services/audit.service');
const { businessEvents } = require('../../../services/businessEventEngine.service');
const { TRANSACTION_TYPES } = require('../../../config/constants');

const BIZ = 'biz1';
const INV_ACC = 'invAcc';

// Inventory CASH SALE: 5 units, revenue 500, COGS 5 × 60 = 300.
const makeInventorySale = (o = {}) => ({
  _id: 'sale1', businessId: BIZ,
  transactionType: TRANSACTION_TYPES.CASH_SALE,
  status: 'posted', entryType: 'adjusting', // skip period lookups in this harness
  amount: 500, partiallyPaidAmount: 0,
  debitAccountId: { _id: 'CASH' }, creditAccountId: { _id: 'SALES' },
  inventoryItemId: { _id: 'item1' }, inventoryQty: 5,
  journalLines: [
    { accountId: 'CASH',  type: 'debit',  amount: 500 },
    { accountId: 'SALES', type: 'credit', amount: 500 },
    { accountId: 'COGS',  type: 'debit',  amount: 300 },
    { accountId: INV_ACC, type: 'credit', amount: 300 },
  ],
  metadata: {},
  ...o,
});

beforeEach(() => {
  jest.clearAllMocks();
  auditService.logReversal = jest.fn().mockResolvedValue(undefined);
  accountRepository.findById.mockResolvedValue({ _id: 'acc', normalBalance: 'Debit' });
  accountRepository.updateRunningBalance.mockResolvedValue({});
  transactionRepository.createTransaction.mockResolvedValue({ _id: 'rev1' });
  transactionRepository.updateTransaction.mockResolvedValue({});
  ChartOfAccount.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: INV_ACC }) });
  jest.spyOn(businessEvents, 'emit').mockReturnValue('evt');
});
afterEach(() => jest.restoreAllMocks());

describe('F8 — reversal restores physical inventory', () => {
  test('reversing an inventory SALE adds the stock back at the original COGS unit cost', async () => {
    transactionRepository.findByIdWithDetails.mockResolvedValue(makeInventorySale());

    await transactionService.reverseTransaction('sale1', BIZ, { reason: 'return' }, 'u1', '127.0.0.1');

    // 300 COGS / 5 units → 60 per unit, restored inside the txn session.
    expect(inventoryService.applyPurchaseStock).toHaveBeenCalledWith(
      BIZ, 'item1', 5, 60, expect.objectContaining({ session: SESSION })
    );
    expect(inventoryService.reduceStock).not.toHaveBeenCalled();
  });

  test('falls back to the item cost (null) when the COGS leg cannot be identified', async () => {
    transactionRepository.findByIdWithDetails.mockResolvedValue(
      makeInventorySale({ journalLines: [] }) // legacy entry without lines
    );

    await transactionService.reverseTransaction('sale1', BIZ, {}, 'u1', '127.0.0.1');

    expect(inventoryService.applyPurchaseStock).toHaveBeenCalledWith(
      BIZ, 'item1', 5, null, expect.objectContaining({ session: SESSION })
    );
  });

  test('reversing an inventory PURCHASE removes the stock again', async () => {
    transactionRepository.findByIdWithDetails.mockResolvedValue(makeInventorySale({
      transactionType: TRANSACTION_TYPES.CASH_PURCHASE,
      journalLines: [
        { accountId: INV_ACC, type: 'debit',  amount: 300 },
        { accountId: 'CASH',  type: 'credit', amount: 300 },
      ],
    }));

    await transactionService.reverseTransaction('sale1', BIZ, {}, 'u1', '127.0.0.1');

    expect(inventoryService.reduceStock).toHaveBeenCalledWith(BIZ, 'item1', 5, SESSION);
    expect(inventoryService.applyPurchaseStock).not.toHaveBeenCalled();
  });

  test('reversing a non-inventory entry touches no stock', async () => {
    transactionRepository.findByIdWithDetails.mockResolvedValue(makeInventorySale({
      inventoryItemId: null, inventoryQty: null, journalLines: [],
    }));

    await transactionService.reverseTransaction('sale1', BIZ, {}, 'u1', '127.0.0.1');

    expect(inventoryService.applyPurchaseStock).not.toHaveBeenCalled();
    expect(inventoryService.reduceStock).not.toHaveBeenCalled();
  });
});
