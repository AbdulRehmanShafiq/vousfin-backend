// routes/v1/aml.routes.js — FR-10.3 AML/KYC Screening
'use strict';
const express = require('express');
const ctrl = require('../../controllers/aml.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const { attachMembership, requirePermission } = require('../../middleware/rbac.middleware');
const validate = require('../../middleware/validate.middleware');
const { amlJustifySchema } = require('../../validations/lease.validation');
const { PERMISSIONS } = require('../../config/constants');

const router = express.Router();
router.use(authMiddleware, requireBusiness, attachMembership, requirePermission(PERMISSIONS.COMPLIANCE_MANAGE));

router.get('/',                ctrl.list);
router.get('/:id/str-draft',   ctrl.draftSTR);
router.patch('/:id/justify',   validate(amlJustifySchema), ctrl.addJustification);

module.exports = router;
