// routes/v1/customer.routes.js
const express = require('express');
const customerController = require('../../controllers/customer.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const validate = require('../../middleware/validate.middleware');
const {
  createCustomerSchema,
  updateCustomerSchema,
  customerIdParamSchema,
  customerFiltersSchema,
} = require('../../validations/customer.validation');

const router = express.Router();

// Apply auth and business middleware to all routes
router.use(authMiddleware);
router.use(requireBusiness);

router
  .route('/')
  .post(validate(createCustomerSchema), customerController.createCustomer)
  .get(validate(customerFiltersSchema, 'query'), customerController.listCustomers);

router
  .route('/:id')
  .get(validate(customerIdParamSchema, 'params'), customerController.getCustomerById)
  .put(
    validate(customerIdParamSchema, 'params'),
    validate(updateCustomerSchema),
    customerController.updateCustomer
  );

router.get(
  '/:id/balance',
  validate(customerIdParamSchema, 'params'),
  customerController.getCustomerBalance
);

router.get(
  '/:id/transactions',
  validate(customerIdParamSchema, 'params'),
  customerController.getCustomerTransactions
);

router.patch(
  '/:id/toggle-active',
  validate(customerIdParamSchema, 'params'),
  customerController.toggleActive
);

module.exports = router;
