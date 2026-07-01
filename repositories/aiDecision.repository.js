// repositories/aiDecision.repository.js — AI Decision Ledger persistence.
'use strict';
const BaseRepository = require('./base.repository');
const AIDecision = require('../models/AIDecision.model');
const { applyOutcome } = require('../utils/aiDecision.helper');

class AIDecisionRepository extends BaseRepository {
  constructor() { super(AIDecision); }

  async findByBusiness(businessId, { kind, outcome, page = 1, limit = 25 } = {}) {
    const query = { businessId };
    if (kind) query.kind = kind;
    if (outcome) query.outcome = outcome;
    const skip = (Math.max(1, page) - 1) * limit;
    const [data, total] = await Promise.all([
      this.model.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.model.countDocuments(query),
    ]);
    return { data, total, page, limit };
  }

  findByIdForBusiness(id, businessId) {
    return this.model.findOne({ _id: id, businessId }).lean();
  }

  /** Set the one-time outcome. Returns null if not found; throws if already set. */
  async setOutcome(id, businessId, newOutcome, correctedTo = null) {
    const existing = await this.model.findOne({ _id: id, businessId }).lean();
    if (!existing) return null;
    const outcome = applyOutcome(existing.outcome, newOutcome); // guards; throws on illegal
    return this.model.findOneAndUpdate(
      { _id: id, businessId },
      { outcome, correctedTo, resolvedAt: new Date() },
      { new: true },
    );
  }
}

module.exports = new AIDecisionRepository();
