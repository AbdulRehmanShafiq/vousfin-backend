// routes/v1/advisor.routes.js — Proactive AI CFO (Intelligence Roadmap Phase 4)
'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/advisor.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');

router.use(authMiddleware, requireBusiness);

router.get('/recommendations', ctrl.getRecommendations);

module.exports = router;
