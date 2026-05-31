// routes/v1/forecastPlatform.routes.js — Forecast Platform Foundation (F1)
'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/forecastPlatform.controller');
const { authMiddleware }  = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');

router.use(authMiddleware, requireBusiness);

router.get('/sources',               ctrl.listSources);
router.post('/datasets/build',       ctrl.buildDataset);
router.get('/datasets',              ctrl.listRegistry);
router.post('/features/materialize', ctrl.materialize);
router.get('/features',              ctrl.listFeatures);
router.get('/feature-catalog',       ctrl.featureCatalog);   // FE framework
router.post('/features/engineer',    ctrl.engineerFeatures); // FE framework

module.exports = router;
