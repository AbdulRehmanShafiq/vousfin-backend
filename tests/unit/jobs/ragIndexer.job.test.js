jest.mock('node-cron', () => ({
  schedule: jest.fn(),
}));

jest.mock('../../../models/Business.model', () => ({
  find: jest.fn(),
  findById: jest.fn(),
}));

jest.mock('../../../models/IndexerState.model', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../../../models/AIInteractionLog.model', () => ({
  create: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../../services/contextSummarizer.service', () => ({
  getModifiedRecords: jest.fn(),
  summarize: jest.fn(),
  periodFromDate: jest.fn((date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`),
}));

jest.mock('../../../services/embeddingService', () => ({
  embedDocuments: jest.fn(),
}));

jest.mock('../../../services/vectorStore.service', () => ({
  upsertEmbedding: jest.fn(),
}));

jest.mock('../../../services/report.service', () => ({
  getIncomeStatement: jest.fn(),
  getCashFlowStatement: jest.fn(),
  getAgingReport: jest.fn(),
}));

jest.mock('../../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const IndexerState = require('../../../models/IndexerState.model');
const AIInteractionLog = require('../../../models/AIInteractionLog.model');
const contextSummarizer = require('../../../services/contextSummarizer.service');
const reportService = require('../../../services/report.service');
const ragIndexer = require('../../../jobs/ragIndexer.job');

describe('ragIndexer state handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    IndexerState.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ lastIndexedAt: new Date('2026-01-01T00:00:00Z') }),
    });
    reportService.getIncomeStatement.mockResolvedValue({ totalRevenue: 0, totalExpenses: 0 });
    reportService.getCashFlowStatement.mockResolvedValue({ netCashFlow: 0, operating: { total: 0 } });
    reportService.getAgingReport.mockResolvedValue({ total: 0 });
  });

  test('does not advance lastIndexedAt when a data type fails', async () => {
    contextSummarizer.getModifiedRecords.mockImplementation(async (businessId, dataType) => {
      if (dataType === 'journal_entry') throw new Error('journal failure');
      return [];
    });

    const stats = await ragIndexer.indexBusiness({ _id: 'biz1', businessName: 'Test Co' });

    expect(stats.errors).toBe(1);
    expect(stats.failedTypes).toContain('journal_entry');

    const update = IndexerState.findOneAndUpdate.mock.calls[0][1];
    expect(update.lastIndexedAt).toBeUndefined();
    expect(update.lastSuccessfulIndexedAt).toBeUndefined();
    expect(update.lastError).toBe('1 indexing task(s) failed');
    expect(update.lastRunStats.failedTypes).toContain('journal_entry');
    expect(AIInteractionLog.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'INDEXER_ERROR',
      retrievalStats: expect.objectContaining({ errors: 1 }),
    }));
  });

  test('advances lastIndexedAt after a clean run', async () => {
    contextSummarizer.getModifiedRecords.mockResolvedValue([]);

    const stats = await ragIndexer.indexBusiness({ _id: 'biz1', businessName: 'Test Co' });

    expect(stats.errors).toBe(0);
    const update = IndexerState.findOneAndUpdate.mock.calls[0][1];
    expect(update.lastIndexedAt).toBeInstanceOf(Date);
    expect(update.lastSuccessfulIndexedAt).toBeInstanceOf(Date);
    expect(update.lastError).toBeNull();
  });
});
