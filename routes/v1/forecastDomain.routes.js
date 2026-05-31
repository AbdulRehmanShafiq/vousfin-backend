// routes/v1/forecastDomain.routes.js — Forecast Platform F6
'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/forecastDomain.controller');
const { authMiddleware }  = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');

router.use(authMiddleware, requireBusiness);

router.get('/',         ctrl.list);
router.get('/:domain',  ctrl.forecast);   // ?horizon=

module.exports = router;
