// workers/bookkeeper.worker.js
//
// Phase 3 — Autonomous Bookkeeper Background Worker (BullMQ).
//
// This worker runs as a dedicated job processor that listens to the
// 'bookkeeper-ingest' queue. When a source document is uploaded (receipt,
// bill scan, forwarded email), a job is enqueued and this worker:
//
//   1. Calls bookkeeper.ingest() which runs the AI text-extraction pipeline.
//   2. The ingest function resolves accounts, recalls entity memory, and
//      proposes a journal entry through the Action Router.
//   3. Based on the autonomy policy, the entry is either auto-posted to the
//      ledger or queued for owner approval in the Command Center.
//
// This architecture ensures the main API thread is NEVER blocked by AI
// inference, and failed jobs are automatically retried with exponential backoff.
//
'use strict';
const { Queue, Worker } = require('bullmq');
const logger = require('../config/logger');

const QUEUE_NAME = 'bookkeeper-ingest';

// ─── Redis connection config ──────────────────────────────────────────────────
function getRedisConnection() {
  if (!process.env.REDIS_URL) return null;
  // Parse the REDIS_URL into an ioredis-compatible connection object
  try {
    const url = new URL(process.env.REDIS_URL);
    return {
      host: url.hostname,
      port: parseInt(url.port) || 6379,
      password: url.password || undefined,
      username: url.username || undefined,
      tls: url.protocol === 'rediss:' ? {} : undefined,
      maxRetriesPerRequest: null,
    };
  } catch (err) {
    logger.warn(`[BookkeeperWorker] Invalid REDIS_URL: ${err.message}`);
    return null;
  }
}

// ─── Queue (used by the API to enqueue jobs) ──────────────────────────────────
let _queue = null;

function getQueue() {
  if (_queue) return _queue;
  const connection = getRedisConnection();
  if (!connection) {
    logger.warn('[BookkeeperWorker] No REDIS_URL — BullMQ queue unavailable. Documents will be processed synchronously.');
    return null;
  }
  _queue = new Queue(QUEUE_NAME, { connection });
  return _queue;
}

/**
 * Enqueue a document for background AI processing.
 * Falls back to synchronous processing if Redis is unavailable.
 *
 * @param {Object} params - { businessId, rawText, source, submittedBy, image, mimeType }
 * @returns {Promise<{ queued: boolean, jobId?: string }>}
 */
async function enqueueIngest(params) {
  const queue = getQueue();
  if (!queue) {
    // Fallback: process synchronously (for local dev without Redis)
    const bookkeeper = require('../services/bookkeeper.service');
    const result = await bookkeeper.ingest(params);
    return { queued: false, result };
  }

  const job = await queue.add('ingest', params, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000, // 5s → 10s → 20s
    },
    removeOnComplete: { count: 100 },  // keep last 100 for diagnostics
    removeOnFail:     { count: 50 },
  });

  logger.info(`[BookkeeperWorker] Enqueued ingest job ${job.id} for business ${params.businessId}`);
  return { queued: true, jobId: job.id };
}

// ─── Worker (started from server.js) ──────────────────────────────────────────
let _worker = null;

function startWorker() {
  const connection = getRedisConnection();
  if (!connection) {
    logger.info('[BookkeeperWorker] No REDIS_URL — worker not started. Using synchronous fallback.');
    return null;
  }

  // Lazy-require bookkeeper to avoid circular dependency issues at boot
  const bookkeeper = require('../services/bookkeeper.service');

  _worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { businessId, rawText, source, submittedBy, image, mimeType } = job.data;
      logger.info(`[BookkeeperWorker] Processing job ${job.id} for business ${businessId}`);

      const result = await bookkeeper.ingest({
        businessId, rawText, source, submittedBy, image, mimeType,
      });

      if (result.error) {
        // If the AI is busy (429/503), throw so BullMQ retries with backoff
        if (result.busy) {
          throw new Error(`AI temporarily unavailable: ${result.error}`);
        }
        logger.warn(`[BookkeeperWorker] Job ${job.id} completed with error: ${result.error}`);
      }

      return {
        documentId: result.document?._id,
        actionId:   result.action?._id,
        status:     result.action?.status || 'failed',
      };
    },
    {
      connection,
      concurrency: 2,  // Process 2 documents at a time
      limiter: {
        max: 10,
        duration: 60000, // Max 10 jobs per minute (rate-limit AI calls)
      },
    },
  );

  _worker.on('completed', (job, result) => {
    logger.info(`[BookkeeperWorker] Job ${job.id} completed: ${result.status}`);
  });

  _worker.on('failed', (job, err) => {
    logger.error(`[BookkeeperWorker] Job ${job?.id} failed: ${err.message}`);
  });

  _worker.on('error', (err) => {
    logger.error(`[BookkeeperWorker] Worker error: ${err.message}`);
  });

  logger.info('[BookkeeperWorker] Background worker started, listening for documents...');
  return _worker;
}

function stopWorker() {
  if (_worker) {
    _worker.close();
    _worker = null;
  }
}

module.exports = {
  enqueueIngest,
  startWorker,
  stopWorker,
  getQueue,
  QUEUE_NAME,
};
