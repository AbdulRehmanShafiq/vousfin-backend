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

/**
 * Guard: require `perm` ONLY when `predicate(req)` is true; otherwise pass through.
 * Use for higher-risk sub-actions gated by a request flag (e.g. a 3-way-match
 * override that must need `match:override`, while a normal approval needs only
 * `transaction:approve`). Use AFTER attachMembership.
 */
const requirePermissionWhen = (predicate, perm) => (req, res, next) =>
  predicate(req) ? requirePermission(perm)(req, res, next) : next();

/** Guard: require any of the given roles. */
const requireRole = (...roles) => (req, res, next) => {
  const have = req.membership?.roles || [];
  if (!have.some((r) => roles.includes(r))) {
    return next(new ApiError(403, "You don't have permission to do that."));
  }
  next();
};

/** Guard every write (non-GET) under a router with one permission. Reads stay open. */
const writeGuard = (perm) => (req, res, next) =>
  (req.method === 'GET' ? next() : requirePermission(perm)(req, res, next));

/**
 * One guard for a mixed-domain router: picks the permission by what the write does.
 *   approve / reject / escalate / reassign  → `approve`
 *   DELETE, or void / write-off / reverse    → `reverse`
 *   everything else (create / edit / lifecycle) → `create`
 * GET stays open. Omit `approve`/`reverse` for routers that don't have them.
 * Use AFTER attachMembership.
 */
const domainWriteGuard = ({ create, approve, reverse }) => (req, res, next) => {
  if (req.method === 'GET') return next();
  const p = (req.path || '').toLowerCase();
  if (approve && /(approve|reject|escalat|reassign)/.test(p)) return requirePermission(approve)(req, res, next);
  if (reverse && (req.method === 'DELETE' || /(void|write-?off|reverse)/.test(p))) return requirePermission(reverse)(req, res, next);
  return requirePermission(create)(req, res, next);
};

module.exports = { attachMembership, requirePermission, requirePermissionWhen, requireRole, writeGuard, domainWriteGuard };
