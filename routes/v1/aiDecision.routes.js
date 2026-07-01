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

router.get('/',            ctrl.list);
router.get('/stats',       ctrl.stats);          // Phase 1 — calibration (before /:id)
router.get('/:id',         ctrl.getById);
router.get('/:id/explain', ctrl.explain);        // Phase 2 — grounded "why"
router.post('/:id/outcome', ctrl.setOutcome);    // Phase 2 — accept/correct/reverse

module.exports = router;
