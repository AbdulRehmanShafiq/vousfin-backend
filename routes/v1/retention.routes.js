// routes/v1/retention.routes.js — FR-10.4 Document Retention
'use strict';
const express = require('express');
const ctrl = require('../../controllers/retention.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const { attachMembership, requirePermission } = require('../../middleware/rbac.middleware');
const { PERMISSIONS } = require('../../config/constants');

const router = express.Router();
router.use(authMiddleware, requireBusiness, attachMembership, requirePermission(PERMISSIONS.COMPLIANCE_MANAGE));

router.get('/policies',  ctrl.listPolicies);
router.post('/policies', ctrl.setPolicies);

module.exports = router;
