// routes/v1/bookkeeping.routes.js — Autonomy Phase 2 (Bookkeeper agent)
'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/bookkeeper.controller');
const { authMiddleware }  = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');

router.use(authMiddleware, requireBusiness);

router.post('/ingest',    ctrl.ingest);        // { rawText, source? } → proposed journal entry
router.get('/documents',  ctrl.listDocuments); // recent intake + outcomes

module.exports = router;
