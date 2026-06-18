// repositories/employee.repository.js — FR-08.1
'use strict';
const BaseRepository = require('./base.repository');
const Employee = require('../models/Employee.model');

class EmployeeRepository extends BaseRepository {
  constructor() { super(Employee); }

  async findByBusiness(businessId, { activeOnly = false } = {}) {
    const q = { businessId };
    if (activeOnly) q.status = 'active';
    return this.model.find(q).sort({ code: 1 }).lean();
  }

  async findByCode(businessId, code) {
    return this.model.findOne({ businessId, code }).lean();
  }

  async findActive(businessId) {
    return this.model.find({ businessId, status: 'active' }).sort({ code: 1 }).lean();
  }

  async findOwned(businessId, id) {
    const e = await this.model.findById(id).lean();
    return e && String(e.businessId) === String(businessId) ? e : null;
  }
}

module.exports = new EmployeeRepository();
