// routes/v1/benchmarking.routes.js — Phase 8 FR-09.3
'use strict';
const express = require('express');
const ctrl = require('../../controllers/benchmarking.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const { attachMembership, requirePermission } = require('../../middleware/rbac.middleware');
const { PERMISSIONS } = require('../../config/constants');

const router = express.Router();
router.use(authMiddleware, requireBusiness, attachMembership, requirePermission(PERMISSIONS.REPORT_VIEW));

router.get('/', ctrl.getBenchmark);

module.exports = router;
