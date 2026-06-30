/**
 * @module aiAssistant.service
 * @description Real AI financial assistant using Groq (LLaMA).
 * Collects live accounting data, builds a compact context summary,
 * and sends it to Groq to answer financial questions.
 *
 * Uses GROQ_API_KEY from .env. Does NOT touch the NL Parser,
 * forecasting service, or any unrelated modules.
 */

const crypto = require('crypto');
const reportService = require('./report.service');
const ragQuery = require('./ragQuery.service');
const faithfulnessJudge = require('./faithfulnessJudge.service');
const modelRouter = require('./modelRouter.service');
const AIInteractionLog = require('../models/AIInteractionLog.model');
const { extractJSON } = require('./nlParser/services/geminiService');
const logger = require('../config/logger');

const RAG_REFUSAL = "I don't have enough financial data indexed to answer that question accurately. This may be because the data is still being indexed. Please try again after reindexing, or ask about a different time period.";

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are vousFin AI, an expert financial assistant and chartered accountant for small and medium businesses in Pakistan.

You have access to the user's real, live financial data provided in each message inside a structured context block marked with === FINANCIAL CONTEXT ===.

Your role:
- Analyse financial data accurately and give actionable insights
- Answer accounting, finance, and business questions clearly and concisely
- Highlight risks, opportunities, and trends based ONLY on the provided data
- Use PKR (Pakistani Rupee) as the currency throughout
- Use markdown: **bold** for key numbers, bullet lists for multi-point answers
- Keep answers focused — 3–6 sentences or a short bullet list unless a detailed breakdown is asked
- Never invent or guess numbers — if data is absent, say "No data available for this period"
- When profit is negative, flag it as a loss and suggest corrective actions
- When asked about forecasting, remind the user to check the Forecast page for ML predictions

Topics you cover with expertise:
- Revenue analysis and income trends
- Expense analysis and cost optimisation
- Net profit / gross profit / operating profit
- Cash flow health and liquidity
- Balance sheet strength (assets vs liabilities vs equity)
- Accounts receivable / payable management and aging
- Fraud and anomaly alerts
- Business growth patterns
- Financial ratios (profit margin, current ratio, debt-to-equity)`;

function isRagEnabled() {
  return process.env.AI_RAG_ENABLED === 'true';
}

const BLOCKED_INTENTS = [
  /list all (invoices|customers|vendors|bills|transactions|entries)/i,
  /export (all|every|complete)/i,
  /give me (all|every) (record|transaction|entry|customer|vendor)/i,
  /dump (all|every|complete)/i,
];

function detectBlockedIntent(question) {
  return BLOCKED_INTENTS.some((pattern) => pattern.test(question || ''));
}

function hashQuestion(question) {
  return crypto.createHash('sha256').update(String(question || '')).digest('hex');
}

function buildRagSystemPrompt(context) {
  return `You are VousFin's Smart Accounting Assistant, a financial advisor for small and medium businesses in Pakistan.

Retrieved context from this business's indexed financial summaries:
${context}

Strict rules:
1. Answer only from the retrieved context above. Never invent, estimate, or assume a number that isn't there.
2. Treat all figures as approximate because indexed amounts are rounded for privacy — always present them as already-rounded conclusions (e.g. "~PKR 888K"). Never show the underlying arithmetic (no "PKR 222K x 4 = PKR 888K", no per-line addition chains) — do the math silently and state only the result.
3. If several sources are the same type of record (e.g. multiple journal entries), summarize them as one line item with a total, not a list of identical-looking entries.
4. Cite supporting evidence with [Source N] notation, citing a range (e.g. [Source 2-5]) when multiple sources support one figure.
5. Use PKR as the currency.
6. If the retrieved context answers the question: give a direct, structured answer in 3-6 sentences, leading with the headline figure.
7. If the retrieved context only partially answers the question: answer the part you can from real data, then name exactly what's missing in one short sentence and point to where the user can find it (e.g. "Check the Cash Flow page for liquidity details").
8. If the retrieved context does not address the question at all (e.g. it's about an unrelated period or category): say so in one sentence. Do not repurpose unrelated figures to manufacture an answer.
9. You cannot modify accounting records or execute transactions. Recommend review with an accountant for important decisions.`;
}

async function logAIQuery({ businessId, userId, question, mode, confident, sources, retrievalStats, details }) {
  try {
    await AIInteractionLog.create({
      businessId,
      userId: userId || null,
      eventType: confident === false ? 'AI_REFUSAL' : 'AI_QUERY',
      questionHash: hashQuestion(question),
      mode,
      confident,
      sources: Array.isArray(sources) ? sources.map((source) => ({
        dataType: source.dataType,
        period: source.period,
      })) : [],
      retrievalStats: retrievalStats || {},
      details: details || {},
    });
  } catch (error) {
    logger.warn(`[aiAssistant] Failed to log AI query event: ${error.message}`);
  }
}

function buildRagFallbackAnswer(sources = []) {
  if (!sources.length) return RAG_REFUSAL;
  const sourceList = sources
    .slice(0, 3)
    .map((source) => `${source.dataType.replace(/_/g, ' ')} (${source.period})`)
    .join(', ');
  return `I found relevant indexed financial context from ${sourceList}, but the AI model is currently unavailable. Please try again shortly.`;
}

// ── Financial context builder ─────────────────────────────────────────────────

async function buildFinancialContext(businessId) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  // Collect data with graceful failure for each source
  const ctx = {};

  // 1. Current-month income statement
  try {
    const is = await reportService.getIncomeStatement(businessId, startOfMonth, now);
    ctx.incomeStatement = {
      period: `${startOfMonth.toLocaleDateString('en-PK', { month: 'short', day: 'numeric' })} – today`,
      totalRevenue: is.totalRevenue ?? 0,
      totalExpenses: is.totalExpenses ?? 0,
      grossProfit: is.grossProfit ?? 0,
      netProfit: is.netIncome ?? is.netProfit ?? 0,
      topRevenue: (is.revenue?.accounts ?? [])
        .sort((a, b) => b.balance - a.balance)
        .slice(0, 3)
        .map(a => ({ name: a.accountName, amount: a.balance })),
      topExpenses: [...(is.operatingExpenses?.accounts ?? []), ...(is.cogs?.accounts ?? [])]
        .sort((a, b) => b.balance - a.balance)
        .slice(0, 5)
        .map(a => ({ name: a.accountName, amount: a.balance })),
    };
  } catch (e) {
    logger.warn('[aiAssistant] Income statement unavailable:', e.message);
    ctx.incomeStatement = null;
  }

  // 2. Balance sheet as of today
  try {
    const bs = await reportService.getBalanceSheet(businessId, now);
    ctx.balanceSheet = {
      totalAssets: bs.totalAssets ?? 0,
      totalLiabilities: bs.totalLiabilities ?? 0,
      totalEquity: bs.totalEquity ?? 0,
      equationValid: bs.equationValid,
      topAssets: (bs.assets?.accounts ?? [])
        .filter(a => a.balance > 0)
        .sort((a, b) => b.balance - a.balance)
        .slice(0, 3)
        .map(a => ({ name: a.accountName, amount: a.balance })),
    };
  } catch (e) {
    logger.warn('[aiAssistant] Balance sheet unavailable:', e.message);
    ctx.balanceSheet = null;
  }

  // 3. Cash flow for current month
  try {
    const cf = await reportService.getCashFlowStatement(businessId, startOfMonth, now);
    ctx.cashFlow = {
      netCashFlow: cf.netCashFlow ?? 0,
      operatingCashFlow: cf.operating?.total ?? 0,
    };
  } catch (e) {
    logger.warn('[aiAssistant] Cash flow unavailable:', e.message);
    ctx.cashFlow = null;
  }

  // 4. Receivables aging
  try {
    const ar = await reportService.getAgingReport(businessId, 'receivable');
    ctx.receivables = {
      total: ar.total ?? 0,
      current: ar.current ?? 0,
      overdue: (ar.days_1_30 ?? 0) + (ar.days_31_60 ?? 0) + (ar.days_61_90 ?? 0) + (ar.days_over_90 ?? 0),
    };
  } catch (e) {
    ctx.receivables = null;
  }

  // 5. Payables aging
  try {
    const ap = await reportService.getAgingReport(businessId, 'payable');
    ctx.payables = {
      total: ap.total ?? 0,
      current: ap.current ?? 0,
      overdue: (ap.days_1_30 ?? 0) + (ap.days_31_60 ?? 0) + (ap.days_61_90 ?? 0) + (ap.days_over_90 ?? 0),
    };
  } catch (e) {
    ctx.payables = null;
  }

  // 6. Anomaly alert counts
  try {
    const anomalyService = require('./anomalyDetection.service');
    const stats = await anomalyService.getStats(businessId);
    ctx.anomalyAlerts = {
      pending: stats.pending ?? 0,
      confirmed: stats.confirmed_issue ?? 0,
    };
  } catch (e) {
    ctx.anomalyAlerts = null;
  }

  return ctx;
}

// ── Format context as compact text ────────────────────────────────────────────

function formatContext(ctx) {
  const fmt = (n) =>
    n != null
      ? `PKR ${Number(n).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`
      : 'N/A';

  const lines = ['=== FINANCIAL CONTEXT (live data, current month) ==='];

  if (ctx.incomeStatement) {
    const is = ctx.incomeStatement;
    const profitLabel = is.netProfit < 0 ? 'Net LOSS' : 'Net Profit';
    lines.push(`\n[INCOME STATEMENT – ${is.period}]`);
    lines.push(`Total Revenue: ${fmt(is.totalRevenue)}`);
    lines.push(`Total Expenses: ${fmt(is.totalExpenses)}`);
    lines.push(`Gross Profit: ${fmt(is.grossProfit)}`);
    lines.push(`${profitLabel}: ${fmt(is.netProfit)}`);
    if (is.topRevenue?.length) {
      lines.push(`Top Revenue Sources: ${is.topRevenue.map(a => `${a.name} (${fmt(a.amount)})`).join(' | ')}`);
    }
    if (is.topExpenses?.length) {
      lines.push(`Top Expense Accounts: ${is.topExpenses.map(a => `${a.name} (${fmt(a.amount)})`).join(' | ')}`);
    }
  } else {
    lines.push('\n[INCOME STATEMENT] No transaction data recorded this month.');
  }

  if (ctx.balanceSheet) {
    const bs = ctx.balanceSheet;
    lines.push(`\n[BALANCE SHEET – as of today]`);
    lines.push(`Total Assets: ${fmt(bs.totalAssets)}`);
    lines.push(`Total Liabilities: ${fmt(bs.totalLiabilities)}`);
    lines.push(`Total Equity: ${fmt(bs.totalEquity)}`);
    lines.push(`Accounting Equation: ${bs.equationValid ? 'Balanced ✓' : 'UNBALANCED ⚠️'}`);
    if (bs.topAssets?.length) {
      lines.push(`Top Assets: ${bs.topAssets.map(a => `${a.name} (${fmt(a.amount)})`).join(' | ')}`);
    }
  } else {
    lines.push('\n[BALANCE SHEET] Not available.');
  }

  if (ctx.cashFlow) {
    const cf = ctx.cashFlow;
    const cfLabel = cf.netCashFlow < 0 ? 'NEGATIVE cash flow' : 'Positive cash flow';
    lines.push(`\n[CASH FLOW – current month]`);
    lines.push(`Net Cash Flow: ${fmt(cf.netCashFlow)} (${cfLabel})`);
    lines.push(`Operating Cash Flow: ${fmt(cf.operatingCashFlow)}`);
  } else {
    lines.push('\n[CASH FLOW] Not available (Cash/Bank account may not be configured).');
  }

  if (ctx.receivables) {
    lines.push(`\n[ACCOUNTS RECEIVABLE] Total: ${fmt(ctx.receivables.total)} | Current: ${fmt(ctx.receivables.current)} | Overdue: ${fmt(ctx.receivables.overdue)}`);
  }
  if (ctx.payables) {
    lines.push(`[ACCOUNTS PAYABLE] Total: ${fmt(ctx.payables.total)} | Current: ${fmt(ctx.payables.current)} | Overdue: ${fmt(ctx.payables.overdue)}`);
  }
  if (ctx.anomalyAlerts) {
    lines.push(`\n[FRAUD ALERTS] ${ctx.anomalyAlerts.pending} pending review | ${ctx.anomalyAlerts.confirmed} confirmed anomalies`);
  }

  lines.push('\n=== END FINANCIAL CONTEXT ===');
  return lines.join('\n');
}

// ── Groq API call helper ──────────────────────────────────────────────────────

/**
 * Send a messages array to the model gateway and return the assistant's text.
 * The gateway (modelRouter) owns provider selection, retries, timeouts and the
 * Groq → Gemini fallback chain, so this stays a thin text-only wrapper.
 * @param {Array<{role:string,content:string}>} messages - OpenAI-format messages
 * @param {object} opts - Optional overrides: temperature, max_tokens
 */
async function callGroq(messages, opts = {}) {
  const result = await modelRouter.callChat(messages, opts);
  return result.text;
}

// ── Fallback response builder ───────────────────────────────────────────────

function buildFallbackAnswer(question, ctx) {
  const q = (question || '').toLowerCase();
  const fmt = (n) => `PKR ${Number(n || 0).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`;

  if (ctx.cashFlow && (q.includes('cash') || q.includes('flow'))) {
    return `The AI model was unavailable, so I used your latest ledger data instead. Net cash flow for the current month is ${fmt(ctx.cashFlow.netCashFlow)}.`;
  }

  if (ctx.incomeStatement) {
    const is = ctx.incomeStatement;
    if (q.includes('profit') || q.includes('loss') || q.includes('income')) {
      const label = is.netProfit < 0 ? 'loss' : 'profit';
      const absAmount = Math.abs(is.netProfit || 0);
      return `The AI model was unavailable, so I used your latest ledger data instead. Your current month shows a ${label} of ${fmt(absAmount)} with revenue of ${fmt(is.totalRevenue)} and expenses of ${fmt(is.totalExpenses)}.`;
    }

    if (q.includes('expense') || q.includes('cost')) {
      const topExpense = is.topExpenses?.[0];
      if (topExpense) {
        return `The AI model was unavailable, so I used your latest ledger data instead. Your largest expense category is ${topExpense.name} at ${fmt(topExpense.amount)}.`;
      }
    }
  }

  if (ctx.balanceSheet) {
    const bs = ctx.balanceSheet;
    return `The AI model was unavailable, so I used your latest ledger data instead. Your balance sheet shows total assets of ${fmt(bs.totalAssets)}, liabilities of ${fmt(bs.totalLiabilities)}, and equity of ${fmt(bs.totalEquity)}.`;
  }

  return 'The AI model was unavailable, so I used your latest ledger data instead. There is not enough financial data available yet to provide a richer answer.';
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Try the deterministic grounded query engine first for exact GL figures.
 */
async function tryGroundedAnswer(question, businessId) {
  try {
    const grounded = await require('./financialQuery.service').answer(question, businessId);
    if (!grounded) return null;

    const answer = grounded.answer + (grounded.followUp ? `\n\n${grounded.followUp}` : '');
    return {
      answer,
      response: answer,
      basis: grounded.basis,
      figures: grounded.figures,
      grounded: true,
      sources: [],
      confident: true,
      mode: 'grounded',
    };
  } catch (error) {
    logger.warn(`[financialQuery] grounded engine failed, falling back to assistant flow: ${error.message}`);
    return null;
  }
}

function buildRagMessages(question, context, chatHistory = []) {
  const messages = [{ role: 'system', content: buildRagSystemPrompt(context) }];
  chatHistory
    .slice(-8)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .forEach((m) => messages.push({ role: m.role, content: m.content }));
  messages.push({ role: 'user', content: question });
  return messages;
}

function emitChunkedFallback(answer, onToken) {
  if (typeof onToken === 'function') {
    modelRouter.emitChunkedText(answer, onToken);
  }
}

/**
 * Answer from indexed summaries only. Used when AI_RAG_ENABLED=true.
 */
async function chatWithRag(question, businessId, chatHistory = [], options = {}) {
  const userId = options.userId || null;
  const onToken = typeof options.onToken === 'function' ? options.onToken : null;
  const onMeta = typeof options.onMeta === 'function' ? options.onMeta : null;

  if (detectBlockedIntent(question)) {
    const answer = "I can't list or export complete raw accounting records from the assistant. Please use the relevant ledger, invoice, customer, or vendor page with filters and export controls.";
    onMeta?.({ sources: [], confident: false, mode: 'rag-blocked', retrievalStats: { blockedIntent: true } });
    emitChunkedFallback(answer, onToken);
    await logAIQuery({
      businessId,
      userId,
      question,
      mode: 'rag-blocked',
      confident: false,
      sources: [],
      retrievalStats: { blockedIntent: true },
    });
    return { answer, response: answer, sources: [], confident: false, mode: 'rag-blocked' };
  }

  const retrieval = await ragQuery.getContext(businessId, question, options.retrieval || {});
  if (!retrieval.context) {
    await logAIQuery({
      businessId,
      userId,
      question,
      mode: 'rag-refusal',
      confident: false,
      sources: retrieval.sources,
      retrievalStats: retrieval.retrievalStats,
    });
    onMeta?.({
      sources: retrieval.sources || [],
      confident: false,
      mode: 'rag-refusal',
      retrievalStats: retrieval.retrievalStats,
    });
    emitChunkedFallback(RAG_REFUSAL, onToken);
    return {
      answer: RAG_REFUSAL,
      response: RAG_REFUSAL,
      sources: retrieval.sources || [],
      confident: false,
      mode: 'rag-refusal',
      retrievalStats: retrieval.retrievalStats,
    };
  }

  onMeta?.({
    sources: retrieval.sources || [],
    confident: true,
    mode: 'rag',
    retrievalStats: retrieval.retrievalStats,
  });

  const messages = buildRagMessages(question, retrieval.context, chatHistory);

  try {
    const result = onToken
      ? await modelRouter.callChatStream(messages, { temperature: 0.25, max_tokens: 800 }, onToken)
      : await modelRouter.callChat(messages, { temperature: 0.25, max_tokens: 800 });
    const answer = result.text;
    faithfulnessJudge.checkAsync(answer, retrieval.context, businessId);
    await logAIQuery({
      businessId,
      userId,
      question,
      mode: 'rag',
      confident: true,
      sources: retrieval.sources,
      retrievalStats: retrieval.retrievalStats,
      details: { provider: result.provider },
    });
    return {
      answer,
      response: answer,
      sources: retrieval.sources || [],
      confident: true,
      mode: 'rag',
      retrievalStats: retrieval.retrievalStats,
      provider: result.provider,
    };
  } catch (error) {
    logger.warn(`[aiAssistant] RAG model call failed, using indexed-context fallback: ${error.message}`);
    const answer = buildRagFallbackAnswer(retrieval.sources || []);
    emitChunkedFallback(answer, onToken);
    await logAIQuery({
      businessId,
      userId,
      question,
      mode: 'rag-model-fallback',
      confident: false,
      sources: retrieval.sources,
      retrievalStats: retrieval.retrievalStats,
      details: { error: error.message },
    });
    return {
      answer,
      response: answer,
      sources: retrieval.sources || [],
      confident: false,
      mode: 'rag-model-fallback',
      retrievalStats: retrieval.retrievalStats,
    };
  }
}

/**
 * Answer a financial question using the grounded engine, RAG, or live data + Groq.
 *
 * @param {string} question - User's question
 * @param {string} businessId - Authenticated business ID
 * @param {Array}  chatHistory - Prior messages [{ role: 'user'|'assistant', content: string }]
 * @param {object} options - Optional metadata such as userId
 * @returns {Promise<{ answer: string }>}
 */
async function chat(question, businessId, chatHistory = [], options = {}) {
  const grounded = await tryGroundedAnswer(question, businessId);
  if (grounded) return grounded;

  if (isRagEnabled()) {
    try {
      return await chatWithRag(question, businessId, chatHistory, options);
    } catch (error) {
      logger.warn(`[aiAssistant] RAG flow failed: ${error.message}`);
      await logAIQuery({
        businessId,
        userId: options.userId,
        question,
        mode: 'rag-error',
        confident: false,
        sources: [],
        retrievalStats: { error: error.message },
      });
      return {
        answer: RAG_REFUSAL,
        response: RAG_REFUSAL,
        sources: [],
        confident: false,
        mode: 'rag-error',
      };
    }
  }

  const ctx = await buildFinancialContext(businessId);
  const contextBlock = formatContext(ctx);
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  chatHistory
    .slice(-8)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .forEach((m) => messages.push({ role: m.role, content: m.content }));

  messages.push({
    role: 'user',
    content: `${contextBlock}\n\nQuestion: ${question}`,
  });

  try {
    const answer = await callGroq(messages, { temperature: 0.5, max_tokens: 800 });
    return { answer, response: answer, sources: [], confident: true, mode: 'llm' };
  } catch (error) {
    logger.warn(`[aiAssistant] Live-context model call failed, using deterministic fallback: ${error.message}`);
    const answer = buildFallbackAnswer(question, ctx);
    return { answer, response: answer, sources: [], confident: false, mode: 'fallback' };
  }
}

async function chatStream(question, businessId, chatHistory = [], options = {}) {
  const onToken = typeof options.onToken === 'function' ? options.onToken : () => {};
  const onMeta = typeof options.onMeta === 'function' ? options.onMeta : null;
  const grounded = await tryGroundedAnswer(question, businessId);
  if (grounded) {
    onMeta?.(grounded);
    modelRouter.emitChunkedText(grounded.answer, onToken);
    return grounded;
  }

  if (isRagEnabled()) {
    try {
      return await chatWithRag(question, businessId, chatHistory, { ...options, onToken });
    } catch (error) {
      logger.warn(`[aiAssistant] RAG stream flow failed: ${error.message}`);
      await logAIQuery({
        businessId,
        userId: options.userId,
        question,
        mode: 'rag-error',
        confident: false,
        sources: [],
        retrievalStats: { error: error.message },
      });
      onMeta?.({ sources: [], confident: false, mode: 'rag-error', retrievalStats: { error: error.message } });
      modelRouter.emitChunkedText(RAG_REFUSAL, onToken);
      return {
        answer: RAG_REFUSAL,
        response: RAG_REFUSAL,
        sources: [],
        confident: false,
        mode: 'rag-error',
      };
    }
  }

  const ctx = await buildFinancialContext(businessId);
  const contextBlock = formatContext(ctx);
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  chatHistory
    .slice(-8)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .forEach((m) => messages.push({ role: m.role, content: m.content }));

  messages.push({
    role: 'user',
    content: `${contextBlock}\n\nQuestion: ${question}`,
  });

  try {
    onMeta?.({ sources: [], confident: true, mode: 'llm' });
    const result = await modelRouter.callChatStream(messages, { temperature: 0.5, max_tokens: 800 }, onToken);
    return { answer: result.text, response: result.text, sources: [], confident: true, mode: 'llm', provider: result.provider };
  } catch (error) {
    logger.warn(`[aiAssistant] Live-context stream failed, using deterministic fallback: ${error.message}`);
    const answer = buildFallbackAnswer(question, ctx);
    onMeta?.({ sources: [], confident: false, mode: 'fallback' });
    modelRouter.emitChunkedText(answer, onToken);
    return { answer, response: answer, sources: [], confident: false, mode: 'fallback' };
  }
}
/**
 * Generate 3-4 AI-powered actionable financial recommendations
 * based on live accounting data. Falls back to rule-based tips if Groq fails.
 *
 * @param {string} businessId
 * @returns {Promise<Array<{ type: string, text: string }>>}
 */
async function generateRecommendations(businessId) {
  if (isRagEnabled()) {
    try {
      const retrieval = await ragQuery.getContext(
        businessId,
        'financial recommendations revenue expenses cash flow receivables payables risks',
        { topK: 6 }
      );

      if (retrieval.context) {
        const messages = [
          {
            role: 'system',
            content: `${buildRagSystemPrompt(retrieval.context)}\n\nOutput ONLY a valid JSON array of recommendations.`,
          },
          {
            role: 'user',
            content: 'Generate exactly 3 to 4 specific, actionable recommendations. Return JSON only: [{ "type": "warning|positive|info", "text": "specific recommendation" }]',
          },
        ];
        const raw = await callGroq(messages, { temperature: 0.25, max_tokens: 500 });
        const parsed = extractJSON(raw);

        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        if (Array.isArray(parsed?.recommendations)) return parsed.recommendations;
      }
    } catch (error) {
      logger.warn(`[aiAssistant] RAG recommendations failed, using live-context recommendations: ${error.message}`);
    }
  }

  const ctx = await buildFinancialContext(businessId);

  // Fallback: no data yet
  const hasData = ctx.incomeStatement?.totalRevenue > 0 || ctx.balanceSheet?.totalAssets > 0;
  if (!hasData) {
    return [
      { type: 'info', text: 'Start recording transactions to unlock AI-powered financial recommendations.' },
      { type: 'info', text: 'Use the NLP Parser to quickly add transactions by typing natural language descriptions.' },
    ];
  }

  const contextBlock = formatContext(ctx);
  const prompt = `${contextBlock}

Generate exactly 3 to 4 specific, actionable financial recommendations for this business based on the data above.
Return a JSON array ONLY — no extra text, no markdown, no explanation:
[
  { "type": "warning|positive|info", "text": "recommendation text (1-2 sentences, specific to the numbers)" }
]
Use "warning" for risks/problems, "positive" for strengths/opportunities, "info" for neutral tips.`;

  try {
    const messages = [
      { role: 'system', content: 'You are a financial advisor. Output ONLY a valid JSON array of recommendations. No markdown, no explanation.' },
      { role: 'user',   content: prompt },
    ];

    const raw    = await callGroq(messages, { temperature: 0.3, max_tokens: 500 });
    const parsed = extractJSON(raw);

    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    if (Array.isArray(parsed?.recommendations)) return parsed.recommendations;
    throw new Error('Unexpected JSON shape');
  } catch (err) {
    logger.warn('[aiAssistant] Recommendations Groq call failed, using rule-based fallback:', err.message);
    return buildRuleBasedRecommendations(ctx);
  }
}

/**
 * Rule-based recommendation fallback — never leaves the panel empty.
 */
function buildRuleBasedRecommendations(ctx) {
  const recs = [];

  if (ctx.incomeStatement) {
    const is = ctx.incomeStatement;
    if (is.netProfit < 0) {
      recs.push({ type: 'warning', text: `Your business is running at a net loss of PKR ${Math.abs(is.netProfit).toLocaleString()} this month. Review your top expenses and identify areas to reduce costs.` });
    } else if (is.netProfit > 0 && is.totalRevenue > 0) {
      const margin = ((is.netProfit / is.totalRevenue) * 100).toFixed(1);
      recs.push({ type: 'positive', text: `Your net profit margin is ${margin}% this month — ${margin > 15 ? 'excellent performance' : 'there is room to improve margins by reducing overhead'}.` });
    }

    if (is.topExpenses?.length) {
      const top = is.topExpenses[0];
      if (top.amount > is.totalRevenue * 0.3) {
        recs.push({ type: 'warning', text: `${top.name} represents more than 30% of your revenue (PKR ${top.amount.toLocaleString()}). Consider renegotiating or reducing this cost.` });
      }
    }
  }

  if (ctx.cashFlow && ctx.cashFlow.netCashFlow < 0) {
    recs.push({ type: 'warning', text: `Your net cash flow is negative this month. Prioritise collecting outstanding receivables and defer non-essential spending.` });
  }

  if (ctx.receivables && ctx.receivables.overdue > 0) {
    recs.push({ type: 'warning', text: `You have PKR ${ctx.receivables.overdue.toLocaleString()} in overdue receivables. Follow up with customers to improve cash collection.` });
  }

  if (ctx.anomalyAlerts && ctx.anomalyAlerts.pending > 0) {
    recs.push({ type: 'warning', text: `${ctx.anomalyAlerts.pending} transaction${ctx.anomalyAlerts.pending > 1 ? 's' : ''} flagged by the AI fraud detector. Review them in the Anomaly Detection section.` });
  }

  if (recs.length === 0) {
    recs.push({ type: 'positive', text: 'Your financial records look healthy this month. Keep transactions up to date for accurate AI insights.' });
  }

  return recs;
}

module.exports = {
  chat,
  chatStream,
  chatWithRag,
  generateRecommendations,
  buildFallbackAnswer,
  buildRagSystemPrompt,
  detectBlockedIntent,
};
