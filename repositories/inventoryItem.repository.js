// repositories/inventoryItem.repository.js
const BaseRepository = require('./base.repository');
const InventoryItem = require('../models/InventoryItem.model');
const { sanitizeAndValidateId } = require('../utils/sanitize.helper');
const logger = require('../config/logger');

class InventoryItemRepository extends BaseRepository {
  constructor() {
    super(InventoryItem);
  }

  async findByBusiness(businessId, filters = {}, pagination = {}) {
    const validBusinessId = sanitizeAndValidateId(businessId);
    const { page = 1, limit = 50, sortBy = 'name', sortOrder = 1 } = pagination;
    const skip = (page - 1) * limit;

    const query = { businessId: validBusinessId };
    if (filters.isActive !== undefined) query.isActive = filters.isActive;
    if (filters.search) {
      const escaped = filters.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { sku:  { $regex: escaped, $options: 'i' } },
      ];
    }
    if (filters.lowStock) {
      query.$expr = { $lte: ['$currentStock', '$reorderLevel'] };
    }

    const sortOptions = { [sortBy]: sortOrder };
    const [data, total] = await Promise.all([
      this.model.find(query).sort(sortOptions).skip(skip).limit(limit).lean(),
      this.model.countDocuments(query),
    ]);
    return { data, total, page, limit };
  }

  async findByBusinessAndId(businessId, itemId) {
    return this.findOne({
      _id:        sanitizeAndValidateId(itemId),
      businessId: sanitizeAndValidateId(businessId),
    });
  }

  async findBySku(businessId, sku) {
    return this.findOne({
      businessId: sanitizeAndValidateId(businessId),
      sku: sku.trim(),
    });
  }

  async getLowStockItems(businessId) {
    return InventoryItem.getLowStockItems(sanitizeAndValidateId(businessId));
  }
}

module.exports = new InventoryItemRepository();
