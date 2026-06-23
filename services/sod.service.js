// services/sod.service.js — Phase 6B (Segregation of Duties)
//
// The SoD conflict matrix: which role pairs a single person may not hold at once.
// A business may define custom rules; if it has none, a built-in default applies
// (accountant + approver — a preparer must not also approve). checkRoleAssignment
// is called from membership.service when roles are assigned (invite / updateRoles).
'use strict';
const { ApiError } = require('../utils/ApiError');
const SodRule = require('../models/SodRule.model');
const { BUSINESS_ROLES } = require('../config/constants');

// Built-in default conflicts (used when a business has defined none of its own).
const DEFAULT_CONFLICTS = [
  {
    roleA: BUSINESS_ROLES.ACCOUNTANT,
    roleB: BUSINESS_ROLES.APPROVER,
    reason: 'A person who records transactions should not also approve them (segregation of duties).',
  },
];

const pair = (a, b) => [a, b].sort();
const key = (a, b) => pair(a, b).join('|');

class SodService {
  /** Rules to show in the UI: the business's own, or the built-in defaults if none. */
  async listRules(businessId) {
    const custom = await SodRule.find({ businessId }).lean();
    if (custom.length) return custom;
    return DEFAULT_CONFLICTS.map((c) => ({
      _id: `default:${key(c.roleA, c.roleB)}`, businessId,
      roleA: pair(c.roleA, c.roleB)[0], roleB: pair(c.roleA, c.roleB)[1],
      reason: c.reason, isActive: true, isDefault: true,
    }));
  }

  /** The active conflict set (custom rules if any, else defaults), as "a|b" keys. */
  async _effectiveConflictSet(businessId) {
    const custom = await SodRule.find({ businessId, isActive: true }).lean();
    const rules = custom.length ? custom : DEFAULT_CONFLICTS;
    return new Set(rules.map((r) => key(r.roleA, r.roleB)));
  }

  async addRule(businessId, { roleA, roleB, reason }, actor = {}) {
    if (roleA === roleB) throw new ApiError(400, 'A conflict needs two different roles.');
    const [a, b] = pair(roleA, roleB);
    if (await SodRule.findOne({ businessId, roleA: a, roleB: b })) {
      throw new ApiError(409, 'That conflict rule already exists.');
    }
    return SodRule.create({ businessId, roleA: a, roleB: b, reason: reason || '', createdBy: actor._id || actor.id || null });
  }

  async removeRule(businessId, id) {
    const r = await SodRule.findOne({ _id: id, businessId });
    if (!r) throw new ApiError(404, 'Conflict rule not found.');
    await SodRule.deleteOne({ _id: id });
    return { removed: true };
  }

  /** Throws ApiError(409) if the proposed roles contain a conflicting pair. */
  async checkRoleAssignment(businessId, roles = []) {
    if (!Array.isArray(roles) || roles.length < 2) return; // a single role can't conflict
    const conflicts = await this._effectiveConflictSet(businessId);
    for (let i = 0; i < roles.length; i++) {
      for (let j = i + 1; j < roles.length; j++) {
        if (conflicts.has(key(roles[i], roles[j]))) {
          throw new ApiError(409, `These roles can't be held by the same person: "${roles[i]}" + "${roles[j]}" (segregation of duties).`);
        }
      }
    }
  }
}

module.exports = new SodService();
