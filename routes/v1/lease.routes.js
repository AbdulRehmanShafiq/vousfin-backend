// routes/v1/lease.routes.js — FR-10.2 IFRS-16 Leases + IAS-36 Impairment
'use strict';
const express = require('express');
const ctrl = require('../../controllers/lease.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const { attachMembership, requirePermission } = require('../../middleware/rbac.middleware');
const validate = require('../../middleware/validate.middleware');
const { createLeaseSchema } = require('../../validations/lease.validation');
const { PERMISSIONS } = require('../../config/constants');

const router = express.Router();
router.use(authMiddleware, requireBusiness, attachMembership, requirePermission(PERMISSIONS.COMPLIANCE_MANAGE));

// Leases
router.post('/',                    validate(createLeaseSchema), ctrl.createLease);
router.get('/',                     ctrl.listLeases);
router.get('/:id',                  ctrl.getLease);
router.get('/:id/schedule',         ctrl.getSchedule);
router.post('/:id/amortize',        ctrl.postAmortization);
router.patch('/:id/terminate',      ctrl.terminateLease);

module.exports = router;
