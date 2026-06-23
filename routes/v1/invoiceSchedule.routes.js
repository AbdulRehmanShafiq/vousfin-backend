// routes/v1/invoiceSchedule.routes.js — AR/AP M8 (recurring invoices)
'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/invoiceSchedule.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { attachMembership, writeGuard } = require('../../middleware/rbac.middleware');
const { PERMISSIONS } = require('../../config/constants');

router.use(authMiddleware, attachMembership, writeGuard(PERMISSIONS.TRANSACTION_CREATE));

router.post('/',                ctrl.create);
router.get('/',                 ctrl.list);
router.post('/trigger',         ctrl.triggerGenerate);
router.get('/:id',              ctrl.getById);
router.patch('/:id',            ctrl.update);
router.patch('/:id/deactivate', ctrl.deactivate);

module.exports = router;
