'use strict';

/**
 * howTo.service.js — Tier 3 "how do I…" answers grounded in the GLOBAL help
 * corpus. It retrieves only app_help docs under the reserved sentinel, so no
 * tenant data is ever involved; it refuses (rather than hallucinate steps) when
 * nothing relevant is found, and always returns a deep link to the best page.
 */

const { GLOBAL_CATALOG_BUSINESS_ID } = require('../config/constants');
const embeddingService = require('./embeddingService');
const vectorStore = require('./vectorStore.service');
const modelRouter = require('./modelRouter.service');
const faithfulnessJudge = require('./faithfulnessJudge.service');
const logger = require('../config/logger');

const HELP_DATA_TYPE = 'app_help';
const MIN_SCORE = Number(process.env.CATALOG_SEARCH_MIN_SCORE || 0.15);
const TOP_K = parseInt(process.env.HOWTO_TOP_K, 10) || 4;
const REFUSAL = "I couldn't find a help article for that yet. Try rephrasing, or search for the page by name and open it directly.";

function buildPrompt(query, docs) {
  const context = docs
    .map((d, i) => `[Doc ${i + 1}] ${d.metadata?.title || d.recordId}\n${d.summary}`)
    .join('\n\n');
  return [
    {
      role: 'system',
      content:
        'You are VousFin\'s in-app help assistant. Answer ONLY from the help documents provided. '
        + 'Give a short, numbered list of steps in plain language for a non-accountant. '
        + 'Do not invent menu paths or features that are not in the documents. '
        + 'If the documents do not cover the question, say so briefly. Keep it under 6 steps.',
    },
    { role: 'user', content: `Help documents:\n${context}\n\nQuestion: ${query}\n\nSteps:` },
  ];
}

/** A usable answer built directly from the top help doc when the model is down. */
function fallbackAnswer(top) {
  return top?.summary ? top.summary : REFUSAL;
}

async function answerHowTo(query, { onToken } = {}) {
  const queryVector = await embeddingService.embedQuery(query);
  const hits = await vectorStore.searchSimilar(
    queryVector,
    GLOBAL_CATALOG_BUSINESS_ID,
    TOP_K,
    { dataTypes: [HELP_DATA_TYPE], queryText: query }
  );

  const relevant = hits.filter((h) => Number(h.vectorScore) >= MIN_SCORE).slice(0, TOP_K);
  if (relevant.length === 0) {
    return { grounded: false, answer: REFUSAL, href: null, sources: [] };
  }

  const top = relevant[0];
  const sources = relevant.map((h) => ({
    id: h.recordId,
    title: h.metadata?.title || h.recordId,
    href: h.metadata?.href || null,
  }));

  const messages = buildPrompt(query, relevant);
  let answer;
  try {
    const result = onToken
      ? await modelRouter.callChatStream(messages, { temperature: 0.2, max_tokens: 400 }, onToken)
      : await modelRouter.callChat(messages, { temperature: 0.2, max_tokens: 400 });
    answer = result.text;
    faithfulnessJudge.checkAsync(answer, messages[1].content, 'global');
  } catch (err) {
    logger.warn(`[howTo] model unavailable, using help-doc fallback: ${err.message}`);
    answer = fallbackAnswer(top);
  }

  return { grounded: true, answer, href: top.metadata?.href || null, sources };
}

module.exports = { answerHowTo, REFUSAL };
