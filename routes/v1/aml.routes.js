// routes/v1/aml.routes.js — FR-10.3 AML/KYC Screening
'use strict';
const express = require('express');
const ctrl = require('../../controllers/aml.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const { attachMembership, requirePermission } = require('../../middleware/rbac.middleware');
const { PERMISSIONS } = require('../../config/constants');

const router = express.Router();
router.use(authMiddleware, requireBusiness, attachMembership, requirePermission(PERMISSIONS.COMPLIANCE_MANAGE));

router.get('/',                ctrl.list);
router.get('/:id/str-draft',   ctrl.draftSTR);
router.patch('/:id/justify',   ctrl.addJustification);

module.exports = router;
