// routes/v1/payroll.routes.js — FR-08
'use strict';
const express = require('express');
const ctrl = require('../../controllers/payroll.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const validate = require('../../middleware/validate.middleware');
const {
  createEmployeeSchema, updateEmployeeSchema, processRunSchema, payRunSchema,
} = require('../../validations/payroll.validation');
const { attachMembership, domainWriteGuard } = require('../../middleware/rbac.middleware');
const { PERMISSIONS } = require('../../config/constants');

const router = express.Router();
router.use(authMiddleware);
router.use(requireBusiness);
router.use(attachMembership, domainWriteGuard({ create: PERMISSIONS.TRANSACTION_CREATE, reverse: PERMISSIONS.TRANSACTION_REVERSE }));

router.get('/employees', ctrl.listEmployees);
router.post('/employees', validate(createEmployeeSchema), ctrl.createEmployee);
router.patch('/employees/:id', validate(updateEmployeeSchema), ctrl.updateEmployee);

router.get('/runs', ctrl.listRuns);
router.post('/runs', validate(processRunSchema), ctrl.processRun);
router.get('/runs/:id', ctrl.getRun);
router.post('/runs/:id/post', ctrl.postRun);
router.post('/runs/:id/pay', validate(payRunSchema), ctrl.payRun);
router.post('/runs/:id/reverse', ctrl.reverseRun);
router.get('/runs/:id/payslips', ctrl.payslips);
router.get('/runs/:id/bank-file', ctrl.bankFile);

router.get('/certificates/:employeeId/:taxYear', ctrl.certificate);
router.get('/certificates/:employeeId/:taxYear/pdf', ctrl.certificatePdf);

module.exports = router;
