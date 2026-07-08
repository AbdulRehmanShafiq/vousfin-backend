/**
 * Financial Query Engine — FR-03.1.
 *
 * Deterministic, GROUNDED answers for common financial questions, computed
 * straight from the live GL. Sits IN FRONT of the DeepSeek LLM inside
 * aiAssistant.chat(): if an intent matches, the answer is exact (labelled
 * "factual" with drill-down links); otherwise the LLM fallback handles it.
 * Forward-looking questions are answered from run-rate and labelled "estimate".
 *
 * Understands English + Roman-Urdu code-switching ("salaries pe kitna kharcha
 * hua last quarter?", "sab se zyada qarz kis customer ka hai?").
 */
'use strict';

const mongoose = require('mongoose');
const reportService = require('./report.service');

const fmt = (n) => `Rs ${Math.round(Math.abs(Number(n) || 0)).toLocaleString('en-PK')}`;

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

/* ── Period parsing (EN + Roman Urdu) ──────────────────────────────────────── */
function parsePeriod(q) {
  const now = new Date();
  const t = q.toLowerCase();
  const range = (s, e, label) => ({ start: s, end: e, label });

  // "in March", "march mein"
  for (let i = 0; i < 12; i++) {
    if (new RegExp(`\\b${MONTHS[i]}\\b`).test(t)) {
      const y = now.getMonth() >= i ? now.getFullYear() : now.getFullYear() - 1;
      return range(new Date(y, i, 1), new Date(y, i + 1, 1), `${MONTHS[i][0].toUpperCase()}${MONTHS[i].slice(1)} ${y}`);
    }
  }
  if (/last\s+quarter|pichl\w*\s+quarter/.test(t)) {
    const qIdx = Math.floor(now.getMonth() / 3);
    const s = new Date(now.getFullYear(), (qIdx - 1) * 3, 1);
    const e = new Date(now.getFullYear(), qIdx * 3, 1);
    return range(s, e, 'last quarter');
  }
  if (/this\s+quarter|is\s+quarter/.test(t)) {
    const s = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    return range(s, now, 'this quarter');
  }
  if (/last\s+month|pichl\w*\s+(mahin|month)/.test(t)) {
    return range(new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 1), 'last month');
  }
  if (/this\s+year|is\s+saal/.test(t)) {
    return range(new Date(now.getFullYear(), 0, 1), now, 'this year');
  }
  if (/last\s+year|pichl\w*\s+saal/.test(t)) {
    return range(new Date(now.getFullYear() - 1, 0, 1), new Date(now.getFullYear(), 0, 1), 'last year');
  }
  // default: this month
  return range(new Date(now.getFullYear(), now.getMonth(), 1), now, 'this month');
}

/* ── GL helpers ────────────────────────────────────────────────────────────── */
async function expenseByKeyword(businessId, keywords, start, end) {
  const is = await reportService.getIncomeStatement(businessId, start, end);
  const all = [
    ...(is.operatingExpenses?.accounts || []),
    ...(is.cogs?.accounts || []),
    ...(is.depreciationAmortization?.accounts || []),
  ];
  const hit = all.filter(a => keywords.some(k => a.accountName.toLowerCase().includes(k)));
  return { hit, total: hit.reduce((s, a) => s + a.balance, 0), totalExpenses: is.totalExpenses };
}

async function topDebtors(businessId, limit = 3) {
  const Customer = mongoose.model('Customer');
  const rows = await Customer.find({ businessId, currentReceivableBalance: { $gt: 0 } })
    .sort({ currentReceivableBalance: -1 }).limit(limit)
    .select('fullName currentReceivableBalance').lean();
  return rows.map(r => ({ ...r, name: r.fullName || 'Unnamed customer' }));
}

/* ── Intents ───────────────────────────────────────────────────────────────── */
const SALARY_KW  = ['salar', 'wage', 'payroll', 'tankhwa', 'tankha'];
const EXPENSE_CATEGORY_KW = {
  salaries:  SALARY_KW,
  rent:      ['rent', 'kiraya'],
  utilities: ['utilit', 'electric', 'bijli', 'gas', 'power'],
  fuel:      ['fuel', 'petrol', 'diesel'],
  marketing: ['market', 'advertis', 'ishtihar'],
};

async function answer(question, businessId) {
  const q = String(question || '').toLowerCase();
  const t0 = Date.now();
  const done = (res) => ({ ...res, engine: 'grounded-query', tookMs: Date.now() - t0 });

  /* 1 ─ "how much did we spend on X …" / "X pe kitna kharcha …" */
  const spendAsk = /(spend|spent|kharch|expense|cost)/.test(q);
  if (spendAsk) {
    for (const [cat, kws] of Object.entries(EXPENSE_CATEGORY_KW)) {
      if (kws.some(k => q.includes(k))) {
        const p = parsePeriod(q);
        const { hit, total } = await expenseByKeyword(businessId, kws, p.start, p.end);
        if (hit.length === 0) {
          return done({
            basis: 'factual',
            answer: `📊 Factual — live ledger: No ${cat} expense was recorded ${p.label}.`,
            figures: [],
          });
        }
        return done({
          basis: 'factual',
          answer: `📊 Factual — live ledger: You spent ${fmt(total)} on ${cat} ${p.label}` +
                  (hit.length > 1 ? ` across ${hit.length} accounts (${hit.map(h => h.accountName).join(', ')}).` : ` (account: ${hit[0].accountName}).`),
          figures: hit.map(h => ({ label: h.accountName, value: Math.round(h.balance), link: '/financial-reports/general-ledger' })),
          followUp: 'Want the individual entries? Open the General Ledger link.',
        });
      }
    }
  }

  /* 2 ─ "which customer owes us the most" / "sab se zyada qarz" */
  if (/(owes?|owe us|outstanding|receivab|qarz|udhaar?)/.test(q) && /(customer|client|kis|who|kon|most|zyada|sab se)/.test(q)) {
    const tops = await topDebtors(businessId, 3);
    if (!tops.length) {
      return done({ basis: 'factual', answer: '📊 Factual — live ledger: No customer currently owes you anything. All receivables are settled.', figures: [] });
    }
    const lead = tops[0];
    return done({
      basis: 'factual',
      answer: `📊 Factual — live ledger: ${lead.name} owes you the most: ${fmt(lead.currentReceivableBalance)}.` +
              (tops.length > 1 ? ` Next: ${tops.slice(1).map(c => `${c.name} (${fmt(c.currentReceivableBalance)})`).join(', ')}.` : ''),
      figures: tops.map(c => ({ label: c.name, value: Math.round(c.currentReceivableBalance), link: '/sales/receivables' })),
      followUp: 'Open Receivables to send a reminder or record a payment.',
    });
  }

  /* 3 ─ profitability: past = factual, future = estimate */
  if (/(profit|munafa|nuqsan|loss|profitable)/.test(q)) {
    const future = /(will|going to|forecast|expect|next|honge|hoga)/.test(q);
    const now = new Date();
    const mStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const is = await reportService.getIncomeStatement(businessId, mStart, now);
    if (!future) {
      const sign = is.netIncome >= 0 ? 'profit' : 'loss';
      return done({
        basis: 'factual',
        answer: `📊 Factual — live ledger: Month-to-date you have a net ${sign} of ${fmt(is.netIncome)} ` +
                `(revenue ${fmt(is.totalRevenue)} − expenses ${fmt(is.totalExpenses)}).`,
        figures: [
          { label: 'Net profit (MTD)', value: Math.round(is.netIncome), link: '/financial-reports/income-statement' },
          { label: 'Revenue (MTD)', value: Math.round(is.totalRevenue), link: '/financial-reports/income-statement' },
        ],
      });
    }
    // Estimate: extrapolate month-to-date run-rate to full month
    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const projected = (is.netIncome / Math.max(dayOfMonth, 1)) * daysInMonth;
    return done({
      basis: 'estimate',
      answer: `🔮 Estimate — based on this month's run-rate: you are on track for a net ${projected >= 0 ? 'profit' : 'loss'} of ` +
              `about ${fmt(projected)} this month (MTD actual: ${fmt(is.netIncome)} over ${dayOfMonth} days).`,
      figures: [{ label: 'MTD actual net', value: Math.round(is.netIncome), link: '/financial-reports/income-statement' }],
      followUp: 'See the AI Forecast tab for the model-based projection.',
    });
  }

  /* 4 ─ "what happened to our cash (in March)" / cash balance */
  if (/(cash|nakad|naqad).*(balance|happened|hua|position|kahan|where)|balance.*cash/.test(q)) {
    const p = parsePeriod(q);
    const bs = await reportService.getBalanceSheet(businessId, p.end);
    const bsStart = await reportService.getBalanceSheet(businessId, p.start);
    const cashOf = (b) => (b.assets?.accounts || [])
      .filter(a => /cash|bank/i.test(a.accountName))
      .reduce((s, a) => s + (a.balance || 0), 0);
    const endCash = cashOf(bs), startCash = cashOf(bsStart);
    const delta = endCash - startCash;
    return done({
      basis: 'factual',
      answer: `📊 Factual — live ledger: Cash & bank ${p.label}: ${delta >= 0 ? 'increased' : 'decreased'} by ${fmt(delta)} ` +
              `(from ${fmt(startCash)} to ${fmt(endCash)}).`,
      figures: [
        { label: `Cash at start of ${p.label}`, value: Math.round(startCash), link: '/financial-reports/balance-sheet' },
        { label: `Cash at end of ${p.label}`, value: Math.round(endCash), link: '/financial-reports/balance-sheet' },
      ],
      followUp: 'Open the Cash Flow statement for the operating/investing/financing split.',
    });
  }

  /* 5 ─ compare revenue vs same month last year */
  if (/(compare|muqabla|vs|versus).*(revenue|sales|amdani)|revenue.*(last year|pichlay saal)/.test(q)) {
    const now = new Date();
    const curS = new Date(now.getFullYear(), now.getMonth(), 1);
    const priS = new Date(now.getFullYear() - 1, now.getMonth(), 1);
    const priE = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    const cmp = await reportService.getComparativeIncomeStatement(businessId, curS, now, priS, priE);
    const r = cmp.revenue;
    const pctTxt = r.changePct === null ? '' : ` (${r.changePct >= 0 ? '+' : ''}${r.changePct}%)`;
    return done({
      basis: 'factual',
      answer: `📊 Factual — live ledger: Revenue this month is ${fmt(r.current)} vs ${fmt(r.prior)} in the same period last year` +
              `${pctTxt} — ${r.change >= 0 ? 'up' : 'down'} ${fmt(r.change)}.`,
      figures: [
        { label: 'Revenue (this month)', value: Math.round(r.current), link: '/financial-reports/income-statement' },
        { label: 'Revenue (same month last year)', value: Math.round(r.prior), link: '/financial-reports/comparative' },
      ],
    });
  }

  /* 6 ─ generic revenue / expense totals for a period */
  if (/(revenue|sales|amdani|income)\b/.test(q) && /(kitn|how much|total|what)/.test(q)) {
    const p = parsePeriod(q);
    const is = await reportService.getIncomeStatement(businessId, p.start, p.end);
    return done({
      basis: 'factual',
      answer: `📊 Factual — live ledger: Revenue ${p.label} was ${fmt(is.totalRevenue)}; expenses ${fmt(is.totalExpenses)}; net ${fmt(is.netIncome)}.`,
      figures: [{ label: `Revenue (${p.label})`, value: Math.round(is.totalRevenue), link: '/financial-reports/income-statement' }],
    });
  }

  return null; // no grounded intent — caller falls back to the LLM
}

module.exports = { answer, _parsePeriod: parsePeriod };
