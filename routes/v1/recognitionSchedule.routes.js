// routes/v1/recognitionSchedule.routes.js
//
// Phase 4 — Accrual accounting: revenue/expense recognition schedules.
//
const express = require('express');
const router = express.Router();
const controller = require('../../controllers/recognitionSchedule.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const validate = require('../../middleware/validate.middleware');
const { createRecognitionScheduleSchema } = require('../../validations/recognitionSchedule.validation');
const { attachMembership, writeGuard } = require('../../middleware/rbac.middleware');
const { PERMISSIONS } = require('../../config/constants');

router.use(authMiddleware, requireBusiness, attachMembership, writeGuard(PERMISSIONS.TRANSACTION_CREATE));

router.post('/',          validate(createRecognitionScheduleSchema), controller.create);
router.get('/',           controller.list);
router.post('/post-due',  controller.postDue);   // before /:id to avoid collision
router.get('/:id',        controller.getById);
router.post('/:id/cancel', controller.cancel);

module.exports = router;
