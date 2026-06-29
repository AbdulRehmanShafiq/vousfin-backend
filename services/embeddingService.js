const crypto = require('crypto');
const logger = require('../config/logger');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'text-embedding-004';
const DIMENSIONS = parseInt(process.env.EMBEDDING_DIMENSIONS, 10) || 768;
const MAX_RETRIES = parseInt(process.env.EMBEDDING_MAX_RETRIES, 10) || 4;
const BATCH_SIZE = parseInt(process.env.EMBEDDING_BATCH_SIZE, 10) || 100;
const TIMEOUT_MS = parseInt(process.env.EMBEDDING_TIMEOUT_MS, 10) || 30000;

let warnedAboutLocalFallback = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Embedding input must be a non-empty string');
  }
}

function shouldUseLocalFallback() {
  return (
    process.env.AI_EMBEDDINGS_LOCAL === 'true' ||
    process.env.NODE_ENV === 'test' ||
    !process.env.GEMINI_API_KEY
  );
}

function warnLocalFallback() {
  if (warnedAboutLocalFallback) return;
  warnedAboutLocalFallback = true;
  logger.warn('[embeddingService] GEMINI_API_KEY not configured; using deterministic local embeddings');
}

function createLocalEmbedding(text, dimensions = DIMENSIONS) {
  const vector = new Array(dimensions).fill(0);
  const tokens = String(text)
    .toLowerCase()
    .match(/[a-z0-9]+/g) || [];

  tokens.forEach((token) => {
    const hash = crypto.createHash('sha256').update(token).digest();
    for (let i = 0; i < 4; i += 1) {
      const index = hash.readUInt16BE(i * 2) % dimensions;
      const sign = hash[i + 8] % 2 === 0 ? 1 : -1;
      vector[index] += sign;
    }
  });

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / norm).toFixed(6)));
}

async function fetchWithTimeout(url, options, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Embedding API request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractEmbeddingValues(payload) {
  const values = payload?.embedding?.values || payload?.embeddings?.[0]?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('Embedding API returned no embedding values');
  }
  return values;
}

async function postGeminiEmbedding(body, endpoint) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `${GEMINI_API_BASE}/${DEFAULT_MODEL}:${endpoint}?key=${apiKey}`;

  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (response.status === 429 && attempt < MAX_RETRIES - 1) {
        await sleep((2 ** attempt) * 1000);
        continue;
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`Gemini embedding API error (${response.status}): ${errorBody.slice(0, 300)}`);
      }

      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES - 1) {
        await sleep((2 ** attempt) * 1000);
      }
    }
  }

  throw lastError;
}

async function embedQuery(text) {
  assertText(text);

  if (shouldUseLocalFallback()) {
    warnLocalFallback();
    return createLocalEmbedding(text);
  }

  try {
    const payload = await postGeminiEmbedding({
      content: { parts: [{ text }] },
      taskType: 'RETRIEVAL_QUERY',
    }, 'embedContent');
    return extractEmbeddingValues(payload);
  } catch (error) {
    if (process.env.AI_EMBEDDING_STRICT === 'true') throw error;
    logger.warn(`[embeddingService] API query embedding failed; using local fallback: ${error.message}`);
    return createLocalEmbedding(text);
  }
}

async function embedDocuments(texts) {
  if (!Array.isArray(texts)) {
    throw new Error('embedDocuments expects an array of strings');
  }
  texts.forEach(assertText);
  if (texts.length === 0) return [];

  if (shouldUseLocalFallback()) {
    warnLocalFallback();
    return texts.map((text) => createLocalEmbedding(text));
  }

  const embeddings = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    try {
      const payload = await postGeminiEmbedding({
        requests: batch.map((text) => ({
          model: `models/${DEFAULT_MODEL}`,
          content: { parts: [{ text }] },
          taskType: 'RETRIEVAL_DOCUMENT',
        })),
      }, 'batchEmbedContents');

      const batchEmbeddings = payload?.embeddings;
      if (!Array.isArray(batchEmbeddings) || batchEmbeddings.length !== batch.length) {
        throw new Error('Embedding API returned an unexpected batch shape');
      }
      embeddings.push(...batchEmbeddings.map((embedding) => embedding.values));
    } catch (error) {
      if (process.env.AI_EMBEDDING_STRICT === 'true') throw error;
      logger.warn(`[embeddingService] API document embedding failed; using local fallback: ${error.message}`);
      embeddings.push(...batch.map((text) => createLocalEmbedding(text)));
    }

    if (i + BATCH_SIZE < texts.length) {
      await sleep(500);
    }
  }

  return embeddings;
}

module.exports = {
  embedQuery,
  embedDocuments,
  createLocalEmbedding,
  DIMENSIONS,
};
