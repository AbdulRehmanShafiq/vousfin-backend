/**
 * approvalEngine.service.js — AR/AP Domain Refactor, Milestone M6.
 *
 * Multi-level approval engine for invoices and bills. Pure + framework-free:
 * it builds and advances an ordered approval chain on a document, enforcing
 * role validation, segregation of duties (creator ≠ approver), sequential
 * progression and per-step audit history. The document services persist the
 * mutated chain; final approval triggers the existing recognition posting.
 *
 * Ladder (by amount tier): Level 1 → Level 2 → Finance → Controller → CFO.
 */

'use strict';

const { ApiError } = require('../utils/ApiError');
const {
  APPROVAL_LEVELS, APPROVAL_TIERS, APPROVAL_STEP_STATUS, APPROVER_ROLES,
} = require('../config/constants');

const LEVELS_BY_KEY = Object.values(APPROVAL_LEVELS).reduce((m, l) => { m[l.key] = l; return m; }, {});
const ORDERED = Object.values(APPROVAL_LEVELS).sort((a, b) => a.rank - b.rank);
const S = APPROVAL_STEP_STATUS;

/** Build the ordered approval chain for an amount (first matching tier). */
function buildChain(amount, opts = {}) {
  const amt = Number(amount) || 0;
  const tiers = opts.tiers || APPROVAL_TIERS;
  const tier = tiers.find((t) => amt <= t.maxAmount) || tiers[tiers.length - 1];
  return tier.levels.map((key, i) => ({
    sequence:     i + 1,
    level:        key,
    name:         (LEVELS_BY_KEY[key] || {}).name || key,
    requiredRole: key,
    status:       S.PENDING,
    actorId:      null,
    actorName:    null,
    actedAt:      null,
    note:         null,
    history:      [],
  }));
}

/** The first still-pending step (the only one that may be acted on). */
function currentStep(chain) {
  return (chain || []).find((s) => s.status === S.PENDING) || null;
}

function isComplete(chain) {
  return Array.isArray(chain) && chain.length > 0 && chain.every((s) => s.status === S.APPROVED);
}
function isRejected(chain) {
  return (chain || []).some((s) => s.status === S.REJECTED);
}

/** Role validation: owner/admin override; otherwise the user must hold the step's level. */
function canUserApprove(user, step) {
  if (!user || !step) return false;
  if (user.role === APPROVER_ROLES.OWNER || user.role === APPROVER_ROLES.ADMIN) return true;
  const levels = Array.isArray(user.approvalLevels) ? user.approvalLevels : [];
  return levels.includes(step.level) || user.role === step.requiredRole;
}

/** Segregation of duties — the creator can never approve their own document. */
function assertSoD(doc, user) {
  if (doc && doc.createdBy && user && String(doc.createdBy) === String(user._id)) {
    throw new ApiError(403, 'Segregation of duties: the creator of a document cannot approve it');
  }
}

function _act(doc, user, statusForStep, action, note) {
  const step = currentStep(doc.approvalChain);
  if (!step) throw new ApiError(409, 'No pending approval step');
  assertSoD(doc, user);
  if (!canUserApprove(user, step)) {
    throw new ApiError(403, `Your role is not permitted to ${action} the ${step.name} step`);
  }
  step.status   = statusForStep;
  step.actorId  = user._id;
  step.actorName = user.fullName || user.email || 'User';
  step.actedAt  = new Date();
  step.note     = note || null;
  step.history.push({ action, actorId: user._id, at: new Date(), note: note || null });
  return step;
}

/** Approve the current step. @returns {{ fullyApproved, nextStep }} */
function approveStep(doc, user, note) {
  _act(doc, user, S.APPROVED, 'approve', note);
  return { fullyApproved: isComplete(doc.approvalChain), nextStep: currentStep(doc.approvalChain) };
}

/** Reject the current step → the whole chain is rejected. */
function rejectStep(doc, user, note) {
  _act(doc, user, S.REJECTED, 'reject', note);
  return { rejected: true };
}

/** Reassign the current pending step to a different approval level/role. */
function reassignStep(doc, newLevel, user, note) {
  const step = currentStep(doc.approvalChain);
  if (!step) throw new ApiError(409, 'No pending approval step to reassign');
  if (!LEVELS_BY_KEY[newLevel]) throw new ApiError(400, `Unknown approval level "${newLevel}"`);
  step.history.push({ action: 'reassigned', from: step.level, to: newLevel, actorId: user && user._id, at: new Date(), note: note || null });
  step.level = newLevel;
  step.requiredRole = newLevel;
  step.name = LEVELS_BY_KEY[newLevel].name;
  step.status = S.PENDING;
  return { reassignedTo: newLevel };
}

/** Escalate the current pending step to the next-higher authority (… → CFO). */
function escalateStep(doc, user, note) {
  const step = currentStep(doc.approvalChain);
  if (!step) throw new ApiError(409, 'No pending approval step to escalate');
  const cur = LEVELS_BY_KEY[step.level];
  const next = ORDERED.find((l) => l.rank > (cur ? cur.rank : 0));
  if (!next) throw new ApiError(409, `Already at the highest authority (${step.name}); cannot escalate further`);
  step.history.push({ action: 'escalated', from: step.level, to: next.key, actorId: user && user._id, at: new Date(), note: note || null });
  step.level = next.key;
  step.requiredRole = next.key;
  step.name = next.name;
  step.status = S.PENDING;
  return { escalatedTo: next.key };
}

/** Compact summary for UI / API. */
function summarize(chain) {
  if (!Array.isArray(chain) || chain.length === 0) return null;
  const cur = currentStep(chain);
  return {
    total: chain.length,
    approved: chain.filter((s) => s.status === S.APPROVED).length,
    current: cur ? { level: cur.level, name: cur.name, sequence: cur.sequence } : null,
    complete: isComplete(chain),
    rejected: isRejected(chain),
  };
}

module.exports = {
  buildChain, currentStep, isComplete, isRejected, canUserApprove, assertSoD,
  approveStep, rejectStep, reassignStep, escalateStep, summarize,
};
