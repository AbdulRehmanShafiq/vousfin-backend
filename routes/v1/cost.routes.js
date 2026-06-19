// routes/v1/cost.routes.js — FR-07
'use strict';
const express = require('express');
const ctrl = require('../../controllers/cost.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const validate = require('../../middleware/validate.middleware');
const { createJobSchema, addCostSchema, breakEvenSchema, whatIfSchema } = require('../../validations/cost.validation');

const router = express.Router();
router.use(authMiddleware);
router.use(requireBusiness);

router.get('/jobs', ctrl.listJobs);
router.post('/jobs', validate(createJobSchema), ctrl.createJob);
router.get('/jobs/:id', ctrl.getJob);
router.post('/jobs/:id/costs', validate(addCostSchema), ctrl.addCost);
router.post('/jobs/:id/complete', ctrl.completeJob);
router.post('/jobs/:id/cancel', ctrl.cancelJob);

router.get('/profitability', ctrl.profitability);
router.post('/break-even', validate(breakEvenSchema), ctrl.breakEven);
router.post('/what-if', validate(whatIfSchema), ctrl.whatIf);
router.get('/break-even/estimate', ctrl.estimate);

module.exports = router;
