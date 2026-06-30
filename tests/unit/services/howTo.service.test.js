'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../services/embeddingService', () => ({ embedQuery: jest.fn().mockResolvedValue([1, 0, 0]) }));
jest.mock('../../../services/vectorStore.service', () => ({ searchSimilar: jest.fn() }));
jest.mock('../../../services/modelRouter.service', () => ({ callChat: jest.fn() }));
jest.mock('../../../services/faithfulnessJudge.service', () => ({ checkAsync: jest.fn() }));

const { GLOBAL_CATALOG_BUSINESS_ID } = require('../../../config/constants');
const vectorStore = require('../../../services/vectorStore.service');
const modelRouter = require('../../../services/modelRouter.service');
const faithfulnessJudge = require('../../../services/faithfulnessJudge.service');
const { answerHowTo } = require('../../../services/howTo.service');

const helpHit = (id, href, score) => ({
  recordId: id,
  businessId: GLOBAL_CATALOG_BUSINESS_ID,
  dataType: 'app_help',
  summary: `How to use ${id}\nSteps to ${id}.`,
  vectorScore: score,
  metadata: { title: `How to use ${id}`, href, module: 'sales', type: 'page' },
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CATALOG_SEARCH_MIN_SCORE = '0.15';
});

describe('answerHowTo', () => {
  it('queries ONLY the global sentinel + app_help dataType (isolation)', async () => {
    vectorStore.searchSimilar.mockResolvedValue([]);
    await answerHowTo('how do i send an invoice');
    const [, bizId, , opts] = vectorStore.searchSimilar.mock.calls[0];
    expect(String(bizId)).toBe(GLOBAL_CATALOG_BUSINESS_ID);
    expect(opts.dataTypes).toEqual(['app_help']);
  });

  it('refuses (no hallucinated steps) when nothing relevant is retrieved', async () => {
    vectorStore.searchSimilar.mockResolvedValue([]);
    const r = await answerHowTo('how do i fly to the moon');
    expect(r.grounded).toBe(false);
    expect(r.href).toBeNull();
    expect(r.sources).toEqual([]);
    expect(modelRouter.callChat).not.toHaveBeenCalled();
  });

  it('grounds an answer on the retrieved help docs and returns a deep link + sources', async () => {
    vectorStore.searchSimilar.mockResolvedValue([
      helpHit('help.sales.invoices', '/sales/invoices', 0.88),
      helpHit('help.sales.new-invoice', '/sales/invoices/new', 0.81),
    ]);
    modelRouter.callChat.mockResolvedValue({ text: '1. Open Sales → Invoices.\n2. Click New.', provider: 'groq' });

    const r = await answerHowTo('how do i create an invoice');
    expect(r.grounded).toBe(true);
    expect(r.answer).toMatch(/Open Sales/);
    expect(r.href).toBe('/sales/invoices');
    expect(r.sources.map((s) => s.href)).toContain('/sales/invoices');
    expect(modelRouter.callChat).toHaveBeenCalledTimes(1);
    expect(faithfulnessJudge.checkAsync).toHaveBeenCalledTimes(1);
  });

  it('falls back to the top help doc when the model is unavailable', async () => {
    vectorStore.searchSimilar.mockResolvedValue([helpHit('help.sales.invoices', '/sales/invoices', 0.9)]);
    modelRouter.callChat.mockRejectedValue(new Error('model down'));
    const r = await answerHowTo('how do i invoice');
    expect(r.grounded).toBe(true);
    expect(r.href).toBe('/sales/invoices');
    expect(r.answer).toBeTruthy(); // a usable fallback, not an error
  });
});
