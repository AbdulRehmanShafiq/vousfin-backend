// repositories/payrollRun.repository.js — FR-08.2
'use strict';
const BaseRepository = require('./base.repository');
const PayrollRun = require('../models/PayrollRun.model');

class PayrollRunRepository extends BaseRepository {
  constructor() { super(PayrollRun); }

  async findActiveByPeriod(businessId, period) {
    return this.model.findOne({ businessId, period, status: { $ne: 'reversed' } });
  }

  async listByBusiness(businessId) {
    return this.model.find({ businessId }).sort({ period: -1, createdAt: -1 }).lean();
  }

  async findOwned(businessId, id) {
    const run = await this.model.findById(id);
    return run && String(run.businessId) === String(businessId) ? run : null;
  }
}

module.exports = new PayrollRunRepository();
