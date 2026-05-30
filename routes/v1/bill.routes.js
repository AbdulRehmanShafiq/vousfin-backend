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

router.use(authMiddleware, requireBusiness);

// Listing + creation
router.post('/', validate(createBillSchema), billController.createDraft);
router.get('/',  billController.list);

// Detail + timeline
router.get('/:id',          billController.getById);
router.get('/:id/timeline', billController.getTimeline);

// Phase 2: Update draft
router.put('/:id', validate(updateBillSchema), billController.updateDraft);

// Approval workflow
router.post('/:id/submit',  billController.submitForApproval);
router.post('/:id/approve', billController.approve);
router.post('/:id/reject',  billController.reject);

// Lifecycle
router.post('/:id/schedule',   billController.schedule);
router.post('/:id/cancel',     billController.cancel);
router.post('/:id/void',        billController.void);            // M5 — GL-correct void
router.post('/:id/credit-memo', billController.applyCreditMemo); // M5 — vendor credit memo
router.post('/:id/reassign-approval', billController.reassignApproval); // M6
router.post('/:id/escalate-approval', billController.escalateApproval); // M6
router.post('/:id/transition', billController.transitionState);

// Soft delete
router.delete('/:id', billController.softDelete);

// Phase 3.2 — 3-way match on demand
router.post('/:id/match', billController.runMatch);

module.exports = router;
