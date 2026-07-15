// services/inventory.service.js
const inventoryItemRepository = require('../repositories/inventoryItem.repository');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const { businessEvents, EVENTS } = require('./businessEventEngine.service'); // ERP refactor Step 3

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
   *
   * Optionally posts an Inventory Purchase journal entry so the books reflect
   * how the stock was funded (cash, bank, payables, loan, etc.).
   *
   * @param {string} businessId
   * @param {string} itemId
   * @param {number} qty
   * @param {number} costPerUnit
   * @param {Object} [opts]
   * @param {string} [opts.paymentMode]      'cash' | 'bank' | 'credit' (AP) | 'loan'
   * @param {string} [opts.sourceAccountId]  Cash/Bank/Loan account to credit (required for cash/bank/loan)
   * @param {string} [opts.vendorId]         Vendor for AP posting (required for credit mode)
   * @param {string} [opts.userId]           Acting user id (for journal createdBy)
   * @param {string} [opts.ipAddress]
   * @param {Date}   [opts.transactionDate]  defaults to now
   * @param {string} [opts.notes]
   * @returns {Promise<{ item: Object, journalEntry: Object | null }>}
   */
  async addStock(businessId, itemId, qty, costPerUnit, opts = {}) {
    const item = await inventoryItemRepository.model.findOne({ _id: itemId, businessId });
    if (!item) throw new ApiError(404, 'Inventory item not found');

    let journalEntry = null;

    // ── Post an Inventory Purchase journal entry if paymentMode is provided ──
    if (opts.paymentMode) {
      const ChartOfAccount = require('../models/ChartOfAccount.model');
      const { TRANSACTION_TYPES, TRANSACTION_MODES, INPUT_METHODS } = require('../config/constants');

      // Resolve the Inventory account (debit side)
      const inventoryAcct = await ChartOfAccount.findOne({
        businessId,
        accountName: { $regex: /^inventory$/i },
      }).lean();
      if (!inventoryAcct) {
        throw new ApiError(400, 'Inventory account missing from chart of accounts — cannot post journal entry');
      }

      // Resolve the credit-side account based on paymentMode
      let creditAccountId = opts.sourceAccountId;
      let transactionMode = TRANSACTION_MODES.CASH;
      let vendorId = null;

      if (opts.paymentMode === 'credit') {
        // AP — credit the Accounts Payable account, set vendor reference
        const apAcct = await ChartOfAccount.findOne({
          businessId,
          accountName: { $regex: /accounts payable/i },
        }).lean();
        if (!apAcct) throw new ApiError(400, 'Accounts Payable account not found');
        creditAccountId = apAcct._id;
        transactionMode = TRANSACTION_MODES.CREDIT;
        vendorId = opts.vendorId || item.preferredVendorId || null;
        if (!vendorId) throw new ApiError(400, 'vendorId required for credit purchase');
      } else if (!creditAccountId) {
        throw new ApiError(400, `sourceAccountId required for paymentMode="${opts.paymentMode}"`);
      }

      const totalCost = Math.round(qty * costPerUnit * 100) / 100;
      const transactionService = require('./transaction.service');

      const jeData = {
        businessId,
        transactionDate: opts.transactionDate || new Date(),
        description: `Stock purchase: ${qty} ${item.unit || 'units'} of ${item.name}`,
        transactionType: TRANSACTION_TYPES.INVENTORY_PURCHASE,
        amount: totalCost,
        debitAccountId: inventoryAcct._id,
        creditAccountId,
        transactionMode,
        vendorId,
        inventoryItemId: item._id,
        inventoryQty: qty,
        inputMethod: INPUT_METHODS.FORM,
        notes: opts.notes || null,
        // ERP refactor Step 3: this service owns the physical stock increment
        // (via applyPurchaseStock below). Tell transaction.service NOT to mirror
        // the stock change again, otherwise the purchase would be counted twice.
        skipInventorySync: true,
      };

      // transaction.service handles auditing, AR/AP balance tracking, etc.
      // It expects (data, userId, ipAddress)
      journalEntry = await transactionService.createTransaction(
        jeData,
        opts.userId || null,
        opts.ipAddress || null
      );
    }

    // Single source of truth for the physical stock increment + event emission.
    const { item: updatedItem } = await this.applyPurchaseStock(
      businessId, itemId, qty, costPerUnit, { userId: opts.userId, vendorId: opts.vendorId }
    );
    return { item: updatedItem, journalEntry };
  }

  /**
   * Apply a purchase-side stock increment WITHOUT posting any journal entry.
   *
   * This is the single, journal-free entry point that physically increases
   * stock (weighted-average cost) and broadcasts inventory events. The funding
   * journal (Inventory ⇄ Cash/Bank/AP) is always owned by the caller — either
   * `addStock` (UI flow) or `transaction.service.createTransaction` (generic
   * transaction flow). Keeping the increment journal-free guarantees we never
   * touch double-entry balancing here.
   *
   * @param {string} businessId
   * @param {string} itemId
   * @param {number} qty            units received (> 0)
   * @param {number} costPerUnit    landed unit cost; falls back to item.unitCostPrice
   * @param {Object} [opts]
   * @param {string} [opts.userId]
   * @param {string} [opts.vendorId]
   * @returns {Promise<{ item: Object }>}
   */
  /**
   * Resolve the COGS and Inventory control accounts for a business — the same
   * pair transaction.service uses when posting a sale's COGS. Centralized here
   * (ERP Step 5) so the procurement/invoice document flows recognize COGS
   * against the identical accounts without duplicating the lookup. (Rule 8)
   *
   * @returns {Promise<{ cogsAccountId: (ObjectId|null), inventoryAccountId: (ObjectId|null) }>}
   */
  async resolveCostAccounts(businessId) {
    const ChartOfAccount = require('../models/ChartOfAccount.model');
    // INV-5 — resolve by the canonical DEFAULT_ACCOUNTS codes first (stable under
    // renames), falling back to the legacy name/subtype heuristics for custom COAs.
    const byCode = (code) => ChartOfAccount.findOne({ businessId, accountCode: code }).lean();
    let [cogsAcct, inventoryAcct] = await Promise.all([byCode('5110'), byCode('1150')]);
    if (!cogsAcct) {
      cogsAcct = await ChartOfAccount.findOne({
        businessId,
        $or: [
          { accountName: { $regex: /cost of goods/i } },
          { accountSubtype: 'Direct Cost' },
        ],
      }).lean();
    }
    if (!inventoryAcct) {
      inventoryAcct = await ChartOfAccount.findOne({
        businessId,
        accountName: { $regex: /^inventory$/i },
      }).lean();
    }
    return {
      cogsAccountId:      cogsAcct ? cogsAcct._id : null,
      inventoryAccountId: inventoryAcct ? inventoryAcct._id : null,
    };
  }

  async applyPurchaseStock(businessId, itemId, qty, costPerUnit, opts = {}) {
    if (!businessId) throw new ApiError(400, 'Business ID is required');
    if (!(Number(qty) > 0)) throw new ApiError(400, 'Quantity must be a positive number');

    const item = await inventoryItemRepository.model.findOne({ _id: itemId, businessId }).session(opts.session || null);
    if (!item) throw new ApiError(404, 'Inventory item not found');

    const valuationBefore = Math.round(item.currentStock * item.unitCostPrice * 100) / 100;
    const cost = Number(costPerUnit) > 0 ? Number(costPerUnit) : item.unitCostPrice;

    // Phase 7 — a lot-tracked item may not take stock in anonymously, or its
    // traceability is broken from the first receipt.
    if (item.trackLots && !opts.lot?.code) {
      throw new ApiError(400, `"${item.name}" is tracked by batch — record which batch or lot number this stock belongs to.`);
    }

    // Phase 8 — under standard costing, stock enters at the STANDARD and the
    // difference vs. what was paid is a purchase price variance the caller
    // posts. Quote it here so item, movement and journal all agree.
    const { quoteReceipt } = require('../utils/inventoryCosting.util');
    const receipt = quoteReceipt(item, qty, cost);

    await item.addStock(qty, cost, opts.session || null);
    logger.info(`Stock added: ${qty} units of "${item.name}" (new stock: ${item.currentStock})`);

    const valuationAfter = Math.round(item.currentStock * item.unitCostPrice * 100) / 100;

    // Phase 1 — sub-ledger entry in the SAME session as the item mutation.
    const stockMovementService = require('./stockMovement.service');
    await stockMovementService.record({
      businessId, itemId: item._id, direction: 'in',
      movementType: opts.movementType || 'purchase',
      qty: Number(qty), unitCost: receipt.unitCostIn, value: receipt.valueIn,
      balanceQtyAfter: item.currentStock, balanceValueAfter: valuationAfter,
      warehouseId: opts.warehouseId || item.defaultWarehouseId || null,
      source: opts.source || null, journalEntryId: opts.journalEntryId || null,
      reason: opts.reason || null,
      warehouseId: opts.warehouseId || null, lot: opts.lot || null,
      createdBy: opts.userId || null, notes: opts.notes || null,
    }, { session: opts.session || null });

    // Fire-and-forget — inventory events must never block (or break) the purchase.
    businessEvents.emit(EVENTS.INVENTORY_RECEIVED, {
      businessId, userId: opts.userId || null,
      entityType: 'inventory_item', entityId: item._id,
      itemName: item.name, sku: item.sku,
      qty: Number(qty), costPerUnit: cost,
      newStock: item.currentStock, vendorId: opts.vendorId || item.preferredVendorId || null,
    });
    businessEvents.emit(EVENTS.INVENTORY_VALUATION_CHANGED, {
      businessId, userId: opts.userId || null,
      entityType: 'inventory_item', entityId: item._id,
      itemName: item.name, valuationBefore, valuationAfter,
      delta: Math.round((valuationAfter - valuationBefore) * 100) / 100,
    });

    // `variance` is non-zero only for standard-cost items (Phase 8) — the
    // caller owns posting it to Purchase Price Variance (5115).
    return { item, variance: receipt.variance };
  }

  /**
   * Reduce stock and return COGS amount.
   * Called by transaction.service when recording an Inventory Sale.
   *
   * Side effect: if stock crosses the reorder threshold AFTER this reduction,
   * fire an automated reorder email to the item's preferredVendorId.
   *
   * @returns {{ cogsAmount: number, unitCostUsed: number, updatedStock: number }}
   */
  async reduceStock(businessId, itemId, qty, session = null, opts = {}) {
    const item = await inventoryItemRepository.model.findOne({ _id: itemId, businessId }).session(session);
    if (!item) throw new ApiError(404, 'Inventory item not found');

    const stockBefore = item.currentStock;
    const valuationBefore = Math.round(stockBefore * item.unitCostPrice * 100) / 100;
    const { cogsAmount, unitCostUsed } = await item.reduceStock(qty, session);
    logger.info(`Stock reduced: ${qty} units of "${item.name}" → COGS ${cogsAmount}, remaining ${item.currentStock}`);

    const valuationAfter = Math.round(item.currentStock * item.unitCostPrice * 100) / 100;

    // Phase 1 — sub-ledger entry in the SAME session; value = the exact COGS.
    const stockMovementService = require('./stockMovement.service');
    await stockMovementService.record({
      businessId, itemId: item._id, direction: 'out',
      movementType: opts.movementType || 'sale',
      qty: Number(qty), unitCost: unitCostUsed, value: cogsAmount,
      balanceQtyAfter: item.currentStock, balanceValueAfter: valuationAfter,
      source: opts.source || null, journalEntryId: opts.journalEntryId || null,
      reason: opts.reason || null,
      warehouseId: opts.warehouseId || null, lot: opts.lot || null,
      createdBy: opts.userId || null, notes: opts.notes || null,
    }, { session });

    // ERP refactor Step 3 — broadcast the stock reduction + valuation change.
    // Fire-and-forget: inventory events must never block (or break) the sale.
    businessEvents.emit(EVENTS.INVENTORY_REDUCED, {
      businessId, entityType: 'inventory_item', entityId: item._id,
      itemName: item.name, sku: item.sku,
      qty: Number(qty), cogsAmount, unitCostUsed,
      newStock: item.currentStock,
    });
    businessEvents.emit(EVENTS.INVENTORY_VALUATION_CHANGED, {
      businessId, entityType: 'inventory_item', entityId: item._id,
      itemName: item.name, valuationBefore, valuationAfter,
      delta: Math.round((valuationAfter - valuationBefore) * 100) / 100,
    });

    // Reorder trigger: only fire when we just crossed the threshold (not on every sale)
    const justCrossed = stockBefore > item.reorderLevel && item.currentStock <= item.reorderLevel;
    if (justCrossed && item.reorderLevel > 0) {
      // Broadcast the low-stock event for any subscriber (dashboard, forecasting…).
      businessEvents.emit(EVENTS.LOW_STOCK_REACHED, {
        businessId, entityType: 'inventory_item', entityId: item._id,
        itemName: item.name, sku: item.sku,
        currentStock: item.currentStock, reorderLevel: item.reorderLevel,
        reorderQty: item.reorderQty, vendorId: item.preferredVendorId || null,
      });
      // Fire-and-forget — never block the sale on email
      this._fireReorderEmail(item, businessId).catch(err =>
        logger.error(`[reorder] Hook failed: ${err.message}`)
      );
    }

    return { cogsAmount, unitCostUsed, updatedStock: item.currentStock, itemName: item.name };
  }

  /**
   * INV-3 — reverse a RECEIPT (GRN cancel, receipt correction) at the ORIGINAL
   * receipt cost, not at current WAC / oldest FIFO layers like a sale would.
   *
   * The GL reversal restores exactly qty × receiptUnitCost, so the physical
   * removal must take the same value out of the subledger or item valuation
   * drifts from the Inventory account:
   *   - FIFO: remove the received batch's layers (newest-first, cost-matched).
   *   - WAC:  subtract qty × receiptUnitCost from total value and recompute WAC.
   *
   * No journal is posted here — the caller owns the GL reversal (mirror of
   * applyPurchaseStock's contract).
   *
   * @param {string} businessId
   * @param {string} itemId
   * @param {number} qty              units to remove (> 0)
   * @param {number} receiptUnitCost  the cost the receipt was booked at
   * @param {Object} [opts]           { session, userId }
   * @returns {Promise<{ item: Object, removedValue: number }>}
   */
  async applyReceiptReversal(businessId, itemId, qty, receiptUnitCost, opts = {}) {
    if (!businessId) throw new ApiError(400, 'Business ID is required');
    if (!(Number(qty) > 0)) throw new ApiError(400, 'Quantity must be a positive number');

    const item = await inventoryItemRepository.model.findOne({ _id: itemId, businessId }).session(opts.session || null);
    if (!item) throw new ApiError(404, 'Inventory item not found');
    if (Number(qty) > item.currentStock) {
      throw new ApiError(400, `Cannot reverse ${qty} ${item.unit || 'units'} of "${item.name}" — only ${item.currentStock} in stock (some may already be sold)`);
    }

    const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
    const cost = Number(receiptUnitCost) > 0 ? Number(receiptUnitCost) : item.unitCostPrice;
    const valuationBefore = r2(item.currentStock * item.unitCostPrice);
    const newQty = r2(item.currentStock - Number(qty));
    let removedValue;

    if (item.valuationMethod === 'fifo') {
      const { removeReceiptLayers } = require('../utils/inventoryCosting.util');
      const seeded = (item.costLayers && item.costLayers.length)
        ? item.costLayers
        : (item.currentStock > 0 ? [{ qty: item.currentStock, unitCost: item.unitCostPrice }] : []);
      const res = removeReceiptLayers(seeded, Number(qty), cost);
      item.costLayers = res.remainingLayers;
      removedValue = res.removedValue;
      const remVal = res.remainingLayers.reduce((s, l) => s + l.qty * l.unitCost, 0);
      if (newQty > 0) item.unitCostPrice = r2(remVal / newQty);
    } else {
      // WAC: take out exactly the receipt value; remaining value re-averages.
      removedValue = r2(Number(qty) * cost);
      const remVal = Math.max(0, r2(valuationBefore - removedValue));
      if (newQty > 0) item.unitCostPrice = r2(remVal / newQty);
    }

    item.currentStock = newQty;
    await item.save({ session: opts.session || null });
    logger.info(`Receipt reversed: ${qty} units of "${item.name}" @ ${cost} (value ${removedValue}, remaining ${item.currentStock})`);

    const valuationAfter = r2(item.currentStock * item.unitCostPrice);

    // Phase 1 — sub-ledger entry in the SAME session; value = receipt value out.
    const stockMovementService = require('./stockMovement.service');
    await stockMovementService.record({
      businessId, itemId: item._id, direction: 'out',
      movementType: 'receipt_reversal',
      qty: Number(qty), unitCost: cost, value: removedValue,
      balanceQtyAfter: item.currentStock, balanceValueAfter: valuationAfter,
      source: opts.source || null, journalEntryId: opts.journalEntryId || null,
      reason: opts.reason || null,
      warehouseId: opts.warehouseId || null, lot: opts.lot || null,
      createdBy: opts.userId || null, notes: opts.notes || null,
    }, { session: opts.session || null });
    businessEvents.emit(EVENTS.INVENTORY_VALUATION_CHANGED, {
      businessId, userId: opts.userId || null,
      entityType: 'inventory_item', entityId: item._id,
      itemName: item.name, valuationBefore, valuationAfter,
      delta: r2(valuationAfter - valuationBefore),
    });

    return { item, removedValue };
  }

  /**
   * Internal — resolve vendor + business details and dispatch the reorder email.
   * Lazy-requires to avoid circular deps and keep email infra optional.
   */
  async _fireReorderEmail(item, businessId) {
    if (!item.preferredVendorId) {
      logger.info(`[reorder] No preferredVendorId set for "${item.name}" — skipping email`);
      return;
    }
    const Vendor = require('../models/Vendor.model');
    const Business = require('../models/Business.model');
    const { sendReorderRequestEmail } = require('../utils/email.utils');

    const [vendor, business] = await Promise.all([
      Vendor.findById(item.preferredVendorId).lean(),
      Business.findById(businessId).select('businessName email').lean(),
    ]);
    if (!vendor) {
      logger.warn(`[reorder] Vendor ${item.preferredVendorId} not found for item "${item.name}"`);
      return;
    }
    await sendReorderRequestEmail({
      to:            vendor.email,
      vendorName:    vendor.businessName || vendor.fullName,
      itemName:      item.name,
      sku:           item.sku,
      currentStock:  item.currentStock,
      reorderLevel:  item.reorderLevel,
      reorderQty:    item.reorderQty,
      unit:          item.unit,
      businessName:  business?.businessName || 'vousFin Business',
      businessEmail: business?.email,
    });
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

  /**
   * Get stock movement ledger for an item — lists all transactions that
   * reference this inventory item, showing qty-in, qty-out, and running balance.
   *
   * @param {string} businessId
   * @param {string} itemId
   * @returns {Promise<Object>}
   */
  async getStockLedger(businessId, itemId) {
    const item = await inventoryItemRepository.findByBusinessAndId(businessId, itemId);
    if (!item) throw new ApiError(404, 'Inventory item not found');

    // Phase 1 — items with recorded movements read the append-only sub-ledger
    // (exact costs, every movement type). Items whose history predates the
    // sub-ledger fall back to the legacy journal-entry inference below until
    // the backfill script has run.
    const stockMovementService = require('./stockMovement.service');
    const movements = await stockMovementService.getLedger(businessId, itemId, { limit: 1000 });
    if (movements.length > 0) {
      const ordered = [...movements].reverse(); // getLedger returns newest-first
      const lines = ordered.map((m) => ({
        _id:         m._id,
        date:        m.movementDate,
        description: m.notes || (m.source?.docType ? `${m.source.docType}` : m.movementType.replace(/_/g, ' ')),
        type:        m.movementType,
        qtyIn:       m.direction === 'in' ? m.qty : 0,
        qtyOut:      m.direction === 'out' ? m.qty : 0,
        balance:     m.balanceQtyAfter,
        amount:      m.value,
        unitCost:    m.unitCost,
      }));
      return {
        item: {
          _id: item._id, name: item.name, sku: item.sku, barcode: item.barcode,
          category: item.category, currentStock: item.currentStock,
          unitCostPrice: item.unitCostPrice, unit: item.unit,
        },
        lines,
        summary: {
          totalIn:  lines.reduce((s, l) => s + l.qtyIn, 0),
          totalOut: lines.reduce((s, l) => s + l.qtyOut, 0),
          currentStock: item.currentStock,
        },
        ledgerSource: 'stock_movements',
      };
    }

    const JournalEntry = require('../models/JournalEntry.model');
    const mongoose = require('mongoose');
    const { TRANSACTION_TYPES } = require('../config/constants');

    const entries = await JournalEntry.find({
      businessId: new mongoose.Types.ObjectId(String(businessId)),
      inventoryItemId: new mongoose.Types.ObjectId(String(itemId)),
      isArchived: { $ne: true },
    })
      .sort({ transactionDate: 1, createdAt: 1 })
      .select('transactionDate description transactionType inventoryQty amount')
      .lean();

    // ERP refactor Step 3 — any purchase-type entry increases stock; any
    // sale-type entry decreases it. The previous code only matched the two
    // "Inventory *" types and silently under-counted Cash/Credit movements.
    const PURCHASE_TYPES = new Set([
      TRANSACTION_TYPES.INVENTORY_PURCHASE,
      TRANSACTION_TYPES.CASH_PURCHASE,
      TRANSACTION_TYPES.CREDIT_PURCHASE,
    ]);
    const SALE_TYPES = new Set([
      TRANSACTION_TYPES.INVENTORY_SALE,
      TRANSACTION_TYPES.CASH_SALE,
      TRANSACTION_TYPES.CREDIT_SALE,
      TRANSACTION_TYPES.INCOME,
    ]);

    let runningQty = 0;
    const lines = entries.map((tx) => {
      const isIn  = PURCHASE_TYPES.has(tx.transactionType);
      const isOut = SALE_TYPES.has(tx.transactionType);
      const qtyIn  = isIn  ? (tx.inventoryQty || 0) : 0;
      const qtyOut = isOut ? (tx.inventoryQty || 0) : 0;
      runningQty += qtyIn - qtyOut;
      return {
        _id:         tx._id,
        date:        tx.transactionDate,
        description: tx.description,
        type:        tx.transactionType,
        qtyIn,
        qtyOut,
        balance:     runningQty,
        amount:      tx.amount,
      };
    });

    return {
      item: {
        _id:          item._id,
        name:         item.name,
        sku:          item.sku,
        barcode:      item.barcode,
        category:     item.category,
        currentStock: item.currentStock,
        unitCostPrice:item.unitCostPrice,
        unit:         item.unit,
      },
      lines,
      summary: {
        totalIn:   lines.reduce((s, l) => s + l.qtyIn,  0),
        totalOut:  lines.reduce((s, l) => s + l.qtyOut, 0),
        currentStock: item.currentStock,
      },
      ledgerSource: 'journal_inference',
    };
  }

  /**
   * Phase 1 — inventory↔sub-ledger integrity report for the whole business.
   * Thin passthrough so the controller keeps one service dependency.
   */
  async getIntegrityReport(businessId) {
    const stockMovementService = require('./stockMovement.service');
    return stockMovementService.computeDrift(businessId);
  }
}

module.exports = new InventoryService();
