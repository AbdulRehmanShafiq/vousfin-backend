// services/membership.service.js — Phase 6A
'use strict';
const crypto = require('crypto');
const { ApiError } = require('../utils/ApiError');
const repo = require('../repositories/membership.repository');
const userRepository = require('../repositories/user.repository');
const businessRepository = require('../repositories/business.repository');
const auditService = require('./audit.service');
const logger = require('../config/logger');
const { sendTeamInviteEmail } = require('../utils/email.utils');
const { BUSINESS_ROLES, MEMBERSHIP_STATUS, ENTITY_TYPES, AUDIT_ACTIONS } = require('../config/constants');

const VALID_ROLES = new Set(Object.values(BUSINESS_ROLES));
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function assertRoles(roles) {
  if (!Array.isArray(roles) || roles.length === 0) throw new ApiError(400, 'Pick at least one role.');
  for (const r of roles) if (!VALID_ROLES.has(r)) throw new ApiError(400, `Unknown role "${r}".`);
}

class MembershipService {
  /**
   * Active membership for (business, user); self-heals a legacy single-user owner.
   * @param {string} businessId
   * @param {string} userId
   * @returns {Promise<{roles: string[], status: string}|null>}
   */
  async resolveActiveMembership(businessId, userId) {
    const existing = await repo.findActiveByBusinessAndUser(businessId, userId);
    if (existing) return existing;
    // Legacy self-heal: the user's own business → make them owner.
    const user = await userRepository.findById(userId);
    if (user && String(user.businessId) === String(businessId)) {
      const m = await this.ensureOwnerMembership(businessId, userId);
      return { roles: m.roles, status: m.status };
    }
    return null;
  }

  /**
   * Idempotent: returns existing membership or creates an active owner membership.
   * @param {string} businessId
   * @param {string} userId
   * @returns {Promise<Object>}
   */
  async ensureOwnerMembership(businessId, userId) {
    const found = await repo.findByBusinessAndUser(businessId, userId);
    if (found) return found;
    return repo.create({
      businessId,
      userId,
      roles: [BUSINESS_ROLES.OWNER],
      status: MEMBERSHIP_STATUS.ACTIVE,
      joinedAt: new Date(),
    });
  }

  /**
   * List all members (active + invited) for a business.
   * @param {string} businessId
   * @returns {Promise<Object[]>}
   */
  async listMembers(businessId) {
    return repo.findOwnedByBusiness(businessId);
  }

  /**
   * Invite a new team member by email.
   * Creates an INVITED membership row and sends an invite email (best-effort).
   * @param {string} businessId
   * @param {{ email: string, roles: string[] }} params
   * @param {{ _id: string }} actor
   * @returns {Promise<Object>} The created membership document
   */
  async invite(businessId, { email, roles }, actor) {
    assertRoles(roles);
    const actorId = actor._id || actor.id;
    const lower = String(email || '').toLowerCase().trim();
    if (!lower) throw new ApiError(400, 'An email address is required.');

    // Reject if email already has an invite or membership row in this business
    if (await repo.findByBusinessAndEmail(businessId, lower)) {
      throw new ApiError(409, 'That person already has an invite or membership in this business.');
    }

    // If the user already exists, also check by userId
    const existingUser = await userRepository.findByEmail(lower);
    if (existingUser && await repo.findByBusinessAndUser(businessId, existingUser._id)) {
      throw new ApiError(409, 'That person is already a member of this business.');
    }

    const inviteToken = crypto.randomBytes(24).toString('hex');
    const membership = await repo.create({
      businessId,
      userId: existingUser ? existingUser._id : null,
      roles,
      status: MEMBERSHIP_STATUS.INVITED,
      invitedEmail: lower,
      inviteToken,
      inviteTokenExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
      invitedBy: actorId,
      invitedAt: new Date(),
    });

    // Send invite email — best-effort; the invite row is safe even if email fails.
    // Resolve the business name separately so a lookup failure still attempts the send.
    let businessName = 'your team';
    try {
      const business = await businessRepository.findById(businessId);
      if (business) businessName = business.businessName || business.name || businessName;
    } catch (e) {
      logger.warn(`[membership] could not resolve business name for invite email: ${e.message}`);
    }
    try {
      await sendTeamInviteEmail(lower, inviteToken, businessName, roles);
    } catch (e) {
      logger.warn(`[membership] invite email failed for ${lower}: ${e.message}`);
    }

    // Confirmed: auditService.log accepts businessId, entityType, entityId, action,
    // performedBy, metadata, beforeState, afterState keys directly.
    await auditService.log({
      businessId,
      entityType: ENTITY_TYPES.MEMBERSHIP,
      entityId: membership._id,
      action: AUDIT_ACTIONS.MEMBER_INVITED,
      performedBy: actorId,
      metadata: { invitedEmail: lower, roles },
    });

    return membership;
  }

  /**
   * Accept a pending invite by token.
   * Validates token, email match, and expiry; activates the membership.
   * @param {string} token
   * @param {{ _id: string, email: string }} user  — the accepting user
   * @returns {Promise<Object>} The updated membership document
   */
  async acceptInvite(token, user) {
    const userId = user._id || user.id;
    const m = await repo.findByInviteToken(token);
    if (!m || m.status !== MEMBERSHIP_STATUS.INVITED) {
      throw new ApiError(400, 'This invitation is invalid or already used.');
    }
    if (m.inviteTokenExpiresAt && m.inviteTokenExpiresAt.getTime() < Date.now()) {
      throw new ApiError(400, 'This invitation has expired. Ask for a new one.');
    }
    if (!m.invitedEmail || String(user.email).toLowerCase() !== m.invitedEmail) {
      throw new ApiError(403, 'This invitation was sent to a different email address. It does not match your account.');
    }

    m.userId = userId;
    m.status = MEMBERSHIP_STATUS.ACTIVE;
    m.inviteToken = null;
    m.inviteTokenExpiresAt = null;
    m.joinedAt = new Date();
    await m.save();

    await auditService.log({
      businessId: m.businessId,
      entityType: ENTITY_TYPES.MEMBERSHIP,
      entityId: m._id,
      action: AUDIT_ACTIONS.MEMBER_JOINED,
      performedBy: userId,
      metadata: { roles: m.roles },
    });

    return m;
  }

  /**
   * Update a member's roles.
   * Blocks removing the last owner.
   * @param {string} businessId
   * @param {string} targetUserId
   * @param {string[]} roles
   * @param {{ _id: string }} actor
   * @returns {Promise<Object>} The updated membership document
   */
  async updateRoles(businessId, targetUserId, roles, actor) {
    assertRoles(roles);
    const actorId = actor._id || actor.id;
    const m = await repo.findByBusinessAndUser(businessId, targetUserId);
    if (!m) throw new ApiError(404, 'That member was not found.');

    // Last-owner protection: removing owner from the only active owner is blocked.
    const losingOwner = m.roles.includes(BUSINESS_ROLES.OWNER) && !roles.includes(BUSINESS_ROLES.OWNER);
    if (losingOwner && (await repo.countActiveOwners(businessId)) <= 1) {
      throw new ApiError(409, 'A business must have at least one owner. Assign another owner before changing this role.');
    }

    // NOTE (6B): SoD conflict check on `roles` will be inserted here.
    const before = [...m.roles];
    m.roles = roles;
    m.lastModifiedBy = actorId;
    await m.save();

    await auditService.log({
      businessId,
      entityType: ENTITY_TYPES.MEMBERSHIP,
      entityId: m._id,
      action: AUDIT_ACTIONS.MEMBER_ROLES_CHANGED,
      performedBy: actorId,
      beforeState: { roles: before },
      afterState: { roles },
    });

    return m;
  }

  /**
   * Remove a member from the business.
   * Blocks removing the last owner.
   * @param {string} businessId
   * @param {string} targetUserId
   * @param {{ _id: string }} actor
   * @returns {Promise<{ removed: boolean }>}
   */
  async removeMember(businessId, targetUserId, actor) {
    const actorId = actor._id || actor.id;
    const m = await repo.findByBusinessAndUser(businessId, targetUserId);
    if (!m) throw new ApiError(404, 'That member was not found.');
    if (m.roles.includes(BUSINESS_ROLES.OWNER) && (await repo.countActiveOwners(businessId)) <= 1) {
      throw new ApiError(409, 'A business must have at least one owner. Assign another owner before removing this member.');
    }

    await repo.delete(m._id);

    await auditService.log({
      businessId,
      entityType: ENTITY_TYPES.MEMBERSHIP,
      entityId: m._id,
      action: AUDIT_ACTIONS.MEMBER_REMOVED,
      performedBy: actorId,
      metadata: { removedUserId: String(targetUserId) },
    });

    return { removed: true };
  }
}

module.exports = new MembershipService();
