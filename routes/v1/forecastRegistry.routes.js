// routes/v1/forecastRegistry.routes.js — Forecast Platform F3
'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/forecastRegistry.controller');
const { authMiddleware }  = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const forecastMeter = require('../../middleware/forecastMeter.middleware'); // F9 usage metering

router.use(authMiddleware, requireBusiness, forecastMeter);

router.get('/runs',          ctrl.listRuns);
router.get('/models',        ctrl.listModels);
router.get('/accuracy',      ctrl.accuracySummary);
router.get('/accuracy-score', ctrl.accuracyScore);  // A1 — measured accuracy% + confidence
router.get('/governance/dashboard', ctrl.governanceDashboard); // F9
router.post('/governance/rollback', ctrl.rollback);            // F9
router.get('/usage',         ctrl.usage);                      // F9
router.get('/ensemble',      ctrl.ensemble);
router.get('/hierarchical',  ctrl.hierarchical);  // B1 — by-stream + reconciliation
router.get('/drift',         ctrl.drift);         // F5
router.get('/champion',      ctrl.champion);      // F5
router.get('/explain',       ctrl.explain);       // F7
router.get('/infra',         ctrl.infra);         // F8
router.post('/backtest',     ctrl.backtest);
router.post('/retrain',      ctrl.retrain);       // F5
router.post('/scenario',     ctrl.scenario);      // F7
router.post('/accuracy/run', ctrl.runAccuracy);

module.exports = router;
