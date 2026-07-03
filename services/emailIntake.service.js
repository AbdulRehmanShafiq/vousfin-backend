// services/emailIntake.service.js — forward-a-bill email capture (Intelligence
// Roadmap Phase 5 follow-on). A per-business secret token (embedded in a
// forwarding address) authenticates an inbound email webhook without a login;
// the email is turned into a bookkeeper.ingest so it flows through the exact
// same read → propose → (policy) post pipeline as any other document.
'use strict';
const crypto = require('crypto');
const Business = require('../models/Business.model');
const bookkeeper = require('./bookkeeper.service');
const { buildIngestFromEmail } = require('../utils/emailIntake.helper');
const { ApiError } = require('../utils/ApiError');

/** Turn on email intake for a business, returning (and persisting) its token. */
async function enableForBusiness(businessId) {
  const biz = await Business.findById(businessId);
  if (!biz) throw new ApiError(404, 'Business not found');
  if (!biz.aiSettings) biz.aiSettings = {};
  if (!biz.aiSettings.emailIntakeToken) {
    biz.aiSettings.emailIntakeToken = crypto.randomBytes(16).toString('hex');
    await biz.save();
  }
  return { emailIntakeToken: biz.aiSettings.emailIntakeToken };
}

/** Capture a forwarded email against its business token. */
async function captureEmail(token, email) {
  if (!token) throw new ApiError(401, 'Missing intake token');
  const biz = await Business.findOne({ 'aiSettings.emailIntakeToken': token }).lean();
  if (!biz) throw new ApiError(401, 'Invalid intake token');

  const payload = buildIngestFromEmail(email);
  if (!payload) throw new ApiError(400, 'Nothing to read in this email — no text or attachment.');

  return bookkeeper.ingest({
    businessId: biz._id,
    rawText: payload.rawText,
    image: payload.image,
    mimeType: payload.mimeType,
    source: payload.source,
    submittedBy: null, // machine-originated
  });
}

module.exports = { enableForBusiness, captureEmail };
