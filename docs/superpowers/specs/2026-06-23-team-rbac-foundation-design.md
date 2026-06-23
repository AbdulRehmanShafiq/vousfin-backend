# Phase 6A — Team & RBAC Foundation (Design Spec)

**Date:** 2026-06-23
**SRS:** Foundation for FR-05.2 (SoD matrix) + FR-05.4 (Internal Audit) — enables multiple users per business with distinct roles. Part of the SRS gap-closure master plan, Phase 6 (decomposed into 6A team/RBAC → 6B SoD → 6C Internal Audit).
**Status:** Design approved (decisions locked via brainstorming). Next: writing-plans → subagent-driven execution.

## Problem / why

VousFin is single-user-per-business today: each `User` has one global `role` (`customer`/`admin`) and one `businessId`. The granular `APPROVER_ROLES` (owner/accountant/manager/admin) exist in `config/constants.js` and `approvalEngine.service.js` references them, but **nothing can assign them** — there is no team-membership concept, so the approval ladder and any SoD matrix have nothing real to act on. An enterprise accounting product needs multiple users per business with distinct, assignable roles. 6A builds that foundation; 6B (SoD) and 6C (Internal Audit) build on it.

## Locked decisions (brainstorming)

- **Roles (per-business):** `owner`, `accountant`, `approver`, `viewer`. owner = all (incl. approve); accountant = prepare/create/post, NOT approve; approver = approve, NOT create; viewer = read-only.
- **Memberships hold a ROLES ARRAY** (not a single role) — so 6B's SoD matrix can block conflicting pairs (e.g. `accountant`+`approver`) on one person.
- **Permission-matrix RBAC** (role → permission set over a permission catalog), not ad-hoc role string checks.
- **Layer on top of existing auth** — do not replace `authMiddleware`. Backfill every existing business's user as `owner` so nothing breaks.
- **Enforcement rollout: high-sensitivity routes first** (team mgmt, approvals, settings, deletes/reversals); all other authenticated routes remain open to any active member in 6A and get enforced incrementally in later phases.
- **Invites via email** (the live Brevo SMTP) with a tokenized accept link.

## Roles & permissions

Add to `config/constants.js`:

```js
BUSINESS_ROLES: { OWNER: 'owner', ACCOUNTANT: 'accountant', APPROVER: 'approver', VIEWER: 'viewer' },

// Permission catalog (action strings)
PERMISSIONS: {
  MEMBER_MANAGE:      'member:manage',       // invite / remove / change roles
  SETTINGS_MANAGE:    'settings:manage',     // business settings, fiscal year, COA config
  TRANSACTION_CREATE: 'transaction:create',  // create/post journals, invoices, bills, POs, etc.
  TRANSACTION_APPROVE:'transaction:approve', // approve bills / POs / approval-chain steps
  TRANSACTION_REVERSE:'transaction:reverse', // reverse / void / delete posted entries
  REPORT_VIEW:        'report:view',         // view reports & records (baseline read)
  REPORT_MANAGE:      'report:manage',       // report-builder templates, scheduled reports
  AUDIT_MANAGE:       'audit:manage',        // internal-audit workspace (6C)
  SOD_MANAGE:         'sod:manage',          // SoD rule matrix (6B)
},

// role -> permissions. '*' means all permissions.
ROLE_PERMISSIONS: {
  owner:      ['*'],
  accountant: ['transaction:create','transaction:reverse','report:view','report:manage'],
  approver:   ['transaction:approve','report:view'],
  viewer:     ['report:view'],
},
```

A member's effective permissions = union of their roles' permission sets (owner's `*` = all).

## Components (files)

**Model** — `models/Membership.model.js`
```
{ businessId (ref Business, required, indexed),
  userId (ref User, required, indexed; null for a not-yet-accepted email invite),
  roles: [String]  // subset of BUSINESS_ROLES, ≥1
  status: 'active' | 'invited' | 'suspended'  (default depends on flow),
  invitedEmail: String,           // lowercased; how an invite is matched on accept
  inviteToken: String,            // random hex, cleared on accept; indexed
  inviteTokenExpiresAt: Date,     // 7 days
  invitedBy (ref User), invitedAt, joinedAt, lastModifiedBy }
```
Indexes: unique `(businessId, userId)` (partial: only where userId != null); `(businessId, status)`; `inviteToken`. Static `hasPermission(membership, perm)` and `permissionsFor(roles)` helpers (or in service).

**Repository** — `repositories/membership.repository.js` (extends BaseRepository): `findByBusinessAndUser(businessId,userId)`, `findOwnedByBusiness(businessId)` (list, populate user name/email), `findByInviteToken(token)`, `findByBusinessAndEmail(businessId,email)`, `countOwners(businessId)`.

**Service** — `services/membership.service.js`:
- `ensureOwnerMembership(businessId, userId)` — idempotent; creates an active `owner` membership if none. Called lazily on `getProfile`/login so existing businesses self-heal (plus a one-off backfill script).
- `listMembers(businessId)`
- `invite(businessId, { email, roles }, actor)` — validate roles; reject if a membership for that email/user already exists; create `invited` membership w/ token; send invite email (best-effort, logged); return membership.
- `acceptInvite(token, user)` — find by token (not expired); attach `userId`, set `active`, clear token, set `joinedAt`. If the accepting user's email ≠ invitedEmail → 403.
- `updateRoles(businessId, targetUserId, roles, actor)` — validate; **guard: cannot remove the last owner** (countOwners check); (6B will insert the SoD check here). Audit-log the change.
- `removeMember(businessId, targetUserId, actor)` — cannot remove the last owner; soft (status `suspended`) or hard delete — **hard delete** the membership row (the user/account is untouched).
- All mutating ops go through `auditService.log` (who changed whose roles).

**Constants/permissions helper** — `utils/permissions.js` (or static on Membership): `permissionsFor(roles)` → flattened set; `can(membership, perm)`.

**Middleware** — `middleware/rbac.middleware.js`:
- `attachMembership` — after `authMiddleware`; loads the active membership for `(req.user.id, req.user.businessId)`; sets `req.membership = { roles, permissions, status }`. If no membership but the user owns the business (legacy), it calls `ensureOwnerMembership` then attaches owner. If suspended → 403. If none and not owner → 403 (no access to this business).
- `requirePermission(perm)` — 403 unless `req.membership` includes `perm` (or `*`).
- `requireRole(...roles)` — 403 unless `req.membership.roles` intersects.

**Controller/routes** — `controllers/team.controller.js`, `routes/v1/team.routes.js`, mount `/team` in `routes/index.js`:
- `GET /team` (list members) — requires `member:manage` to see roles, or any active member to see names (decision: require `member:manage`).
- `POST /team/invite` — `member:manage`.
- `POST /team/accept` — auth only (any logged-in user with the token).
- `PATCH /team/:userId/roles` — `member:manage`.
- `DELETE /team/:userId` — `member:manage`.
- Joi validation in `validations/team.validation.js`.

**Backfill** — `scripts/backfillOwnerMemberships.js`: for every `(businessId)` with users, ensure each `User.businessId` owner has an `owner` membership. Idempotent; dry-run default, `--apply`. Also called lazily via `ensureOwnerMembership` on profile fetch so it self-heals without the script.

**Enforcement rollout (6A scope — high-sensitivity only):** apply guards to:
- all `/team/*` mutations → `member:manage`
- bill approve / PO approve / approval-step routes → `transaction:approve`
- business settings update, fiscal-year, accounts-config routes → `settings:manage`
- transaction/invoice/bill delete + reverse/void routes → `transaction:reverse`
- report-builder template + scheduled-report routes → `report:manage`
Everything else stays open to any active member this phase (read baseline). `attachMembership` is added to the global authenticated pipeline so `req.membership` is always available.

**Frontend** (vousfin-frontend-main):
- `src/pages/settings/TeamPage.jsx` — list members (name/email/roles/status), invite (email + role multiselect), change roles, remove; plain-language role labels ("Owner", "Accountant — can record", "Approver — can approve", "Viewer — read-only").
- `src/pages/AcceptInvitePage.jsx` (route `/accept-invite?token=`) — accept flow.
- `team.service.js` (api calls); register in `nav.config.js` (Settings area) + `routes.jsx` with `withSuspense()`.
- Hide/disable UI actions the member lacks permission for (client-side convenience; server is the real gate).

## Data flow

login → `authMiddleware` (req.user{id,role,businessId}) → `attachMembership` (req.membership{roles,permissions}) → `requirePermission` guard on protected routes. Invite: owner `POST /team/invite` → Brevo email w/ accept link → invitee `POST /team/accept` → active membership → can log in and operate within their permissions.

## Error handling

- No membership + not owner → `403 "You don't have access to this business."`
- Suspended membership → `403`.
- Missing permission → `403 "You don't have permission to do that."` (plain language).
- Last-owner protection → `409 "A business must have at least one owner."`
- Invite to an existing member → `409`. Expired/invalid token → `400`.
- Email send failure on invite → logged best-effort; the invite still exists (resend possible).

## Testing

- `tests/unit/services/membership.service.test.js`: invite (creates invited + token), acceptInvite (matches token+email→active; wrong email→403; expired→400), updateRoles (validates; last-owner block), removeMember (last-owner block), ensureOwnerMembership (idempotent).
- `tests/unit/middleware/rbac.middleware.test.js`: attachMembership (owner legacy self-heal; suspended→403; none+not-owner→403), requirePermission (allow/deny, owner `*`).
- `tests/unit/utils/permissions.test.js`: permissionsFor union; owner `*`.
- Integration: invite→accept→list; a viewer hitting an approve route → 403.
- Full suite green + `node scripts/ledgerDrift.js` = 0 (no ledger impact — this phase is RBAC only).

## Backward compatibility

- `User.role`/`businessId` untouched; platform-admin (`USER_ROLES.admin`) behavior unchanged.
- Existing businesses keep working: their single user becomes an `owner` member (all permissions) via backfill + lazy self-heal.
- Routes without new guards behave exactly as before.

## Non-goals (this phase)

- SoD conflict enforcement (→ 6B; `updateRoles` leaves a clearly-marked insertion point).
- Internal Audit workspace (→ 6C).
- Full permission enforcement on every route (incremental; only high-sensitivity routes here).
- A user belonging to multiple businesses simultaneously (model supports it via the join table, but UI/active-business switching is out of scope now — keep `User.businessId` as the active business).
- Custom/user-defined roles (fixed role set this phase).
