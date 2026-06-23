// routes/v1/purchaseOrder.routes.js
//
// Phase 3.1 — REST API for Purchase Order domain.
//
const express = require('express');
const router = express.Router();
const poController = require('../../controllers/purchaseOrder.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const { attachMembership, requirePermission, domainWriteGuard } = require('../../middleware/rbac.middleware'); // Phase 6A — RBAC
const { PERMISSIONS } = require('../../config/constants');

router.use(authMiddleware, requireBusiness, attachMembership, domainWriteGuard({ create: PERMISSIONS.TRANSACTION_CREATE, approve: PERMISSIONS.TRANSACTION_APPROVE, reverse: PERMISSIONS.TRANSACTION_REVERSE }));

// Listing + creation
router.post('/', poController.createDraft);
router.get('/',  poController.list);

// Detail + timeline
router.get('/:id',          poController.getById);
router.get('/:id/timeline', poController.getTimeline);

// Update draft
router.put('/:id', poController.updateDraft);

// Approval workflow
router.post('/:id/submit',  poController.submitForApproval);
router.post('/:id/approve', requirePermission(PERMISSIONS.TRANSACTION_APPROVE), poController.approve);
router.post('/:id/reject',  poController.reject);

// Lifecycle
router.post('/:id/cancel', poController.cancel);
router.post('/:id/close',  poController.close);

// 3-Way Match
router.post('/:id/three-way-match', poController.runThreeWayMatch);

// Soft delete
router.delete('/:id', poController.softDelete);

module.exports = router;
