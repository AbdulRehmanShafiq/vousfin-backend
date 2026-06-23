// services/internalAudit.service.js — Phase 6C (Internal Audit)
//
// Plans define a scope + period; drawSample pulls journal entries using either
// risk-based (high amount) or random strategy. Findings track control weaknesses;
// management records responses. agingReport shows how long issues have been open.
'use strict';
const { ApiError } = require('../utils/ApiError');
const auditPlanRepo    = require('../repositories/auditPlan.repository');
const auditFindingRepo = require('../repositories/auditFinding.repository');
const JournalEntry     = require('../models/JournalEntry.model');

const VALID_PLAN_STATUSES    = ['draft', 'in_progress', 'completed'];
const VALID_FINDING_STATUSES = ['open', 'in_progress', 'resolved'];

class InternalAuditService {
  // ── Plans ────────────────────────────────────────────────────────────────

  async createPlan(businessId, data, actor) {
    const createdBy = actor?._id || actor?.id || null;
    return auditPlanRepo.create({ businessId, createdBy, ...data });
  }

  async listPlans(businessId) {
    return auditPlanRepo.findByBusiness(businessId);
  }

  async getPlan(id, businessId) {
    const plan = await auditPlanRepo.findOwned(businessId, id);
    if (!plan) throw new ApiError(404, 'Audit plan not found.');
    return plan;
  }

  async updatePlanStatus(id, businessId, status) {
    if (!VALID_PLAN_STATUSES.includes(status)) {
      throw new ApiError(400, `Invalid status. Must be one of: ${VALID_PLAN_STATUSES.join(', ')}.`);
    }
    const plan = await auditPlanRepo.findOwned(businessId, id);
    if (!plan) throw new ApiError(404, 'Audit plan not found.');
    return auditPlanRepo.update(id, { status }, { new: true });
  }

  // ── Sample drawing ───────────────────────────────────────────────────────

  async drawSample(id, businessId) {
    const plan = await auditPlanRepo.findOwned(businessId, id);
    if (!plan) throw new ApiError(404, 'Audit plan not found.');

    const matchFilter = {
      businessId,
      transactionDate: { $gte: plan.periodStart, $lte: plan.periodEnd },
    };
    const projection = { _id: 1, transactionDate: 1, amount: 1, description: 1, transactionType: 1 };

    let sample;
    if (plan.sampleStrategy === 'random') {
      sample = await JournalEntry.aggregate([
        { $match: matchFilter },
        { $project: projection },
        { $sample: { size: plan.sampleSize } },
      ]);
    } else {
      // risk_based: highest-amount entries are most material
      sample = await JournalEntry.find(matchFilter)
        .sort({ amount: -1 })
        .limit(plan.sampleSize)
        .lean();
    }

    // Advance plan to in_progress when still draft
    if (plan.status === 'draft') {
      await auditPlanRepo.update(id, { status: 'in_progress' }, { new: false });
    }

    return sample;
  }

  // ── Findings ─────────────────────────────────────────────────────────────

  async raiseFinding(businessId, data, actor) {
    const { planId } = data;
    const plan = await auditPlanRepo.findOwned(businessId, planId);
    if (!plan) throw new ApiError(404, 'Audit plan not found or does not belong to this business.');
    const createdBy = actor?._id || actor?.id || null;
    return auditFindingRepo.create({ businessId, createdBy, ...data });
  }

  async listFindings(businessId, filters = {}) {
    return auditFindingRepo.findByBusiness(businessId, filters);
  }

  async recordResponse(findingId, businessId, { managementResponse, targetResolutionDate, status } = {}) {
    if (status !== undefined && !VALID_FINDING_STATUSES.includes(status)) {
      throw new ApiError(400, `Invalid status. Must be one of: ${VALID_FINDING_STATUSES.join(', ')}.`);
    }
    const finding = await auditFindingRepo.findOwned(businessId, findingId);
    if (!finding) throw new ApiError(404, 'Audit finding not found.');

    const update = {};
    if (managementResponse !== undefined) update.managementResponse = managementResponse;
    if (targetResolutionDate !== undefined) update.targetResolutionDate = targetResolutionDate;
    if (status !== undefined) update.status = status;

    return auditFindingRepo.update(findingId, update, { new: true });
  }

  // ── Aging report ─────────────────────────────────────────────────────────

  async agingReport(businessId) {
    const findings = await auditFindingRepo.findOpenByBusiness(businessId);
    const now = Date.now();

    const buckets = { '0-30': [], '31-60': [], '61-90': [], '90+': [] };
    const byRisk  = { critical: 0, high: 0, medium: 0, low: 0 };

    for (const f of findings) {
      const ageDays = Math.floor((now - new Date(f.createdAt).getTime()) / (1000 * 60 * 60 * 24));
      if      (ageDays <= 30) buckets['0-30'].push(f);
      else if (ageDays <= 60) buckets['31-60'].push(f);
      else if (ageDays <= 90) buckets['61-90'].push(f);
      else                    buckets['90+'].push(f);

      if (byRisk[f.riskRating] !== undefined) byRisk[f.riskRating]++;
    }

    return { buckets, total: findings.length, byRisk };
  }
}

module.exports = new InternalAuditService();
