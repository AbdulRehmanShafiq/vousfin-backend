// routes/v1/inventory.routes.js
const express = require('express');
const inventoryController = require('../../controllers/inventory.controller');
const { authMiddleware } = require('../../middleware/auth.middleware');
const { requireBusiness } = require('../../middleware/business.middleware');

const router = express.Router();
router.use(authMiddleware);
router.use(requireBusiness);

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

module.exports = router;
