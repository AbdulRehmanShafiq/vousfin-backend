const cron = require('node-cron');
const Business = require('../models/Business.model');
const IndexerState = require('../models/IndexerState.model');
const AIInteractionLog = require('../models/AIInteractionLog.model');
const contextSummarizer = require('../services/contextSummarizer.service');
const embeddingService = require('../services/embeddingService');
const vectorStore = require('../services/vectorStore.service');
const reportService = require('../services/report.service');
const logger = require('../config/logger');

const CRON_EXPRESSION = process.env.RAG_INDEXER_CRON || '0 2 * * *';
const TIMEZONE = process.env.RAG_INDEXER_TIMEZONE || 'Asia/Karachi';
const EVENT_REINDEX_DELAY_MS = parseInt(process.env.RAG_EVENT_REINDEX_DELAY_MS, 10) || 5 * 60 * 1000;
const pendingBusinessTimers = new Map();

function monthRange(monthStart) {
  const start = new Date(monthStart);
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  end.setMilliseconds(-1);
  return { start, end };
}

function recentMonths(count = 13) {
  const months = [];
  const cursor = new Date();
  cursor.setDate(1);
  cursor.setHours(0, 0, 0, 0);

  for (let i = 0; i < count; i += 1) {
    const month = new Date(cursor);
    month.setMonth(cursor.getMonth() - i);
    months.push(month);
  }

  return months;
}

function periodFromMonth(month) {
  return contextSummarizer.periodFromDate(month);
}

async function upsertSummaries(businessId, summaries, stats) {
  if (!summaries.length) return;

  const embeddings = await embeddingService.embedDocuments(summaries.map((item) => item.summary));
  for (let i = 0; i < summaries.length; i += 1) {
    const result = await vectorStore.upsertEmbedding({
      businessId,
      dataType: summaries[i].dataType,
      recordId: summaries[i].recordId,
      period: summaries[i].period,
      summary: summaries[i].summary,
      embedding: embeddings[i],
      summaryHash: summaries[i].hash,
      metadata: summaries[i].metadata,
    });

    if (result.skipped) stats.skipped += 1;
    if (result.upserted) stats.indexed += 1;
  }
}

async function indexRecordType(businessId, dataType, since, stats) {
  const records = await contextSummarizer.getModifiedRecords(businessId, dataType, since);
  if (!records.length) return;

  const summaries = await contextSummarizer.summarize(businessId, dataType, records);
  await upsertSummaries(businessId, summaries, stats);
}

async function indexMonthlyReports(businessId, stats) {
  const monthsToIndex = parseInt(process.env.RAG_INDEX_REPORT_MONTHS, 10) || 13;

  for (const month of recentMonths(monthsToIndex)) {
    const { start, end } = monthRange(month);
    const period = periodFromMonth(month);

    try {
      const currentPnl = await reportService.getIncomeStatement(businessId, start, end);
      const previousRange = monthRange(new Date(start.getFullYear(), start.getMonth() - 1, 1));
      let revenueGrowth = null;

      try {
        const previousPnl = await reportService.getIncomeStatement(businessId, previousRange.start, previousRange.end);
        if (previousPnl.totalRevenue) {
          revenueGrowth = ((currentPnl.totalRevenue - previousPnl.totalRevenue) / previousPnl.totalRevenue) * 100;
        }
      } catch {
        revenueGrowth = null;
      }

      if (currentPnl.totalRevenue || currentPnl.totalExpenses) {
        const summary = await contextSummarizer.summarizePnL(businessId, period, {
          ...currentPnl,
          revenueGrowth,
        });
        await upsertSummaries(businessId, [summary], stats);
      }
    } catch (error) {
      stats.errors += 1;
      stats.failedTypes.push(`monthly_pnl:${period}`);
      logger.warn(`[ragIndexer] P&L indexing skipped for ${businessId}/${period}: ${error.message}`);
    }

    try {
      const cashFlow = await reportService.getCashFlowStatement(businessId, start, end);
      if (cashFlow.netCashFlow || cashFlow.operating?.total) {
        const summary = await contextSummarizer.summarizeCashFlow(businessId, period, cashFlow);
        await upsertSummaries(businessId, [summary], stats);
      }
    } catch (error) {
      stats.errors += 1;
      stats.failedTypes.push(`monthly_cashflow:${period}`);
      logger.warn(`[ragIndexer] Cash-flow indexing skipped for ${businessId}/${period}: ${error.message}`);
    }
  }

  const currentPeriod = periodFromMonth(new Date());
  for (const type of ['receivable', 'payable']) {
    try {
      const aging = await reportService.getAgingReport(businessId, type);
      if (aging.total) {
        const summary = await contextSummarizer.summarizeAgingReport(businessId, currentPeriod, type, aging);
        await upsertSummaries(businessId, [summary], stats);
      }
    } catch (error) {
      stats.errors += 1;
      stats.failedTypes.push(`${type}_aging_summary`);
      logger.warn(`[ragIndexer] ${type} aging indexing skipped for ${businessId}: ${error.message}`);
    }
  }
}

async function indexBusiness(business) {
  const businessId = business._id || business;
  const state = await IndexerState.findOne({ businessId }).lean();
  const since = state?.lastIndexedAt || new Date(0);
  const runStartedAt = new Date();
  const stats = { indexed: 0, skipped: 0, errors: 0, failedTypes: [] };
  const dataTypes = [
    'journal_entry',
    'invoice_summary',
    'bill_summary',
    'payment_summary',
    'anomaly_summary',
    'bank_statement_summary',
    'budget_summary',
    'tax_position_summary',
  ];

  for (const dataType of dataTypes) {
    try {
      await indexRecordType(businessId, dataType, since, stats);
    } catch (error) {
      stats.errors += 1;
      stats.failedTypes.push(dataType);
      logger.error(`[ragIndexer] Failed ${dataType} indexing for ${businessId}: ${error.message}`);
    }
  }

  await indexMonthlyReports(businessId, stats);

  const stateUpdate = {
    businessId,
    lastRunStats: stats,
    lastRunStartedAt: runStartedAt,
    lastRunCompletedAt: new Date(),
    lastError: stats.errors ? `${stats.errors} indexing task(s) failed` : null,
  };
  if (!stats.errors) {
    stateUpdate.lastIndexedAt = runStartedAt;
    stateUpdate.lastSuccessfulIndexedAt = runStartedAt;
  }

  await IndexerState.findOneAndUpdate(
    { businessId },
    stateUpdate,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await AIInteractionLog.create({
    businessId,
    eventType: stats.errors ? 'INDEXER_ERROR' : 'INDEXER_RUN',
    retrievalStats: stats,
  }).catch(() => {});

  logger.info(`[ragIndexer] Indexed business ${businessId}: ${JSON.stringify(stats)}`);
  return stats;
}

async function indexBusinessById(businessId) {
  const business = await Business.findById(businessId).select('_id businessName').lean();
  if (!business) throw new Error('Business not found for RAG indexing');
  return indexBusiness(business);
}

async function runFullIndex() {
  logger.info('[ragIndexer] Starting full indexing run');
  const businesses = await Business.find({}).select('_id businessName').lean();
  const results = [];

  for (const business of businesses) {
    try {
      const stats = await indexBusiness(business);
      results.push({ businessId: business._id, stats });
    } catch (error) {
      logger.error(`[ragIndexer] Business ${business._id} failed: ${error.message}`);
      results.push({ businessId: business._id, error: error.message });
    }
  }

  logger.info(`[ragIndexer] Full indexing run completed for ${businesses.length} business(es)`);
  return { businesses: businesses.length, results };
}

function scheduleRagIndexer() {
  if (process.env.AI_RAG_INDEXER_ENABLED === 'false') {
    logger.info('[ragIndexer] Disabled by AI_RAG_INDEXER_ENABLED=false');
    return null;
  }

  return cron.schedule(CRON_EXPRESSION, () => {
    runFullIndex().catch((error) => {
      logger.error(`[ragIndexer] Scheduled run failed: ${error.message}`);
    });
  }, { timezone: TIMEZONE });
}

function scheduleBusinessReindex(businessId, reason = 'event') {
  if (!businessId) return false;
  if (process.env.AI_RAG_EVENT_INDEXER_ENABLED === 'false') return false;

  const key = String(businessId);
  if (pendingBusinessTimers.has(key)) {
    clearTimeout(pendingBusinessTimers.get(key));
  }

  const timer = setTimeout(() => {
    pendingBusinessTimers.delete(key);
    indexBusinessById(key).catch((error) => {
      logger.warn(`[ragIndexer] Event-driven reindex failed for ${key} (${reason}): ${error.message}`);
    });
  }, EVENT_REINDEX_DELAY_MS);

  pendingBusinessTimers.set(key, timer);
  logger.debug(`[ragIndexer] Scheduled debounced reindex for ${key} because ${reason}`);
  return true;
}

module.exports = {
  scheduleRagIndexer,
  scheduleBusinessReindex,
  runFullIndex,
  indexBusiness,
  indexBusinessById,
};
