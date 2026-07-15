/**
 * tests/unit/services/stockMovement.service.test.js
 *
 * Inventory Engine Phase 1 — the append-only item sub-ledger writer and the
 * inventory↔projection integrity check.
 */
'use strict';

const mockSM = {
  create: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  aggregate: jest.fn(),
};
const mockItem = { find: jest.fn() };

jest.mock('../../../models/StockMovement.model', () => mockSM);
jest.mock('../../../models/InventoryItem.model', () => mockItem);
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('mongoose', () => ({
  Types: { ObjectId: Object.assign(function (v) { return v; }, { isValid: () => true }) },
}));

const svc = require('../../../services/stockMovement.service');

const BIZ = 'biz1';
const ITEM = 'item1';

beforeEach(() => {
  jest.clearAllMocks();
  mockSM.create.mockImplementation((docs) => Promise.resolve(docs));
});

describe('record()', () => {
  test('writes one movement with computed value inside the given session', async () => {
    await svc.record({
      businessId: BIZ, itemId: ITEM, direction: 'in', movementType: 'purchase',
      qty: 4, unitCost: 25.505, balanceQtyAfter: 10, balanceValueAfter: 255.05,
      source: { docType: 'GoodsReceipt', docId: 'grn1' }, journalEntryId: 'je1',
    }, { session: 'S1' });

    expect(mockSM.create).toHaveBeenCalledTimes(1);
    const [docs, opts] = mockSM.create.mock.calls[0];
    expect(opts).toEqual({ session: 'S1' });
    expect(docs[0].value).toBe(102.02);      // r2(4 × 25.51)
    expect(docs[0].unitCost).toBe(25.51);    // rounded to cents
    expect(docs[0].direction).toBe('in');
    expect(docs[0].source.docType).toBe('GoodsReceipt');
    expect(docs[0].journalEntryId).toBe('je1');
  });

  test('rejects a non-positive quantity', async () => {
    await expect(svc.record({ businessId: BIZ, itemId: ITEM, direction: 'out', movementType: 'sale', qty: 0, unitCost: 5 }))
      .rejects.toThrow(/qty must be positive/i);
    expect(mockSM.create).not.toHaveBeenCalled();
  });

  test('rejects a movement without tenant + item scope', async () => {
    await expect(svc.record({ itemId: ITEM, direction: 'in', movementType: 'purchase', qty: 1, unitCost: 5 }))
      .rejects.toThrow(/businessId and itemId/i);
  });
});

describe('computeDrift()', () => {
  test('flags items whose cached projection diverges from the movement ledger', async () => {
    mockSM.aggregate.mockResolvedValue([
      { _id: ITEM, qtyIn: 10, qtyOut: 4, valueIn: 1000, valueOut: 400, movements: 3 },
    ]);
    mockItem.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([
      { _id: ITEM, name: 'Widget', sku: 'W1', currentStock: 7, unitCostPrice: 100 }, // cached 700 vs ledger 600
    ]) }) });

    const r = await svc.computeDrift(BIZ);

    expect(r.totals.driftedCount).toBe(1);
    const row = r.items[0];
    expect(row.ledgerQty).toBe(6);
    expect(row.qtyDrift).toBe(1);       // cached 7 − ledger 6
    expect(row.valueDrift).toBe(100);   // cached 700 − ledger 600
  });

  test('items with no movements report as untracked, never as drift', async () => {
    mockSM.aggregate.mockResolvedValue([]);
    mockItem.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([
      { _id: ITEM, name: 'Legacy', sku: null, currentStock: 5, unitCostPrice: 10 },
    ]) }) });

    const r = await svc.computeDrift(BIZ);

    expect(r.totals.untrackedCount).toBe(1);
    expect(r.totals.driftedCount).toBe(0);
    expect(r.items[0].untracked).toBe(true);
  });

  test('reports clean when projections match the ledger to the cent', async () => {
    mockSM.aggregate.mockResolvedValue([
      { _id: ITEM, qtyIn: 10, qtyOut: 4, valueIn: 1000, valueOut: 400, movements: 3 },
    ]);
    mockItem.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([
      { _id: ITEM, name: 'Widget', sku: 'W1', currentStock: 6, unitCostPrice: 100 },
    ]) }) });

    const r = await svc.computeDrift(BIZ);
    expect(r.totals.driftedCount).toBe(0);
    expect(r.items[0].qtyDrift).toBe(0);
    expect(r.items[0].valueDrift).toBe(0);
  });
});
