'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../models/SearchLog.model', () => ({
  create: jest.fn(),
  aggregate: jest.fn(),
}));

const SearchLog = require('../../../models/SearchLog.model');
const svc = require('../../../services/searchAnalytics.service');

const BIZ = '507f1f77bcf86cd799439060';

beforeEach(() => jest.clearAllMocks());

describe('logSearch', () => {
  it('normalizes + hashes the query and stores it WITHOUT any userId', async () => {
    SearchLog.create.mockResolvedValue({});
    await svc.logSearch({ businessId: BIZ, kind: 'catalog', query: '  Who Owes Me  ', noResult: true });
    const doc = SearchLog.create.mock.calls[0][0];
    expect(doc.query).toBe('who owes me');
    expect(doc.queryHash).toHaveLength(64); // sha256 hex
    expect(doc.noResult).toBe(true);
    expect('userId' in doc).toBe(false);
  });

  it('ignores empty queries (no row written)', async () => {
    await svc.logSearch({ businessId: BIZ, query: '   ' });
    expect(SearchLog.create).not.toHaveBeenCalled();
  });

  it('never throws — logging must not break the response path', async () => {
    SearchLog.create.mockRejectedValue(new Error('db down'));
    await expect(svc.logSearch({ businessId: BIZ, query: 'x' })).resolves.toBeUndefined();
  });
});

describe('getInsights', () => {
  it('returns totals (with CTR%), top queries and the no-result content-gap backlog', async () => {
    SearchLog.aggregate
      .mockResolvedValueOnce([{ _id: null, searches: 50, clicks: 40, noResults: 5 }]) // totals
      .mockResolvedValueOnce([{ _id: 'invoices', count: 12 }, { _id: 'who owes me', count: 8 }]) // top
      .mockResolvedValueOnce([{ _id: 'split bill', count: 4 }]); // gaps

    const out = await svc.getInsights(BIZ, { days: 30 });
    expect(out.totals).toMatchObject({ searches: 50, clicks: 40, noResults: 5, ctr: 80 });
    expect(out.topQueries[0]).toEqual({ query: 'invoices', count: 12 });
    expect(out.gaps).toEqual([{ query: 'split bill', count: 4 }]);
  });

  it('handles an empty window without dividing by zero', async () => {
    SearchLog.aggregate.mockResolvedValue([]);
    const out = await svc.getInsights(BIZ, {});
    expect(out.totals).toMatchObject({ searches: 0, clicks: 0, ctr: 0 });
    expect(out.topQueries).toEqual([]);
  });
});
