// repositories/budget.repository.js — FR-04.1
'use strict';
const BaseRepository = require('./base.repository');
const Budget = require('../models/Budget.model');
const { BUDGET_STATUS } = require('../config/constants');

class BudgetRepository extends BaseRepository {
  constructor() { super(Budget); }

  findActive(businessId, fiscalYearId, scenario) {
    return this.model.findOne({
      businessId, fiscalYearId, scenario, status: BUDGET_STATUS.ACTIVE,
    }).lean();
  }

  findVersions(businessId, fiscalYearId, scenario) {
    return this.model.find({ businessId, fiscalYearId, scenario }).sort({ version: -1 }).lean();
  }

  findOwned(businessId, filters = {}) {
    const q = { businessId };
    if (filters.fiscalYearId) q.fiscalYearId = filters.fiscalYearId;
    if (filters.scenario)     q.scenario = filters.scenario;
    if (filters.status)       q.status = filters.status;
    return this.model.find(q).sort({ createdAt: -1 }).lean();
  }

  // Live Mongoose doc (not .lean()) so the approval engine can mutate approvalChain
  // and the service can persist it.
  findOwnedById(businessId, id) {
    return this.model.findOne({ _id: id, businessId });
  }

  findActiveByFiscalYear(businessId, fiscalYearId) {
    return this.model.find({ businessId, fiscalYearId, status: BUDGET_STATUS.ACTIVE });
  }
}

module.exports = new BudgetRepository();
