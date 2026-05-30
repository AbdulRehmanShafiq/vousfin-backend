// routes/v1/forecastRegistry.routes.js — Forecast Platform F3
'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/forecastRegistry.controller');
const { authMiddleware }  = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');

router.use(authMiddleware, requireBusiness);

router.get('/runs',          ctrl.listRuns);
router.get('/models',        ctrl.listModels);
router.get('/accuracy',      ctrl.accuracySummary);
router.get('/ensemble',      ctrl.ensemble);
router.post('/backtest',     ctrl.backtest);
router.post('/accuracy/run', ctrl.runAccuracy);

module.exports = router;
