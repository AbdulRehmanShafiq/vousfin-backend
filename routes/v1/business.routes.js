const express = require('express');
const router = express.Router();
const businessController = require('../../controllers/business.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const validate = require('../../middleware/validate.middleware');
const {
  createBusinessSchema,
  updateBusinessSchema,
  confirmActionSchema,
  addCustomAccountSchema,
  updateAccountSchema,
  listAccountsQuerySchema,
} = require('../../validations/business.validation');
const { attachMembership, requirePermission } = require('../../middleware/rbac.middleware'); // Phase 6A — RBAC
const { PERMISSIONS } = require('../../config/constants');
const SETTINGS = [attachMembership, requirePermission(PERMISSIONS.SETTINGS_MANAGE)];

// All business routes require authentication
router.use(authMiddleware);

// Business profile routes (no business required for creation)
router.post('/', validate(createBusinessSchema), businessController.createBusiness);
router.get('/', businessController.getBusiness);
router.put('/', SETTINGS, validate(updateBusinessSchema), businessController.updateBusiness);

// Destructive maintenance routes (require typed business-name confirmation)
router.post('/reset', SETTINGS, validate(confirmActionSchema), businessController.resetBusinessData);
router.delete('/', SETTINGS, validate(confirmActionSchema), businessController.deleteBusiness);

// Chart of accounts routes (business must exist)
router.get('/accounts', validate(listAccountsQuerySchema, 'query'), businessController.getAccounts);
// Sync route MUST be defined before /:accountId to avoid path conflict
router.post('/accounts/sync', businessController.syncAccounts);
router.post('/accounts', SETTINGS, validate(addCustomAccountSchema), businessController.addCustomAccount);
router.put('/accounts/:accountId', SETTINGS, validate(updateAccountSchema), businessController.updateAccount);

module.exports = router;