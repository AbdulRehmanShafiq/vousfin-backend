// routes/v1/budget.routes.js — FR-04.1 / FR-04.2
'use strict';
const express = require('express');
const ctrl = require('../../controllers/budget.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const validate = require('../../middleware/validate.middleware');
const { createBudgetSchema, updateBudgetSchema, seedSchema, approvalNoteSchema } = require('../../validations/budget.validation');

const router = express.Router();
router.use(authMiddleware);
router.use(requireBusiness);

router.get('/', ctrl.list);
router.post('/', validate(createBudgetSchema), ctrl.create);
router.post('/seed', validate(seedSchema), ctrl.seed);
router.get('/:id', ctrl.getOne);
router.put('/:id', validate(updateBudgetSchema), ctrl.update);
router.post('/:id/submit', ctrl.submit);
router.post('/:id/approve', validate(approvalNoteSchema), ctrl.approve);
router.post('/:id/reject', validate(approvalNoteSchema), ctrl.reject);
router.post('/:id/clone', ctrl.clone);
router.get('/:id/variance', ctrl.variance);

module.exports = router;
