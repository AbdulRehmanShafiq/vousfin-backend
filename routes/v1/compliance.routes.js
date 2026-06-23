// routes/v1/compliance.routes.js — FR-10.1 Compliance Calendar
'use strict';
const express = require('express');
const ctrl = require('../../controllers/compliance.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const { attachMembership, requirePermission } = require('../../middleware/rbac.middleware');
const { PERMISSIONS } = require('../../config/constants');

const router = express.Router();
router.use(authMiddleware, requireBusiness, attachMembership, requirePermission(PERMISSIONS.COMPLIANCE_MANAGE));

router.post('/generate',              ctrl.generate);
router.get('/obligations',            ctrl.list);
router.patch('/obligations/:id/complete', ctrl.complete);
router.patch('/obligations/:id/waive',    ctrl.waive);
router.post('/check-overdue',         ctrl.checkOverdue);
router.get('/upcoming',               ctrl.upcoming);

module.exports = router;
