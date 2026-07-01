// routes/v1/autonomy.routes.js — Autonomy Phase 0 (control plane + inbox)
'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/autonomy.controller');
const { authMiddleware }  = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');

router.use(authMiddleware, requireBusiness);

// Control plane — the autonomy dials + the Autonomy Report
router.get('/policy',                 ctrl.getPolicy);
router.put('/policy/:capability',     ctrl.setCapability);   // { level?, confidenceThreshold?, maxAutoAmount? }
router.get('/report',                 ctrl.getReport);       // accuracy + dial recommendations

// The one inbox + activity
router.get('/inbox',                  ctrl.getInbox);        // ?capability=
router.post('/scan',                  ctrl.scan);            // agents look for work → inbox
router.post('/payments/hold',         ctrl.setPaymentHold);  // { vendorId, hold } — per-vendor payment hold
router.get('/close/status',           ctrl.getCloseStatus);  // month-end checklist (the plan view)
router.get('/close/readiness',        ctrl.getCloseReadiness); // Phase 3 — weighted close-readiness score
router.get('/stp-scorecard',          ctrl.getStpScorecard);   // Phase 3 — automation-depth rates (?days=)
router.get('/plans',                  ctrl.getPlans);        // routines on offer + latest run
router.post('/plans/:key/run',        ctrl.runPlan);         // run a routine (weekly_cash | monthly_close)
router.post('/control',               ctrl.control);         // { text } — plain-language control line
router.get('/actions',                ctrl.getActions);
router.post('/actions/:id/approve',   ctrl.approve);
router.post('/actions/:id/reject',    ctrl.reject);
router.post('/actions/:id/reverse',   ctrl.reverse);   // undo an executed action

module.exports = router;
