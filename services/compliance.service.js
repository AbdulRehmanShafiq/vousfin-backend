// services/compliance.service.js — FR-10.1 Compliance Calendar
'use strict';
const { ApiError } = require('../utils/ApiError');
const ComplianceObligation = require('../models/ComplianceObligation.model');
const { COMPLIANCE_OBLIGATIONS } = require('../config/complianceCalendar');

class ComplianceService {
  /**
   * Generate obligation documents for every in-scope month/template combination
   * for a given year. Idempotent — upserts by {businessId, code, period}.
   */
  async generateObligations(businessId, year) {
    let count = 0;
    for (let month = 1; month <= 12; month++) {
      for (const tpl of COMPLIANCE_OBLIGATIONS) {
        const inScope = tpl.dueMonths === null || tpl.dueMonths.includes(month);
        if (!inScope) continue;

        const period = `${year}-${String(month).padStart(2, '0')}`;
        // JS months are 0-indexed; day is 1-indexed
        const dueDate = new Date(year, month - 1, tpl.dueDayOfMonth);

        await ComplianceObligation.findOneAndUpdate(
          { businessId, code: tpl.code, period },
          {
            $setOnInsert: {
              businessId,
              code: tpl.code,
              period,
              dueDate,
              status: 'pending',
              referenceNumber: '',
              notes: '',
              completedAt: null,
              completedBy: null,
            },
          },
          { upsert: true, new: true },
        );
        count++;
      }
    }
    return count;
  }

  /**
   * List obligations for a business, with optional filters.
   */
  async listObligations(businessId, { year, month, status } = {}) {
    const filter = { businessId };
    if (year && month) {
      filter.period = `${year}-${String(month).padStart(2, '0')}`;
    } else if (year) {
      filter.period = { $regex: `^${year}-` };
    }
    if (status) filter.status = status;

    return ComplianceObligation.find(filter).sort({ dueDate: 1 }).lean();
  }

  /**
   * Mark an obligation complete.
   */
  async completeObligation(id, businessId, { referenceNumber, notes }, actor) {
    const obl = await ComplianceObligation.findOne({ _id: id, businessId });
    if (!obl) throw new ApiError(404, 'Obligation not found');

    obl.status = 'completed';
    obl.completedAt = new Date();
    obl.completedBy = actor._id || actor.id || null;
    obl.referenceNumber = referenceNumber || '';
    obl.notes = notes || '';
    await obl.save();
    return obl;
  }

  /**
   * Waive an obligation.
   */
  async waiveObligation(id, businessId, { notes }, actor) {
    const obl = await ComplianceObligation.findOne({ _id: id, businessId });
    if (!obl) throw new ApiError(404, 'Obligation not found');

    obl.status = 'waived';
    obl.notes = notes || '';
    obl.completedBy = actor._id || actor.id || null;
    await obl.save();
    return obl;
  }

  /**
   * Find all pending obligations whose dueDate is in the past and mark them overdue.
   * Returns count of documents updated.
   */
  async checkAndMarkOverdue(businessId) {
    const result = await ComplianceObligation.updateMany(
      { businessId, status: 'pending', dueDate: { $lt: new Date() } },
      { $set: { status: 'overdue' } },
    );
    return result.modifiedCount || 0;
  }

  /**
   * Return pending obligations due within `days` days from now.
   */
  async upcomingReminders(businessId, days) {
    const now = new Date();
    const horizon = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    return ComplianceObligation.find({
      businessId,
      status: 'pending',
      dueDate: { $gte: now, $lte: horizon },
    })
      .sort({ dueDate: 1 })
      .lean();
  }

  /** Enrich obligations with template metadata for API responses. */
  enrichWithTemplate(obligations) {
    const tplMap = Object.fromEntries(COMPLIANCE_OBLIGATIONS.map((t) => [t.code, t]));
    return obligations.map((o) => ({ ...o, template: tplMap[o.code] || null }));
  }
}

module.exports = new ComplianceService();
