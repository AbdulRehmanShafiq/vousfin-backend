// routes/v1/bill.routes.js
//
// Phase 1 — REST API for first-class Bill domain entity.
//
const express = require('express');
const router = express.Router();
const billController = require('../../controllers/bill.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const validate = require('../../middleware/validate.middleware'); // M4
const { createBillSchema, updateBillSchema } = require('../../validations/bill.validation'); // M4
const { attachMembership, requirePermission, requirePermissionWhen, domainWriteGuard } = require('../../middleware/rbac.middleware'); // Phase 6A — RBAC
const { PERMISSIONS } = require('../../config/constants');

router.use(authMiddleware, requireBusiness, attachMembership, domainWriteGuard({ create: PERMISSIONS.TRANSACTION_CREATE, approve: PERMISSIONS.TRANSACTION_APPROVE, reverse: PERMISSIONS.TRANSACTION_REVERSE }));

// Listing + creation
router.post('/', validate(createBillSchema), billController.createDraft);
router.get('/',  billController.list);

// Detail + timeline + PDF
router.get('/:id',          billController.getById);
router.get('/:id/timeline', billController.getTimeline);
router.get('/:id/pdf',      billController.downloadPdf);

// Phase 2: Update draft
router.put('/:id', validate(updateBillSchema), billController.updateDraft);

// Approval workflow
router.post('/:id/submit',  billController.submitForApproval);
// Approving a clean bill needs transaction:approve. Forcing a BLOCKED 3-way
// match through (override:true) additionally needs match:override (SoD).
router.post('/:id/approve',
  requirePermission(PERMISSIONS.TRANSACTION_APPROVE),
  requirePermissionWhen((req) => req.body?.override === true, PERMISSIONS.MATCH_OVERRIDE),
  billController.approve);
router.post('/:id/reject',  billController.reject);

// Lifecycle
router.post('/:id/schedule',   billController.schedule);
router.post('/:id/cancel',     billController.cancel);
router.post('/:id/void',        requirePermission(PERMISSIONS.TRANSACTION_REVERSE), billController.void); // M5 — GL-correct void
router.post('/:id/credit-memo', billController.applyCreditMemo); // M5 — vendor credit memo
router.get('/:id/early-payment-discount',  billController.previewEarlyPaymentDiscount); // M8 — preview
router.post('/:id/early-payment-discount', billController.applyEarlyPaymentDiscount);   // M8 — realize
router.post('/:id/reassign-approval', billController.reassignApproval); // M6
router.post('/:id/escalate-approval', billController.escalateApproval); // M6
router.post('/:id/transition', billController.transitionState);

// Soft delete
router.delete('/:id', requirePermission(PERMISSIONS.TRANSACTION_REVERSE), billController.softDelete);

// Phase 3.2 — 3-way match on demand
router.post('/:id/match', billController.runMatch);

module.exports = router;
