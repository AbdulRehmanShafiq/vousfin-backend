// repositories/auditFinding.repository.js — Phase 6C (Internal Audit)
'use strict';
const BaseRepository = require('./base.repository');
const AuditFinding = require('../models/AuditFinding.model');

class AuditFindingRepository extends BaseRepository {
  constructor() { super(AuditFinding); }

  /**
   * All findings for a business with optional planId / status filters.
   * @param {string|ObjectId} businessId
   * @param {{ planId?: string, status?: string }} filters
   */
  findByBusiness(businessId, filters = {}) {
    const query = { businessId };
    if (filters.planId) query.planId = filters.planId;
    if (filters.status) query.status = filters.status;
    return this.model.find(query).sort({ createdAt: -1 }).lean();
  }

  /** Single finding that belongs to this business, or null. */
  findOwned(businessId, id) {
    return this.model.findOne({ _id: id, businessId }).lean();
  }

  /** All non-resolved findings for a business (for aging). */
  findOpenByBusiness(businessId) {
    return this.model.find({ businessId, status: { $ne: 'resolved' } }).lean();
  }
}

module.exports = new AuditFindingRepository();
