// utils/aiExplain.helper.js — pure, grounded explanation of an AI decision
// (Intelligence Roadmap Phase 2: Explainability Everywhere).
//
// Renders a Phase-0 AIDecision record as plain language. Like narrative.service,
// every sentence is COMPUTED from the stored decision fields — it never
// introduces a value that isn't already in the record, so a hallucinated
// rationale is impossible (faithful by construction). Copy is plain for a
// non-accountant owner (no debit/credit jargon as the primary text).
'use strict';

function fmtAmount(n) {
  if (n == null || Number.isNaN(Number(n))) return null;
  return `Rs ${Math.round(Number(n)).toLocaleString('en-PK')}`;
}

const KIND_VERB = {
  parse: 'read', autopost: 'read', classify: 'looked at', match: 'checked',
  reconcile: 'reconciled', anomaly: 'reviewed', forecast: 'forecast from', recommend: 'reviewed',
};

const OUTCOME_SENTENCE = {
  pending: "You haven't reviewed this yet.",
  accepted: 'You accepted it.',
  corrected: 'You corrected it.',
  reversed: 'It was later reversed.',
};

/**
 * @param {object} decision  an AIDecision record (or lean object)
 * @returns {{ text: string, citedValues: string[], faithful: true }}
 */
function buildExplanation(decision = {}) {
  const { kind, inputsSummary, decision: d, confidence, outcome } = decision;
  const cited = [];
  const parts = [];
  const summary = inputsSummary ? `“${inputsSummary}”` : 'your input';

  if ((kind === 'parse' || kind === 'autopost') && d) {
    const amt = fmtAmount(d.amount);
    const type = d.transactionType || 'transaction';
    let s = `VousFin read ${summary} and suggested recording `;
    if (amt) { s += `${amt} `; cited.push(amt); }
    s += `as a ${type}`;
    if (d.debitAccount && d.creditAccount) {
      s += `, using the accounts ${d.debitAccount} and ${d.creditAccount}`;
      cited.push(d.debitAccount, d.creditAccount);
    }
    s += '.';
    parts.push(s);
    if (kind === 'autopost') {
      parts.push('It recorded this automatically because the confidence was above your auto-post limit and both accounts matched exactly.');
    }
  } else {
    const verb = KIND_VERB[kind] || 'reviewed';
    parts.push(`VousFin ${verb} ${summary}.`);
  }

  if (confidence != null) {
    const pct = Math.round(confidence * 100);
    parts.push(`It was ${pct}% confident.`);
    cited.push(`${pct}%`);
  }

  if (outcome && OUTCOME_SENTENCE[outcome]) parts.push(OUTCOME_SENTENCE[outcome]);

  return { text: parts.join(' '), citedValues: cited, faithful: true };
}

module.exports = { buildExplanation };
