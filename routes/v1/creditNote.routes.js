// routes/v1/creditNote.routes.js
//
// Phase 2 — REST API for Credit Notes / Debit Notes.
//
const express = require('express');
const router = express.Router();
const cnController = require('../../controllers/creditNote.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');

router.use(authMiddleware, requireBusiness);

// CRUD
router.post('/', cnController.create);
router.get('/',  cnController.list);
router.get('/:id', cnController.getById);

// By invoice
router.get('/invoice/:invoiceId', cnController.listByInvoice);

// Lifecycle
router.post('/:id/approve', cnController.approve);
router.post('/:id/apply',   cnController.apply);
router.post('/:id/cancel',  cnController.cancel);

// Soft delete
router.delete('/:id', cnController.softDelete);

module.exports = router;
