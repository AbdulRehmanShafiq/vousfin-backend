const mongoose = require('mongoose');

jest.mock('../../../models/VectorDocument.model', () => ({
  aggregate: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  deleteMany: jest.fn(),
  deleteOne: jest.fn(),
  countDocuments: jest.fn(),
}));

const VectorDocument = require('../../../models/VectorDocument.model');
const vectorStore = require('../../../services/vectorStore.service');

function mockFindResults(results) {
  const lean = jest.fn().mockResolvedValue(results);
  const limit = jest.fn().mockReturnValue({ lean });
  VectorDocument.find.mockReturnValue({ limit });
  return { limit, lean };
}

describe('vectorStore tenant isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VECTOR_SEARCH_DISABLE = '';
  });

  test('Atlas vector search includes mandatory businessId prefilter', async () => {
    const businessId = new mongoose.Types.ObjectId();
    VectorDocument.aggregate.mockResolvedValue([]);

    await vectorStore.searchSimilar([1, 0, 0], businessId, 10);

    const pipeline = VectorDocument.aggregate.mock.calls[0][0];
    expect(pipeline[0].$vectorSearch.filter.businessId.toString()).toBe(businessId.toString());
  });

  test('Atlas path post-filter strips a leaked cross-tenant document', async () => {
    // Defense-in-depth: even if the Atlas $vectorSearch pre-filter were ever
    // mis-configured (or the index dropped the businessId filter) and the
    // aggregate returned another tenant's document, the application-layer
    // post-filter MUST strip it before any summary leaves the boundary.
    const businessA = new mongoose.Types.ObjectId();
    const businessB = new mongoose.Types.ObjectId();
    VectorDocument.aggregate.mockResolvedValue([
      {
        _id: 'a',
        businessId: businessA,
        recordId: 'a',
        dataType: 'monthly_pnl',
        period: '2026-06',
        summary: 'Own-tenant revenue summary',
        vectorScore: 0.91,
      },
      {
        _id: 'b',
        businessId: businessB,
        recordId: 'b',
        dataType: 'monthly_pnl',
        period: '2026-06',
        summary: 'Leaked other-tenant summary',
        vectorScore: 0.99,
      },
    ]);

    const results = await vectorStore.searchSimilar([1, 0, 0], businessA, 10);

    expect(results).toHaveLength(1);
    expect(String(results[0].businessId)).toBe(String(businessA));
    expect(results.map((r) => r.summary)).not.toContain('Leaked other-tenant summary');
  });

  test('local fallback queries and returns only the requested business', async () => {
    const businessA = new mongoose.Types.ObjectId();
    const businessB = new mongoose.Types.ObjectId();
    VectorDocument.aggregate.mockRejectedValue(new Error('$vectorSearch is unavailable'));
    mockFindResults([
      {
        _id: 'a',
        businessId: businessA,
        recordId: 'a',
        dataType: 'monthly_pnl',
        period: '2026-06',
        summary: 'Revenue summary for the current period',
        embedding: [1, 0, 0],
      },
      {
        _id: 'b',
        businessId: businessB,
        recordId: 'b',
        dataType: 'monthly_pnl',
        period: '2026-06',
        summary: 'Leaked tenant summary',
        embedding: [1, 0, 0],
      },
    ]);

    const results = await vectorStore.searchSimilar([1, 0, 0], businessA, 10, {
      queryText: 'revenue',
    });

    expect(VectorDocument.find).toHaveBeenCalledWith({ businessId: businessA });
    expect(results).toHaveLength(1);
    expect(String(results[0].businessId)).toBe(String(businessA));
  });
});
