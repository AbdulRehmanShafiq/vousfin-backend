// repositories/auditPlan.repository.js — Phase 6C (Internal Audit)
'use strict';
const BaseRepository = require('./base.repository');
const AuditPlan = require('../models/AuditPlan.model');

class AuditPlanRepository extends BaseRepository {
  constructor() { super(AuditPlan); }

  /** All plans for a business, newest first. */
  findByBusiness(businessId) {
    return this.model.find({ businessId }).sort({ createdAt: -1 }).lean();
  }

  /** Single plan that belongs to this business, or null. */
  findOwned(businessId, id) {
    return this.model.findOne({ _id: id, businessId }).lean();
  }
}

module.exports = new AuditPlanRepository();
