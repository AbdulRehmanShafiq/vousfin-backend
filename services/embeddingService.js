// services/embeddingService.js — text → vector for RAG (semantic search).
//
// DeepSeek's hosted API has no embeddings endpoint, so this service always
// uses a deterministic, DB-free local embedding: a signed hash of each token
// projected into a fixed-size vector, L2-normalized. No network call, no API
// key, no quota. Same text always produces the same vector, and cosine
// similarity between related short phrases is meaningfully higher than
// between unrelated ones — good enough for the app's catalog/how-to/RAG
// search, though it will not match the semantic quality of a trained
// embedding model. DIMENSIONS must match the Atlas Vector Search index.
'use strict';
const crypto = require('crypto');

const DIMENSIONS = parseInt(process.env.EMBEDDING_DIMENSIONS, 10) || 768;

function assertText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Embedding input must be a non-empty string');
  }
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

async function embedQuery(text) {
  assertText(text);
  return createLocalEmbedding(text);
}

async function embedDocuments(texts) {
  if (!Array.isArray(texts)) {
    throw new Error('embedDocuments expects an array of strings');
  }
  texts.forEach(assertText);
  return texts.map((text) => createLocalEmbedding(text));
}

module.exports = {
  embedQuery,
  embedDocuments,
  createLocalEmbedding,
  DIMENSIONS,
};
