// routes/v1/invoice.routes.js
//
// Phase 1 — REST API for first-class Invoice domain entity.
//
const express = require('express');
const router = express.Router();
const invoiceController = require('../../controllers/invoice.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const validate = require('../../middleware/validate.middleware'); // M4
const { createInvoiceSchema, updateInvoiceSchema } = require('../../validations/invoice.validation'); // M4
const { attachMembership, requirePermission } = require('../../middleware/rbac.middleware'); // Phase 6A — RBAC
const { PERMISSIONS } = require('../../config/constants');

router.use(authMiddleware, requireBusiness, attachMembership);

// Listing + creation
router.post('/', validate(createInvoiceSchema), invoiceController.createDraft);
router.get('/',  invoiceController.list);

// Detail + timeline + PDF
router.get('/:id',          invoiceController.getById);
router.get('/:id/timeline', invoiceController.getTimeline);
router.get('/:id/pdf',      invoiceController.downloadPdf);

// Phase 2: Update draft
router.put('/:id', validate(updateInvoiceSchema), invoiceController.updateDraft);

// Approval workflow
router.post('/:id/submit',  invoiceController.submitForApproval);
router.post('/:id/approve', requirePermission(PERMISSIONS.TRANSACTION_APPROVE), invoiceController.approve);
router.post('/:id/reject',  invoiceController.reject);

// Lifecycle operations
router.post('/:id/send',       invoiceController.send);
router.post('/:id/cancel',     invoiceController.cancel);
router.post('/:id/void',        requirePermission(PERMISSIONS.TRANSACTION_REVERSE), invoiceController.void); // M5 — GL-correct void
router.post('/:id/credit-memo', invoiceController.applyCreditMemo); // M5 — customer credit memo
router.get('/:id/early-payment-discount',  invoiceController.previewEarlyPaymentDiscount); // M8 — preview
router.post('/:id/early-payment-discount', invoiceController.applyEarlyPaymentDiscount);   // M8 — realize
router.post('/:id/reassign-approval', invoiceController.reassignApproval); // M6
router.post('/:id/escalate-approval', invoiceController.escalateApproval); // M6
router.post('/:id/dispute',    invoiceController.dispute);
router.post('/:id/write-off',  requirePermission(PERMISSIONS.TRANSACTION_REVERSE), invoiceController.writeOff);
router.post('/:id/transition', invoiceController.transitionState);

// Soft delete
router.delete('/:id', requirePermission(PERMISSIONS.TRANSACTION_REVERSE), invoiceController.softDelete);

module.exports = router;
