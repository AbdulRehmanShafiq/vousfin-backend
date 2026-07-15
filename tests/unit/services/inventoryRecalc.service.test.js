/**
 * tests/unit/services/inventoryRecalc.service.test.js
 *
 * R-04 — inventory cost recalculation. Replays an item's stock movements (from
 * the journal) to recompute the correct on-hand qty + weighted-average cost,
 * detects drift from the stored values, and (when post=true) heals the item and
 * books one balanced Inventory↔COGS adjustment for the value delta.
 */
'use strict';

const mockJE   = { find: jest.fn() };
const mockItem = { findOne: jest.fn() };

jest.mock('mongoose', () => ({
  model: () => ({}),
  Types: { ObjectId: Object.assign(function (v) { return v; }, { isValid: () => true }) },
}));
jest.mock('../../../models/InventoryItem.model', () => mockItem);
jest.mock('../../../models/JournalEntry.model', () => mockJE);
jest.mock('../../../services/inventory.service', () => ({
  resolveCostAccounts: jest.fn().mockResolvedValue({ cogsAccountId: 'COGS', inventoryAccountId: 'INV' }),
}));
jest.mock('../../../services/ledgerPosting.service', () => ({ postBalancedJournal: jest.fn().mockResolvedValue({ _id: 'adj-je' }) }));
jest.mock('../../../utils/withTransaction', () => ({ withTransaction: (fn) => fn(null) }));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const recalc = require('../../../services/inventoryRecalc.service');
const ledgerPosting = require('../../../services/ledgerPosting.service');
const { TRANSACTION_TYPES } = require('../../../config/constants');

const BIZ = '507f1f77bcf86cd799439060';
const ITEM = '507f1f77bcf86cd799439071';

// Movement history: buy 10 @ 100, buy 10 @ 120 (WAC→110), sell 5 (qty→15, WAC 110).
const MOVEMENTS = [
  { transactionType: TRANSACTION_TYPES.CREDIT_PURCHASE, inventoryQty: 10, amount: 1000, transactionDate: new Date('2026-01-01') },
  { transactionType: TRANSACTION_TYPES.CREDIT_PURCHASE, inventoryQty: 10, amount: 1200, transactionDate: new Date('2026-01-05') },
  { transactionType: TRANSACTION_TYPES.CREDIT_SALE,     inventoryQty: 5,  amount: 800,  transactionDate: new Date('2026-01-10') },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockJE.find.mockReturnValue({ sort: () => ({ select: () => ({ lean: () => Promise.resolve(MOVEMENTS) }) }) });
});

describe('replayItem()', () => {
  it('recomputes on-hand qty and weighted-average cost from movements', async () => {
    const r = await recalc.replayItem(BIZ, ITEM);
    expect(r.correctQty).toBe(15);     // 10 + 10 − 5
    expect(r.correctWac).toBe(110);    // (1000 + 1200) / 20
    expect(r.correctValue).toBe(1650); // 15 × 110
    expect(r.replayedCogs).toBe(550);  // 5 × 110
  });
});

describe('recalculateItem()', () => {
  it('reports in-sync when stored values already match the replay (no post)', async () => {
    mockItem.findOne.mockResolvedValue({ _id: ITEM, name: 'Pen', businessId: BIZ, currentStock: 15, unitCostPrice: 110, save: jest.fn() });
    const report = await recalc.recalculateItem(BIZ, ITEM, { post: false });
    expect(report.inSync).toBe(true);
    expect(report.applied).toBe(false);
    expect(ledgerPosting.postBalancedJournal).not.toHaveBeenCalled();
  });

  it('detects drift but does not write when post=false', async () => {
    mockItem.findOne.mockResolvedValue({ _id: ITEM, name: 'Pen', businessId: BIZ, currentStock: 15, unitCostPrice: 90, save: jest.fn() });
    const report = await recalc.recalculateItem(BIZ, ITEM, { post: false });
    expect(report.inSync).toBe(false);
    expect(report.valueVariance).toBe(300); // correct 1650 − stored (15×90=1350)
    expect(report.applied).toBe(false);
    expect(ledgerPosting.postBalancedJournal).not.toHaveBeenCalled();
  });

  it('heals the item and posts a DR Inventory / CR COGS adjustment when undervalued (post=true)', async () => {
    const save = jest.fn();
    const item = { _id: ITEM, name: 'Pen', businessId: BIZ, currentStock: 15, unitCostPrice: 90, save };
    mockItem.findOne.mockResolvedValue(item);

    const report = await recalc.recalculateItem(BIZ, ITEM, { post: true, user: { _id: 'u1' } });

    expect(item.currentStock).toBe(15);
    expect(item.unitCostPrice).toBe(110);   // healed to replayed WAC
    expect(save).toHaveBeenCalled();
    const entry = ledgerPosting.postBalancedJournal.mock.calls[0][0];
    expect(entry.amount).toBe(300);
    expect(entry.debitAccountId).toBe('INV');  // undervalued → inventory up
    expect(entry.creditAccountId).toBe('COGS');
    expect(report.applied).toBe(true);
    expect(report.adjustmentJournalId).toBe('adj-je');
  });
});

// INV-4 — FIFO items replay through cost layers and the heal rebuilds them,
// so Σ(layers.qty) always equals currentStock after a recalculation.
describe('replayItem() / recalculateItem() — FIFO (INV-4)', () => {
  it('replays purchases as layers and consumes sales oldest-first', async () => {
    const r = await recalc.replayItem(BIZ, ITEM, 'fifo');
    // buy 10 @ 100, buy 10 @ 120, sell 5 → consumes the @100 layer first
    expect(r.correctQty).toBe(15);
    expect(r.replayedCogs).toBe(500);                 // 5 × 100 (NOT 5 × 110 WAC)
    expect(r.correctValue).toBe(1700);                // 5×100 + 10×120
    expect(r.correctLayers).toEqual([
      { qty: 5,  unitCost: 100 },
      { qty: 10, unitCost: 120 },
    ]);
    expect(r.correctWac).toBeCloseTo(113.33, 2);      // 1700 / 15 summary
  });

  it('healing a FIFO item rebuilds costLayers together with qty/WAC', async () => {
    const save = jest.fn();
    const item = {
      _id: ITEM, name: 'Pen', businessId: BIZ, valuationMethod: 'fifo',
      currentStock: 15, unitCostPrice: 90,
      costLayers: [{ qty: 99, unitCost: 1 }], // stale garbage layers
      save,
    };
    mockItem.findOne.mockResolvedValue(item);

    const report = await recalc.recalculateItem(BIZ, ITEM, { post: true, user: { _id: 'u1' } });

    expect(report.applied).toBe(true);
    expect(item.currentStock).toBe(15);
    expect(item.costLayers).toEqual([
      { qty: 5,  unitCost: 100 },
      { qty: 10, unitCost: 120 },
    ]);
    // Layer sum must equal the healed on-hand quantity
    const layerQty = item.costLayers.reduce((s, l) => s + l.qty, 0);
    expect(layerQty).toBe(item.currentStock);
  });
});
