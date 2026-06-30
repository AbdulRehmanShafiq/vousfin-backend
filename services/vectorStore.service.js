const mongoose = require('mongoose');
const VectorDocument = require('../models/VectorDocument.model');
const logger = require('../config/logger');

let warnedAboutVectorFallback = false;

function toObjectId(value) {
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new Error('A valid businessId is required for vector search');
  }
  return new mongoose.Types.ObjectId(value);
}

function cosineSimilarity(a = [], b = []) {
  const length = Math.min(a.length, b.length);
  if (!length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function tokenize(text) {
  return new Set(String(text).toLowerCase().match(/[a-z0-9]+/g) || []);
}

function keywordScore(queryText, summary) {
  const queryTokens = tokenize(queryText);
  if (!queryTokens.size) return 0;

  const summaryTokens = tokenize(summary);
  let matches = 0;
  queryTokens.forEach((token) => {
    if (summaryTokens.has(token)) matches += 1;
  });
  return matches / queryTokens.size;
}

function normalizeResult(doc, scoreName = 'vectorScore') {
  const raw = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    _id: raw._id,
    businessId: raw.businessId,
    recordId: raw.recordId,
    dataType: raw.dataType,
    period: raw.period,
    summary: raw.summary,
    summaryHash: raw.summaryHash,
    metadata: raw.metadata || {},
    vectorScore: Number(raw[scoreName] || raw.vectorScore || raw.score || 0),
  };
}

function normalizeList(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function buildMongoFilter(businessId, options = {}) {
  const filter = { businessId: toObjectId(businessId) };
  const periods = normalizeList(options.periods);
  const dataTypes = normalizeList(options.dataTypes);

  if (periods.length) filter.period = { $in: periods };
  if (dataTypes.length) filter.dataType = { $in: dataTypes };
  return filter;
}

function buildVectorSearchFilter(businessId, options = {}) {
  const filter = { businessId: toObjectId(businessId) };
  const periods = normalizeList(options.periods);
  const dataTypes = normalizeList(options.dataTypes);

  if (periods.length) filter.period = { $in: periods };
  if (dataTypes.length) filter.dataType = { $in: dataTypes };
  return filter;
}

function warnVectorFallback(error) {
  if (warnedAboutVectorFallback) return;
  warnedAboutVectorFallback = true;
  logger.warn(`[vectorStore] Atlas Vector Search unavailable; using local vector fallback: ${error.message}`);
}

async function upsertEmbedding(payload) {
  const {
    businessId,
    dataType,
    recordId,
    period,
    summary,
    embedding,
    summaryHash,
    metadata = {},
    scope = 'tenant',
  } = payload;

  if (!businessId || !dataType || !recordId || !period || !summary || !summaryHash) {
    throw new Error('Missing required vector document fields');
  }
  if (!Array.isArray(embedding) || !embedding.length) {
    throw new Error('Embedding must be a non-empty array');
  }

  const tenantId = toObjectId(businessId);
  const existing = await VectorDocument.findOne({ businessId: tenantId, recordId, dataType }).lean();
  if (existing && existing.summaryHash === summaryHash) {
    return { skipped: true, document: existing };
  }

  const document = await VectorDocument.findOneAndUpdate(
    { businessId: tenantId, recordId, dataType },
    {
      businessId: tenantId,
      dataType,
      recordId,
      period,
      summary,
      embedding,
      summaryHash,
      metadata,
      scope,
      updatedAt: new Date(),
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );

  return { upserted: true, document };
}

async function searchWithLocalFallback(queryVector, businessId, k, options = {}) {
  const tenantFilter = buildMongoFilter(businessId, options);
  const tenantId = tenantFilter.businessId;
  const documents = await VectorDocument.find(tenantFilter)
    .limit(parseInt(process.env.VECTOR_LOCAL_SCAN_LIMIT, 10) || 1500)
    .lean();

  return documents
    .filter((doc) => String(doc.businessId) === String(tenantId))
    .map((doc) => {
      const vector = cosineSimilarity(queryVector, doc.embedding);
      const lexical = keywordScore(options.queryText || '', doc.summary);
      return normalizeResult({
        ...doc,
        vectorScore: Math.max(0, vector) * 0.75 + lexical * 0.25,
      });
    })
    .sort((a, b) => b.vectorScore - a.vectorScore)
    .slice(0, k);
}

async function searchSimilar(queryVector, businessId, k = 40, options = {}) {
  if (!Array.isArray(queryVector) || !queryVector.length) {
    throw new Error('queryVector must be a non-empty array');
  }

  const tenantId = toObjectId(businessId);
  const indexName = process.env.VECTOR_SEARCH_INDEX_NAME || 'vousfin_vector_index';

  if (process.env.VECTOR_SEARCH_DISABLE !== 'true') {
    try {
      const vectorResults = await VectorDocument.aggregate([
        {
          $vectorSearch: {
            index: indexName,
            path: 'embedding',
            queryVector,
            numCandidates: parseInt(process.env.VECTOR_SEARCH_NUM_CANDIDATES, 10) || 150,
            limit: Math.max(k, 40),
            filter: buildVectorSearchFilter(tenantId, options),
          },
        },
        {
          $project: {
            businessId: 1,
            recordId: 1,
            dataType: 1,
            period: 1,
            summary: 1,
            summaryHash: 1,
            metadata: 1,
            vectorScore: { $meta: 'vectorSearchScore' },
          },
        },
      ]);

      return vectorResults
        .filter((doc) => String(doc.businessId) === String(tenantId))
        .map((doc) => normalizeResult(doc))
        .slice(0, k);
    } catch (error) {
      warnVectorFallback(error);
    }
  }

  return searchWithLocalFallback(queryVector, tenantId, k, options);
}

async function keywordSearch(businessId, queryText, k = 20, options = {}) {
  const tenantId = toObjectId(businessId);
  const tokens = Array.from(tokenize(queryText)).slice(0, 12);
  if (!tokens.length) return [];

  const regex = new RegExp(tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
  const filter = { ...buildMongoFilter(tenantId, options), summary: regex };
  const docs = await VectorDocument.find(filter)
    .sort({ updatedAt: -1 })
    .limit(k)
    .lean();

  return docs
    .filter((doc) => String(doc.businessId) === String(tenantId))
    .map((doc) => normalizeResult({ ...doc, vectorScore: keywordScore(queryText, doc.summary) }));
}

function deleteByBusinessId(businessId) {
  return VectorDocument.deleteMany({ businessId: toObjectId(businessId) });
}

function deleteByRecordId(businessId, recordId, dataType) {
  return VectorDocument.deleteOne({ businessId: toObjectId(businessId), recordId, dataType });
}

function countByBusinessId(businessId) {
  return VectorDocument.countDocuments({ businessId: toObjectId(businessId) });
}

module.exports = {
  upsertEmbedding,
  searchSimilar,
  keywordSearch,
  deleteByBusinessId,
  deleteByRecordId,
  countByBusinessId,
  cosineSimilarity,
  buildMongoFilter,
};
