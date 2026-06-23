// models/Membership.model.js
//
// Phase 6A — per-business team membership. The join between User and Business
// that makes VousFin multi-user: who belongs to a business and which roles they
// hold. Roles are an ARRAY so the SoD matrix (6B) can block conflicting pairs.
'use strict';
const mongoose = require('mongoose');
const { BUSINESS_ROLES, MEMBERSHIP_STATUS } = require('../config/constants');

const membershipSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    // null until an emailed invite is accepted.
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    roles: {
      type: [String],
      enum: Object.values(BUSINESS_ROLES),
      validate: { validator: (v) => Array.isArray(v) && v.length > 0, message: 'A member needs at least one role' },
      required: true,
    },
    status: { type: String, enum: Object.values(MEMBERSHIP_STATUS), default: MEMBERSHIP_STATUS.ACTIVE },
    invitedEmail: { type: String, trim: true, lowercase: true, default: null },
    inviteToken: { type: String, default: null, index: true },
    inviteTokenExpiresAt: { type: Date, default: null },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    invitedAt: { type: Date, default: null },
    joinedAt: { type: Date, default: null },
    lastModifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, toJSON: { transform: (doc, ret) => { delete ret.__v; delete ret.inviteToken; return ret; } } },
);

// One membership per (business, user). Partial: only enforced when userId is set
// (so multiple email-only pending invites don't collide on null).
membershipSchema.index({ businessId: 1, userId: 1 }, { unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } });
membershipSchema.index({ businessId: 1, status: 1 });

module.exports = mongoose.model('Membership', membershipSchema);
