const express = require('express');
const router = express.Router();
const businessController = require('../../controllers/business.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const validate = require('../../middleware/validate.middleware');
const {
  createBusinessSchema,
  updateBusinessSchema,
  addCustomAccountSchema,
  updateAccountSchema,
  listAccountsQuerySchema,
} = require('../../validations/business.validation');

// All business routes require authentication
router.use(authMiddleware);

// Business profile routes (no business required for creation)
router.post('/', validate(createBusinessSchema), businessController.createBusiness);
router.get('/', businessController.getBusiness);
router.put('/', validate(updateBusinessSchema), businessController.updateBusiness);

// Chart of accounts routes (business must exist)
router.get('/accounts', validate(listAccountsQuerySchema, 'query'), businessController.getAccounts);
router.post('/accounts', validate(addCustomAccountSchema), businessController.addCustomAccount);
router.put('/accounts/:accountId', validate(updateAccountSchema), businessController.updateAccount);

module.exports = router;