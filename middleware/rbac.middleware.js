// middleware/rbac.middleware.js — Phase 6A
'use strict';
const { ApiError } = require('../utils/ApiError');
const membershipService = require('../services/membership.service');
const { permissionsFor, can } = require('../utils/permissions');

/**
 * After authMiddleware: resolve the caller's membership for their active business
 * and attach req.membership = { roles, permissions, status }. No business context
 * (no businessId) → pass through (requireBusiness handles that case).
 */
const attachMembership = async (req, res, next) => {
  try {
    if (!req.user || !req.user.businessId) return next();
    const m = await membershipService.resolveActiveMembership(req.user.businessId, req.user.id);
    if (!m) throw new ApiError(403, "You don't have access to this business.");
    if (m.status === 'suspended') throw new ApiError(403, 'Your access to this business is suspended.');
    req.membership = { roles: m.roles, permissions: [...permissionsFor(m.roles)], status: m.status };
    next();
  } catch (err) {
    next(err);
  }
};

/** Guard: require a specific permission. Use AFTER attachMembership. */
const requirePermission = (perm) => (req, res, next) => {
  const perms = req.membership ? new Set(req.membership.permissions) : new Set();
  if (!can(perms, perm)) {
    return next(new ApiError(403, "You don't have permission to do that."));
  }
  next();
};

/** Guard: require any of the given roles. */
const requireRole = (...roles) => (req, res, next) => {
  const have = req.membership?.roles || [];
  if (!have.some((r) => roles.includes(r))) {
    return next(new ApiError(403, "You don't have permission to do that."));
  }
  next();
};

module.exports = { attachMembership, requirePermission, requireRole };
