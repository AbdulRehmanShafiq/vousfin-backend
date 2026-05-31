/**
 * tests/unit/services/hierarchical.service.test.js
 *
 * Forecast Platform — B1. By-stream assembly + reconciliation (parts sum to total).
 */
'use strict';

jest.mock('../../../models/JournalEntry.model', () => ({ aggregate: jest.fn() }));

const svc = require('../../../services/forecasting/hierarchical.service');
const JournalEntry = require('../../../models/JournalEntry.model');

const BIZ = '507f1f77bcf86cd799439060';
beforeEach(() => jest.clearAllMocks());

describe('reconcile (pure)', () => {
  it('rescales streams so they sum exactly to the reconciled total', () => {
    const direct = [100, 120];
    const streams = [
      { name: 'A', forecast: [40, 50] },
      { name: 'B', forecast: [40, 50] },
    ]; // bottom-up = [80, 100]; reconciled total = [(100+80)/2, (120+100)/2] = [90, 110]
    const r = svc.reconcile(direct, streams, 'proportional');
    expect(r.total).toEqual([90, 110]);
    // adjusted streams sum to the reconciled total (within rounding)
    r.total.forEach((t, h) => {
      const sum = r.streams.reduce((s, st) => s + st.forecast[h], 0);
      expect(Math.abs(sum - t)).toBeLessThanOrEqual(1);
    });
  });

  it('bottom_up uses the sum of streams as the total', () => {
    const r = svc.reconcile([999, 999], [{ name: 'A', forecast: [30, 30] }, { name: 'B', forecast: [20, 20] }], 'bottom_up');
    expect(r.total).toEqual([50, 50]);
  });
});

describe('assembleStreams (pure)', () => {
  it('aligns per-account monthly series and lumps the tail into Other', () => {
    const rows = [
      { accountName: 'Sales', year: 2026, month: 1, amount: 1000 },
      { accountName: 'Sales', year: 2026, month: 2, amount: 1200 },
      { accountName: 'Services', year: 2026, month: 1, amount: 500 },
      { accountName: 'Misc', year: 2026, month: 2, amount: 50 },
    ];
    const { months, streams, total } = svc.assembleStreams(rows, 5);
    expect(months).toEqual(['2026-01', '2026-02']);
    const sales = streams.find((s) => s.name === 'Sales');
    expect(sales.series).toEqual([1000, 1200]);
    expect(total).toEqual([1500, 1250]);  // Jan: 1000+500, Feb: 1200+50
  });

  it('lumps streams beyond topN into Other', () => {
    const rows = ['A', 'B', 'C'].flatMap((name, i) => [{ accountName: name, year: 2026, month: 1, amount: (3 - i) * 100 }]);
    const { streams } = svc.assembleStreams(rows, 2);
    expect(streams.map((s) => s.name)).toEqual(['A', 'B', 'Other']);
  });
});

describe('forecast (orchestrator)', () => {
  it('returns reconciled streams + total for a multi-stream business', async () => {
    const rows = [];
    for (let m = 1; m <= 8; m++) {
      rows.push({ accountName: 'Sales',    year: 2026, month: m, amount: 1000 + m * 50 });
      rows.push({ accountName: 'Services', year: 2026, month: m, amount: 400 + m * 20 });
    }
    JournalEntry.aggregate.mockResolvedValue(rows);
    const r = await svc.forecast(BIZ, { target: 'Revenue', horizon: 3 });
    expect(r.streams.length).toBeGreaterThanOrEqual(2);
    expect(r.total).toHaveLength(3);
    // reconciled parts sum to the total
    r.total.forEach((t, h) => {
      const sum = r.streams.reduce((s, st) => s + st.forecast[h], 0);
      expect(Math.abs(sum - t)).toBeLessThanOrEqual(2);
    });
  });

  it('returns insufficient when there are no streams', async () => {
    JournalEntry.aggregate.mockResolvedValue([]);
    expect((await svc.forecast(BIZ, { target: 'Revenue' })).insufficient).toBe(true);
  });
});
