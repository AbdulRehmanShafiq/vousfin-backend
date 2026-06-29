const embeddingService = require('./embeddingService');
const vectorStore = require('./vectorStore.service');
const rerankService = require('./rerankService');

const DEFAULT_TOP_K = parseInt(process.env.RAG_TOP_K, 10) || 8;
const DEFAULT_CANDIDATES = parseInt(process.env.RAG_CANDIDATES, 10) || 40;
const MIN_SIMILARITY_THRESHOLD = Number(process.env.RAG_MIN_SIMILARITY || 0.15);
const MAX_CONTEXT_CHARS = parseInt(process.env.RAG_MAX_CONTEXT_CHARS, 10) || 14000;
const HYBRID_KEYWORD_WEIGHT = Number(process.env.RAG_KEYWORD_WEIGHT || 0.25);

const MONTHS = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function monthPeriod(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function periodsForYear(year) {
  return Array.from({ length: 12 }, (_, idx) => monthPeriod(year, idx + 1));
}

function periodsForQuarter(year, quarter) {
  const start = (quarter - 1) * 3 + 1;
  return [start, start + 1, start + 2].map((month) => monthPeriod(year, month));
}

function currentMonthPeriod() {
  const now = new Date();
  return monthPeriod(now.getFullYear(), now.getMonth() + 1);
}

function previousMonthPeriod() {
  const now = new Date();
  now.setMonth(now.getMonth() - 1);
  return monthPeriod(now.getFullYear(), now.getMonth() + 1);
}

function parsePeriodHints(question) {
  const text = String(question || '').toLowerCase();
  const periods = new Set();

  for (const match of text.matchAll(/\b(20\d{2})-(0[1-9]|1[0-2])\b/g)) {
    periods.add(match[0]);
  }

  for (const match of text.matchAll(/\bq([1-4])\s*(20\d{2})\b/g)) {
    periodsForQuarter(Number(match[2]), Number(match[1])).forEach((period) => periods.add(period));
  }

  for (const match of text.matchAll(/\b(20\d{2})\s*q([1-4])\b/g)) {
    periodsForQuarter(Number(match[1]), Number(match[2])).forEach((period) => periods.add(period));
  }

  for (const [name, month] of Object.entries(MONTHS)) {
    const re = new RegExp(`\\b${name}\\s+(20\\d{2})\\b`, 'g');
    for (const match of text.matchAll(re)) {
      periods.add(monthPeriod(Number(match[1]), month));
    }
  }

  if (/\bthis month\b/.test(text)) periods.add(currentMonthPeriod());
  if (/\blast month\b|\bprevious month\b/.test(text)) periods.add(previousMonthPeriod());

  const standaloneYears = [...text.matchAll(/\b(20\d{2})\b/g)].map((match) => Number(match[1]));
  if (/\blast year\b/.test(text)) {
    const now = new Date();
    periodsForYear(now.getFullYear() - 1).forEach((period) => periods.add(period));
  } else if (periods.size === 0 && standaloneYears.length === 1) {
    periodsForYear(standaloneYears[0]).forEach((period) => periods.add(period));
  }

  return [...periods];
}

function isContextSufficient(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return false;
  const bestScore = Math.max(...candidates.map((candidate) => Number(candidate.vectorScore || 0)));
  return bestScore >= MIN_SIMILARITY_THRESHOLD;
}

function formatSource(doc, index) {
  return `[Source ${index + 1}: ${doc.dataType} | ${doc.period}]\n${doc.summary}`;
}

function trimContext(parts) {
  const selected = [];
  let used = 0;

  for (const part of parts) {
    if (used + part.length > MAX_CONTEXT_CHARS) break;
    selected.push(part);
    used += part.length;
  }

  return selected.join('\n\n---\n\n');
}

function toSources(docs) {
  return docs.map((doc, index) => ({
    sourceId: index + 1,
    sourceRef: `${doc.dataType}:${doc.recordId || doc._id}:${doc.period}`,
    recordId: doc.recordId,
    dataType: doc.dataType,
    period: doc.period,
    score: Number(doc.vectorScore || 0),
  }));
}

function mergeCandidates(vectorResults = [], keywordResults = []) {
  const merged = new Map();

  const add = (doc, source, weight = 1) => {
    const key = `${doc.dataType}:${doc.recordId || doc._id}:${doc.period}`;
    const existing = merged.get(key);
    const incomingScore = Number(doc.vectorScore || 0) * weight;
    if (!existing) {
      merged.set(key, {
        ...doc,
        vectorScore: incomingScore,
        retrievalSources: [source],
      });
      return;
    }

    existing.vectorScore = Math.max(Number(existing.vectorScore || 0), incomingScore);
    if (!existing.retrievalSources.includes(source)) existing.retrievalSources.push(source);
  };

  vectorResults.forEach((doc) => add(doc, 'vector', 1));
  keywordResults.forEach((doc) => add(doc, 'keyword', HYBRID_KEYWORD_WEIGHT));

  return [...merged.values()].sort((a, b) => Number(b.vectorScore || 0) - Number(a.vectorScore || 0));
}

async function retrieveCandidates(businessId, question, queryVector, searchOptions, limit) {
  const [vectorResults, keywordResults] = await Promise.all([
    vectorStore.searchSimilar(queryVector, businessId, limit, { ...searchOptions, queryText: question }),
    vectorStore.keywordSearch(businessId, question, Math.max(10, Math.ceil(limit / 2)), searchOptions),
  ]);
  return mergeCandidates(vectorResults, keywordResults);
}

async function getContext(businessId, question, options = {}) {
  const startMs = Date.now();
  const queryVector = await embeddingService.embedQuery(question);
  const periodHints = options.periods || parsePeriodHints(question);
  const searchOptions = {
    periods: periodHints,
    dataTypes: options.dataTypes,
  };
  const candidateLimit = options.candidates || DEFAULT_CANDIDATES;
  let usedPeriodFilter = periodHints.length > 0;
  let periodFallback = false;
  let candidates = await retrieveCandidates(businessId, question, queryVector, searchOptions, candidateLimit);

  if (!isContextSufficient(candidates) && usedPeriodFilter && options.disablePeriodFallback !== true) {
    periodFallback = true;
    usedPeriodFilter = false;
    candidates = await retrieveCandidates(
      businessId,
      question,
      queryVector,
      { dataTypes: options.dataTypes },
      candidateLimit
    );
  }

  const bestScore = candidates.length
    ? Math.max(...candidates.map((candidate) => Number(candidate.vectorScore || 0)))
    : 0;

  if (!isContextSufficient(candidates)) {
    return {
      context: null,
      sources: [],
      confident: false,
      retrievalStats: {
        candidates: candidates.length,
        afterRerank: 0,
        bestScore,
        threshold: MIN_SIMILARITY_THRESHOLD,
        periodHints,
        usedPeriodFilter,
        periodFallback,
        latencyMs: Date.now() - startMs,
      },
    };
  }

  const topK = options.topK || DEFAULT_TOP_K;
  const rerankedIndexes = await rerankService.rerank(
    question,
    candidates.map((candidate) => candidate.summary),
    topK
  );

  const top = (rerankedIndexes.length ? rerankedIndexes : candidates.map((_, idx) => idx))
    .map((idx) => candidates[idx])
    .filter(Boolean)
    .slice(0, topK);

  const context = trimContext(top.map(formatSource));

  return {
    context,
    sources: toSources(top),
    confident: true,
    retrievalStats: {
      candidates: candidates.length,
      afterRerank: top.length,
      bestScore,
      threshold: MIN_SIMILARITY_THRESHOLD,
      periodHints,
      usedPeriodFilter,
      periodFallback,
      latencyMs: Date.now() - startMs,
    },
  };
}

async function semanticSearch(businessId, query, limit = 20) {
  const queryVector = await embeddingService.embedQuery(query);
  const periodHints = parsePeriodHints(query);
  const results = await retrieveCandidates(
    businessId,
    query,
    queryVector,
    { periods: periodHints },
    limit
  );
  return results.map((doc) => ({
    id: doc._id || doc.recordId,
    recordId: doc.recordId,
    dataType: doc.dataType,
    period: doc.period,
    summary: doc.summary,
    similarity: Number(doc.vectorScore || 0),
    sources: [{ dataType: doc.dataType, period: doc.period }],
  }));
}

module.exports = {
  getContext,
  semanticSearch,
  isContextSufficient,
  parsePeriodHints,
  mergeCandidates,
};
