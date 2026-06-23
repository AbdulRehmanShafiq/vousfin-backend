// routes/v1/team.routes.js — Phase 6A
'use strict';
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

// Accept does not require an existing business membership — a brand-new invitee may not yet have one.
router.post('/accept', validate(acceptSchema), ctrl.accept);

// Everything else is business-scoped.
router.use(requireBusiness, attachMembership);
// Any active member can read their own access (used by the UI to gate actions).
router.get('/me', ctrl.me);
router.get('/', requirePermission(PERMISSIONS.MEMBER_MANAGE), ctrl.list);
router.post('/invite', requirePermission(PERMISSIONS.MEMBER_MANAGE), validate(inviteSchema), ctrl.invite);
router.patch('/:userId/roles', requirePermission(PERMISSIONS.MEMBER_MANAGE), validate(updateRolesSchema), ctrl.updateRoles);
router.delete('/:userId', requirePermission(PERMISSIONS.MEMBER_MANAGE), ctrl.remove);

module.exports = router;
