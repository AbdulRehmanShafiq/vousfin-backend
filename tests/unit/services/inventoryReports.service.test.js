/**
 * tests/unit/services/inventoryReports.service.test.js
 *
 * Inventory Engine Phase 10 — the reporting contract that matters most:
 * every report is DERIVED from the stock sub-ledger, so no two reports may
 * disagree about the same stock.
 *
 * The regression this locks down: aging valued its age bands at what each
 * receipt originally cost, while its own `value` column used the item's
 * current carrying cost. A revaluation split the two apart — one line of one
 * report contradicting itself, and the report total contradicting the
 * balance sheet.
 */
'use strict';

const mockMovement = { aggregate: jest.fn() };
const mockItem = { find: jest.fn() };

jest.mock('mongoose', () => ({
  Types: { ObjectId: Object.assign(function (v) { return String(v); }, { isValid: () => true }) },
}));
jest.mock('../../../models/StockMovement.model', () => mockMovement);
jest.mock('../../../models/InventoryItem.model', () => mockItem);
jest.mock('../../../models/Invoice.model', () => ({ aggregate: jest.fn() }), { virtual: true });

const reports = require('../../../services/inventoryReports.service');

const BIZ = 'biz1';
const ITEM = 'item1';
const leaned = (v) => ({ select: () => ({ lean: () => Promise.resolve(v) }) });

/**
 * Mirrors the live "Infinix hot 60i" that surfaced the bug:
 *   opening       +2 @ 48,000 = 96,000
 *   write_off     -1           = 48,000
 *   adjustment_in +1 @ 48,000  = 48,000
 *   revalue        0 qty, -4,000 value   ← re-marks the holding
 * On hand: 2 units worth 92,000 (46,000 each), all received today.
 */
const MOVEMENTS = [
  { type: 'opening',       direction: 'in',  qty: 2, value: 96000, movementDate: new Date() },
  { type: 'write_off',     direction: 'out', qty: 1, value: 48000, movementDate: new Date() },
  { type: 'adjustment_in', direction: 'in',  qty: 1, value: 48000, movementDate: new Date() },
  { type: 'revalue',       direction: 'out', qty: 0, value: 4000,  movementDate: new Date() },
];

const netQty = MOVEMENTS.reduce((s, m) => s + (m.direction === 'in' ? m.qty : -m.qty), 0);
const netValue = MOVEMENTS.reduce((s, m) => s + (m.direction === 'in' ? m.value : -m.value), 0);

beforeEach(() => {
  jest.clearAllMocks();
  mockItem.find.mockReturnValue(leaned([{ _id: ITEM, name: 'Infinix hot 60i', sku: null, unit: 'unit' }]));
  // aggregate() is called for on-hand totals first, then for the receipt walk.
  mockMovement.aggregate
    .mockResolvedValueOnce([{ _id: ITEM, qty: netQty, value: netValue }])
    .mockResolvedValueOnce([{
      _id: ITEM,
      receipts: MOVEMENTS.filter((m) => m.direction === 'in' && m.qty > 0)
        .map((m) => ({ qty: m.qty, movementDate: m.movementDate })),
    }]);
});

describe('inventory aging', () => {
  it('values the age bands at the carrying cost, not the original receipt cost', async () => {
    const res = await reports.aging(BIZ);
    const line = res.lines[0];

    // 2 units × 46,000 carrying — NOT 2 × 48,000 as originally received.
    expect(line.value).toBe(92000);
    expect(res.totalValue).toBe(92000);
    expect(res.totals[0]).toBe(92000);
  });

  it('never lets a line contradict itself — the bands always sum to the value', async () => {
    const res = await reports.aging(BIZ);
    for (const line of res.lines) {
      const summed = line.buckets.reduce((s, b) => s + b, 0);
      expect(Math.round(summed * 100) / 100).toBe(line.value);
    }
  });

  it('ties to the valuation report, because both replay the same sub-ledger', async () => {
    const aging = await reports.aging(BIZ);

    mockMovement.aggregate.mockReset();
    mockMovement.aggregate.mockResolvedValueOnce([{ _id: ITEM, qty: netQty, value: netValue }]);
    mockItem.find.mockReturnValue(leaned([{ _id: ITEM, name: 'Infinix hot 60i', sku: null, unit: 'unit' }]));
    const valuation = await reports.valuationAsOf(BIZ, new Date());

    expect(aging.totalValue).toBe(valuation.totalValue);
  });

  it('ages stock by when it arrived, splitting quantity across the bands', async () => {
    const old = new Date(Date.now() - 200 * 86400000);
    mockMovement.aggregate.mockReset();
    mockMovement.aggregate
      .mockResolvedValueOnce([{ _id: ITEM, qty: 3, value: 300 }])
      .mockResolvedValueOnce([{ _id: ITEM, receipts: [
        { qty: 1, movementDate: new Date() },
        { qty: 2, movementDate: old },
      ] }]);

    const res = await reports.aging(BIZ);
    const line = res.lines[0];
    expect(line.qtyBuckets[0]).toBe(1);                        // 0-30 days
    expect(line.qtyBuckets[line.qtyBuckets.length - 1]).toBe(2); // 181+ days
    expect(line.buckets[0]).toBe(100);
    expect(line.buckets[line.buckets.length - 1]).toBe(200);
  });

  it('drops items the sub-ledger says are no longer on hand', async () => {
    mockMovement.aggregate.mockReset();
    mockMovement.aggregate
      .mockResolvedValueOnce([])   // everything sold through
      .mockResolvedValueOnce([]);
    const res = await reports.aging(BIZ);
    expect(res.lines).toEqual([]);
    expect(res.totalValue).toBe(0);
  });
});

/**
 * Margin by item — revenue and COGS must answer to the same authority.
 *
 * The regression this locks down: revenue was filtered on the invoice's
 * workflow `state`, so an invoice that reached 'sent' WITHOUT ever posting its
 * AR/revenue journal still contributed revenue, while COGS (read from the
 * sub-ledger, which only moves when the invoice posts) found nothing behind it
 * — reporting a bogus 100% margin that the income statement disagreed with.
 * Per CLAUDE.md: reports derive from accounting records; a report may never
 * disagree with them. So revenue counts an invoice only once it has posted.
 */
describe('margin by item', () => {
  const Invoice = require('../../../models/Invoice.model');

  /** The $match stage the revenue side runs against the invoices collection. */
  async function revenueMatch() {
    Invoice.aggregate.mockResolvedValueOnce([]);
    mockMovement.aggregate.mockReset();
    mockMovement.aggregate.mockResolvedValueOnce([]);
    mockItem.find.mockReturnValue(leaned([]));
    await reports.marginByItem(BIZ, {});
    return Invoice.aggregate.mock.calls[0][0][0].$match;
  }

  it('counts revenue only from invoices that actually posted to the ledger', async () => {
    const match = await revenueMatch();
    // An unposted invoice has neither journal id; requiring one is what keeps
    // this report tied to the income statement.
    expect(match.$or).toEqual(
      expect.arrayContaining([
        { arJournalId: { $ne: null } },
        { linkedJournalEntryId: { $ne: null } },
      ])
    );
  });

  it('excludes voided invoices by their real state name', async () => {
    const match = await revenueMatch();
    // The enum member is 'voided'. The filter used to exclude the string 'void',
    // which is not a state any invoice can hold — so voided invoices, whose
    // revenue is reversed out of the GL, were still counted as revenue here.
    expect(match.state.$nin).toContain('voided');
  });
});
