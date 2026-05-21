const express = require('express');
const router = express.Router();
const adminController = require('../../controllers/admin.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const adminMiddleware = require('../../middleware/admin.middleware');
const validate = require('../../middleware/validate.middleware');
const {
  listCustomersQuerySchema,
  customerIdParamSchema,
  suspendCustomerBodySchema,
} = require('../../validations/admin.validation');

// All admin routes require auth + admin role
router.use(authMiddleware, adminMiddleware);

router.get('/customers', validate(listCustomersQuerySchema, 'query'), adminController.getAllCustomers);
router.get('/customers/:id', validate(customerIdParamSchema, 'params'), adminController.getCustomerById);
router.put('/customers/:id/suspend', validate(customerIdParamSchema, 'params'), validate(suspendCustomerBodySchema), adminController.suspendCustomer);
router.put('/customers/:id/reinstate', validate(customerIdParamSchema, 'params'), adminController.reinstateCustomer);
router.delete('/customers/:id', validate(customerIdParamSchema, 'params'), adminController.deleteCustomer);
router.get('/stats', adminController.getSystemStats);

module.exports = router;