// routes/v1/payment.routes.js — AR/AP Domain Refactor, Milestone M2
const express = require('express');
const router  = express.Router();
const paymentCtrl = require('../../controllers/payment.controller');
const { authMiddleware }  = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const { attachMembership, writeGuard } = require('../../middleware/rbac.middleware');
const { PERMISSIONS } = require('../../config/constants');

router.use(authMiddleware, requireBusiness, attachMembership, writeGuard(PERMISSIONS.TRANSACTION_CREATE));

router.post('/',              paymentCtrl.record);   // record + apply (multi-allocation)
router.post('/auto-allocate', paymentCtrl.autoAllocate); // Phase 2: auto allocation
router.get('/',               paymentCtrl.list);     // list (?direction&partyId&status&startDate&endDate)
router.get('/:id',            paymentCtrl.getById);

module.exports = router;
