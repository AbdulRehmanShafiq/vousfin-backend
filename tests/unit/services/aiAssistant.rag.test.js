jest.mock('../../../services/ragQuery.service', () => ({
  getContext: jest.fn(),
}));

jest.mock('../../../services/modelRouter.service', () => ({
  callChat: jest.fn(),
  callChatStream: jest.fn(),
  emitChunkedText: jest.fn((text, onToken) => {
    String(text || '').split(/(\s+)/).filter(Boolean).forEach((chunk) => onToken?.(chunk));
  }),
}));

jest.mock('../../../services/faithfulnessJudge.service', () => ({
  checkAsync: jest.fn(),
}));

jest.mock('../../../models/AIInteractionLog.model', () => ({
  create: jest.fn(),
}));

jest.mock('../../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const ragQuery = require('../../../services/ragQuery.service');
const modelRouter = require('../../../services/modelRouter.service');
const AIInteractionLog = require('../../../models/AIInteractionLog.model');
const aiAssistant = require('../../../services/aiAssistant.service');

describe('aiAssistant RAG behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('blocks raw export/list-all intents without retrieval', async () => {
    const result = await aiAssistant.chatWithRag(
      'export all transactions',
      '64f000000000000000000001',
      [],
      { userId: '64f000000000000000000002' }
    );

    expect(result.mode).toBe('rag-blocked');
    expect(result.confident).toBe(false);
    expect(ragQuery.getContext).not.toHaveBeenCalled();
    expect(AIInteractionLog.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'AI_REFUSAL',
      questionHash: expect.not.stringContaining('export all transactions'),
    }));
  });

  test('logs hashed questions and model provider, not plaintext question', async () => {
    ragQuery.getContext.mockResolvedValue({
      context: '[Source 1: monthly_pnl | 2026-06]\nRevenue summary',
      sources: [{ dataType: 'monthly_pnl', period: '2026-06' }],
      confident: true,
      retrievalStats: { candidates: 1, afterRerank: 1 },
    });
    modelRouter.callChat.mockResolvedValue({ text: 'Revenue improved. [Source 1]', provider: 'groq' });

    const result = await aiAssistant.chatWithRag(
      'How was revenue in June?',
      '64f000000000000000000001',
      [],
      { userId: '64f000000000000000000002' }
    );

    expect(result.mode).toBe('rag');
    expect(result.provider).toBe('groq');
    expect(AIInteractionLog.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'AI_QUERY',
      questionHash: expect.any(String),
      details: { provider: 'groq' },
    }));
    const logged = AIInteractionLog.create.mock.calls[0][0];
    expect(logged.questionHash).not.toBe('How was revenue in June?');
    expect(JSON.stringify(logged)).not.toContain('How was revenue in June?');
  });

  test('falls back to indexed-context message when model routing fails', async () => {
    ragQuery.getContext.mockResolvedValue({
      context: '[Source 1: monthly_pnl | 2026-06]\nRevenue summary',
      sources: [{ dataType: 'monthly_pnl', period: '2026-06' }],
      confident: true,
      retrievalStats: { candidates: 1, afterRerank: 1 },
    });
    modelRouter.callChat.mockRejectedValue(new Error('provider down'));

    const result = await aiAssistant.chatWithRag('How was revenue?', '64f000000000000000000001');

    expect(result.mode).toBe('rag-model-fallback');
    expect(result.answer).toContain('monthly pnl (2026-06)');
    expect(result.confident).toBe(false);
  });
});
