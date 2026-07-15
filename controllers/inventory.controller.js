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

// Phase 2 — stock adjustment (increase/decrease/write_off/count/revalue)
exports.adjustStock = async (req, res, next) => {
  try {
    const inventoryAdjustmentService = require('../services/inventoryAdjustment.service');
    const result = await inventoryAdjustmentService.adjustStock(
      req.user.businessId, req.params.id, req.body, req.user
    );
    ApiResponse.success(res, result, result?.noChange ? 'No change needed' : 'Stock adjusted');
  } catch (e) { next(e); }
};

// Phase 1 — inventory ↔ sub-ledger integrity report (drift must read 0)
exports.getIntegrityReport = async (req, res, next) => {
  try {
    const report = await inventoryService.getIntegrityReport(req.user.businessId);
    ApiResponse.success(res, report, 'Inventory integrity report');
  } catch (e) { next(e); }
};

// ── Phase 4 — landed costs ───────────────────────────────────────────────────
exports.applyLandedCost = async (req, res, next) => {
  try {
    const landedCostService = require('../services/landedCost.service');
    const r = await landedCostService.apply(req.user.businessId, req.body, req.user);
    ApiResponse.success(res, r, 'Shipping and import costs added to stock');
  } catch (e) { next(e); }
};

// ── Phase 5 — warehouses + transfers ─────────────────────────────────────────
const warehouseService = require('../services/warehouse.service');

exports.createWarehouse = async (req, res, next) => {
  try {
    const wh = await warehouseService.create(req.user.businessId, req.body, req.user);
    ApiResponse.created(res, wh, 'Location added');
  } catch (e) { next(e); }
};
exports.listWarehouses = async (req, res, next) => {
  try {
    const rows = await warehouseService.list(req.user.businessId, { includeInactive: req.query.includeInactive === 'true' });
    ApiResponse.success(res, rows, 'Locations retrieved');
  } catch (e) { next(e); }
};
exports.updateWarehouse = async (req, res, next) => {
  try {
    const wh = await warehouseService.update(req.user.businessId, req.params.id, req.body);
    ApiResponse.success(res, wh, 'Location updated');
  } catch (e) { next(e); }
};
exports.stockByLocation = async (req, res, next) => {
  try {
    const rows = await warehouseService.stockByLocation(req.user.businessId, req.query.itemId || null);
    ApiResponse.success(res, rows, 'Stock by location');
  } catch (e) { next(e); }
};
exports.transferStock = async (req, res, next) => {
  try {
    const r = await warehouseService.transfer(req.user.businessId, req.body, req.user);
    ApiResponse.success(res, r, 'Stock moved');
  } catch (e) { next(e); }
};

// ── Phase 6 — reservations / available to promise ────────────────────────────
const stockReservationService = require('../services/stockReservation.service');

exports.getAtp = async (req, res, next) => {
  try {
    const r = await stockReservationService.availableToPromise(req.user.businessId, req.params.id);
    ApiResponse.success(res, r, 'Available to promise');
  } catch (e) { next(e); }
};
exports.reserveStock = async (req, res, next) => {
  try {
    const r = await stockReservationService.reserve(req.user.businessId, { ...req.body, itemId: req.params.id }, req.user);
    ApiResponse.success(res, r, r.backordered > 0 ? 'Set aside what we had — the rest is on backorder' : 'Stock set aside');
  } catch (e) { next(e); }
};
exports.releaseReservation = async (req, res, next) => {
  try {
    const r = await stockReservationService.release(req.user.businessId, req.body, req.user);
    ApiResponse.success(res, r, 'Reservation released');
  } catch (e) { next(e); }
};
exports.getBackorders = async (req, res, next) => {
  try {
    const r = await stockReservationService.fillableBackorders(req.user.businessId);
    ApiResponse.success(res, r, 'Backorders you can now fill');
  } catch (e) { next(e); }
};

// ── Phase 7 — lots ───────────────────────────────────────────────────────────
exports.getLots = async (req, res, next) => {
  try {
    const stockMovementService = require('../services/stockMovement.service');
    const rows = await stockMovementService.lotBalances(req.user.businessId, req.params.id);
    ApiResponse.success(res, rows, 'Batches in stock');
  } catch (e) { next(e); }
};

// ── Phase 9 — recipes + builds ───────────────────────────────────────────────
const assemblyService = require('../services/assembly.service');

exports.createBom = async (req, res, next) => {
  try {
    const bom = await assemblyService.createBom(req.user.businessId, req.body, req.user);
    ApiResponse.created(res, bom, 'Recipe saved');
  } catch (e) { next(e); }
};
exports.listBoms = async (req, res, next) => {
  try {
    const rows = await assemblyService.listBoms(req.user.businessId, { itemId: req.query.itemId || null });
    ApiResponse.success(res, rows, 'Recipes retrieved');
  } catch (e) { next(e); }
};
exports.quoteBuild = async (req, res, next) => {
  try {
    const r = await assemblyService.quoteBuild(req.user.businessId, req.params.id, req.query.runs || 1);
    ApiResponse.success(res, r, 'Build preview');
  } catch (e) { next(e); }
};
exports.build = async (req, res, next) => {
  try {
    const r = await assemblyService.build(req.user.businessId, { ...req.body, bomId: req.params.id }, req.user);
    ApiResponse.success(res, r, 'Built and added to stock');
  } catch (e) { next(e); }
};

// ── Phase 10 — reports (all derived from the stock sub-ledger) ───────────────
const inventoryReportsService = require('../services/inventoryReports.service');

exports.reportValuation = async (req, res, next) => {
  try {
    const r = await inventoryReportsService.valuationAsOf(req.user.businessId, req.query.asOf || new Date());
    ApiResponse.success(res, r, 'Stock valuation');
  } catch (e) { next(e); }
};
exports.reportTurnover = async (req, res, next) => {
  try {
    const r = await inventoryReportsService.turnover(req.user.businessId, req.query);
    ApiResponse.success(res, r, 'Stock turnover');
  } catch (e) { next(e); }
};
exports.reportAging = async (req, res, next) => {
  try {
    const r = await inventoryReportsService.aging(req.user.businessId, {});
    ApiResponse.success(res, r, 'Stock aging');
  } catch (e) { next(e); }
};
exports.reportMargin = async (req, res, next) => {
  try {
    const r = await inventoryReportsService.marginByItem(req.user.businessId, req.query);
    ApiResponse.success(res, r, 'Margin by item');
  } catch (e) { next(e); }
};
exports.reportSlowMovers = async (req, res, next) => {
  try {
    const r = await inventoryReportsService.slowMovers(req.user.businessId, { days: req.query.days || 90 });
    ApiResponse.success(res, r, 'Slow-moving stock');
  } catch (e) { next(e); }
};
exports.reportExpiring = async (req, res, next) => {
  try {
    const r = await inventoryReportsService.expiringLots(req.user.businessId, { days: req.query.days || 60 });
    ApiResponse.success(res, r, 'Batches expiring soon');
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
    const { qty, costPerUnit, paymentMode, sourceAccountId, vendorId, notes, transactionDate } = req.body;
    if (!qty || qty <= 0) return next({ status: 400, message: 'qty must be positive' });
    const result = await inventoryService.addStock(
      req.user.businessId, req.params.id,
      Number(qty), Number(costPerUnit || 0),
      {
        paymentMode,
        sourceAccountId,
        vendorId,
        notes,
        transactionDate,
        userId:    req.user.id,
        ipAddress: req.ip,
      }
    );
    ApiResponse.success(res, result, `Added ${qty} units to stock`);
  } catch (e) { next(e); }
};

exports.getStockLedger = async (req, res, next) => {
  try {
    const ledger = await inventoryService.getStockLedger(req.user.businessId, req.params.id);
    ApiResponse.success(res, ledger, 'Stock ledger retrieved');
  } catch (e) { next(e); }
};

// R-04 — recompute an item's weighted-average cost by replaying its movements.
// ?post=true (or body.post) also heals the item + posts a valuation adjustment.
exports.recalculate = async (req, res, next) => {
  try {
    const recalcService = require('../services/inventoryRecalc.service');
    const post = req.query.post === 'true' || req.body?.post === true;
    const report = await recalcService.recalculateItem(req.user.businessId, req.params.id, {
      post,
      user: { _id: req.user.id },
    });
    ApiResponse.success(res, report, report.inSync
      ? 'Inventory valuation is in sync'
      : report.applied
        ? 'Inventory valuation recalculated and corrected'
        : 'Inventory valuation drift detected (preview)');
  } catch (e) { next(e); }
};
