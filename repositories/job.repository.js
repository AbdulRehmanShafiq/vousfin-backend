// repositories/job.repository.js — FR-07.2
'use strict';
const BaseRepository = require('./base.repository');
const Job = require('../models/Job.model');
class JobRepository extends BaseRepository {
  constructor() { super(Job); }
  findByCode(businessId, code) { return this.model.findOne({ businessId, code }).lean(); }
  findOwned(businessId, filters = {}) {
    const q = { businessId };
    if (filters.status) q.status = filters.status;
    if (filters.customerId) q.customerId = filters.customerId;
    return this.model.find(q).sort({ createdAt: -1 }).lean();
  }
  findOwnedById(businessId, id) { return this.model.findOne({ _id: id, businessId }); } // live doc
}
module.exports = new JobRepository();
