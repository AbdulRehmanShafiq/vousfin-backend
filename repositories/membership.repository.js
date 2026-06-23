// repositories/membership.repository.js — Phase 6A
'use strict';
const BaseRepository = require('./base.repository');
const Membership = require('../models/Membership.model');
const { MEMBERSHIP_STATUS, BUSINESS_ROLES } = require('../config/constants');

class MembershipRepository extends BaseRepository {
  constructor() { super(Membership); }

  findByBusinessAndUser(businessId, userId) {
    return this.model.findOne({ businessId, userId });
  }
  findActiveByBusinessAndUser(businessId, userId) {
    return this.model.findOne({ businessId, userId, status: MEMBERSHIP_STATUS.ACTIVE }).lean();
  }
  findOwnedByBusiness(businessId) {
    return this.model.find({ businessId }).populate('userId', 'fullName email').sort({ createdAt: 1 }).lean();
  }
  findByInviteToken(token) {
    return this.model.findOne({ inviteToken: token });
  }
  findByBusinessAndEmail(businessId, email) {
    return this.model.findOne({ businessId, invitedEmail: String(email || '').toLowerCase() });
  }
  countActiveOwners(businessId) {
    return this.model.countDocuments({ businessId, status: MEMBERSHIP_STATUS.ACTIVE, roles: BUSINESS_ROLES.OWNER });
  }
}

module.exports = new MembershipRepository();
