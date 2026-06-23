// routes/v1/goodsReceipt.routes.js
//
// Phase 3.1 — REST API for Goods Receipt Note (GRN) domain.
//
const express = require('express');
const router = express.Router();
const grnController = require('../../controllers/goodsReceipt.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const { attachMembership, domainWriteGuard } = require('../../middleware/rbac.middleware');
const { PERMISSIONS } = require('../../config/constants');

router.use(authMiddleware, requireBusiness, attachMembership, domainWriteGuard({ create: PERMISSIONS.TRANSACTION_CREATE, reverse: PERMISSIONS.TRANSACTION_REVERSE }));

// Listing + creation
router.post('/', grnController.createDraft);
router.get('/',  grnController.list);

// Detail
router.get('/:id', grnController.getById);

// Workflow transitions
router.post('/:id/confirm',    grnController.confirm);
router.post('/:id/reconcile',  grnController.reconcile);
router.post('/:id/cancel',     grnController.cancel);

// Soft delete
router.delete('/:id', grnController.softDelete);

module.exports = router;
