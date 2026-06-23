// routes/v1/costCenter.routes.js — SRS FR-07.1
const express = require('express');
const ctrl = require('../../controllers/costCenter.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const validate = require('../../middleware/validate.middleware');
const { createCostCenterSchema, updateCostCenterSchema } = require('../../validations/costCenter.validation');
const { attachMembership, writeGuard } = require('../../middleware/rbac.middleware');
const { PERMISSIONS } = require('../../config/constants');

const router = express.Router();
router.use(authMiddleware);
router.use(requireBusiness);
router.use(attachMembership, writeGuard(PERMISSIONS.SETTINGS_MANAGE));

router.get('/tree', ctrl.getTree);

router
  .route('/')
  .post(validate(createCostCenterSchema), ctrl.createCostCenter)
  .get(ctrl.listCostCenters);

router
  .route('/:id')
  .get(ctrl.getCostCenter)
  .put(validate(updateCostCenterSchema), ctrl.updateCostCenter)
  .delete(ctrl.deleteCostCenter);

module.exports = router;
