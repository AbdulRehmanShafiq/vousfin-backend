// routes/v1/internalAudit.routes.js — Phase 6C (Internal Audit)
'use strict';
const express = require('express');
const ctrl  = require('../../controllers/internalAudit.controller');
const { authMiddleware }   = require('../../middleware/auth.middleware');
const { requireBusiness }  = require('../../middleware/business.middleware');
const { attachMembership, requirePermission } = require('../../middleware/rbac.middleware');
const validate = require('../../middleware/validate.middleware');
const {
  createPlanSchema, raiseFindingSchema, recordResponseSchema, planStatusSchema,
} = require('../../validations/internalAudit.validation');
const { PERMISSIONS } = require('../../config/constants');

const router = express.Router();
router.use(authMiddleware, requireBusiness, attachMembership, requirePermission(PERMISSIONS.AUDIT_MANAGE));

router.post('/plans',              validate(createPlanSchema), ctrl.createPlan);
router.get('/plans',               ctrl.listPlans);
router.get('/plans/:id',           ctrl.getPlan);
router.patch('/plans/:id/status',  validate(planStatusSchema), ctrl.updatePlanStatus);
router.get('/plans/:id/sample',    ctrl.drawSample);

router.post('/findings',           validate(raiseFindingSchema), ctrl.raiseFinding);
router.get('/findings',            ctrl.listFindings);
router.patch('/findings/:id',      validate(recordResponseSchema), ctrl.recordResponse);

router.get('/aging',               ctrl.aging);

module.exports = router;
