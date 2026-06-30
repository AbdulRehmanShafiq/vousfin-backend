const express = require('express');
const router = express.Router();
const searchController = require('../../controllers/search.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const adminMiddleware = require('../../middleware/admin.middleware');

// Tier 2 semantic catalog search — any authenticated user.
router.get('/catalog', authMiddleware, searchController.catalogSearch);

// Tier 3 grounded "how do I…" answer over the help corpus.
router.post('/howto', authMiddleware, searchController.howToSearch);

// Analytics: log an event (any user, fire-and-forget) + insights (admin only).
router.post('/log', authMiddleware, searchController.logSearch);
router.get('/insights', authMiddleware, adminMiddleware, searchController.searchInsights);

// Re-embed the global app catalog — admin only (defense in depth alongside the
// controller). Idempotent; safe to re-run.
router.post('/reindex', authMiddleware, adminMiddleware, searchController.reindexCatalog);

module.exports = router;
