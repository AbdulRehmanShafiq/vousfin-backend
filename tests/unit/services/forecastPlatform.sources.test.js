/**
 * tests/unit/services/forecastPlatform.sources.test.js
 *
 * Forecast Platform — F2. New source extractors: payments (cash flow), payroll,
 * customer/vendor behavior (flow), and assets/liabilities/inventory (snapshot).
 */
'use strict';

jest.mock('../../../models/JournalEntry.model', () => ({ aggregate: jest.fn() }));
jest.mock('../../../models/Invoice.model', () => ({ aggregate: jest.fn() }));
jest.mock('../../../models/Bill.model', () => ({ aggregate: jest.fn() }));
jest.mock('../../../models/Payment.model', () => ({ aggregate: jest.fn() }));
jest.mock('../../../models/ChartOfAccount.model', () => ({ aggregate: jest.fn() }));
jest.mock('../../../models/InventoryItem.model', () => ({ aggregate: jest.fn() }));
jest.mock('../../../services/fx.service', () => ({ getBaseCurrency: jest.fn().mockResolvedValue('USD'), convert: jest.fn() }));

const builder = require('../../../services/forecasting/platform/datasetBuilder.service');
const JournalEntry = require('../../../models/JournalEntry.model');
const Invoice = require('../../../models/Invoice.model');
const Bill = require('../../../models/Bill.model');
const Payment = require('../../../models/Payment.model');
const ChartOfAccount = require('../../../models/ChartOfAccount.model');
const InventoryItem = require('../../../models/InventoryItem.model');

const BIZ = '507f1f77bcf86cd799439060';

beforeEach(() => {
  jest.clearAllMocks();
  JournalEntry.aggregate.mockResolvedValue([]);
  Invoice.aggregate.mockResolvedValue([]);
  Bill.aggregate.mockResolvedValue([]);
  Payment.aggregate.mockResolvedValue([]);
  ChartOfAccount.aggregate.mockResolvedValue([]);
  InventoryItem.aggregate.mockResolvedValue([]);
});

it('advertises the new sources as live and only macro as declared', () => {
  expect(builder.sources.live).toEqual(expect.arrayContaining(['payments', 'payroll', 'customer_behavior', 'vendor_behavior', 'assets', 'liabilities', 'inventory']));
  expect(builder.sources.declared).toEqual(['macro_indicators']);
});

it('aggregates payments into per-period cash inflow / outflow', async () => {
  Payment.aggregate.mockResolvedValue([
    { _id: { y: 2026, m: 1, d: 5, ccy: 'USD', dir: 'inbound' },  date: new Date('2026-01-05'), amount: 300 },
    { _id: { y: 2026, m: 1, d: 9, ccy: 'USD', dir: 'outbound' }, date: new Date('2026-01-09'), amount: 120 },
  ]);
  const { rows } = await builder.buildDataset(BIZ, { granularity: 'monthly', sources: ['payments'], monthsBack: 6, asOf: new Date('2026-02-01') });
  const jan = rows.find((r) => r.periodKey === '2026-01');
  expect(jan.cashInflow).toBe(300);
  expect(jan.cashOutflow).toBe(120);
});

it('counts distinct active customers + new invoices (customer behavior)', async () => {
  Invoice.aggregate.mockResolvedValue([
    { _id: { y: 2026, m: 1, d: 5 }, date: new Date('2026-01-05'), parties: ['c1', 'c2'], count: 2 },
    { _id: { y: 2026, m: 1, d: 20 }, date: new Date('2026-01-20'), parties: ['c2', 'c3'], count: 1 },
  ]);
  const { rows } = await builder.buildDataset(BIZ, { granularity: 'monthly', sources: ['customer_behavior'], monthsBack: 6, asOf: new Date('2026-02-01') });
  const jan = rows.find((r) => r.periodKey === '2026-01');
  expect(jan.activeCustomers).toBe(3);     // {c1,c2,c3}
  expect(jan.newInvoices).toBe(3);          // 2 + 1
});

it('attaches assets/liabilities + inventory snapshots to the latest period', async () => {
  // one journal data point so there is a period axis
  JournalEntry.aggregate.mockResolvedValue([
    { _id: { y: 2026, m: 1, d: 5, ccy: 'USD' }, date: new Date('2026-01-05'), revenue: 100, expenses: 40, entries: 1 },
  ]);
  ChartOfAccount.aggregate.mockResolvedValue([
    { _id: 'Asset', total: 5000 }, { _id: 'Liability', total: 2000 }, { _id: 'Equity', total: 3000 },
  ]);
  InventoryItem.aggregate.mockResolvedValue([{ _id: null, stockValue: 1500, items: 12, lowStock: 2 }]);

  const { rows } = await builder.buildDataset(BIZ, {
    granularity: 'monthly', sources: ['journal_entries', 'assets', 'liabilities', 'inventory'],
    monthsBack: 6, asOf: new Date('2026-01-31'),
  });
  const latest = rows[rows.length - 1];
  expect(latest.totalAssets).toBe(5000);
  expect(latest.totalLiabilities).toBe(2000);
  expect(latest.equity).toBe(3000);
  expect(latest.inventoryValue).toBe(1500);
  expect(latest.lowStockCount).toBe(2);
});
