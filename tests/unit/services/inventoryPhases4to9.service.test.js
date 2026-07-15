/**
 * tests/unit/services/inventoryPhases4to9.service.test.js
 *
 * Inventory Engine Phases 4–9 — the accounting contracts that matter:
 *   4 landed costs  — value capitalized into stock, cleared through 1157
 *   5 transfers     — location changes, value conserved, NO journal
 *   6 reservations  — promises only, NO journal, ATP = on hand − reserved
 *   9 assemblies    — value conserved; a journal only when labour is added
 */
'use strict';

const mockItem = { findOne: jest.fn(), find: jest.fn() };
const mockCOA = { findOne: jest.fn() };
const mockGRN = { findOne: jest.fn() };
const mockWarehouse = {
  findOne: jest.fn(), find: jest.fn(), create: jest.fn(),
  countDocuments: jest.fn(), updateMany: jest.fn(),
};
const mockReservation = { find: jest.fn(), create: jest.fn(), aggregate: jest.fn() };
const mockBom = { findOne: jest.fn(), create: jest.fn(), find: jest.fn() };

jest.mock('mongoose', () => ({
  Types: { ObjectId: Object.assign(function (v) { return v; }, { isValid: () => true }) },
}));
jest.mock('../../../models/InventoryItem.model', () => mockItem);
jest.mock('../../../models/ChartOfAccount.model', () => mockCOA);
jest.mock('../../../models/GoodsReceipt.model', () => mockGRN);
jest.mock('../../../models/Warehouse.model', () => mockWarehouse);
jest.mock('../../../models/StockReservation.model', () => mockReservation);
jest.mock('../../../models/BillOfMaterials.model', () => mockBom);
jest.mock('../../../services/inventory.service', () => ({
  resolveCostAccounts: jest.fn().mockResolvedValue({ cogsAccountId: 'acct-5110', inventoryAccountId: 'acct-1150' }),
  applyPurchaseStock: jest.fn().mockResolvedValue({ item: {}, variance: 0 }),
  reduceStock: jest.fn().mockResolvedValue({ cogsAmount: 0, unitCostUsed: 0 }),
}));
jest.mock('../../../services/stockMovement.service', () => ({
  record: jest.fn().mockResolvedValue({}),
  balancesByWarehouse: jest.fn().mockResolvedValue([]),
  lotBalances: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../../services/ledgerPosting.service', () => ({
  postBalancedJournal: jest.fn().mockResolvedValue({ _id: 'je-1' }),
  postCompoundJournal: jest.fn().mockResolvedValue({ _id: 'je-c' }),
}));
jest.mock('../../../utils/withTransaction', () => ({ withTransaction: (fn) => fn('S1') }));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const landedCostService = require('../../../services/landedCost.service');
const warehouseService = require('../../../services/warehouse.service');
const reservationService = require('../../../services/stockReservation.service');
const assemblyService = require('../../../services/assembly.service');
const inventoryService = require('../../../services/inventory.service');
const stockMovementService = require('../../../services/stockMovement.service');
const { postBalancedJournal, postCompoundJournal } = require('../../../services/ledgerPosting.service');

const BIZ = 'biz1';
const USER = { id: 'u1' };
const sessioned = (v) => ({ session: () => Promise.resolve(v) });

beforeEach(() => {
  jest.clearAllMocks();
  mockCOA.findOne.mockImplementation((q) => ({ lean: () => Promise.resolve({ _id: `acct-${q.accountCode || 'X'}` }) }));
  inventoryService.resolveCostAccounts.mockResolvedValue({ cogsAccountId: 'acct-5110', inventoryAccountId: 'acct-1150' });
});

// ── Phase 4 ─────────────────────────────────────────────────────────────────
describe('landedCost.apply()', () => {
  const grn = {
    _id: 'grn1', grnNumber: 'GRN-1', businessId: BIZ, inventoryApplied: true, vendorId: 'v1',
    receivedItems: [
      { inventoryItemId: 'iA', name: 'A', quantityReceived: 10, quantityRejected: 0, unitCost: 100 }, // value 1000
      { inventoryItemId: 'iB', name: 'B', quantityReceived: 10, quantityRejected: 0, unitCost: 300 }, // value 3000
    ],
  };

  beforeEach(() => {
    mockGRN.findOne.mockResolvedValue(grn);
    mockItem.findOne.mockImplementation((q) => sessioned({
      _id: q._id, name: q._id, valuationMethod: 'weighted_average',
      currentStock: 10, unitCostPrice: q._id === 'iA' ? 100 : 300,
      save: jest.fn(),
    }));
  });

  test('spreads by value and posts DR Inventory (per item) / CR Landed Cost Clearing', async () => {
    const r = await landedCostService.apply(BIZ, {
      grnId: 'grn1', method: 'value', charges: [{ description: 'Freight', amount: 400 }],
    }, USER);

    expect(r.total).toBe(400);
    // 1000 : 3000 → 100 : 300
    expect(r.allocations.map((a) => a.amount)).toEqual([100, 300]);

    const [je] = postCompoundJournal.mock.calls[0];
    const dr = je.journalLines.filter((l) => l.type === 'debit');
    const cr = je.journalLines.filter((l) => l.type === 'credit');
    expect(dr.every((l) => l.accountId === 'acct-1150')).toBe(true);
    expect(cr).toEqual([expect.objectContaining({ accountId: 'acct-1157', amount: 400 })]);
    expect(dr.reduce((s, l) => s + l.amount, 0)).toBe(400); // balanced
  });

  test('spreads by quantity when asked', async () => {
    const r = await landedCostService.apply(BIZ, {
      grnId: 'grn1', method: 'quantity', charges: [{ description: 'Freight', amount: 400 }],
    }, USER);
    expect(r.allocations.map((a) => a.amount)).toEqual([200, 200]); // 10 : 10
  });

  test('records value-only movements — quantity never moves', async () => {
    await landedCostService.apply(BIZ, { grnId: 'grn1', charges: [{ amount: 400 }] }, USER);
    const calls = stockMovementService.record.mock.calls.map(([m]) => m);
    expect(calls).toHaveLength(2);
    expect(calls.every((m) => m.movementType === 'landed_cost' && m.qty === 0)).toBe(true);
  });

  test('refuses on a receipt that has not been taken into stock yet', async () => {
    mockGRN.findOne.mockResolvedValue({ ...grn, inventoryApplied: false });
    await expect(landedCostService.apply(BIZ, { grnId: 'grn1', charges: [{ amount: 10 }] }, USER))
      .rejects.toThrow(/not been received into stock yet/i);
  });

  test('fails closed in plain language when 1157 is missing', async () => {
    mockCOA.findOne.mockImplementation(() => ({ lean: () => Promise.resolve(null) }));
    await expect(landedCostService.apply(BIZ, { grnId: 'grn1', charges: [{ amount: 10 }] }, USER))
      .rejects.toThrow(/Landed Cost Clearing \(1157\)/);
  });

  test('requires at least one charge', async () => {
    await expect(landedCostService.apply(BIZ, { grnId: 'grn1', charges: [] }, USER))
      .rejects.toThrow(/at least one cost/i);
  });
});

// ── Phase 5 ─────────────────────────────────────────────────────────────────
describe('warehouse.transfer()', () => {
  beforeEach(() => {
    mockWarehouse.findOne.mockImplementation((q) => ({
      lean: () => Promise.resolve({ _id: q._id, name: q._id === 'w1' ? 'Shop' : 'Store' }),
    }));
    mockItem.findOne.mockReturnValue(sessioned({
      _id: 'i1', name: 'Widget', unit: 'pcs', valuationMethod: 'weighted_average',
      currentStock: 20, unitCostPrice: 5,
    }));
    stockMovementService.balancesByWarehouse.mockResolvedValue([{ warehouseId: 'w1', qty: 12, value: 60 }]);
  });

  test('writes out+in movements at the same cost and posts NO journal', async () => {
    const r = await warehouseService.transfer(BIZ, { itemId: 'i1', fromWarehouseId: 'w1', toWarehouseId: 'w2', qty: 5 }, USER);

    expect(postBalancedJournal).not.toHaveBeenCalled();
    expect(postCompoundJournal).not.toHaveBeenCalled();

    const moves = stockMovementService.record.mock.calls.map(([m]) => m);
    expect(moves).toHaveLength(2);
    expect(moves[0]).toMatchObject({ direction: 'out', movementType: 'transfer_out', warehouseId: 'w1', value: 25 });
    expect(moves[1]).toMatchObject({ direction: 'in', movementType: 'transfer_in', warehouseId: 'w2', value: 25 });
    // Value conserved: what left equals what arrived
    expect(moves[0].value).toBe(moves[1].value);
    expect(r.value).toBe(25);
  });

  test('refuses to move more than the source location holds', async () => {
    await expect(
      warehouseService.transfer(BIZ, { itemId: 'i1', fromWarehouseId: 'w1', toWarehouseId: 'w2', qty: 50 }, USER)
    ).rejects.toThrow(/only has 12/i);
    expect(stockMovementService.record).not.toHaveBeenCalled();
  });

  test('refuses a transfer to the same location', async () => {
    await expect(
      warehouseService.transfer(BIZ, { itemId: 'i1', fromWarehouseId: 'w1', toWarehouseId: 'w1', qty: 1 }, USER)
    ).rejects.toThrow(/two different locations/i);
  });
});

// ── Phase 6 ─────────────────────────────────────────────────────────────────
describe('stockReservation', () => {
  beforeEach(() => {
    mockItem.findOne.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ _id: 'i1', name: 'Widget', unit: 'pcs', currentStock: 10 }) }),
    });
    mockReservation.aggregate.mockResolvedValue([]);
    mockReservation.create.mockImplementation((d) => Promise.resolve({ _id: 'r1', ...d }));
  });

  test('ATP = on hand − reserved', async () => {
    mockReservation.aggregate.mockResolvedValueOnce([{ qty: 4 }]).mockResolvedValueOnce([]);
    const r = await reservationService.availableToPromise(BIZ, 'i1');
    expect(r).toMatchObject({ onHand: 10, reserved: 4, available: 6 });
  });

  test('reserving posts NO journal — a promise is not an accounting event', async () => {
    await reservationService.reserve(BIZ, { itemId: 'i1', qty: 3, source: { docType: 'Invoice', docId: 'inv1' } }, USER);
    expect(postBalancedJournal).not.toHaveBeenCalled();
    expect(stockMovementService.record).not.toHaveBeenCalled();
  });

  test('reserves what it can and backorders the shortfall instead of failing', async () => {
    mockReservation.aggregate.mockResolvedValueOnce([{ qty: 8 }]).mockResolvedValueOnce([]); // 2 free of 10
    const r = await reservationService.reserve(BIZ, { itemId: 'i1', qty: 5 }, USER);

    expect(r.reserved).toBe(2);
    expect(r.backordered).toBe(3);
    const states = mockReservation.create.mock.calls.map(([d]) => d.state);
    expect(states).toEqual(['active', 'backordered']);
  });

  test('refuses to oversell when backorders are switched off', async () => {
    mockReservation.aggregate.mockResolvedValueOnce([{ qty: 8 }]).mockResolvedValueOnce([]);
    await expect(
      reservationService.reserve(BIZ, { itemId: 'i1', qty: 5, allowBackorder: false }, USER)
    ).rejects.toThrow(/already promised to someone else/i);
    expect(mockReservation.create).not.toHaveBeenCalled();
  });
});

// ── Phase 9 ─────────────────────────────────────────────────────────────────
describe('assembly.build()', () => {
  const bom = {
    _id: 'bom1', businessId: BIZ, itemId: 'fg1', name: 'Kit', outputQty: 1,
    labourCostPerRun: 0,
    components: [{ itemId: 'c1', qtyPerUnit: 2, scrapPct: 0 }],
  };

  beforeEach(() => {
    mockBom.findOne.mockReturnValue({ lean: () => Promise.resolve(bom) });
    mockItem.findOne.mockImplementation(() => ({
      lean: () => Promise.resolve({ _id: 'c1', name: 'Screw', unit: 'pcs', currentStock: 100, unitCostPrice: 3, valuationMethod: 'weighted_average' }),
    }));
    inventoryService.reduceStock.mockResolvedValue({ cogsAmount: 6, unitCostUsed: 3 });
  });

  test('components-only build moves value without a journal (it would net to zero)', async () => {
    const r = await assemblyService.build(BIZ, { bomId: 'bom1', runs: 1 }, USER);

    expect(postBalancedJournal).not.toHaveBeenCalled();
    expect(inventoryService.reduceStock).toHaveBeenCalledWith(
      BIZ, 'c1', 2, 'S1', expect.objectContaining({ movementType: 'assembly_out' }));
    expect(inventoryService.applyPurchaseStock).toHaveBeenCalledWith(
      BIZ, 'fg1', 1, 6, expect.objectContaining({ movementType: 'assembly_in' }));
    // Value conserved: the finished good is worth exactly its components
    expect(r.totalCost).toBe(6);
    expect(r.unitCost).toBe(6);
  });

  test('labour is capitalized into the finished good — DR Inventory / CR Direct Labour', async () => {
    mockBom.findOne.mockReturnValue({ lean: () => Promise.resolve({ ...bom, labourCostPerRun: 4 }) });
    const r = await assemblyService.build(BIZ, { bomId: 'bom1', runs: 1 }, USER);

    const [je] = postBalancedJournal.mock.calls[0];
    expect(je.amount).toBe(4);
    expect(je.debitAccountId).toBe('acct-1150');
    expect(je.creditAccountId).toBe('acct-5120');
    expect(r.totalCost).toBe(10);  // 6 components + 4 labour
  });

  test('scrap consumes more than the recipe quantity', async () => {
    mockBom.findOne.mockReturnValue({ lean: () => Promise.resolve({
      ...bom, components: [{ itemId: 'c1', qtyPerUnit: 2, scrapPct: 50 }],
    }) });
    await assemblyService.build(BIZ, { bomId: 'bom1', runs: 1 }, USER);
    expect(inventoryService.reduceStock).toHaveBeenCalledWith(BIZ, 'c1', 3, 'S1', expect.anything()); // 2 × 1.5
  });

  test('refuses to build without enough components, naming what is short', async () => {
    mockItem.findOne.mockImplementation(() => ({
      lean: () => Promise.resolve({ _id: 'c1', name: 'Screw', unit: 'pcs', currentStock: 1, unitCostPrice: 3, valuationMethod: 'weighted_average' }),
    }));
    await expect(assemblyService.build(BIZ, { bomId: 'bom1', runs: 1 }, USER))
      .rejects.toThrow(/Screw \(short 1 pcs\)/);
    expect(inventoryService.reduceStock).not.toHaveBeenCalled();
  });

  test('a recipe cannot make itself', async () => {
    mockItem.findOne.mockImplementation(() => ({ lean: () => Promise.resolve({ _id: 'fg1', name: 'Kit' }) }));
    await expect(assemblyService.createBom(BIZ, {
      itemId: 'fg1', components: [{ itemId: 'fg1', qtyPerUnit: 1 }],
    }, USER)).rejects.toThrow(/cannot be made out of itself/i);
  });
});
