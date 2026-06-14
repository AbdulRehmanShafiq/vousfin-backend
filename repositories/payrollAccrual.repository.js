// repositories/payrollAccrual.repository.js
//
// FR-04.1 (Phase 3) — persistence for monthly EOBI/SESSI accruals.
//
'use strict';
const BaseRepository = require('./base.repository');
const PayrollAccrual = require('../models/PayrollAccrual.model');

class PayrollAccrualRepository extends BaseRepository {
  constructor() {
    super(PayrollAccrual);
  }

  /**
   * Record (or overwrite) a month's accrual — idempotent per (businessId, month).
   * @param {string} businessId
   * @param {string} month    'YYYY-MM'
   * @param {{ eobi:number, sessi:number, createdBy?:string }} payload
   * @returns {Promise<object>} the upserted lean document
   */
  async upsertForMonth(businessId, month, { eobi = 0, sessi = 0, createdBy = null } = {}) {
    return this.model.findOneAndUpdate(
      { businessId, month },
      { $set: { businessId, month, eobi, sessi, createdBy } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
  }

  /** The most recent accrual for a business (latest month first), or null. */
  async latest(businessId) {
    return this.model.findOne({ businessId }).sort({ month: -1 }).lean();
  }
}

module.exports = new PayrollAccrualRepository();
