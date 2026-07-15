// routes/v1/inventory.routes.js
const express = require('express');
const inventoryController = require('../../controllers/inventory.controller');
// These operations are repeatable ON PURPOSE, so retry-safety can only come from
// a caller-supplied key — see middleware/idempotency.middleware.js.
const { idempotencyKey } = require('../../middleware/idempotency.middleware');
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
router.get('/integrity',    inventoryController.getIntegrityReport); // Phase 1 — sub-ledger drift

// ── Phase 4 — landed costs ──────────────────────────────────────────────────
router.post('/landed-cost', inventoryController.applyLandedCost);

// ── Phase 5 — locations + transfers ─────────────────────────────────────────
router.route('/warehouses')
  .post(inventoryController.createWarehouse)
  .get(inventoryController.listWarehouses);
router.put('/warehouses/:id', inventoryController.updateWarehouse);
router.get('/stock-by-location', inventoryController.stockByLocation);
router.post('/transfer',   inventoryController.transferStock);

// ── Phase 6 — reservations / backorders ─────────────────────────────────────
router.post('/reservations/release', inventoryController.releaseReservation);
router.get('/backorders',  inventoryController.getBackorders);

// ── Phase 9 — recipes + builds ──────────────────────────────────────────────
router.route('/boms')
  .post(inventoryController.createBom)
  .get(inventoryController.listBoms);
router.get('/boms/:id/quote', inventoryController.quoteBuild);
router.post('/boms/:id/build', idempotencyKey, inventoryController.build);

// ── Phase 10 — reports (derived from the stock sub-ledger) ──────────────────
router.get('/reports/valuation',    inventoryController.reportValuation);
router.get('/reports/turnover',     inventoryController.reportTurnover);
router.get('/reports/aging',        inventoryController.reportAging);
router.get('/reports/margin',       inventoryController.reportMargin);
router.get('/reports/slow-movers',  inventoryController.reportSlowMovers);
router.get('/reports/expiring',     inventoryController.reportExpiring);

router.route('/:id')
  .get(inventoryController.getItemById)
  .put(inventoryController.updateItem);

router.patch('/:id/toggle-active', inventoryController.toggleActive);
router.post('/:id/add-stock',      inventoryController.addStock);
router.post('/:id/adjust',         idempotencyKey, inventoryController.adjustStock); // Phase 2 — adjustments/counts/NRV
router.get('/:id/ledger',          inventoryController.getStockLedger);
router.post('/:id/recalculate',    inventoryController.recalculate); // R-04 — replay & heal WAC
router.get('/:id/atp',             inventoryController.getAtp);      // Phase 6 — available to promise
router.post('/:id/reserve',        inventoryController.reserveStock);
router.get('/:id/lots',            inventoryController.getLots);     // Phase 7 — batches in stock

module.exports = router;
