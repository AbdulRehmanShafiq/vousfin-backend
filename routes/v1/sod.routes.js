// routes/v1/sod.routes.js — Phase 6B (Segregation of Duties matrix)
'use strict';
const express = require('express');
const ctrl = require('../../controllers/sod.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const { attachMembership, requirePermission } = require('../../middleware/rbac.middleware');
const validate = require('../../middleware/validate.middleware');
const { addRuleSchema } = require('../../validations/sod.validation');
const { PERMISSIONS } = require('../../config/constants');

const router = express.Router();
router.use(authMiddleware, requireBusiness, attachMembership, requirePermission(PERMISSIONS.SOD_MANAGE));

router.get('/rules', ctrl.list);
router.post('/rules', validate(addRuleSchema), ctrl.add);
router.delete('/rules/:id', ctrl.remove);

module.exports = router;
