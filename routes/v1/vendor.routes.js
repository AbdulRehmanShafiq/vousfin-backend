// routes/v1/vendor.routes.js
const express = require('express');
const vendorController = require('../../controllers/vendor.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const validate = require('../../middleware/validate.middleware');
const {
  createVendorSchema,
  updateVendorSchema,
  vendorIdParamSchema,
  vendorFiltersSchema,
} = require('../../validations/vendor.validation');

const { attachMembership, writeGuard } = require('../../middleware/rbac.middleware');
const { PERMISSIONS } = require('../../config/constants');

const router = express.Router();

// Apply auth and business middleware to all routes
router.use(authMiddleware);
router.use(requireBusiness);
router.use(attachMembership, writeGuard(PERMISSIONS.TRANSACTION_CREATE));

router
  .route('/')
  .post(validate(createVendorSchema), vendorController.createVendor)
  .get(validate(vendorFiltersSchema, 'query'), vendorController.listVendors);

router
  .route('/:id')
  .get(validate(vendorIdParamSchema, 'params'), vendorController.getVendorById)
  .put(
    validate(vendorIdParamSchema, 'params'),
    validate(updateVendorSchema),
    vendorController.updateVendor
  );

router.get(
  '/:id/balance',
  validate(vendorIdParamSchema, 'params'),
  vendorController.getVendorBalance
);

router.get(
  '/:id/transactions',
  validate(vendorIdParamSchema, 'params'),
  vendorController.getVendorTransactions
);

router.patch(
  '/:id/toggle-active',
  validate(vendorIdParamSchema, 'params'),
  vendorController.toggleActive
);

router.get(
  '/:id/stats',
  validate(vendorIdParamSchema, 'params'),
  vendorController.getVendorStats
);

router.get(
  '/:id/statement',
  validate(vendorIdParamSchema, 'params'),
  vendorController.getVendorStatement
);

module.exports = router;
