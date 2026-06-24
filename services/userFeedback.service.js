'use strict';
const Feedback = require('../models/Feedback.model');
const { ApiError } = require('../utils/ApiError');

class UserFeedbackService {
  /**
   * Submit feedback. Enriches with actor info when present.
   */
  async submit(payload, actor = null) {
    const data = { ...payload };
    if (actor) {
      data.userId     = data.userId     || actor.id         || null;
      data.businessId = data.businessId || actor.businessId || null;
      data.name       = data.name       || actor.fullName   || '';
      data.email      = data.email      || actor.email      || '';
    }
    return Feedback.create(data);
  }

  /**
   * List all feedback (admin). Paginated, filterable by status/type.
   */
  async listAll({ status, type, page = 1, limit = 50 } = {}) {
    const query = {};
    if (status) query.status = status;
    if (type)   query.type   = type;
    const skip  = (page - 1) * limit;
    const [data, total] = await Promise.all([
      Feedback.find(query).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      Feedback.countDocuments(query),
    ]);
    return { data, total, page: Number(page), limit: Number(limit) };
  }

  /**
   * Update status (and optional adminNote) on a feedback item.
   */
  async updateStatus(id, { status, adminNote } = {}) {
    const update = {};
    if (status    !== undefined) update.status    = status;
    if (adminNote !== undefined) update.adminNote = adminNote;
    const doc = await Feedback.findByIdAndUpdate(id, update, { new: true });
    if (!doc) throw new ApiError(404, 'Feedback not found');
    return doc;
  }
}

module.exports = new UserFeedbackService();
