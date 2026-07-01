// utils/aiDecision.helper.js — pure logic for the AI Decision Ledger (no I/O).
'use strict';
const { AI_DECISION_KINDS, AI_DECISION_OUTCOMES } = require('../config/constants');

const VALID_KINDS = new Set(Object.values(AI_DECISION_KINDS));
const SETTABLE_OUTCOMES = new Set([
  AI_DECISION_OUTCOMES.ACCEPTED, AI_DECISION_OUTCOMES.CORRECTED, AI_DECISION_OUTCOMES.REVERSED,
]);

const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));

/**
 * Normalize a raw AI decision payload into an immutable-ready record object.
 * @throws Error on invalid kind / missing businessId / empty inputsSummary
 */
function buildDecisionRecord(businessId, kind, payload = {}) {
  if (!businessId) throw new Error('AIDecision requires a businessId');
  if (!VALID_KINDS.has(kind)) throw new Error(`AIDecision: invalid kind "${kind}"`);
  const inputsSummary = String(payload.inputsSummary || '').trim();
  if (!inputsSummary) throw new Error('AIDecision requires a non-empty inputsSummary');
  return {
    businessId,
    kind,
    inputsSummary: inputsSummary.slice(0, 2000),
    candidates: Array.isArray(payload.candidates) ? payload.candidates.slice(0, 20) : [],
    decision: payload.decision ?? null,
    confidence: payload.confidence == null ? null : clamp01(payload.confidence),
    model: payload.model ? String(payload.model).slice(0, 80) : null,
    promptVersion: payload.promptVersion ? String(payload.promptVersion).slice(0, 40) : null,
    linkedEntityId: payload.linkedEntityId || null,
    outcome: AI_DECISION_OUTCOMES.PENDING,
  };
}

/** Guard the one-time outcome transition. @throws on illegal transition/value. */
function applyOutcome(currentOutcome, newOutcome) {
  if (!SETTABLE_OUTCOMES.has(newOutcome)) throw new Error(`AIDecision: invalid outcome "${newOutcome}"`);
  if (currentOutcome !== AI_DECISION_OUTCOMES.PENDING) throw new Error('AIDecision outcome already set');
  return newOutcome;
}

module.exports = { buildDecisionRecord, applyOutcome };
