// repositories/costCenter.repository.js — SRS FR-07.1
'use strict';
const BaseRepository = require('./base.repository');
const CostCenter = require('../models/CostCenter.model');

class CostCenterRepository extends BaseRepository {
  constructor() {
    super(CostCenter);
  }

  /** All cost centres for a business (newest first), optionally active-only. */
  async findByBusiness(businessId, { activeOnly = false } = {}) {
    const q = { businessId };
    if (activeOnly) q.isActive = true;
    return this.model.find(q).sort({ code: 1 }).lean();
  }

  /** Find a cost centre by its (business-unique) code. */
  async findByCode(businessId, code) {
    return this.model.findOne({ businessId, code }).lean();
  }

  /** Business-scoped lookup (null if not owned). */
  async findOwned(businessId, id) {
    const cc = await this.model.findById(id).lean();
    return cc && String(cc.businessId) === String(businessId) ? cc : null;
  }

  /** Does this business have a child pointing at `parentId`? (block deleting a parent). */
  async hasChildren(businessId, parentId) {
    return (await this.model.countDocuments({ businessId, parentId })) > 0;
  }
}

module.exports = new CostCenterRepository();
