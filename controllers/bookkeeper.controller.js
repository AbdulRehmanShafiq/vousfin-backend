// controllers/bookkeeper.controller.js — Autonomy Phase 2 (Bookkeeper agent)
'use strict';
// Registering the service runs executors.register(post_journal, …) at startup,
// so the action router can post / reverse approved bookkeeping actions.
const bookkeeper = require('../services/bookkeeper.service');

const actor = (req) => req.user._id || req.user.id || null;

class BookkeeperController {
  // POST /bookkeeping/ingest — hand the books a document; get back a proposed entry
  async ingest(req, res, next) {
    try {
      const { rawText, source, image, mimeType } = req.body;
      const result = await bookkeeper.ingest({
        businessId: req.user.businessId,
        rawText,
        source,
        image,      // optional base64 (no data: prefix) of a bill/receipt photo
        mimeType,
        submittedBy: actor(req),
      });
      res.status(201).json({ success: true, data: result, message: 'Document read' });
    } catch (err) { next(err); }
  }

  // GET /bookkeeping/documents — recent intake + what it became
  async listDocuments(req, res, next) {
    try {
      res.json({ success: true, data: await bookkeeper.listDocuments(req.user.businessId) });
    } catch (err) { next(err); }
  }
}

module.exports = new BookkeeperController();
