// routes/v1/bookkeeping.routes.js — Autonomy Phase 2 (Bookkeeper agent)
'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/bookkeeper.controller');
const { authMiddleware }  = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');

// Inbound email webhook (token-auth, NO login) — declared BEFORE the auth guard
// so a forwarding service can reach it. The token in the body/query/header
// authenticates and scopes it to exactly one business.
router.post('/email-intake', ctrl.emailWebhook);

router.use(authMiddleware, requireBusiness);

router.post('/ingest',              ctrl.ingest);            // { rawText, source? } → proposed journal entry
router.get('/documents',            ctrl.listDocuments);     // recent intake + outcomes
router.post('/email-intake/enable', ctrl.enableEmailIntake); // owner turns on forward-a-bill; returns token

module.exports = router;
