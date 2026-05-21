/**
 * @module aiAssistant.service
 * @description Real AI financial assistant using Gemini Flash.
 * Collects live accounting data, builds a compact context summary,
 * and sends it to Gemini Flash to answer financial questions.
 *
 * Reuses the same GEMINI_API_KEY and model as the NL Parser.
 * Does NOT touch the forecasting service or any unrelated modules.
 */

const reportService = require('./report.service');
const { extractJSON } = require('./nlParser/services/geminiService');
const logger = require('../config/logger');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const TIMEOUT_MS = 30000;

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

// ── Gemini API call helper ────────────────────────────────────────────────────

async function callGemini(requestBody, retries = 2) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY environment variable is not set');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Gemini API error (${res.status}): ${body.slice(0, 200)}`);
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Gemini returned an empty response');
      return text.trim();
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastError;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Answer a financial question using live data + Gemini Flash.
 *
 * @param {string} question - User's question
 * @param {string} businessId - Authenticated business ID
 * @param {Array}  chatHistory - Prior messages [{ role: 'user'|'assistant', content: string }]
 * @returns {Promise<{ answer: string }>}
 */
async function chat(question, businessId, chatHistory = []) {
  // Build financial context fresh every call so numbers are always current
  const ctx = await buildFinancialContext(businessId);
  const contextBlock = formatContext(ctx);

  // Convert prior messages to Gemini format (last 8 to limit tokens)
  const priorMessages = chatHistory
    .slice(-8)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  // Current user turn: inject financial context into the message
  const currentTurn = {
    role: 'user',
    parts: [{ text: `${contextBlock}\n\nQuestion: ${question}` }],
  };

  const requestBody = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [...priorMessages, currentTurn],
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: 800,
    },
  };

  const answer = await callGemini(requestBody);
  return { answer };
}

/**
 * Generate 3-4 AI-powered actionable financial recommendations
 * based on live accounting data. Falls back to rule-based tips if Gemini fails.
 *
 * @param {string} businessId
 * @returns {Promise<Array<{ type: string, text: string }>>}
 */
async function generateRecommendations(businessId) {
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
Return a JSON array only — no extra text:
[
  { "type": "warning|positive|info", "text": "recommendation text (1-2 sentences, specific to the numbers)" }
]
Use "warning" for risks/problems, "positive" for strengths/opportunities, "info" for neutral tips.`;

  try {
    const requestBody = {
      system_instruction: {
        parts: [{ text: 'You are a financial advisor. Output only a valid JSON array of recommendations.' }],
      },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 500,
        responseMimeType: 'application/json',
      },
    };

    const raw = await callGemini(requestBody, 2);
    const parsed = extractJSON(raw);

    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    if (Array.isArray(parsed?.recommendations)) return parsed.recommendations;
    throw new Error('Unexpected JSON shape');
  } catch (err) {
    logger.warn('[aiAssistant] Recommendations Gemini call failed, using rule-based fallback:', err.message);
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

module.exports = { chat, generateRecommendations };
