// controllers/inventory.controller.js
const inventoryService = require('../services/inventory.service');
const ApiResponse = require('../utils/ApiResponse');

exports.createItem = async (req, res, next) => {
  try {
    const item = await inventoryService.createItem(req.user.businessId, req.body);
    ApiResponse.created(res, item, 'Inventory item created');
  } catch (e) { next(e); }
};

exports.listItems = async (req, res, next) => {
  try {
    const filters = {
      search:   req.query.search,
      isActive: req.query.isActive !== undefined ? req.query.isActive === 'true' : undefined,
      lowStock: req.query.lowStock === 'true',
    };
    const pagination = {
      page:      parseInt(req.query.page, 10)      || 1,
      limit:     parseInt(req.query.limit, 10)     || 50,
      sortBy:    req.query.sortBy                  || 'name',
      sortOrder: parseInt(req.query.sortOrder, 10) || 1,
    };
    const result = await inventoryService.listItems(req.user.businessId, filters, pagination);
    ApiResponse.success(res, result, 'Inventory items retrieved');
  } catch (e) { next(e); }
};

exports.getItemById = async (req, res, next) => {
  try {
    const item = await inventoryService.getItemById(req.user.businessId, req.params.id);
    ApiResponse.success(res, item, 'Inventory item retrieved');
  } catch (e) { next(e); }
};

exports.updateItem = async (req, res, next) => {
  try {
    const item = await inventoryService.updateItem(req.user.businessId, req.params.id, req.body);
    ApiResponse.success(res, item, 'Inventory item updated');
  } catch (e) { next(e); }
};

exports.toggleActive = async (req, res, next) => {
  try {
    const item = await inventoryService.toggleActive(req.user.businessId, req.params.id);
    ApiResponse.success(res, item, 'Inventory item status updated');
  } catch (e) { next(e); }
};

exports.getLowStockAlerts = async (req, res, next) => {
  try {
    const items = await inventoryService.getLowStockAlerts(req.user.businessId);
    ApiResponse.success(res, items, 'Low stock alerts retrieved');
  } catch (e) { next(e); }
};

exports.getInventoryValuation = async (req, res, next) => {
  try {
    const valuation = await inventoryService.getInventoryValuation(req.user.businessId);
    ApiResponse.success(res, valuation, 'Inventory valuation retrieved');
  } catch (e) { next(e); }
};

exports.addStock = async (req, res, next) => {
  try {
    const { qty, costPerUnit } = req.body;
    if (!qty || qty <= 0) return next({ status: 400, message: 'qty must be positive' });
    const item = await inventoryService.addStock(
      req.user.businessId, req.params.id,
      Number(qty), Number(costPerUnit || 0)
    );
    ApiResponse.success(res, item, `Added ${qty} units to stock`);
  } catch (e) { next(e); }
};
