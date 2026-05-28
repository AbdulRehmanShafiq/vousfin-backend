// routes/v1/vendorCredit.routes.js
//
// Phase 3.1 — REST API for Vendor Credit domain.
//
const express = require('express');
const router = express.Router();
const vcController = require('../../controllers/vendorCredit.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');

router.use(authMiddleware, requireBusiness);

// Available credits query (used by Bill editor sidebar)
router.get('/available', vcController.getAvailableCredits);

// Listing + creation
router.post('/', vcController.create);
router.get('/',  vcController.list);

// Detail
router.get('/:id', vcController.getById);

// Workflow
router.post('/:id/apply',  vcController.applyToBill);
router.post('/:id/cancel', vcController.cancel);

// Soft delete
router.delete('/:id', vcController.softDelete);

module.exports = router;
