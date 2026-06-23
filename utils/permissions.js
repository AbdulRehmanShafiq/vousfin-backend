// utils/permissions.js — RBAC permission resolution (pure, no I/O).
'use strict';
const { ROLE_PERMISSIONS } = require('../config/constants');

/** Union of the permission strings granted by a set of roles. Owner's '*' wins. */
function permissionsFor(roles = []) {
  const set = new Set();
  for (const role of roles) {
    const perms = ROLE_PERMISSIONS[role] || [];
    if (perms.includes('*')) return new Set(['*']);
    perms.forEach((p) => set.add(p));
  }
  return set;
}

/** True if the given roles/permission-set grant `perm` (wildcard '*' grants all). */
function can(permsOrRoles, perm) {
  const set = permsOrRoles instanceof Set ? permsOrRoles : permissionsFor(permsOrRoles);
  return set.has('*') || set.has(perm);
}

module.exports = { permissionsFor, can };
