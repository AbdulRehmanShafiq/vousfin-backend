// routes/v1/expenseAllocation.routes.js — Phase 3.3
'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/expenseAllocation.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { attachMembership, writeGuard } = require('../../middleware/rbac.middleware');
const { PERMISSIONS } = require('../../config/constants');

router.use(authMiddleware, attachMembership, writeGuard(PERMISSIONS.TRANSACTION_CREATE));

router.get('/aging',              ctrl.getAgingReport);
router.post('/bills/:billId',     ctrl.create);
router.get('/bills/:billId',      ctrl.getByBill);
router.delete('/bills/:billId',   ctrl.delete);

module.exports = router;
