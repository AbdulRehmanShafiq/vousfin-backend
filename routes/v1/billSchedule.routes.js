// routes/v1/billSchedule.routes.js — Phase 3.3
'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/billSchedule.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { attachMembership, writeGuard } = require('../../middleware/rbac.middleware');
const { PERMISSIONS } = require('../../config/constants');

router.use(authMiddleware, attachMembership, writeGuard(PERMISSIONS.TRANSACTION_CREATE));

router.post('/',                ctrl.create);
router.get('/',                 ctrl.list);
router.get('/reminders',        ctrl.getReminderSummary);
router.post('/trigger',         ctrl.triggerGenerate);
router.get('/:id',              ctrl.getById);
router.patch('/:id',            ctrl.update);
router.patch('/:id/deactivate', ctrl.deactivate);

module.exports = router;
