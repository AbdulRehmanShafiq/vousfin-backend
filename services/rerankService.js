const logger = require('../config/logger');

const HF_RERANKER_URL = process.env.HF_RERANKER_URL ||
  'https://api-inference.huggingface.co/models/BAAI/bge-reranker-v2-m3';

function tokenize(text) {
  return new Set(String(text).toLowerCase().match(/[a-z0-9]+/g) || []);
}

function lexicalScore(query, passage) {
  const queryTokens = tokenize(query);
  if (!queryTokens.size) return 0;
  const passageTokens = tokenize(passage);
  let matches = 0;
  queryTokens.forEach((token) => {
    if (passageTokens.has(token)) matches += 1;
  });
  const phraseBoost = String(passage).toLowerCase().includes(String(query).toLowerCase()) ? 0.25 : 0;
  return matches / queryTokens.size + phraseBoost;
}

function fallbackRerank(query, passages, topK) {
  return passages
    .map((passage, idx) => ({ idx, score: lexicalScore(query, passage) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((item) => item.idx);
}

async function rerank(query, passages, topK = 8) {
  if (!Array.isArray(passages) || passages.length === 0) return [];
  if (!process.env.HF_API_KEY || process.env.RERANK_DISABLE === 'true') {
    return fallbackRerank(query, passages, topK);
  }

  try {
    const response = await fetch(HF_RERANKER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.HF_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: passages.map((passage) => ({ text: query, text_pair: passage })),
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`HF reranker error (${response.status}): ${errorBody.slice(0, 200)}`);
    }

    const payload = await response.json();
    const scores = Array.isArray(payload)
      ? payload.map((item) => (typeof item === 'number' ? item : item.score ?? item[0]?.score ?? 0))
      : [];

    if (scores.length !== passages.length) {
      throw new Error('HF reranker returned an unexpected response shape');
    }

    return scores
      .map((score, idx) => ({ idx, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((item) => item.idx);
  } catch (error) {
    logger.warn(`[rerankService] Reranker unavailable; using lexical fallback: ${error.message}`);
    return fallbackRerank(query, passages, topK);
  }
}

module.exports = {
  rerank,
  lexicalScore,
};
