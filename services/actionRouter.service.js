// services/actionRouter.service.js
//
// Autonomy roadmap Phase 0 — the heart of the Action Framework. Every agent calls
// propose(); the router asks the Autonomy Engine how to handle it (observe /
// queue for approval / auto-execute), persists it, and (when executed) records an
// audit row. Humans approve / reject / reverse queued or executed actions.
//
// Nothing auto-executes until a capability is dialed past "suggest", so in
// Phase 0 every action lands in the inbox as 'queued'.
//
'use strict';
const { ApiError } = require('../utils/ApiError');
const { PROPOSED_ACTION_STATUS, ENTITY_TYPES, AUDIT_ACTIONS } = require('../config/constants');
const policy = require('./autonomyPolicy.service');
const repo = require('../repositories/proposedAction.repository');
const auditService = require('./audit.service');
const feedback = require('./feedback.service');
const executors = require('./actionExecutors');
const logger = require('../config/logger');

const S = PROPOSED_ACTION_STATUS;

async function audit(action, performedBy, auditAction, afterState) {
  try {
    await auditService.log({
      businessId: action.businessId,
      entityType: ENTITY_TYPES.PROPOSED_ACTION,
      entityId: String(action._id),
      action: auditAction,
      performedBy: performedBy || null,
      afterState: { capability: action.capability, type: action.type, ...afterState },
    });
  } catch (e) { logger.warn(`[actionRouter] audit failed: ${e.message}`); }
}

/** Run an executor against a persisted action and record the outcome. */
async function runExecutor(action, executor, performedBy) {
  try {
    const result = await executor(action);
    const updated = await repo.update(action._id, { $set: { status: S.EXECUTED, result: result || {}, executedAt: new Date() } });
    await audit(action, performedBy, AUDIT_ACTIONS.STATE_CHANGED, { status: 'executed' });
    return updated;
  } catch (e) {
    return repo.update(action._id, { $set: { status: S.FAILED, result: { error: e.message } } });
  }
}

/**
 * Propose an action. The Autonomy Engine decides how it's handled.
 * @param {object} raw  { businessId, capability, type, confidence, amount, ... }
 * @param {object} [opts] { executor }  function(action) → result, run on auto-execute
 */
async function propose(raw, { executor } = {}) {
  // Fall back to the agent's registered handler for this action type.
  executor = executor || executors.executor(raw.type);
  const { decision } = await policy.decideForCapability(raw.businessId, raw.capability, { confidence: raw.confidence, amount: raw.amount });

  const status =
    decision === 'observe' ? S.OBSERVED :
    decision === 'execute' ? (executor ? S.QUEUED : S.APPROVED) :  // QUEUED placeholder; promoted on execute
    S.QUEUED;

  const action = await repo.create({ ...raw, decision, status });

  if (decision === 'execute' && executor) {
    return runExecutor(action, executor, null);
  }
  return action;
}

async function loadQueued(businessId, id, requiredStatus, label) {
  const a = await repo.findOwned(businessId, id);
  if (!a) throw new ApiError(404, 'Action not found');
  if (a.status !== requiredStatus) throw new ApiError(400, `Action must be ${label} (it is ${a.status})`);
  return a;
}

/** Human approves a queued action → execute it (if an executor is given). */
async function approve(businessId, id, performedBy, executor) {
  const a = await loadQueued(businessId, id, S.QUEUED, 'queued');
  const verdict = a.correction ? 'edited' : 'approved';
  feedback.record({ businessId, capability: a.capability, actionType: a.type, proposedActionId: a._id, verdict, confidence: a.confidence, correction: a.correction, performedBy });
  executor = executor || executors.executor(a.type);
  if (executor) return runExecutor(a, executor, performedBy);
  const updated = await repo.update(id, { $set: { status: S.APPROVED, decidedBy: performedBy, decidedAt: new Date() } });
  await audit(a, performedBy, AUDIT_ACTIONS.APPROVED, { status: 'approved' });
  return updated;
}

/** Human declines a queued action. */
async function reject(businessId, id, performedBy) {
  const a = await loadQueued(businessId, id, S.QUEUED, 'queued');
  feedback.record({ businessId, capability: a.capability, actionType: a.type, proposedActionId: a._id, verdict: 'rejected', confidence: a.confidence, performedBy });
  const updated = await repo.update(id, { $set: { status: S.REJECTED, decidedBy: performedBy, decidedAt: new Date() } });
  await audit(a, performedBy, AUDIT_ACTIONS.REJECTED, { status: 'rejected' });
  const onReject = executors.rejecter(a.type);
  if (onReject) { try { await onReject(a); } catch (e) { logger.warn(`[actionRouter] onReject failed: ${e.message}`); } }
  return updated;
}

/** Undo an executed action via its reverser (every action carries a reversal descriptor). */
async function reverse(businessId, id, performedBy, reverser) {
  const a = await loadQueued(businessId, id, S.EXECUTED, 'executed');
  reverser = reverser || executors.reverser(a.type);
  if (!reverser) throw new ApiError(400, 'This action cannot be reversed');
  const result = await reverser(a);
  const updated = await repo.update(id, { $set: { status: S.REVERSED, result: { reversal: result || {} } } });
  await audit(a, performedBy, AUDIT_ACTIONS.STATE_CHANGED, { status: 'reversed' });
  return updated;
}

module.exports = { propose, approve, reject, reverse };
