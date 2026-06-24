// routes/v1/impairment.routes.js — FR-10.2 IAS-36 Impairment
'use strict';
const express = require('express');
const ctrl = require('../../controllers/lease.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const { attachMembership, requirePermission } = require('../../middleware/rbac.middleware');
const validate = require('../../middleware/validate.middleware');
const { createImpairmentSchema } = require('../../validations/lease.validation');
const { PERMISSIONS } = require('../../config/constants');

const router = express.Router();
router.use(authMiddleware, requireBusiness, attachMembership, requirePermission(PERMISSIONS.COMPLIANCE_MANAGE));

router.post('/',             validate(createImpairmentSchema), ctrl.createAssessment);
router.get('/',              ctrl.listAssessments);
router.post('/:id/post',     ctrl.postImpairmentLoss);
router.get('/indicators',    ctrl.getIndicators);

module.exports = router;
