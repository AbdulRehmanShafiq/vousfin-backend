// routes/v1/aiDecision.routes.js — AI Decision Ledger (Intelligence Roadmap Phase 0)
'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/aiDecision.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const { attachMembership, requirePermission } = require('../../middleware/rbac.middleware');
const { PERMISSIONS } = require('../../config/constants');

router.use(authMiddleware, requireBusiness, attachMembership, requirePermission(PERMISSIONS.AI_REVIEW));

router.get('/',    ctrl.list);
router.get('/:id', ctrl.getById);

module.exports = router;
