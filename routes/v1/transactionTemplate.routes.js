// routes/v1/transactionTemplate.routes.js
const express = require('express');
const router = express.Router();
const controller = require('../../controllers/transactionTemplate.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const validate = require('../../middleware/validate.middleware');
const {
  createTemplateSchema, updateTemplateSchema, applyTemplateSchema, templateIdParamSchema,
} = require('../../validations/transactionTemplate.validation');
const { attachMembership, writeGuard } = require('../../middleware/rbac.middleware');
const { PERMISSIONS } = require('../../config/constants');

router.use(authMiddleware, requireBusiness, attachMembership, writeGuard(PERMISSIONS.TRANSACTION_CREATE));

router.get('/', controller.list);
router.post('/', validate(createTemplateSchema), controller.create);
router.post('/run-due', controller.runDue);          // manual trigger for the recurring cron
router.get('/:id', validate(templateIdParamSchema, 'params'), controller.getById);
router.put('/:id', validate(templateIdParamSchema, 'params'), validate(updateTemplateSchema), controller.update);
router.delete('/:id', validate(templateIdParamSchema, 'params'), controller.remove);
router.post('/:id/apply', validate(templateIdParamSchema, 'params'), validate(applyTemplateSchema), controller.apply);

module.exports = router;
