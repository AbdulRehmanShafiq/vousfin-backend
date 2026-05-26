// services/inventory.service.js
const inventoryItemRepository = require('../repositories/inventoryItem.repository');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');

class InventoryService {
  async createItem(businessId, data) {
    if (!businessId) throw new ApiError(400, 'Business ID is required');
    if (!data.name?.trim()) throw new ApiError(400, 'Item name is required');
    if (typeof data.unitCostPrice !== 'number' || data.unitCostPrice < 0) {
      throw new ApiError(400, 'Unit cost price must be a non-negative number');
    }
    // Duplicate SKU guard
    if (data.sku?.trim()) {
      const existing = await inventoryItemRepository.findBySku(businessId, data.sku.trim());
      if (existing) throw new ApiError(409, `SKU "${data.sku.trim()}" already exists`);
    }
    const item = await inventoryItemRepository.create({ businessId, ...data });
    logger.info(`Inventory item created: ${item._id} (${item.name}) for business ${businessId}`);
    return item;
  }

  async updateItem(businessId, itemId, data) {
    const item = await inventoryItemRepository.findByBusinessAndId(businessId, itemId);
    if (!item) throw new ApiError(404, 'Inventory item not found');
    if (data.sku?.trim() && data.sku !== item.sku) {
      const existing = await inventoryItemRepository.findBySku(businessId, data.sku.trim());
      if (existing && existing._id.toString() !== itemId) {
        throw new ApiError(409, `SKU "${data.sku.trim()}" already exists`);
      }
    }
    const updated = await inventoryItemRepository.update(itemId, data);
    return updated;
  }

  async getItemById(businessId, itemId) {
    const item = await inventoryItemRepository.findByBusinessAndId(businessId, itemId);
    if (!item) throw new ApiError(404, 'Inventory item not found');
    return item;
  }

  async listItems(businessId, filters = {}, pagination = {}) {
    if (!businessId) throw new ApiError(400, 'Business ID is required');
    return inventoryItemRepository.findByBusiness(businessId, filters, pagination);
  }

  /**
   * Add stock to an item (weighted-average cost update).
   * Called when recording an Inventory Purchase.
   * @returns {Promise<Object>} Updated item
   */
  async addStock(businessId, itemId, qty, costPerUnit) {
    const item = await inventoryItemRepository.model.findOne({
      _id: itemId, businessId,
    });
    if (!item) throw new ApiError(404, 'Inventory item not found');
    await item.addStock(qty, costPerUnit);
    logger.info(`Stock added: ${qty} units of "${item.name}" (new stock: ${item.currentStock})`);
    return item;
  }

  /**
   * Reduce stock and return COGS amount.
   * Called by transaction.service when recording an Inventory Sale.
   * @returns {{ cogsAmount: number, unitCostUsed: number, updatedStock: number }}
   */
  async reduceStock(businessId, itemId, qty) {
    const item = await inventoryItemRepository.model.findOne({
      _id: itemId, businessId,
    });
    if (!item) throw new ApiError(404, 'Inventory item not found');
    const { cogsAmount, unitCostUsed } = await item.reduceStock(qty);
    logger.info(`Stock reduced: ${qty} units of "${item.name}" → COGS ${cogsAmount}, remaining ${item.currentStock}`);
    return { cogsAmount, unitCostUsed, updatedStock: item.currentStock, itemName: item.name };
  }

  async getLowStockAlerts(businessId) {
    return inventoryItemRepository.getLowStockItems(businessId);
  }

  async getInventoryValuation(businessId) {
    const { data: items } = await inventoryItemRepository.findByBusiness(
      businessId, { isActive: true }, { limit: 1000 }
    );
    const totalValue = items.reduce((sum, i) => sum + (i.currentStock * i.unitCostPrice), 0);
    const lowStockCount = items.filter(i => i.currentStock <= i.reorderLevel).length;
    return {
      itemCount: items.length,
      totalValue: Math.round(totalValue * 100) / 100,
      lowStockCount,
      items: items.map(i => ({
        _id: i._id,
        name: i.name,
        sku: i.sku,
        currentStock: i.currentStock,
        unitCostPrice: i.unitCostPrice,
        totalValue: Math.round(i.currentStock * i.unitCostPrice * 100) / 100,
        reorderLevel: i.reorderLevel,
        isLowStock: i.currentStock <= i.reorderLevel,
      })),
    };
  }

  async toggleActive(businessId, itemId) {
    const item = await inventoryItemRepository.findByBusinessAndId(businessId, itemId);
    if (!item) throw new ApiError(404, 'Inventory item not found');
    return inventoryItemRepository.update(itemId, { isActive: !item.isActive });
  }
}

module.exports = new InventoryService();
