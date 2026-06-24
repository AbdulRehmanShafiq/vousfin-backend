'use strict';
const Announcement = require('../models/Announcement.model');
const { ApiError } = require('../utils/ApiError');

class AnnouncementService {
  /** Active announcements visible to all users. */
  async listActive() {
    const now = new Date();
    return Announcement.find({
      active: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    }).sort({ createdAt: -1 }).lean();
  }

  /** Admin: all announcements. */
  async listAll() {
    return Announcement.find().sort({ createdAt: -1 }).lean();
  }

  /** Admin: create announcement. */
  async create(data, actor) {
    return Announcement.create({ ...data, createdBy: actor.id });
  }

  /** Admin: update announcement. */
  async update(id, data) {
    const doc = await Announcement.findByIdAndUpdate(id, data, { new: true });
    if (!doc) throw new ApiError(404, 'Announcement not found');
    return doc;
  }

  /** Admin: delete announcement. */
  async remove(id) {
    const doc = await Announcement.findByIdAndDelete(id);
    if (!doc) throw new ApiError(404, 'Announcement not found');
    return doc;
  }
}

module.exports = new AnnouncementService();
