// tests/unit/services/profitability.service.test.js
'use strict';
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockAggregate = jest.fn();
jest.mock('../../../models/JournalEntry.model', () => ({ aggregate: (...a) => mockAggregate(...a) }));
jest.mock('../../../repositories/transaction.repository', () => ({
  EFFECTIVE_LINES_STAGE: { $addFields: { effectiveLines: '$x' } },
  REPORT_STATUSES: ['posted', 'partially_settled', 'settled'],
}));

const BIZ = '507f1f77bcf86cd799439011';
const C1 = '507f1f77bcf86cd799439a01';
const C2 = '507f1f77bcf86cd799439a02';

jest.mock('../../../models/Customer.model', () => ({ find: jest.fn(() => ({ lean: () => Promise.resolve([{ _id: '507f1f77bcf86cd799439a01', name: 'Acme' }]) })) }));
jest.mock('../../../models/InventoryItem.model', () => ({ find: jest.fn(() => ({ lean: () => Promise.resolve([]) })) }));
jest.mock('../../../repositories/costCenter.repository', () => ({ findByBusiness: jest.fn(() => Promise.resolve([])) }));

const profitability = require('../../../services/profitability.service');

describe('profitability.byDimension', () => {
  beforeEach(() => jest.clearAllMocks());
  test('computes revenue, variable cost, gross margin, GM%, loss-maker flag', async () => {
    mockAggregate.mockResolvedValue([
      { _id: C1, revenue: 540000, variableCost: 360000 },
      { _id: C2, revenue: 100000, variableCost: 130000 },
    ]);
    const out = await profitability.byDimension(BIZ, 'customer', { from: '2026-01-01', to: '2026-12-31' });
    const a = out.segments.find((s) => s.id === C1);
    const b = out.segments.find((s) => s.id === C2);
    expect(a).toMatchObject({ revenue: 540000, variableCost: 360000, grossMargin: 180000, lossMaker: false });
    expect(a.name).toBe('Acme');
    expect(Math.round(a.grossMarginPct * 1000) / 1000).toBe(0.333);
    expect(b).toMatchObject({ grossMargin: -30000, lossMaker: true });
    expect(out.totals.grossMargin).toBe(150000);
  });
  test('rejects an unknown dimension', async () => {
    await expect(profitability.byDimension(BIZ, 'galaxy', {})).rejects.toThrow(/dimension/i);
  });
});
