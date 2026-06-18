// repositories/fiscalYear.repository.js
'use strict';
const BaseRepository = require('./base.repository');
const FiscalYear = require('../models/FiscalYear.model');

class FiscalYearRepository extends BaseRepository {
  constructor() { super(FiscalYear); }

  findOwnedById(businessId, id) {
    return this.model.findOne({ _id: id, businessId }).lean();
  }

  /** The fiscal year immediately preceding the given one (ends on/just before its start). */
  findPrior(businessId, startDate) {
    return this.model.findOne({ businessId, endDate: { $lte: new Date(startDate) } })
      .sort({ endDate: -1 }).lean();
  }

  /** The fiscal year whose [startDate,endDate] contains the given date. */
  findContaining(businessId, date) {
    const d = new Date(date);
    return this.model.findOne({ businessId, startDate: { $lte: d }, endDate: { $gte: d } }).lean();
  }
}

module.exports = new FiscalYearRepository();
