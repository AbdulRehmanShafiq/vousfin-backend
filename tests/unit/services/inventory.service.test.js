/**
 * tests/unit/services/inventory.service.test.js
 *
 * ERP Integration Refactor — Step 3 (Inventory ↔ Transaction engine).
 * Validates the journal-free stock increment (applyPurchaseStock), the
 * event broadcasts on reduceStock (INVENTORY_REDUCED / VALUATION_CHANGED /
 * LOW_STOCK_REACHED), and the getStockLedger classification fix that now
 * counts every purchase/sale type — not only the two "Inventory *" types.
 *
 * The item model, repository and JournalEntry model are mocked. The REAL
 * businessEventEngine is used with a spy on emit() so we can assert exactly
 * which events were broadcast without running detached handlers.
 */
'use strict';

const ID_BUSINESS = '507f1f77bcf86cd799439060';
const ID_ITEM     = '507f1f77bcf86cd799439061';
const ID_VENDOR   = '507f1f77bcf86cd799439062';

jest.mock('../../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../../repositories/inventoryItem.repository', () => ({
  model: { findOne: jest.fn() },
  findByBusinessAndId: jest.fn(),
  findByBusiness: jest.fn(),
}));
jest.mock('../../../models/JournalEntry.model', () => ({ find: jest.fn() }));
// Phase 1 — the sub-ledger writer is unit-tested on its own; here we only
// assert the physical mutation + events, so stub the movement recording.
jest.mock('../../../services/stockMovement.service', () => ({
  record: jest.fn().mockResolvedValue({}),
  getLedger: jest.fn().mockResolvedValue([]),
  hasMovements: jest.fn().mockResolvedValue(false),
  computeDrift: jest.fn(),
}));

const inventoryService     = require('../../../services/inventory.service');
const inventoryItemRepo    = require('../../../repositories/inventoryItem.repository');
const JournalEntry         = require('../../../models/JournalEntry.model');
const { businessEvents, EVENTS } = require('../../../services/businessEventEngine.service');

// Build a fake InventoryItem document with working addStock / reduceStock.
const makeItem = (overrides = {}) => ({
  _id: ID_ITEM,
  businessId: ID_BUSINESS,
  name: 'Widget',
  sku: 'W-1',
  unit: 'pcs',
  currentStock: 10,
  unitCostPrice: 5,
  reorderLevel: 2,
  reorderQty: 10,
  preferredVendorId: null,
  async addStock(qty, cost) {
    const totalCost = this.currentStock * this.unitCostPrice + qty * cost;
    this.currentStock += qty;
    this.unitCostPrice = this.currentStock ? totalCost / this.currentStock : cost;
  },
  async reduceStock(qty) {
    this.currentStock -= qty;
    return { cogsAmount: Math.round(qty * this.unitCostPrice * 100) / 100, unitCostUsed: this.unitCostPrice };
  },
  ...overrides,
});

const emittedEventNames = () => businessEvents.emit.mock.calls.map((c) => c[0]);
const lastPayloadFor = (name) => {
  const call = [...businessEvents.emit.mock.calls].reverse().find((c) => c[0] === name);
  return call ? call[1] : undefined;
};

/**
 * Returns a mock that works for BOTH the old direct-await call
 * (applyPurchaseStock: `await findOne(...)`) AND the new session-chained call
 * (reduceStock: `await findOne(...).session(session)`).
 * The returned object is a thenable resolving to `val`, and also has a
 * `.session()` method that returns a Promise resolving to `val`.
 */
const mockFindOneResult = (val) => {
  const p = Promise.resolve(val);
  p.session = () => Promise.resolve(val);
  return p;
};

beforeEach(() => {
  jest.clearAllMocks();
  // Stub emit so we record broadcasts without running detached handlers.
  jest.spyOn(businessEvents, 'emit').mockReturnValue('evt-test-id');
});
afterEach(() => jest.restoreAllMocks());

// ── applyPurchaseStock ─────────────────────────────────────────────────────────
describe('InventoryService.applyPurchaseStock()', () => {
  it('increments stock (weighted-avg) and broadcasts RECEIVED + VALUATION_CHANGED', async () => {
    const item = makeItem(); // stock 10 @ 5
    inventoryItemRepo.model.findOne.mockReturnValue(mockFindOneResult(item));

    const res = await inventoryService.applyPurchaseStock(ID_BUSINESS, ID_ITEM, 5, 7, { vendorId: ID_VENDOR });

    expect(res.item).toBe(item);
    expect(item.currentStock).toBe(15);

    const names = emittedEventNames();
    expect(names).toContain(EVENTS.INVENTORY_RECEIVED);
    expect(names).toContain(EVENTS.INVENTORY_VALUATION_CHANGED);

    const received = lastPayloadFor(EVENTS.INVENTORY_RECEIVED);
    expect(received.businessId).toBe(ID_BUSINESS);
    expect(received.qty).toBe(5);
    expect(received.costPerUnit).toBe(7);
    expect(received.newStock).toBe(15);
    expect(received.vendorId).toBe(ID_VENDOR);

    const valuation = lastPayloadFor(EVENTS.INVENTORY_VALUATION_CHANGED);
    expect(valuation.valuationBefore).toBe(50); // 10 * 5
    expect(valuation.valuationAfter).toBe(85);  // 15 * 5.6667 ≈ 85
    expect(valuation.delta).toBe(35);
  });

  it('falls back to the item unit cost when costPerUnit is not positive', async () => {
    const item = makeItem();
    const spy = jest.spyOn(item, 'addStock');
    inventoryItemRepo.model.findOne.mockReturnValue(mockFindOneResult(item));

    await inventoryService.applyPurchaseStock(ID_BUSINESS, ID_ITEM, 4, 0);
    expect(spy).toHaveBeenCalledWith(4, 5, null); // 5 = item.unitCostPrice fallback; null = no session
  });

  it('posts NO journal entry (funding journal is owned by the caller)', async () => {
    const item = makeItem();
    inventoryItemRepo.model.findOne.mockReturnValue(mockFindOneResult(item));
    // If applyPurchaseStock tried to post a journal it would require transaction.service;
    // here we assert it resolves without one and returns only the item plus the
    // Phase 8 receipt variance (zero for anything but standard costing).
    const res = await inventoryService.applyPurchaseStock(ID_BUSINESS, ID_ITEM, 1, 5);
    expect(res.item).toBe(item);
    expect(res.variance).toBe(0);
    expect(Object.keys(res).sort()).toEqual(['item', 'variance']);
  });

  it('throws 400 for non-positive quantity', async () => {
    await expect(inventoryService.applyPurchaseStock(ID_BUSINESS, ID_ITEM, 0, 5))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(inventoryItemRepo.model.findOne).not.toHaveBeenCalled();
  });

  it('throws 404 when the item does not exist', async () => {
    inventoryItemRepo.model.findOne.mockReturnValue(mockFindOneResult(null));
    await expect(inventoryService.applyPurchaseStock(ID_BUSINESS, ID_ITEM, 3, 5))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

// ── reduceStock event broadcasts ─────────────────────────────────────────────────
describe('InventoryService.reduceStock() — events', () => {
  it('broadcasts REDUCED + VALUATION_CHANGED + LOW_STOCK when crossing the reorder level', async () => {
    const item = makeItem({ currentStock: 5, unitCostPrice: 4, reorderLevel: 3 });
    inventoryItemRepo.model.findOne.mockReturnValue(mockFindOneResult(item));
    jest.spyOn(inventoryService, '_fireReorderEmail').mockResolvedValue(undefined);

    const res = await inventoryService.reduceStock(ID_BUSINESS, ID_ITEM, 3); // 5 → 2 (crosses 3)

    expect(res.cogsAmount).toBe(12);
    expect(res.updatedStock).toBe(2);

    const names = emittedEventNames();
    expect(names).toContain(EVENTS.INVENTORY_REDUCED);
    expect(names).toContain(EVENTS.INVENTORY_VALUATION_CHANGED);
    expect(names).toContain(EVENTS.LOW_STOCK_REACHED);
    expect(inventoryService._fireReorderEmail).toHaveBeenCalledTimes(1);

    const low = lastPayloadFor(EVENTS.LOW_STOCK_REACHED);
    expect(low.currentStock).toBe(2);
    expect(low.reorderLevel).toBe(3);
  });

  it('does NOT broadcast LOW_STOCK when stock stays above the reorder level', async () => {
    const item = makeItem({ currentStock: 20, unitCostPrice: 4, reorderLevel: 3 });
    inventoryItemRepo.model.findOne.mockReturnValue(mockFindOneResult(item));
    jest.spyOn(inventoryService, '_fireReorderEmail').mockResolvedValue(undefined);

    await inventoryService.reduceStock(ID_BUSINESS, ID_ITEM, 3); // 20 → 17

    const names = emittedEventNames();
    expect(names).toContain(EVENTS.INVENTORY_REDUCED);
    expect(names).not.toContain(EVENTS.LOW_STOCK_REACHED);
    expect(inventoryService._fireReorderEmail).not.toHaveBeenCalled();
  });
});

// ── getStockLedger classification fix ────────────────────────────────────────────
describe('InventoryService.getStockLedger() — movement classification', () => {
  it('counts ALL purchase types as IN and ALL sale types as OUT', async () => {
    inventoryItemRepo.findByBusinessAndId.mockResolvedValue(
      makeItem({ currentStock: 9, unitCostPrice: 5 })
    );
    JournalEntry.find.mockReturnValue({
      sort:   jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      lean:   jest.fn().mockResolvedValue([
        { _id: '1', transactionType: 'Inventory Purchase', inventoryQty: 4, amount: 20, transactionDate: new Date() },
        { _id: '2', transactionType: 'Cash Purchase',      inventoryQty: 6, amount: 30, transactionDate: new Date() },
        { _id: '3', transactionType: 'Credit Purchase',    inventoryQty: 5, amount: 25, transactionDate: new Date() },
        { _id: '4', transactionType: 'Cash Sale',          inventoryQty: 3, amount: 30, transactionDate: new Date() },
        { _id: '5', transactionType: 'Credit Sale',        inventoryQty: 2, amount: 20, transactionDate: new Date() },
        { _id: '6', transactionType: 'Income',             inventoryQty: 1, amount: 10, transactionDate: new Date() },
      ]),
    });

    const res = await inventoryService.getStockLedger(ID_BUSINESS, ID_ITEM);

    expect(res.summary.totalIn).toBe(15);  // 4 + 6 + 5  (was 4 under the old bug)
    expect(res.summary.totalOut).toBe(6);  // 3 + 2 + 1  (was 0 under the old bug)
    // running balance follows the ledger order
    expect(res.lines[res.lines.length - 1].balance).toBe(9);
  });
});
