# Phase 6A — Team & RBAC Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add per-business multi-user team membership with assignable multi-roles (`owner`/`accountant`/`approver`/`viewer`), a role→permission matrix, membership-aware auth middleware, an email-based invite/accept flow, an owner backfill, and permission guards on high-sensitivity routes — all layered on existing auth so nothing breaks.

**Architecture:** A new `Membership` join collection (businessId × userId × roles[]) is the source of truth for who's in a business and what they can do. `attachMembership` runs after the existing `authMiddleware` and sets `req.membership = { roles, permissions }`; `requirePermission('x')` guards routes. Existing single-user businesses are backfilled (and lazily self-heal) to an `owner` membership.

**Tech Stack:** Node/Express/Mongoose/Jest (backend), React/Vite/TanStack Query (frontend). Email via existing Brevo SMTP (`utils/email.utils.sendEmail`). Roles/permissions live in `config/constants.js`.

## Global Constraints

- **TDD always:** failing test first → watch it fail → minimal code → watch it pass. No production code without a failing test.
- **Roles (exact):** `owner`, `accountant`, `approver`, `viewer`. `ROLE_PERMISSIONS`: owner=`['*']`, accountant=`['transaction:create','transaction:reverse','report:view','report:manage']`, approver=`['transaction:approve','report:view']`, viewer=`['report:view']`.
- **Memberships hold a `roles` ARRAY** (≥1), never a single role.
- **Layer on existing auth** — never modify/replace `authMiddleware`; `req.user` shape stays `{ id, email, role, fullName, businessId, status }`.
- **Backward compatible:** existing businesses keep working — their owner is backfilled to an `owner` membership (full permissions). Routes without new guards behave exactly as before.
- **Enforcement scope this phase:** high-sensitivity routes only (team mgmt, approvals, settings, deletes/reversals, report-builder); all other authenticated routes stay open to any active member.
- **Plain-language user-facing copy** (no jargon): e.g. "You don't have permission to do that."
- **Follow existing patterns** (mirror `CostCenter` model/repo/service/controller/routes/validation). Repos are singletons (`module.exports = new XRepository()`); services are singleton class instances; controllers use `ApiResponse.success/created` + `try/catch → next(err)`; errors via `new ApiError(status, msg)`.
- **Tests live under `tests/unit/<layer>/` and `tests/integration/`** — NEVER `__tests__/` (jest ignores it). Run a file: `npm test -- <pattern>`. Full suite: `npm test`. Ledger gate: `node scripts/ledgerDrift.js` = 0 (this phase has no ledger impact but the gate must stay clean).
- **Commit message footer:** end every commit with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do NOT stage untracked `outputs/cfo-reports/*.pdf`.

---

## File structure

- Create `config` additions in `config/constants.js` (BUSINESS_ROLES, PERMISSIONS, ROLE_PERMISSIONS, MEMBERSHIP_STATUS, ENTITY_TYPES.MEMBERSHIP, AUDIT_ACTIONS membership entries).
- Create `utils/permissions.js` — pure `permissionsFor(roles)` / `can(permsOrRoles, perm)`.
- Create `models/Membership.model.js`, `repositories/membership.repository.js`.
- Create `services/membership.service.js`; add `sendTeamInviteEmail` to `utils/email.utils.js`.
- Create `middleware/rbac.middleware.js`.
- Create `controllers/team.controller.js`, `validations/team.validation.js`, `routes/v1/team.routes.js`; mount `/team` + wire `attachMembership` in the authenticated pipeline (`routes/index.js`).
- Create `scripts/backfillOwnerMemberships.js`; apply guards to high-sensitivity routes.
- Frontend: `src/pages/settings/TeamPage.jsx`, `src/pages/AcceptInvitePage.jsx`, `src/services/team.service.js`, register in `nav.config.js` + `routes.jsx`.

---

## Task 1 — Constants + permissions helper

**Files:**
- Modify: `config/constants.js` (add the role/permission blocks; add `ENTITY_TYPES.MEMBERSHIP` and membership `AUDIT_ACTIONS` if absent)
- Create: `utils/permissions.js`
- Test: `tests/unit/utils/permissions.test.js`

**Interfaces — Produces:** `permissionsFor(roles: string[]) → Set<string>` (owner's `'*'` short-circuits to `Set(['*'])`); `can(permsOrRoles: Set|string[], perm: string) → boolean`. Constants `BUSINESS_ROLES`, `PERMISSIONS`, `ROLE_PERMISSIONS`, `MEMBERSHIP_STATUS`.

- [ ] **Step 1: Write the failing test** — `tests/unit/utils/permissions.test.js`

```js
const { permissionsFor, can } = require('../../../utils/permissions');

describe('permissions helper', () => {
  test('owner resolves to wildcard (all permissions)', () => {
    const set = permissionsFor(['owner']);
    expect(set.has('*')).toBe(true);
    expect(can(set, 'anything:at:all')).toBe(true);
  });
  test('accountant can create + view but not approve', () => {
    expect(can(['accountant'], 'transaction:create')).toBe(true);
    expect(can(['accountant'], 'report:view')).toBe(true);
    expect(can(['accountant'], 'transaction:approve')).toBe(false);
    expect(can(['accountant'], 'member:manage')).toBe(false);
  });
  test('approver can approve + view but not create', () => {
    expect(can(['approver'], 'transaction:approve')).toBe(true);
    expect(can(['approver'], 'transaction:create')).toBe(false);
  });
  test('viewer is read-only', () => {
    expect(can(['viewer'], 'report:view')).toBe(true);
    expect(can(['viewer'], 'transaction:create')).toBe(false);
  });
  test('multiple roles union their permissions', () => {
    expect(can(['accountant', 'approver'], 'transaction:create')).toBe(true);
    expect(can(['accountant', 'approver'], 'transaction:approve')).toBe(true);
  });
  test('unknown role contributes nothing', () => {
    expect(can(['nope'], 'report:view')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- permissions`
Expected: FAIL — `Cannot find module '../../../utils/permissions'`.

- [ ] **Step 3: Add the constants** — in `config/constants.js`, add these as new top-level `module.exports` properties (the file uses inline `KEY: {...},` properties — match that style and comma placement):

```js
  BUSINESS_ROLES: { OWNER: 'owner', ACCOUNTANT: 'accountant', APPROVER: 'approver', VIEWER: 'viewer' },

  MEMBERSHIP_STATUS: { ACTIVE: 'active', INVITED: 'invited', SUSPENDED: 'suspended' },

  // RBAC permission catalog (action strings).
  PERMISSIONS: {
    MEMBER_MANAGE:       'member:manage',
    SETTINGS_MANAGE:     'settings:manage',
    TRANSACTION_CREATE:  'transaction:create',
    TRANSACTION_APPROVE: 'transaction:approve',
    TRANSACTION_REVERSE: 'transaction:reverse',
    REPORT_VIEW:         'report:view',
    REPORT_MANAGE:       'report:manage',
    AUDIT_MANAGE:        'audit:manage',
    SOD_MANAGE:          'sod:manage',
  },

  // role -> permission strings. '*' = all permissions.
  ROLE_PERMISSIONS: {
    owner:      ['*'],
    accountant: ['transaction:create', 'transaction:reverse', 'report:view', 'report:manage'],
    approver:   ['transaction:approve', 'report:view'],
    viewer:     ['report:view'],
  },
```

Then ensure audit support: in the existing `ENTITY_TYPES` object add `MEMBERSHIP: 'membership',` if not present; in the existing `AUDIT_ACTIONS` object add (if not present) `MEMBER_INVITED: 'member_invited', MEMBER_ROLES_CHANGED: 'member_roles_changed', MEMBER_REMOVED: 'member_removed', MEMBER_JOINED: 'member_joined',`. (Read both objects first; only add missing keys.)

- [ ] **Step 4: Create `utils/permissions.js`**

```js
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- permissions`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add config/constants.js utils/permissions.js tests/unit/utils/permissions.test.js
git commit -m "feat(rbac): business roles, permission matrix + resolver (Phase 6A)"
```

---

## Task 2 — Membership model + repository

**Files:**
- Create: `models/Membership.model.js`
- Create: `repositories/membership.repository.js`
- Test: `tests/unit/repositories/membership.repository.test.js`

**Interfaces — Consumes:** `MEMBERSHIP_STATUS`, `BUSINESS_ROLES` (Task 1). **Produces:** `Membership` model; `membershipRepository` singleton with `findByBusinessAndUser(businessId,userId)`, `findActiveByBusinessAndUser(...)`, `findOwnedByBusiness(businessId)` (populates user fullName+email, lean), `findByInviteToken(token)`, `findByBusinessAndEmail(businessId,email)`, `countActiveOwners(businessId)`.

- [ ] **Step 1: Write the failing test** — `tests/unit/repositories/membership.repository.test.js`

```js
const repo = require('../../../repositories/membership.repository');

describe('membership.repository', () => {
  test('exposes the expected query methods', () => {
    for (const m of ['findByBusinessAndUser','findActiveByBusinessAndUser','findOwnedByBusiness','findByInviteToken','findByBusinessAndEmail','countActiveOwners']) {
      expect(typeof repo[m]).toBe('function');
    }
  });
  test('countActiveOwners builds an active+owner query', async () => {
    const spy = jest.spyOn(repo.model, 'countDocuments').mockResolvedValue(2);
    const n = await repo.countActiveOwners('biz1');
    expect(n).toBe(2);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'biz1', status: 'active', roles: 'owner' }));
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- membership.repository`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `models/Membership.model.js`** (mirror `CostCenter.model.js` style)

```js
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
```

- [ ] **Step 4: Create `repositories/membership.repository.js`**

```js
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- membership.repository`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add models/Membership.model.js repositories/membership.repository.js tests/unit/repositories/membership.repository.test.js
git commit -m "feat(rbac): Membership model + repository (Phase 6A)"
```

---

## Task 3 — membership.service + invite email

**Files:**
- Modify: `utils/email.utils.js` (add `sendTeamInviteEmail`, export it)
- Create: `services/membership.service.js`
- Test: `tests/unit/services/membership.service.test.js`

**Interfaces — Consumes:** `membershipRepository` (Task 2); `permissionsFor` (Task 1); `auditService.log`; `sendTeamInviteEmail(to, inviteToken, businessName, roles)`; `userRepository.findByEmail`. **Produces:** `membershipService` singleton with:
- `resolveActiveMembership(businessId, userId)` → membership-like `{ roles, status }` or null (self-heals legacy owner: if no membership but the user's `businessId === businessId` and they're the business owner per `User.businessId`, create+return an owner membership).
- `ensureOwnerMembership(businessId, userId)` → idempotent owner membership.
- `listMembers(businessId)`, `invite(businessId, {email,roles}, actor)`, `acceptInvite(token, user)`, `updateRoles(businessId, targetUserId, roles, actor)`, `removeMember(businessId, targetUserId, actor)`.

- [ ] **Step 1: Write the failing test** — `tests/unit/services/membership.service.test.js`

```js
jest.mock('../../../repositories/membership.repository');
jest.mock('../../../repositories/user.repository');
jest.mock('../../../services/audit.service');
jest.mock('../../../utils/email.utils');

const repo = require('../../../repositories/membership.repository');
const userRepo = require('../../../repositories/user.repository');
const email = require('../../../utils/email.utils');
const service = require('../../../services/membership.service');
const { BUSINESS_ROLES, MEMBERSHIP_STATUS } = require('../../../config/constants');

beforeEach(() => jest.clearAllMocks());

test('invite creates an invited membership with a token and sends the email', async () => {
  repo.findByBusinessAndEmail.mockResolvedValue(null);
  userRepo.findByEmail.mockResolvedValue(null);
  repo.create.mockImplementation(async (d) => ({ _id: 'm1', ...d }));
  const m = await service.invite('biz1', { email: 'New@X.com', roles: ['accountant'] }, { _id: 'u1', businessId: 'biz1' });
  expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
    businessId: 'biz1', invitedEmail: 'new@x.com', roles: ['accountant'], status: MEMBERSHIP_STATUS.INVITED,
  }));
  expect(typeof repo.create.mock.calls[0][0].inviteToken).toBe('string');
  expect(email.sendTeamInviteEmail).toHaveBeenCalled();
});

test('invite rejects an invalid role', async () => {
  await expect(service.invite('biz1', { email: 'a@b.com', roles: ['superuser'] }, { _id: 'u1' }))
    .rejects.toThrow(/role/i);
});

test('invite rejects a duplicate member', async () => {
  repo.findByBusinessAndEmail.mockResolvedValue({ _id: 'm0' });
  await expect(service.invite('biz1', { email: 'a@b.com', roles: ['viewer'] }, { _id: 'u1' }))
    .rejects.toThrow(/already/i);
});

test('updateRoles blocks removing the last owner', async () => {
  repo.findByBusinessAndUser.mockResolvedValue({ _id: 'm1', businessId: 'biz1', userId: 'u2', roles: ['owner'], status: 'active' });
  repo.countActiveOwners.mockResolvedValue(1);
  await expect(service.updateRoles('biz1', 'u2', ['accountant'], { _id: 'u1' }))
    .rejects.toThrow(/owner/i);
});

test('acceptInvite activates a matching pending invite', async () => {
  repo.findByInviteToken.mockResolvedValue({
    _id: 'm1', businessId: 'biz1', invitedEmail: 'new@x.com', status: 'invited',
    inviteTokenExpiresAt: new Date(Date.now() + 1e6), save: jest.fn().mockResolvedValue(true),
  });
  const m = await service.acceptInvite('tok', { _id: 'u9', email: 'new@x.com' });
  expect(m.status).toBe(MEMBERSHIP_STATUS.ACTIVE);
  expect(m.userId).toBe('u9');
});

test('acceptInvite rejects when the email does not match', async () => {
  repo.findByInviteToken.mockResolvedValue({
    _id: 'm1', invitedEmail: 'new@x.com', status: 'invited',
    inviteTokenExpiresAt: new Date(Date.now() + 1e6), save: jest.fn(),
  });
  await expect(service.acceptInvite('tok', { _id: 'u9', email: 'other@x.com' })).rejects.toThrow(/match|invite/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- membership.service`
Expected: FAIL — service module not found.

- [ ] **Step 3: Add `sendTeamInviteEmail` to `utils/email.utils.js`** (mirror `sendPasswordResetEmail`; add to `module.exports`):

```js
const sendTeamInviteEmail = async (to, inviteToken, businessName, roles) => {
  // CLIENT_URL may be comma-separated; use the first origin for the link base.
  const base = String(config.CLIENT_URL || '').split(',')[0].trim();
  const acceptLink = `${base}/accept-invite?token=${inviteToken}`;
  const roleText = (roles || []).join(', ');
  const html = `
    <!DOCTYPE html><html><head><meta charset="UTF-8"></head>
    <body><div style="max-width:600px;margin:0 auto;padding:20px;">
      <h2>You've been invited to ${businessName} on vousFin</h2>
      <p>You've been added as: <b>${roleText}</b>.</p>
      <p>Click below to join the team and set up your access:</p>
      <p><a href="${acceptLink}">Accept invitation</a></p>
      <p>This invitation expires in 7 days.</p>
      <hr><p>vousFin</p>
    </div></body></html>`;
  await sendEmail({ to, subject: `You're invited to ${businessName} on vousFin`, html });
};
```

- [ ] **Step 4: Create `services/membership.service.js`**

```js
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
  /** Active membership for (business,user); self-heals a legacy single-user owner. */
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

  async ensureOwnerMembership(businessId, userId) {
    const found = await repo.findByBusinessAndUser(businessId, userId);
    if (found) return found;
    return repo.create({
      businessId, userId, roles: [BUSINESS_ROLES.OWNER], status: MEMBERSHIP_STATUS.ACTIVE, joinedAt: new Date(),
    });
  }

  async listMembers(businessId) {
    return repo.findOwnedByBusiness(businessId);
  }

  async invite(businessId, { email, roles }, actor) {
    assertRoles(roles);
    const lower = String(email || '').toLowerCase().trim();
    if (!lower) throw new ApiError(400, 'An email address is required.');
    if (await repo.findByBusinessAndEmail(businessId, lower)) {
      throw new ApiError(409, 'That person already has an invite or membership in this business.');
    }
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
      invitedBy: actor._id,
      invitedAt: new Date(),
    });
    try {
      const business = await businessRepository.findById(businessId);
      await sendTeamInviteEmail(lower, inviteToken, business?.businessName || business?.name || 'your team', roles);
    } catch (e) {
      // best-effort: the invite row exists even if the email fails; it can be resent.
      logger.warn(`[membership] invite email failed for ${lower}: ${e.message}`);
    }
    await auditService.log({
      businessId, entityType: ENTITY_TYPES.MEMBERSHIP, entityId: membership._id,
      action: AUDIT_ACTIONS.MEMBER_INVITED, performedBy: actor._id,
      metadata: { invitedEmail: lower, roles },
    });
    return membership;
  }

  async acceptInvite(token, user) {
    const m = await repo.findByInviteToken(token);
    if (!m || m.status !== MEMBERSHIP_STATUS.INVITED) throw new ApiError(400, 'This invitation is invalid or already used.');
    if (m.inviteTokenExpiresAt && m.inviteTokenExpiresAt.getTime() < Date.now()) {
      throw new ApiError(400, 'This invitation has expired. Ask for a new one.');
    }
    if (m.invitedEmail && String(user.email).toLowerCase() !== m.invitedEmail) {
      throw new ApiError(403, 'This invitation was sent to a different email address.');
    }
    m.userId = user._id;
    m.status = MEMBERSHIP_STATUS.ACTIVE;
    m.inviteToken = null;
    m.inviteTokenExpiresAt = null;
    m.joinedAt = new Date();
    await m.save();
    await auditService.log({
      businessId: m.businessId, entityType: ENTITY_TYPES.MEMBERSHIP, entityId: m._id,
      action: AUDIT_ACTIONS.MEMBER_JOINED, performedBy: user._id, metadata: { roles: m.roles },
    });
    return m;
  }

  async updateRoles(businessId, targetUserId, roles, actor) {
    assertRoles(roles);
    const m = await repo.findByBusinessAndUser(businessId, targetUserId);
    if (!m) throw new ApiError(404, 'That member was not found.');
    // Last-owner protection: removing owner from the only active owner is blocked.
    const losingOwner = m.roles.includes(BUSINESS_ROLES.OWNER) && !roles.includes(BUSINESS_ROLES.OWNER);
    if (losingOwner && (await repo.countActiveOwners(businessId)) <= 1) {
      throw new ApiError(409, 'A business must have at least one owner.');
    }
    // NOTE (6B): SoD conflict check on `roles` will be inserted here.
    const before = [...m.roles];
    m.roles = roles;
    m.lastModifiedBy = actor._id;
    await m.save();
    await auditService.log({
      businessId, entityType: ENTITY_TYPES.MEMBERSHIP, entityId: m._id,
      action: AUDIT_ACTIONS.MEMBER_ROLES_CHANGED, performedBy: actor._id,
      beforeState: { roles: before }, afterState: { roles },
    });
    return m;
  }

  async removeMember(businessId, targetUserId, actor) {
    const m = await repo.findByBusinessAndUser(businessId, targetUserId);
    if (!m) throw new ApiError(404, 'That member was not found.');
    if (m.roles.includes(BUSINESS_ROLES.OWNER) && (await repo.countActiveOwners(businessId)) <= 1) {
      throw new ApiError(409, 'A business must have at least one owner.');
    }
    await repo.delete(m._id);
    await auditService.log({
      businessId, entityType: ENTITY_TYPES.MEMBERSHIP, entityId: m._id,
      action: AUDIT_ACTIONS.MEMBER_REMOVED, performedBy: actor._id, metadata: { removedUserId: String(targetUserId) },
    });
    return { removed: true };
  }
}

module.exports = new MembershipService();
```

NOTE: verify `auditService.log` accepts `beforeState`/`afterState`/`metadata` keys (it stores arbitrary fields) — if the existing schema uses different key names (e.g. `before`/`after`), match them. Verify `userRepository.findByEmail` and `businessRepository.findById` exist (they're used elsewhere; adjust names if different).

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- membership.service`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add utils/email.utils.js services/membership.service.js tests/unit/services/membership.service.test.js
git commit -m "feat(rbac): membership service (invite/accept/roles/remove) + invite email (Phase 6A)"
```

---

## Task 4 — RBAC middleware

**Files:**
- Create: `middleware/rbac.middleware.js`
- Test: `tests/unit/middleware/rbac.middleware.test.js`

**Interfaces — Consumes:** `membershipService.resolveActiveMembership`, `permissionsFor`, `can` (Tasks 1+3). **Produces:** `attachMembership(req,res,next)` (sets `req.membership = { roles, permissions: string[], status }`), `requirePermission(perm) → middleware`, `requireRole(...roles) → middleware`.

- [ ] **Step 1: Write the failing test** — `tests/unit/middleware/rbac.middleware.test.js`

```js
jest.mock('../../../services/membership.service');
const membershipService = require('../../../services/membership.service');
const { attachMembership, requirePermission } = require('../../../middleware/rbac.middleware');

const mkRes = () => ({});
beforeEach(() => jest.clearAllMocks());

test('attachMembership sets req.membership from the resolved roles', async () => {
  membershipService.resolveActiveMembership.mockResolvedValue({ roles: ['accountant'], status: 'active' });
  const req = { user: { id: 'u1', businessId: 'b1' } };
  const next = jest.fn();
  await attachMembership(req, mkRes(), next);
  expect(next).toHaveBeenCalledWith(); // no error
  expect(req.membership.roles).toEqual(['accountant']);
  expect(req.membership.permissions).toContain('transaction:create');
});

test('attachMembership 403s when the user has no membership', async () => {
  membershipService.resolveActiveMembership.mockResolvedValue(null);
  const req = { user: { id: 'u1', businessId: 'b1' } };
  const next = jest.fn();
  await attachMembership(req, mkRes(), next);
  expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
  expect(next.mock.calls[0][0].statusCode).toBe(403);
});

test('requirePermission allows when permission present, 403s otherwise', () => {
  const ok = jest.fn();
  requirePermission('report:view')({ membership: { permissions: ['report:view'] } }, mkRes(), ok);
  expect(ok).toHaveBeenCalledWith();

  const denied = jest.fn();
  requirePermission('transaction:approve')({ membership: { permissions: ['report:view'] } }, mkRes(), denied);
  expect(denied.mock.calls[0][0].statusCode).toBe(403);
});

test('owner wildcard passes any permission', () => {
  const ok = jest.fn();
  requirePermission('anything:x')({ membership: { permissions: ['*'] } }, mkRes(), ok);
  expect(ok).toHaveBeenCalledWith();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- rbac.middleware`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `middleware/rbac.middleware.js`**

```js
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
  if (!req.membership || !can(req.membership.permissions, perm)) {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- rbac.middleware`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add middleware/rbac.middleware.js tests/unit/middleware/rbac.middleware.test.js
git commit -m "feat(rbac): attachMembership + requirePermission/requireRole middleware (Phase 6A)"
```

---

## Task 5 — Team API (validation, controller, routes) + wire attachMembership + lazy self-heal

**Files:**
- Create: `validations/team.validation.js`, `controllers/team.controller.js`, `routes/v1/team.routes.js`
- Modify: `routes/index.js` (mount `/team`)
- Modify: `services/auth.service.js` `getProfile` (lazy `ensureOwnerMembership` so existing users self-heal on login)
- Test: `tests/unit/controllers/team.controller.test.js`

**Interfaces — Consumes:** `membershipService` (Task 3), `attachMembership`/`requirePermission` (Task 4), `PERMISSIONS` (Task 1). **Produces:** routes `GET /team`, `POST /team/invite`, `POST /team/accept`, `PATCH /team/:userId/roles`, `DELETE /team/:userId`.

- [ ] **Step 1: Write the failing test** — `tests/unit/controllers/team.controller.test.js` (mirror existing controller-test harness)

```js
jest.mock('../../../services/membership.service');
const membershipService = require('../../../services/membership.service');
const ctrl = require('../../../controllers/team.controller');

const mockRes = () => { const r = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); return r; };
beforeEach(() => jest.clearAllMocks());

test('invite forwards businessId, body and actor to the service', async () => {
  membershipService.invite.mockResolvedValue({ _id: 'm1' });
  const req = { user: { _id: 'u1', id: 'u1', businessId: 'b1' }, body: { email: 'a@b.com', roles: ['viewer'] } };
  const res = mockRes(); const next = jest.fn();
  await ctrl.invite(req, res, next);
  expect(membershipService.invite).toHaveBeenCalledWith('b1', { email: 'a@b.com', roles: ['viewer'] }, req.user);
  expect(res.status).toHaveBeenCalledWith(201);
});

test('updateRoles forwards target userId + roles', async () => {
  membershipService.updateRoles.mockResolvedValue({ _id: 'm1', roles: ['accountant'] });
  const req = { user: { _id: 'u1', id: 'u1', businessId: 'b1' }, params: { userId: 'u2' }, body: { roles: ['accountant'] } };
  const res = mockRes(); const next = jest.fn();
  await ctrl.updateRoles(req, res, next);
  expect(membershipService.updateRoles).toHaveBeenCalledWith('b1', 'u2', ['accountant'], req.user);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- team.controller`
Expected: FAIL — controller module not found.

- [ ] **Step 3: Create the validation** — `validations/team.validation.js` (mirror `costCenter.validation.js`)

```js
const Joi = require('joi');
const { BUSINESS_ROLES } = require('../config/constants');
const ROLES = Object.values(BUSINESS_ROLES);

const inviteSchema = Joi.object({
  email: Joi.string().email().required().messages({ 'any.required': 'An email address is required' }),
  roles: Joi.array().items(Joi.string().valid(...ROLES)).min(1).required(),
});
const updateRolesSchema = Joi.object({
  roles: Joi.array().items(Joi.string().valid(...ROLES)).min(1).required(),
});
const acceptSchema = Joi.object({ token: Joi.string().required() });

module.exports = { inviteSchema, updateRolesSchema, acceptSchema };
```

- [ ] **Step 4: Create the controller** — `controllers/team.controller.js` (mirror `costCenter.controller.js`)

```js
const membershipService = require('../services/membership.service');
const ApiResponse = require('../utils/ApiResponse');

exports.list = async (req, res, next) => {
  try { ApiResponse.success(res, await membershipService.listMembers(req.user.businessId), 'Members retrieved'); }
  catch (e) { next(e); }
};
exports.invite = async (req, res, next) => {
  try {
    const m = await membershipService.invite(req.user.businessId, { email: req.body.email, roles: req.body.roles }, req.user);
    ApiResponse.created(res, m, 'Invitation sent');
  } catch (e) { next(e); }
};
exports.accept = async (req, res, next) => {
  try { ApiResponse.success(res, await membershipService.acceptInvite(req.body.token, req.user), 'Invitation accepted'); }
  catch (e) { next(e); }
};
exports.updateRoles = async (req, res, next) => {
  try { ApiResponse.success(res, await membershipService.updateRoles(req.user.businessId, req.params.userId, req.body.roles, req.user), 'Roles updated'); }
  catch (e) { next(e); }
};
exports.remove = async (req, res, next) => {
  try { ApiResponse.success(res, await membershipService.removeMember(req.user.businessId, req.params.userId, req.user), 'Member removed'); }
  catch (e) { next(e); }
};
```

- [ ] **Step 5: Create the routes** — `routes/v1/team.routes.js`

```js
const express = require('express');
const ctrl = require('../../controllers/team.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const { attachMembership, requirePermission } = require('../../middleware/rbac.middleware');
const validate = require('../../middleware/validate.middleware');
const { inviteSchema, updateRolesSchema, acceptSchema } = require('../../validations/team.validation');
const { PERMISSIONS } = require('../../config/constants');

const router = express.Router();
router.use(authMiddleware);

// Accept does not require an existing business membership — a brand-new invitee.
router.post('/accept', validate(acceptSchema), ctrl.accept);

// Everything else is business + member-management scoped.
router.use(requireBusiness, attachMembership);
router.get('/', requirePermission(PERMISSIONS.MEMBER_MANAGE), ctrl.list);
router.post('/invite', requirePermission(PERMISSIONS.MEMBER_MANAGE), validate(inviteSchema), ctrl.invite);
router.patch('/:userId/roles', requirePermission(PERMISSIONS.MEMBER_MANAGE), validate(updateRolesSchema), ctrl.updateRoles);
router.delete('/:userId', requirePermission(PERMISSIONS.MEMBER_MANAGE), ctrl.remove);

module.exports = router;
```

- [ ] **Step 6: Mount + lazy self-heal**

In `routes/index.js`, add near the other mounts: `router.use('/team', require('./v1/team.routes')); // Phase 6A — team & RBAC`.

In `services/auth.service.js` `getProfile(userId)`: after loading the user, if `user.businessId`, call (best-effort, awaited) `require('./membership.service').ensureOwnerMembership(user.businessId, user._id)` inside a try/catch that logs and continues — so every existing owner self-heals to an owner membership on next profile load. (Do not let a membership hiccup break login/profile.)

- [ ] **Step 7: Run tests + commit**

Run: `npm test -- team.controller` (PASS), then `npm test` (full suite green).
```bash
git add validations/team.validation.js controllers/team.controller.js routes/v1/team.routes.js routes/index.js services/auth.service.js tests/unit/controllers/team.controller.test.js
git commit -m "feat(rbac): /team API + lazy owner self-heal on profile (Phase 6A)"
```

---

## Task 6 — Backfill script + enforcement on high-sensitivity routes

**Files:**
- Create: `scripts/backfillOwnerMemberships.js`
- Modify: high-sensitivity route files to add `attachMembership` + `requirePermission(...)` (list below)
- Test: `tests/integration/rbac.enforcement.test.js` (one representative guarded route → viewer 403, owner 200) — OR a focused unit test on a guarded router; mirror existing integration harness.

**Interfaces — Consumes:** `attachMembership`, `requirePermission`, `PERMISSIONS`, `ensureOwnerMembership`.

- [ ] **Step 1: Write the failing test** — assert a representative guard denies a viewer. Mirror how existing route/integration tests build an app + auth. Minimal example (adapt to the repo's integration harness):

```js
// Verifies requirePermission blocks an under-privileged member on a guarded route.
const express = require('express');
const request = require('supertest');
const { requirePermission } = require('../../middleware/rbac.middleware');
const { PERMISSIONS } = require('../../config/constants');

test('viewer is blocked from a member:manage route; owner allowed', async () => {
  const app = express();
  app.use(express.json());
  // simulate attachMembership having run with a viewer
  app.use((req, _res, next) => { req.membership = { roles: ['viewer'], permissions: ['report:view'] }; next(); });
  app.post('/x', requirePermission(PERMISSIONS.MEMBER_MANAGE), (_req, res) => res.json({ ok: true }));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ message: err.message }));
  const denied = await request(app).post('/x').send({});
  expect(denied.status).toBe(403);
});
```

- [ ] **Step 2: Run it** — `npm test -- rbac.enforcement` → PASS already if Task 4 done (this test validates the guard contract used below). If the repo prefers a true end-to-end integration test, add it here using the existing integration bootstrap.

- [ ] **Step 3: Create the backfill** — `scripts/backfillOwnerMemberships.js` (mirror `scripts/recomputeLedgerBalances.js` connection bootstrap: load env, connect via `config/database`, dry-run default, `--apply`):
  - For each `User` with a `businessId`, call `membershipService.ensureOwnerMembership(businessId, userId)` (idempotent). Print a per-business summary `created/already`. Under dry-run, only report what WOULD be created. Disconnect at end.

- [ ] **Step 4: Apply guards (high-sensitivity routes only).** In each route file below, import `{ attachMembership, requirePermission }` and `{ PERMISSIONS }`, ensure `attachMembership` runs after `authMiddleware`+`requireBusiness`, and add the guard to the listed handlers. Read each file first; insert the guard as middleware before the controller, matching that file's existing `router.<verb>(path, ...middleware, ctrl.x)` style.
  - `routes/v1/bill.routes.js` — the **approve** route → `requirePermission(PERMISSIONS.TRANSACTION_APPROVE)`.
  - `routes/v1/purchaseOrder.routes.js` — the **approve** route → `requirePermission(PERMISSIONS.TRANSACTION_APPROVE)`.
  - `routes/v1/transaction.routes.js` — **delete/reverse** route(s) → `requirePermission(PERMISSIONS.TRANSACTION_REVERSE)`.
  - `routes/v1/invoice.routes.js` — **delete/void/write-off** route(s) → `requirePermission(PERMISSIONS.TRANSACTION_REVERSE)`.
  - `routes/v1/business.routes.js` — business **update/settings** route(s) → `requirePermission(PERMISSIONS.SETTINGS_MANAGE)`.
  - `routes/v1/fiscalYear.routes.js` — mutation routes (create/close/lock) → `requirePermission(PERMISSIONS.SETTINGS_MANAGE)`.
  - report-builder routes (the report template create/update/schedule routes added in Phase 5; find via `git grep -n "report-builder\|reportTemplate\|/templates" routes/`) → `requirePermission(PERMISSIONS.REPORT_MANAGE)`.
  - For each, `attachMembership` must precede the guard. If a router doesn't already `router.use(requireBusiness)`, add `router.use(requireBusiness, attachMembership)` after `authMiddleware`; otherwise add `attachMembership` alongside.
  - Owners have `'*'` so they pass all guards — existing single-user (owner) flows are unaffected.

- [ ] **Step 5: Verify** — `npm test` (full suite green; existing route tests must still pass — owners/legacy resolve to owner and pass). Then `node scripts/ledgerDrift.js` = 0. Run the backfill dry-run locally if a DB is reachable: `node scripts/backfillOwnerMemberships.js` (report only).

- [ ] **Step 6: Commit**

```bash
git add scripts/backfillOwnerMemberships.js routes/ tests/
git commit -m "feat(rbac): owner backfill + permission guards on high-sensitivity routes (Phase 6A)"
```

---

## Task 7 — Frontend: Team management + accept-invite

**Files (vousfin-frontend-main):**
- Create: `src/services/team.service.js`, `src/pages/settings/TeamPage.jsx`, `src/pages/AcceptInvitePage.jsx`
- Modify: `src/config/nav.config.js` (add Team under Settings), `src/routes.jsx` (lazy routes incl. public `/accept-invite`)
- Test: lint + build (frontend has no jest harness for pages — `npm run lint` + `npm run build` must pass)

**Interfaces — Consumes:** backend `/team` endpoints (Task 5). Roles list from a local constant mirroring `BUSINESS_ROLES`.

- [ ] **Step 1: `team.service.js`** — mirror `src/services/*.service.js` (axios instance from `services/api.js`): `listMembers()`, `invite(email, roles)`, `acceptInvite(token)`, `updateRoles(userId, roles)`, `removeMember(userId)` hitting `/team*`.

- [ ] **Step 2: `TeamPage.jsx`** — under Settings. Lists members (name, email, roles, status); an Invite form (email input + role multi-select with plain-language labels: "Owner", "Accountant — can record", "Approver — can approve", "Viewer — read-only"); per-member change-roles + remove. Use TanStack Query (`useQuery`/`useMutation`) following an existing settings page (e.g. `CostCentersPage.jsx`); toast errors via `getErrorMessage` from `utils/errorHandler`. Wrap exported page so it's `React.lazy()`-friendly (the page is default-exported; `withSuspense` is applied in routes).

- [ ] **Step 3: `AcceptInvitePage.jsx`** — reads `?token=` from the URL; on mount (or button click) calls `team.service.acceptInvite(token)`, shows success ("You've joined the team") or the error; links to login/dashboard. Public-ish: it requires the user to be logged in (the backend `accept` route needs auth) — if not logged in, send them to login with a return path back to `/accept-invite?token=`.

- [ ] **Step 4: Wire nav + routes** — add a "Team" item to the Settings section in `nav.config.js`; add lazy routes in `routes.jsx`: `/settings/team` (inside `RequireBusiness`) and `/accept-invite` (inside the authenticated area), each via `withSuspense()`.

- [ ] **Step 5: Verify + commit**

Run (in `vousfin-frontend-main`): `npm run lint` (clean) and `npm run build` (succeeds).
```bash
git add src/services/team.service.js src/pages/settings/TeamPage.jsx src/pages/AcceptInvitePage.jsx src/config/nav.config.js src/routes.jsx
git commit -m "feat(rbac): team management + accept-invite UI (Phase 6A)"
```

---

## Final whole-branch review

After Task 7: run `scripts/review-package <merge-base> HEAD` and dispatch the final reviewer (superpowers:requesting-code-review) on the most capable model. Focus: (1) `req.membership` is always set before any `requirePermission` guard runs (no guard without `attachMembership` upstream); (2) legacy single-user owners still pass every guarded route (self-heal works); (3) no route accidentally locked out its legitimate users; (4) invite tokens are single-use + expiring + email-matched; (5) last-owner protection holds; (6) full suite green + drift 0. Then update the `srs-gap-closure-plan` memory with Phase 6A outcome and proceed to 6B (SoD).

## Non-goals (this phase)
- SoD conflict enforcement (6B — insertion point marked in `membership.service.updateRoles`).
- Internal Audit workspace (6C).
- Full permission enforcement on every route (incremental; high-sensitivity only here).
- Multiple active businesses per user / business switching UI.
- Custom user-defined roles.
