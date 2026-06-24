// routes/v1/fixedAsset.routes.js — Fixed Asset Register
'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/fixedAsset.controller');
const validate = require('../../middleware/validate.middleware');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const { attachMembership, writeGuard } = require('../../middleware/rbac.middleware');
const { PERMISSIONS } = require('../../config/constants');
const { createAssetSchema, disposeSchema } = require('../../validations/fixedAsset.validation');

// Reads open to any member; writes (add/depreciate/dispose) need transaction:create.
router.use(authMiddleware, requireBusiness, attachMembership, writeGuard(PERMISSIONS.TRANSACTION_CREATE));

router.post('/', validate(createAssetSchema), ctrl.create);
router.get('/', ctrl.list);
router.get('/:id', ctrl.get);
router.get('/:id/schedule', ctrl.schedule);
router.post('/:id/depreciate', ctrl.depreciate);
router.post('/:id/dispose', validate(disposeSchema), ctrl.dispose);

module.exports = router;
