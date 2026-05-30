/**
 * tests/unit/services/forecastPlatform.datasetBuilder.test.js
 *
 * Forecast Platform — Foundation (F1). Dataset builder ETL:
 * tenant-scoped multi-source extraction → currency/tz normalization →
 * granularity re-bucketing → contiguous gap-fill → validation.
 */
'use strict';

jest.mock('../../../models/JournalEntry.model', () => ({ aggregate: jest.fn() }));
jest.mock('../../../models/Invoice.model', () => ({ aggregate: jest.fn() }));
jest.mock('../../../models/Bill.model', () => ({ aggregate: jest.fn() }));
jest.mock('../../../services/fx.service', () => ({
  getBaseCurrency: jest.fn().mockResolvedValue('USD'),
  convert: jest.fn(),
}));

const builder = require('../../../services/forecasting/platform/datasetBuilder.service');
const JournalEntry = require('../../../models/JournalEntry.model');
const Invoice = require('../../../models/Invoice.model');
const Bill = require('../../../models/Bill.model');

const BIZ = '507f1f77bcf86cd799439060';

beforeEach(() => {
  jest.clearAllMocks();
  JournalEntry.aggregate.mockResolvedValue([
    { _id: { y: 2026, m: 1, d: 5,  ccy: 'USD' }, date: new Date('2026-01-05'), revenue: 100, expenses: 60, entries: 3 },
    { _id: { y: 2026, m: 1, d: 20, ccy: 'USD' }, date: new Date('2026-01-20'), revenue: 50,  expenses: 20, entries: 2 },
    { _id: { y: 2026, m: 2, d: 10, ccy: 'USD' }, date: new Date('2026-02-10'), revenue: 120, expenses: 70, entries: 4 },
  ]);
  Invoice.aggregate.mockResolvedValue([
    { _id: { y: 2026, m: 1, d: 5, ccy: 'USD' }, date: new Date('2026-01-05'), amount: 200, count: 1 },
  ]);
  Bill.aggregate.mockResolvedValue([
    { _id: { y: 2026, m: 2, d: 10, ccy: 'USD' }, date: new Date('2026-02-10'), amount: 80, count: 1 },
  ]);
});

describe('buildDataset (monthly)', () => {
  it('aggregates daily ledger buckets into monthly periods, normalized + validated', async () => {
    const { meta, rows, validation, contentHash } = await builder.buildDataset(BIZ, {
      granularity: 'monthly', sources: ['journal_entries', 'invoices', 'bills'],
      monthsBack: 6, asOf: new Date('2026-03-01'),
    });

    expect(meta.baseCurrency).toBe('USD');
    expect(meta.granularity).toBe('monthly');
    const jan = rows.find((r) => r.periodKey === '2026-01');
    const feb = rows.find((r) => r.periodKey === '2026-02');
    expect(jan.revenue).toBe(150);   // 100 + 50
    expect(jan.expenses).toBe(80);   // 60 + 20
    expect(jan.arNew).toBe(200);     // invoice issued in Jan
    expect(feb.revenue).toBe(120);
    expect(feb.apNew).toBe(80);      // bill issued in Feb
    expect(feb.netCashFlow).toBe(50);
    expect(validation.passed).toBe(true);
    expect(contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('gap-fills missing periods so the series is contiguous', async () => {
    // Data in Jan and Mar only — February is a genuine gap that must be imputed.
    JournalEntry.aggregate.mockResolvedValueOnce([
      { _id: { y: 2026, m: 1, d: 5,  ccy: 'USD' }, date: new Date('2026-01-05'), revenue: 100, expenses: 60, entries: 3 },
      { _id: { y: 2026, m: 3, d: 8,  ccy: 'USD' }, date: new Date('2026-03-08'), revenue: 90,  expenses: 50, entries: 2 },
    ]);
    Invoice.aggregate.mockResolvedValueOnce([]);
    Bill.aggregate.mockResolvedValueOnce([]);

    const { rows } = await builder.buildDataset(BIZ, { granularity: 'monthly', monthsBack: 6, asOf: new Date('2026-03-15') });
    expect(rows.map((r) => r.periodKey)).toEqual(['2026-01', '2026-02', '2026-03']);
    const feb = rows.find((r) => r.periodKey === '2026-02');
    expect(feb.imputed).toBe(true);
    expect(feb.revenue).toBe(0);
  });

  it('rejects a missing tenant id (isolation guard)', async () => {
    await expect(builder.buildDataset(null, { granularity: 'monthly' })).rejects.toThrow();
  });

  it('exposes the live vs declared source contract', () => {
    expect(builder.sources.live).toContain('journal_entries');
    expect(builder.sources.declared).toContain('macro_indicators');
  });
});
