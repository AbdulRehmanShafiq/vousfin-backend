// routes/v1/inventory.routes.js
const express = require('express');
const inventoryController = require('../../controllers/inventory.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');
const { attachMembership, writeGuard } = require('../../middleware/rbac.middleware');
const { PERMISSIONS } = require('../../config/constants');

const router = express.Router();
router.use(authMiddleware);
router.use(requireBusiness);
router.use(attachMembership, writeGuard(PERMISSIONS.TRANSACTION_CREATE));

router.route('/')
  .post(inventoryController.createItem)
  .get(inventoryController.listItems);

router.get('/low-stock',    inventoryController.getLowStockAlerts);
router.get('/valuation',    inventoryController.getInventoryValuation);

router.route('/:id')
  .get(inventoryController.getItemById)
  .put(inventoryController.updateItem);

router.patch('/:id/toggle-active', inventoryController.toggleActive);
router.post('/:id/add-stock',      inventoryController.addStock);
router.get('/:id/ledger',          inventoryController.getStockLedger);
router.post('/:id/recalculate',    inventoryController.recalculate); // R-04 — replay & heal WAC

module.exports = router;
