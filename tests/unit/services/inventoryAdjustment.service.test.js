/**
 * tests/unit/services/inventoryAdjustment.service.test.js
 *
 * Inventory Engine Phase 2 — stock adjustments, physical counts and
 * revaluations (incl. IAS 2 NRV write-downs and the 2.33 reversal cap).
 *
 * Every adjustment must post a balanced journal AND move the sub-ledger in one
 * atomic unit; the JE recipe per type is asserted here.
 */
'use strict';

const mockItem = { findOne: jest.fn() };
const mockCOA = { findOne: jest.fn() };
const mockSM = { aggregate: jest.fn() };

jest.mock('mongoose', () => ({
  Types: { ObjectId: Object.assign(function (v) { return v; }, { isValid: () => true }) },
}));
jest.mock('../../../models/InventoryItem.model', () => mockItem);
jest.mock('../../../models/ChartOfAccount.model', () => mockCOA);
jest.mock('../../../models/StockMovement.model', () => mockSM);
jest.mock('../../../services/inventory.service', () => ({
  resolveCostAccounts: jest.fn(),
  applyPurchaseStock: jest.fn().mockResolvedValue({ item: {} }),
  reduceStock: jest.fn().mockResolvedValue({ cogsAmount: 0, unitCostUsed: 0 }),
}));
jest.mock('../../../services/stockMovement.service', () => ({ record: jest.fn().mockResolvedValue({}) }));
jest.mock('../../../services/ledgerPosting.service', () => ({
  postBalancedJournal: jest.fn().mockResolvedValue({ _id: 'je-adj' }),
}));
jest.mock('../../../utils/withTransaction', () => ({ withTransaction: (fn) => fn('S1') }));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const svc = require('../../../services/inventoryAdjustment.service');
const inventoryService = require('../../../services/inventory.service');
const stockMovementService = require('../../../services/stockMovement.service');
const { postBalancedJournal } = require('../../../services/ledgerPosting.service');

const BIZ = 'biz1';
const ITEM = 'item1';
const USER = { _id: 'u1' };
const INV_ACC = 'acct-1150';
const WO_ACC = 'acct-6495';

const makeItem = (over = {}) => ({
  _id: ITEM, businessId: BIZ, name: 'Widget', unit: 'pcs',
  valuationMethod: 'weighted_average', currentStock: 10, unitCostPrice: 50,
  costLayers: [], save: jest.fn().mockResolvedValue(undefined), ...over,
});

const stubItem = (item) => mockItem.findOne.mockReturnValue({ session: () => Promise.resolve(item) });

beforeEach(() => {
  jest.clearAllMocks();
  inventoryService.resolveCostAccounts.mockResolvedValue({ cogsAccountId: 'acct-5110', inventoryAccountId: INV_ACC });
  mockCOA.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: WO_ACC }) });
  mockSM.aggregate.mockReturnValue({ session: () => Promise.resolve([]) });
});

describe('validation', () => {
  test('rejects an unknown adjustment type', async () => {
    await expect(svc.adjustStock(BIZ, ITEM, { type: 'teleport', reason: 'other' }, USER))
      .rejects.toThrow(/Adjustment type must be one of/);
  });

  test('rejects an unknown reason code', async () => {
    await expect(svc.adjustStock(BIZ, ITEM, { type: 'increase', qty: 1, reason: 'vibes' }, USER))
      .rejects.toThrow(/Reason must be one of/);
  });

  // Regression: the auth middleware attaches `{ id }` (NOT `_id`). Assuming
  // `_id` made createdBy undefined and every adjustment died at JE validation
  // with "Path `createdBy` is required" — invisible to mocks that pass `_id`.
  test('accepts the auth middleware’s { id } user shape for createdBy', async () => {
    stubItem(makeItem());
    await svc.adjustStock(BIZ, ITEM, { type: 'increase', qty: 1, reason: 'found' }, { id: 'auth-user-1' });

    const [je] = postBalancedJournal.mock.calls[0];
    expect(je.createdBy).toBe('auth-user-1');
    expect(je.lastModifiedBy).toBe('auth-user-1');
  });

  test('fails closed in plain language when 1150/6495 are missing', async () => {
    mockCOA.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    await expect(svc.adjustStock(BIZ, ITEM, { type: 'increase', qty: 1, reason: 'found' }, USER))
      .rejects.toThrow(/chart of accounts is missing/i);
    expect(postBalancedJournal).not.toHaveBeenCalled();
  });
});

describe('increase', () => {
  test('posts DR Inventory / CR Write-off and adds stock as adjustment_in', async () => {
    stubItem(makeItem());
    const r = await svc.adjustStock(BIZ, ITEM, { type: 'increase', qty: 4, unitCost: 25, reason: 'found' }, USER);

    const [je] = postBalancedJournal.mock.calls[0];
    expect(je.amount).toBe(100);            // 4 × 25
    expect(je.debitAccountId).toBe(INV_ACC);
    expect(je.creditAccountId).toBe(WO_ACC);
    expect(je.description).toMatch(/stock found in count/i); // plain language

    expect(inventoryService.applyPurchaseStock).toHaveBeenCalledWith(
      BIZ, ITEM, 4, 25,
      expect.objectContaining({ session: 'S1', movementType: 'adjustment_in', journalEntryId: 'je-adj', reason: 'found' })
    );
    expect(r.qtyDelta).toBe(4);
    expect(r.valueDelta).toBe(100);
  });

  test('defaults the unit cost to the item cost when not supplied', async () => {
    stubItem(makeItem({ unitCostPrice: 50 }));
    await svc.adjustStock(BIZ, ITEM, { type: 'increase', qty: 2, reason: 'found' }, USER);
    expect(postBalancedJournal.mock.calls[0][0].amount).toBe(100); // 2 × 50
  });
});

describe('decrease / write_off', () => {
  test('write_off posts DR Write-off / CR Inventory at the item cost', async () => {
    stubItem(makeItem({ currentStock: 10, unitCostPrice: 50 }));
    const r = await svc.adjustStock(BIZ, ITEM, { type: 'write_off', qty: 3, reason: 'damaged' }, USER);

    const [je] = postBalancedJournal.mock.calls[0];
    expect(je.amount).toBe(150);            // 3 × 50
    expect(je.debitAccountId).toBe(WO_ACC);
    expect(je.creditAccountId).toBe(INV_ACC);

    expect(inventoryService.reduceStock).toHaveBeenCalledWith(
      BIZ, ITEM, 3, 'S1',
      expect.objectContaining({ movementType: 'write_off', reason: 'damaged' })
    );
    expect(r.valueDelta).toBe(-150);
  });

  test('FIFO items are costed through the layers, not the average', async () => {
    stubItem(makeItem({
      valuationMethod: 'fifo', currentStock: 20, unitCostPrice: 65,
      costLayers: [{ qty: 10, unitCost: 50 }, { qty: 10, unitCost: 80 }],
    }));
    await svc.adjustStock(BIZ, ITEM, { type: 'decrease', qty: 15, reason: 'lost' }, USER);
    // 10×50 + 5×80 = 900 (NOT 15 × 65 = 975)
    expect(postBalancedJournal.mock.calls[0][0].amount).toBe(900);
  });

  test('refuses to remove more than is on hand', async () => {
    stubItem(makeItem({ currentStock: 2 }));
    await expect(svc.adjustStock(BIZ, ITEM, { type: 'decrease', qty: 5, reason: 'lost' }, USER))
      .rejects.toThrow(/only 2 in stock/i);
    expect(postBalancedJournal).not.toHaveBeenCalled();
  });
});

describe('count', () => {
  test('a shortfall books the variance out as a count movement', async () => {
    stubItem(makeItem({ currentStock: 10, unitCostPrice: 50 }));
    const r = await svc.adjustStock(BIZ, ITEM, { type: 'count', countedQty: 7, reason: 'count_correction' }, USER);

    expect(postBalancedJournal.mock.calls[0][0].amount).toBe(150); // 3 short × 50
    expect(inventoryService.reduceStock).toHaveBeenCalledWith(
      BIZ, ITEM, 3, 'S1', expect.objectContaining({ movementType: 'count' })
    );
    expect(r.qtyDelta).toBe(-3);
  });

  test('a surplus books the variance in as a count movement', async () => {
    stubItem(makeItem({ currentStock: 10, unitCostPrice: 50 }));
    const r = await svc.adjustStock(BIZ, ITEM, { type: 'count', countedQty: 12, reason: 'count_correction' }, USER);

    expect(inventoryService.applyPurchaseStock).toHaveBeenCalledWith(
      BIZ, ITEM, 2, 50, expect.objectContaining({ movementType: 'count' })
    );
    expect(r.qtyDelta).toBe(2);
  });

  test('a matching count is a no-op — no journal, no movement', async () => {
    stubItem(makeItem({ currentStock: 10 }));
    const r = await svc.adjustStock(BIZ, ITEM, { type: 'count', countedQty: 10, reason: 'count_correction' }, USER);

    expect(r.noChange).toBe(true);
    expect(postBalancedJournal).not.toHaveBeenCalled();
    expect(inventoryService.reduceStock).not.toHaveBeenCalled();
    expect(inventoryService.applyPurchaseStock).not.toHaveBeenCalled();
  });
});

describe('revalue (IAS 2)', () => {
  test('NRV write-down posts DR Write-off / CR Inventory and records a value-only movement', async () => {
    const item = makeItem({ currentStock: 10, unitCostPrice: 50 });
    stubItem(item);
    const r = await svc.adjustStock(BIZ, ITEM, { type: 'revalue', newUnitCost: 35, reason: 'nrv_write_down' }, USER);

    const [je] = postBalancedJournal.mock.calls[0];
    expect(je.amount).toBe(150);            // 10 × (50 − 35)
    expect(je.debitAccountId).toBe(WO_ACC);
    expect(je.creditAccountId).toBe(INV_ACC);
    expect(item.unitCostPrice).toBe(35);

    expect(stockMovementService.record).toHaveBeenCalledWith(
      expect.objectContaining({ movementType: 'revalue', qty: 0, value: 150, balanceQtyAfter: 10 }),
      { session: 'S1' }
    );
    expect(r.valueDelta).toBe(-150);
  });

  test('reversal is capped at the cumulative earlier write-downs (IAS 2.33)', async () => {
    mockSM.aggregate.mockReturnValue({ session: () => Promise.resolve([{ down: 150, up: 0 }]) });
    stubItem(makeItem({ currentStock: 10, unitCostPrice: 35 }));

    // Trying to go back to 60 = +250 > 150 of headroom → refused
    await expect(svc.adjustStock(BIZ, ITEM, { type: 'revalue', newUnitCost: 60, reason: 'nrv_reversal' }, USER))
      .rejects.toThrow(/only be written back up to its original cost/i);
    expect(postBalancedJournal).not.toHaveBeenCalled();
  });

  test('a reversal within the cap posts DR Inventory / CR Write-off', async () => {
    mockSM.aggregate.mockReturnValue({ session: () => Promise.resolve([{ down: 150, up: 0 }]) });
    stubItem(makeItem({ currentStock: 10, unitCostPrice: 35 }));

    const r = await svc.adjustStock(BIZ, ITEM, { type: 'revalue', newUnitCost: 50, reason: 'nrv_reversal' }, USER);
    const [je] = postBalancedJournal.mock.calls[0];
    expect(je.amount).toBe(150);            // exactly the headroom
    expect(je.debitAccountId).toBe(INV_ACC);
    expect(je.creditAccountId).toBe(WO_ACC);
    expect(r.valueDelta).toBe(150);
  });

  test('an unexplained increase is refused (needs nrv_reversal or cost_correction)', async () => {
    stubItem(makeItem({ currentStock: 10, unitCostPrice: 50 }));
    await expect(svc.adjustStock(BIZ, ITEM, { type: 'revalue', newUnitCost: 70, reason: 'other' }, USER))
      .rejects.toThrow(/needs a reason/i);
  });

  test('FIFO items are refused with a plain-language explanation', async () => {
    stubItem(makeItem({ valuationMethod: 'fifo' }));
    await expect(svc.adjustStock(BIZ, ITEM, { type: 'revalue', newUnitCost: 40, reason: 'nrv_write_down' }, USER))
      .rejects.toThrow(/uses FIFO batches/i);
  });

  test('revaluing an item with no stock is refused', async () => {
    stubItem(makeItem({ currentStock: 0 }));
    await expect(svc.adjustStock(BIZ, ITEM, { type: 'revalue', newUnitCost: 40, reason: 'nrv_write_down' }, USER))
      .rejects.toThrow(/no stock on hand/i);
  });
});
