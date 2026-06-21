const BaseRepository = require('./base.repository');
const ReportTemplate = require('../models/ReportTemplate.model');
const mongoose = require('mongoose');

class ReportTemplateRepository extends BaseRepository {
  constructor() { super(ReportTemplate); }

  async findOwned(businessId) {
    return this.model
      .find({ businessId: new mongoose.Types.ObjectId(String(businessId)) })
      .sort({ updatedAt: -1 })
      .lean();
  }

  async findOwnedById(businessId, id) {
    return this.model.findOne({
      _id: new mongoose.Types.ObjectId(String(id)),
      businessId: new mongoose.Types.ObjectId(String(businessId)),
    });
  }

  async findScheduledDue(now) {
    return this.model
      .find({ 'schedule.enabled': true, 'schedule.nextRunAt': { $lte: now } })
      .lean();
  }
}

module.exports = new ReportTemplateRepository();
