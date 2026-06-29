jest.mock('../../../services/aiAssistant.service', () => ({
  chat: jest.fn(),
  chatStream: jest.fn(),
}));

jest.mock('../../../services/ragQuery.service', () => ({
  semanticSearch: jest.fn(),
}));

jest.mock('../../../jobs/ragIndexer.job', () => ({
  runFullIndex: jest.fn(),
  indexBusinessById: jest.fn(),
}));

jest.mock('../../../services/anomalyDetection.service', () => ({}));
jest.mock('../../../services/accountantSuggestions.service', () => ({}));
jest.mock('../../../services/nlParser/services/parserService', () => ({}));
jest.mock('../../../services/forecasting/lstmForecastService', () => ({
  generateLSTMForecast: jest.fn(),
}));
jest.mock('../../../services/financialIntelligence.service', () => ({
  getFinancialInsights: jest.fn(),
}));
jest.mock('../../../utils/forecastResponse.helper', () => ({
  METRIC_API_TO_TARGET: {},
  formatForecastApiResponse: jest.fn(),
}));

const aiAssistant = require('../../../services/aiAssistant.service');
const ragIndexer = require('../../../jobs/ragIndexer.job');
const ctrl = require('../../../controllers/ai.controller');

const mkJsonRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

const mkSseRes = () => {
  const res = { headersSent: false };
  res.status = jest.fn(() => res);
  res.setHeader = jest.fn(() => res);
  res.flushHeaders = jest.fn(() => {
    res.headersSent = true;
  });
  res.write = jest.fn(() => true);
  res.end = jest.fn(() => res);
  return res;
};

const req = (over = {}) => ({
  user: { businessId: 'biz1', id: 'user1', role: 'owner' },
  body: {},
  params: {},
  query: {},
  ...over,
});

describe('ai.controller RAG endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'test';
  });

  test('streaming endpoint emits meta, token, and done events', async () => {
    aiAssistant.chatStream.mockImplementation(async (question, businessId, history, options) => {
      options.onMeta({
        sources: [{ dataType: 'monthly_pnl', period: '2026-06' }],
        confident: true,
        mode: 'rag',
      });
      options.onToken('Revenue ');
      options.onToken('improved.');
      return {
        answer: 'Revenue improved.',
        response: 'Revenue improved.',
        sources: [{ dataType: 'monthly_pnl', period: '2026-06' }],
        confident: true,
        mode: 'rag',
      };
    });

    const res = mkSseRes();
    await ctrl.ragQueryStream(req({ body: { question: 'How was revenue?', chatHistory: [] } }), res, jest.fn());

    const output = res.write.mock.calls.flat().join('');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream; charset=utf-8');
    expect(output).toContain('event: meta');
    expect(output).toContain('event: token');
    expect(output).toContain('Revenue ');
    expect(output).toContain('improved.');
    expect(output).toContain('event: done');
    expect(res.end).toHaveBeenCalled();
  });

  test('reindex rejects cross-business request from a non-admin caller', async () => {
    const next = jest.fn();
    await ctrl.reindexRag(
      req({ user: { businessId: 'biz1', id: 'user1', role: 'owner' }, body: { businessId: 'biz2' } }),
      mkJsonRes(),
      next
    );

    expect(ragIndexer.indexBusinessById).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  test('reindex defaults to the caller business for same-business requests', async () => {
    ragIndexer.indexBusinessById.mockResolvedValue({ indexed: 1, skipped: 0, errors: 0 });
    const res = mkJsonRes();

    await ctrl.reindexRag(req({ body: {} }), res, jest.fn());

    expect(ragIndexer.indexBusinessById).toHaveBeenCalledWith('biz1');
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
