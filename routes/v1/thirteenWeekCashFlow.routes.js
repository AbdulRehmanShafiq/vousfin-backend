// routes/v1/thirteenWeekCashFlow.routes.js — Phase 8 FR-06.3
'use strict';
const express = require('express');
const ctrl = require('../../controllers/thirteenWeekCashFlow.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const { attachMembership, requirePermission } = require('../../middleware/rbac.middleware');
const { PERMISSIONS } = require('../../config/constants');

const router = express.Router();
router.use(authMiddleware, requireBusiness, attachMembership, requirePermission(PERMISSIONS.REPORT_VIEW));

router.get('/', ctrl.getForecast);
router.get('/alerts', ctrl.getAlerts);

module.exports = router;
