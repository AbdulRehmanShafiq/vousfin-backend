const express = require('express');
const router = express.Router();
const searchController = require('../../controllers/search.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const adminMiddleware = require('../../middleware/admin.middleware');

// Tier 2 semantic catalog search — any authenticated user.
router.get('/catalog', authMiddleware, searchController.catalogSearch);

// Re-embed the global app catalog — admin only (defense in depth alongside the
// controller). Idempotent; safe to re-run.
router.post('/reindex', authMiddleware, adminMiddleware, searchController.reindexCatalog);

module.exports = router;
