/**
 * tests/unit/services/inventory.receiptReversal.test.js
 *
 * INV-3 — reversing a goods receipt (GRN cancel) must remove the received
 * batch at its RECEIPT cost so the subledger change equals the GL reversal:
 *   - WAC:  value out = qty × receiptCost; remaining value re-averages.
 *   - FIFO: the received batch's layer is removed (newest, cost-matched),
 *           not the oldest stock like a sale would consume.
 */
'use strict';

const mockRepo = { model: { findOne: jest.fn() } };

jest.mock('../../../repositories/inventoryItem.repository', () => mockRepo);
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../services/stockMovement.service', () => ({
  record: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../../services/businessEventEngine.service', () => ({
  businessEvents: { emit: jest.fn() },
  EVENTS: {
    INVENTORY_RECEIVED: 'inv.received', INVENTORY_REDUCED: 'inv.reduced',
    INVENTORY_VALUATION_CHANGED: 'inv.valuation', LOW_STOCK_REACHED: 'inv.low',
  },
}));

const inventoryService = require('../../../services/inventory.service');
const { businessEvents } = require('../../../services/businessEventEngine.service');

const BIZ = 'biz1';
const ITEM_ID = 'item1';

const makeItem = (fields) => ({
  _id: ITEM_ID, businessId: BIZ, name: 'Widget', unit: 'pcs',
  valuationMethod: 'weighted_average', costLayers: [],
  save: jest.fn().mockResolvedValue(undefined),
  ...fields,
});

const stubFindOne = (item) =>
  mockRepo.model.findOne.mockReturnValue({ session: () => Promise.resolve(item) });

beforeEach(() => jest.clearAllMocks());

describe('inventoryService.applyReceiptReversal() — INV-3', () => {
  test('WAC: removes exactly qty × receipt cost and re-averages the remainder', async () => {
    // 10 on hand @ WAC 110 (5 old @100 + 5 received @120 → avg 110).
    const item = makeItem({ currentStock: 10, unitCostPrice: 110 });
    stubFindOne(item);

    const { removedValue } = await inventoryService.applyReceiptReversal(BIZ, ITEM_ID, 5, 120, {});

    expect(removedValue).toBe(600);          // 5 × 120 — the GL reversal amount
    expect(item.currentStock).toBe(5);
    expect(item.unitCostPrice).toBe(100);    // (1100 − 600) / 5 — old batch cost restored
    expect(item.save).toHaveBeenCalled();
    expect(businessEvents.emit).toHaveBeenCalledWith('inv.valuation', expect.objectContaining({
      delta: -600,
    }));

    // Phase 1 — the sub-ledger records the reversal in the same operation
    const stockMovementService = require('../../../services/stockMovement.service');
    expect(stockMovementService.record).toHaveBeenCalledWith(expect.objectContaining({
      direction: 'out', movementType: 'receipt_reversal', qty: 5, value: 600,
      balanceQtyAfter: 5,
    }), expect.anything());
  });

  test('FIFO: removes the received batch layer, leaving older stock untouched', async () => {
    const item = makeItem({
      valuationMethod: 'fifo', currentStock: 10, unitCostPrice: 110,
      costLayers: [{ qty: 5, unitCost: 100 }, { qty: 5, unitCost: 120 }],
    });
    stubFindOne(item);

    const { removedValue } = await inventoryService.applyReceiptReversal(BIZ, ITEM_ID, 5, 120, {});

    expect(removedValue).toBe(600);
    expect(item.currentStock).toBe(5);
    expect(item.costLayers).toEqual([{ qty: 5, unitCost: 100 }]); // old layer intact
    expect(item.unitCostPrice).toBe(100);
  });

  test('refuses to reverse more than is on hand (some already sold)', async () => {
    const item = makeItem({ currentStock: 3, unitCostPrice: 100 });
    stubFindOne(item);

    await expect(
      inventoryService.applyReceiptReversal(BIZ, ITEM_ID, 5, 100, {})
    ).rejects.toThrow(/only 3 in stock/i);
    expect(item.save).not.toHaveBeenCalled();
  });

  test('threads the mongo session into the item load and save', async () => {
    const item = makeItem({ currentStock: 5, unitCostPrice: 100 });
    const sessionSpy = jest.fn(() => Promise.resolve(item));
    mockRepo.model.findOne.mockReturnValue({ session: sessionSpy });

    await inventoryService.applyReceiptReversal(BIZ, ITEM_ID, 2, 100, { session: 'S1' });

    expect(sessionSpy).toHaveBeenCalledWith('S1');
    expect(item.save).toHaveBeenCalledWith({ session: 'S1' });
  });
});
