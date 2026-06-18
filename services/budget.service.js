// services/budget.service.js — FR-04.1
'use strict';
const { ApiError } = require('../utils/ApiError');
const { BUDGET_STATUS } = require('../config/constants');
const repo = require('../repositories/budget.repository');
const fyRepo = require('../repositories/fiscalYear.repository');
const costCenterService = require('../services/costCenter.service');
const approvalEngine = require('./approvalEngine.service');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Split an annual amount evenly across 12 months; the last month absorbs the
 *  rounding remainder so the months always sum back to the annual figure. */
function splitEvenly(annualAmount) {
  const annual = Number(annualAmount) || 0;
  if (!annual) return Array(12).fill(0);
  const per = round2(annual / 12);
  const months = Array(11).fill(per);
  months.push(round2(annual - per * 11));
  return months;
}

function _normaliseLines(lines = []) {
  return lines.map((l) => ({
    accountId: l.accountId,
    costCenterId: l.costCenterId || null,
    monthly: Array.isArray(l.monthly) && l.monthly.length === 12 ? l.monthly.map(round2) : Array(12).fill(0),
    thresholdPct: l.thresholdPct != null ? l.thresholdPct : null,
  }));
}

async function _validateLines(businessId, lines = []) {
  for (const line of lines) {
    if (line.costCenterId) await costCenterService.validateAssignable(businessId, line.costCenterId);
  }
}

const annualTotal = (doc) =>
  (doc.lines || []).reduce((s, l) => s + (l.monthly || []).reduce((a, b) => a + (Number(b) || 0), 0), 0);

async function createDraft(businessId, payload, user) {
  if (!payload.fiscalYearId) throw new ApiError(400, 'A fiscal year is required.');
  await _validateLines(businessId, payload.lines);
  return repo.create({
    businessId,
    name: payload.name,
    fiscalYearId: payload.fiscalYearId,
    scenario: payload.scenario || 'base',
    version: 1,
    status: BUDGET_STATUS.DRAFT,
    defaultThresholdPct: payload.defaultThresholdPct != null ? payload.defaultThresholdPct : 10,
    createdBy: user.id,
    lines: _normaliseLines(payload.lines),
  });
}

async function updateDraft(businessId, id, payload, user) {
  const doc = await repo.findOwnedById(businessId, id);
  if (!doc) throw new ApiError(404, 'Budget not found.');
  if (doc.status !== BUDGET_STATUS.DRAFT) {
    throw new ApiError(409, 'You can only edit a budget while it is a draft. Clone it to make a new version.');
  }
  if (payload.lines) await _validateLines(businessId, payload.lines);
  const update = {};
  if (payload.name != null) update.name = payload.name;
  if (payload.defaultThresholdPct != null) update.defaultThresholdPct = payload.defaultThresholdPct;
  if (payload.lines) update.lines = _normaliseLines(payload.lines);
  return repo.update(id, update);
}

/** Non-persisted preview: pre-fill every line's 12 months from the PRIOR fiscal
 *  year's GL actuals per account (+cost-centre). The editor loads this. */
async function seedFromActuals(businessId, fiscalYearId, { scenario = 'base' } = {}) {
  const fy = await fyRepo.findOwnedById(businessId, fiscalYearId);
  if (!fy) throw new ApiError(404, 'Fiscal year not found.');
  const prior = await fyRepo.findPrior(businessId, fy.startDate);
  if (!prior) return { fiscalYearId, scenario, lines: [] };
  const variance = require('./variance.service'); // lazy — avoid load-time cycle
  const rows = await variance.actualsByMonth(businessId, { from: prior.startDate, to: prior.endDate });
  return {
    fiscalYearId,
    scenario,
    lines: rows.map((r) => ({
      accountId: r.accountId,
      costCenterId: r.costCenterId || null,
      monthly: (Array.isArray(r.monthly) && r.monthly.length === 12 ? r.monthly : Array(12).fill(0)).map(round2),
      thresholdPct: null,
    })),
  };
}

async function submitForApproval(businessId, id, user) {
  const doc = await repo.findOwnedById(businessId, id);
  if (!doc) throw new ApiError(404, 'Budget not found.');
  if (doc.status !== BUDGET_STATUS.DRAFT) throw new ApiError(409, 'Only a draft budget can be submitted for approval.');
  const approvalChain = approvalEngine.buildChain(annualTotal(doc));
  return repo.update(id, { approvalChain, status: BUDGET_STATUS.PENDING_APPROVAL });
}

async function approve(businessId, id, user, note) {
  const doc = await repo.findOwnedById(businessId, id);
  if (!doc) throw new ApiError(404, 'Budget not found.');
  if (doc.status !== BUDGET_STATUS.PENDING_APPROVAL) throw new ApiError(409, 'This budget is not awaiting approval.');
  const { fullyApproved } = approvalEngine.approveStep(doc, user, note); // throws on SoD / role
  if (!fullyApproved) {
    return repo.update(id, { approvalChain: doc.approvalChain });
  }
  // Final approval: activate, archive the prior active of the same fy+scenario.
  const prior = await repo.findActive(businessId, doc.fiscalYearId, doc.scenario);
  if (prior && String(prior._id) !== String(id)) {
    await repo.update(prior._id, { status: BUDGET_STATUS.ARCHIVED });
  }
  return repo.update(id, { approvalChain: doc.approvalChain, status: BUDGET_STATUS.ACTIVE });
}

async function reject(businessId, id, user, note) {
  const doc = await repo.findOwnedById(businessId, id);
  if (!doc) throw new ApiError(404, 'Budget not found.');
  if (doc.status !== BUDGET_STATUS.PENDING_APPROVAL) throw new ApiError(409, 'This budget is not awaiting approval.');
  approvalEngine.rejectStep(doc, user, note);
  return repo.update(id, { approvalChain: doc.approvalChain, status: BUDGET_STATUS.REJECTED });
}

async function cloneVersion(businessId, id, user) {
  const doc = await repo.findOwnedById(businessId, id);
  if (!doc) throw new ApiError(404, 'Budget not found.');
  return repo.create({
    businessId,
    name: doc.name,
    fiscalYearId: doc.fiscalYearId,
    scenario: doc.scenario,
    version: (doc.version || 1) + 1,
    status: BUDGET_STATUS.DRAFT,
    defaultThresholdPct: doc.defaultThresholdPct,
    createdBy: user.id,
    approvalChain: [],
    lines: (doc.lines || []).map((l) => ({
      accountId: l.accountId, costCenterId: l.costCenterId || null,
      monthly: [...(l.monthly || Array(12).fill(0))], thresholdPct: l.thresholdPct != null ? l.thresholdPct : null,
    })),
  });
}

async function getById(businessId, id) {
  const doc = await repo.findOwnedById(businessId, id);
  if (!doc) throw new ApiError(404, 'Budget not found.');
  return doc;
}

async function list(businessId, filters) { return repo.findOwned(businessId, filters); }

module.exports = {
  splitEvenly, createDraft, updateDraft, seedFromActuals,
  submitForApproval, approve, reject, cloneVersion, getById, list,
};
