// repositories/sourceDocument.repository.js — Autonomy Phase 2 (Bookkeeper)
'use strict';
const BaseRepository = require('./base.repository');
const SourceDocument = require('../models/SourceDocument.model');

class SourceDocumentRepository extends BaseRepository {
  constructor() {
    super(SourceDocument);
  }

  /** Recent intake for a business, newest first (the Bookkeeper activity view). */
  async recent(businessId, limit = 50) {
    return this.model.find({ businessId }).sort({ createdAt: -1 }).limit(limit).lean();
  }

  /** Business-scoped lookup (null if not owned). */
  async findOwned(businessId, id) {
    const d = await this.model.findById(id).lean();
    return d && String(d.businessId) === String(businessId) ? d : null;
  }
}

module.exports = new SourceDocumentRepository();
