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
router.get('/actions',                ctrl.getActions);
router.post('/actions/:id/approve',   ctrl.approve);
router.post('/actions/:id/reject',    ctrl.reject);

module.exports = router;
