jest.mock('../../../services/embeddingService', () => ({
  embedQuery: jest.fn(),
}));

jest.mock('../../../services/vectorStore.service', () => ({
  searchSimilar: jest.fn(),
  keywordSearch: jest.fn(),
}));

jest.mock('../../../services/rerankService', () => ({
  rerank: jest.fn(),
}));

const embeddingService = require('../../../services/embeddingService');
const vectorStore = require('../../../services/vectorStore.service');
const rerankService = require('../../../services/rerankService');
const ragQuery = require('../../../services/ragQuery.service');

describe('ragQuery service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RAG_MIN_SIMILARITY = '0.15';
    embeddingService.embedQuery.mockResolvedValue([1, 0, 0]);
    rerankService.rerank.mockResolvedValue([0]);
  });

  test('merges vector and keyword candidates with stable source metadata', async () => {
    vectorStore.searchSimilar.mockResolvedValue([
      {
        _id: 'v1',
        recordId: 'pnl-2026-06',
        dataType: 'monthly_pnl',
        period: '2026-06',
        summary: 'Revenue grew in June 2026',
        vectorScore: 0.8,
      },
    ]);
    vectorStore.keywordSearch.mockResolvedValue([
      {
        _id: 'v1',
        recordId: 'pnl-2026-06',
        dataType: 'monthly_pnl',
        period: '2026-06',
        summary: 'Revenue grew in June 2026',
        vectorScore: 1,
      },
    ]);

    const result = await ragQuery.getContext('64f000000000000000000001', 'How was revenue in June 2026?');

    expect(result.confident).toBe(true);
    expect(result.context).toContain('[Source 1: monthly_pnl | 2026-06]');
    expect(result.sources[0]).toEqual(expect.objectContaining({
      sourceRef: 'monthly_pnl:pnl-2026-06:2026-06',
      dataType: 'monthly_pnl',
      period: '2026-06',
    }));
    expect(vectorStore.searchSimilar).toHaveBeenCalledWith(
      [1, 0, 0],
      '64f000000000000000000001',
      expect.any(Number),
      expect.objectContaining({ periods: ['2026-06'] })
    );
  });

  test('refuses low-context questions after period fallback', async () => {
    vectorStore.searchSimilar.mockResolvedValue([]);
    vectorStore.keywordSearch.mockResolvedValue([]);

    const result = await ragQuery.getContext('64f000000000000000000001', 'xyz abc 123 in May 2026');

    expect(result.context).toBeNull();
    expect(result.confident).toBe(false);
    expect(result.retrievalStats.periodFallback).toBe(true);
  });

  test('period parser supports quarter and month phrases', () => {
    expect(ragQuery.parsePeriodHints('Compare Q1 2026 revenue')).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(ragQuery.parsePeriodHints('Cash flow in April 2026')).toEqual(['2026-04']);
  });
});
