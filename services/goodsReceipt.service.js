// services/goodsReceipt.service.js
//
// Phase 3.1 — Goods Receipt Note (GRN) domain service.
//
// Manages the physical receiving workflow:
//   createDraft → confirm → (discrepancy_reported → reconciled) / cancelled
//
// On confirm:
//   1. Validates received items reference real PO lines.
//   2. Updates PO.quantityReceived via purchaseOrderService.recordGrnReceipt().
//   3. Flags discrepancies automatically.
//
const mongoose = require('mongoose');
const GoodsReceipt = require('../models/GoodsReceipt.model');
const PurchaseOrder = require('../models/PurchaseOrder.model');
const purchaseOrderService = require('./purchaseOrder.service');
const inventoryService = require('./inventory.service');                       // ERP Step 5 — receive → stock
const { businessEvents, EVENTS } = require('./businessEventEngine.service');   // ERP Step 5 — GOODS_RECEIVED
const auditService = require('./audit.service');
const ledgerPosting = require('./ledgerPosting.service');                      // A13 — GRNI accrual poster
const { withTransaction } = require('../utils/withTransaction');               // A13 — atomic receive + post
const accountRepo = require('../repositories/account.repository');            // A13 — resolve 1150 / 2115
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const {
  GRN_STATES,
  AUDIT_ACTIONS,
  ENTITY_TYPES,
  TRANSACTION_TYPES,
  TRANSACTION_SOURCES,
} = require('../config/constants');

// Fetch a default account by code, back-filling it (additive, idempotent) if a
// business predates it — so the GRNI accrual works on every business out of the box.
async function _ensureAccount(businessId, code) {
  let acc = await accountRepo.findByCode(businessId, code);
  if (!acc) {
    if (typeof accountRepo.syncMissingDefaults === 'function') await accountRepo.syncMissingDefaults(businessId);
    acc = await accountRepo.findByCode(businessId, code);
  }
  return acc;
}

class GoodsReceiptService {
  // Exposed as a method so unit tests can stub it.
  _ensureAccount(businessId, code) {
    return _ensureAccount(businessId, code);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  async _loadOrThrow(id, businessId = null) {
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid GRN id');
    // R-05: tenant scope when provided
    const grn = businessId
      ? await GoodsReceipt.findOne({ _id: id, businessId })
      : await GoodsReceipt.findById(id);
    if (!grn) throw new ApiError(404, 'Goods receipt not found');
    if (grn.isArchived) throw new ApiError(410, 'Goods receipt has been archived');
    return grn;
  }

  _guardTransition(grn, toState) {
    if (!GoodsReceipt.canTransition(grn.state, toState)) {
      throw new ApiError(
        409,
        `Illegal GRN state transition: ${grn._id} cannot move from "${grn.state}" to "${toState}"`
      );
    }
  }

  async _applyStateChange(grn, toState, user, { reason = null, ipAddress = null } = {}) {
    this._guardTransition(grn, toState);
    const fromState = grn.state;
    grn.recordStateChange(toState, user, reason);
    grn.state = toState;
    grn.lastModifiedBy = user._id;
    await grn.save();
    try {
      await auditService.log({
        businessId:      grn.businessId,
        entityType:      ENTITY_TYPES.GOODS_RECEIPT,
        entityId:        grn._id,
        action:          AUDIT_ACTIONS.STATE_CHANGED,
        performedBy:     user._id,
        performedByName: user.fullName || user.email || 'Unknown',
        beforeState:     { state: fromState },
        afterState:      { state: toState, reason },
        ipAddress,
      });
    } catch (e) {
      // best-effort: audit-log write is observability only; the GRN state was already saved above.
      logger.warn(`[grn] audit state-change failed (${fromState}→${toState}): ${e.message}`);
    }
    return grn;
  }

  async _nextGrnNumber(businessId) {
    const now = new Date();
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const prefix = `GRN-${ym}-`;
    const last = await GoodsReceipt.findOne(
      { businessId, grnNumber: { $regex: `^${prefix}` } },
      { grnNumber: 1 }
    ).sort({ grnNumber: -1 }).lean();
    const seq = last
      ? parseInt(last.grnNumber.slice(prefix.length), 10) + 1
      : 1;
    return `${prefix}${String(seq).padStart(5, '0')}`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Discrepancy auto-detection
  // ─────────────────────────────────────────────────────────────────────────

  _detectDiscrepancies(poLineItems, receivedItems) {
    const discrepancies = [];
    for (const ri of receivedItems) {
      const poLine = poLineItems.find(
        (l) => l._id.toString() === ri.poLineItemId.toString()
      );
      if (!poLine) {
        discrepancies.push({
          poLineItemId: ri.poLineItemId,
          type: 'wrong_item',
          description: `Line item ${ri.poLineItemId} not found on purchase order`,
        });
        continue;
      }
      if (ri.quantityReceived < poLine.quantityOrdered) {
        discrepancies.push({
          poLineItemId: ri.poLineItemId,
          type: 'quantity_short',
          description: `Received ${ri.quantityReceived} but ordered ${poLine.quantityOrdered} ${poLine.unit || 'units'}`,
          quantityExpected: poLine.quantityOrdered,
          quantityActual:   ri.quantityReceived,
        });
      } else if (ri.quantityReceived > poLine.quantityOrdered) {
        discrepancies.push({
          poLineItemId: ri.poLineItemId,
          type: 'quantity_excess',
          description: `Received ${ri.quantityReceived} but ordered only ${poLine.quantityOrdered} ${poLine.unit || 'units'}`,
          quantityExpected: poLine.quantityOrdered,
          quantityActual:   ri.quantityReceived,
        });
      }
      // Price mismatch check (5% tolerance)
      if (ri.unitCost && poLine.unitPrice) {
        const priceDiff = Math.abs(ri.unitCost - poLine.unitPrice);
        const priceTolerance = poLine.unitPrice * 0.05;
        if (priceDiff > priceTolerance) {
          discrepancies.push({
            poLineItemId: ri.poLineItemId,
            type: 'price_mismatch',
            description: `Unit cost ${ri.unitCost} differs from PO unit price ${poLine.unitPrice} by ${priceDiff.toFixed(2)}`,
            priceExpected: poLine.unitPrice,
            priceActual:   ri.unitCost,
          });
        }
      }
      // Quality rejection
      if (ri.quantityRejected && ri.quantityRejected > 0) {
        discrepancies.push({
          poLineItemId: ri.poLineItemId,
          type: 'quality_reject',
          description: `${ri.quantityRejected} units of ${ri.name} rejected on quality grounds`,
          quantityExpected: ri.quantityReceived,
          quantityActual:   ri.quantityReceived - ri.quantityRejected,
        });
      }
    }
    return discrepancies;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Creation
  // ─────────────────────────────────────────────────────────────────────────

  async createDraft(data, user, ipAddress) {
    if (!data.businessId || !data.purchaseOrderId || !data.receivedDate) {
      throw new ApiError(400, 'createDraft requires: businessId, purchaseOrderId, receivedDate');
    }
    if (!Array.isArray(data.receivedItems) || data.receivedItems.length === 0) {
      throw new ApiError(400, 'A goods receipt must have at least one received item');
    }

    // Validate PO exists and is in a receivable state
    const po = await PurchaseOrder.findOne({
      _id: data.purchaseOrderId,
      businessId: data.businessId,
    });
    if (!po) throw new ApiError(404, 'Purchase order not found');
    const receivableStates = ['approved', 'partially_received'];
    if (!receivableStates.includes(po.state)) {
      throw new ApiError(
        409,
        `Cannot receive goods against PO in state "${po.state}". PO must be approved.`
      );
    }

    const grnNumber = data.grnNumber || await this._nextGrnNumber(data.businessId);

    const grn = new GoodsReceipt({
      businessId:          data.businessId,
      grnNumber,
      purchaseOrderId:     data.purchaseOrderId,
      vendorId:            data.vendorId || po.vendorId,
      receivedDate:        data.receivedDate,
      receivedItems:       data.receivedItems,
      warehouse:           data.warehouse || null,
      receivedByName:      data.receivedByName || null,
      deliveryNoteNumber:  data.deliveryNoteNumber || null,
      vehicleNumber:       data.vehicleNumber || null,
      notes:               data.notes || null,
      state:               GRN_STATES.DRAFT,
      createdBy:           user._id,
      lastModifiedBy:      user._id,
    });
    grn.recordStateChange(GRN_STATES.DRAFT, user, 'Initial creation');
    await grn.save();

    try {
      await auditService.logCreate(
        ENTITY_TYPES.GOODS_RECEIPT,
        grn._id,
        grn.businessId,
        user._id,
        grn.toObject(),
        ipAddress
      );
    } catch (e) {
      // best-effort: audit-log write is observability only; the GRN document was already persisted.
      logger.warn(`[grn] audit logCreate failed: ${e.message}`);
    }
    return grn;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Confirm (transitions to CONFIRMED or DISCREPANCY_REPORTED)
  // ─────────────────────────────────────────────────────────────────────────

  async confirm(id, user, ipAddress) {
    const grn = await this._loadOrThrow(id, user?.businessId);
    if (grn.state !== GRN_STATES.DRAFT) {
      throw new ApiError(409, `Only draft GRNs can be confirmed. Current state: "${grn.state}"`);
    }

    // Auto-detect discrepancies against PO lines
    const po = await PurchaseOrder.findById(grn.purchaseOrderId);
    let autoDiscrepancies = [];
    if (po && po.lineItems && po.lineItems.length > 0) {
      autoDiscrepancies = this._detectDiscrepancies(po.lineItems, grn.receivedItems);
    }

    // Merge with any manually entered discrepancies
    if (autoDiscrepancies.length > 0) {
      // Avoid duplicates for same poLineItemId + type
      for (const d of autoDiscrepancies) {
        const exists = grn.discrepancies.some(
          (ex) => ex.poLineItemId.toString() === d.poLineItemId.toString() && ex.type === d.type
        );
        if (!exists) grn.discrepancies.push(d);
      }
    }

    const targetState = grn.discrepancies.length > 0
      ? GRN_STATES.DISCREPANCY_REPORTED
      : GRN_STATES.CONFIRMED;

    // Update PO receiving quantities and state
    try {
      await purchaseOrderService.recordGrnReceipt(
        grn.purchaseOrderId,
        grn.receivedItems.map((ri) => ({
          poLineItemId:     ri.poLineItemId,
          quantityReceived: ri.quantityReceived,
        })),
        grn._id,
        user
      );
    } catch (e) {
      // best-effort: PO quantity sync is a convenience mirror; the GRN and GL are the
      // source of truth, so a sync hiccup must not block confirming the receipt.
      logger.warn(`[grn] failed to update PO quantities: ${e.message}`);
    }

    // ── ERP Step 5 + A13: receive goods into inventory AND post the GRNI accrual,
    // atomically. A failure now rolls the receive back (was silently swallowed —
    // A14). Idempotent, so a retry after a crash converges.
    await this._applyReceivedStock(grn, user);

    return this._applyStateChange(grn, targetState, user, {
      reason: targetState === GRN_STATES.DISCREPANCY_REPORTED
        ? `${grn.discrepancies.length} discrepancies detected`
        : 'All items received as ordered',
      ipAddress,
    });
  }

  /**
   * ERP Step 5 — add received goods to inventory at their landed unit cost.
   *
   * For each received line that references a tracked InventoryItem, increment
   * stock by the ACCEPTED quantity (received − rejected) via
   * inventoryService.applyPurchaseStock (weighted-average cost; no journal — the
   * Bill posts the AP/Inventory journal). Lines without an inventoryItemId
   * (services, untracked customs) are skipped. Idempotent via grn.inventoryApplied.
   *
   * Broadcasts GOODS_RECEIVED once with a per-item summary so procurement
   * analytics, dashboards and forecasting can react.
   * @private
   */
  async _applyReceivedStock(grn, user) {
    // Idempotency: the GL post is keyed (idempotencyKey), the subledger increment is
    // guarded by inventoryApplied. On a replica set (production) all writes here commit
    // atomically. On standalone Mongo (dev) withTransaction is non-atomic, so a crash
    // between the GL commit and this guard-save could re-increment stock on retry —
    // accepted: production runs on a replica set.
    if (grn.inventoryApplied && grn.glJournalId) {
      logger.debug(`[grn] stock + accrual already applied for ${grn.grnNumber} — skipping`);
      return;
    }

    // Gather stocked lines and their landed value.
    const stockedLines = [];
    let inventoryValue = 0;
    for (const ri of (grn.receivedItems || [])) {
      if (!ri.inventoryItemId) continue; // service / untracked — accrued at Bill, no inventory leg
      const acceptedQty = Math.max(0, Number(ri.quantityReceived || 0) - Number(ri.quantityRejected || 0));
      if (acceptedQty <= 0) continue;
      const unitCost = Number(ri.unitCost) || 0;
      stockedLines.push({ ri, acceptedQty, unitCost });
      inventoryValue = Math.round((inventoryValue + acceptedQty * unitCost) * 100) / 100;
    }

    if (stockedLines.length === 0) {
      // Nothing tracked to stock (services / untracked customs): set the guard so the
      // confirm path is idempotent; no inventory leg to post (accrued later at Bill).
      grn.inventoryApplied = true;
      grn.inventoryAppliedAt = new Date();
      await grn.save();
      return;
    }

    const invAcc = await this._ensureAccount(grn.businessId, '1150');
    const grniAcc = await this._ensureAccount(grn.businessId, '2115');
    if (!invAcc || !grniAcc) {
      throw new ApiError(400, `Cannot receive ${grn.grnNumber}: Inventory (1150) or Goods Received Not Invoiced (2115) account is missing.`);
    }

    const applied = [];
    await withTransaction(async (s) => {
      const je = await ledgerPosting.postCompoundJournal({
        businessId:        grn.businessId,
        transactionDate:   new Date(),
        description:       `Goods received — ${grn.grnNumber}`,
        transactionType:   TRANSACTION_TYPES.JOURNAL_ENTRY,
        transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
        createdBy:         user._id,
        lastModifiedBy:    user._id,
        idempotencyKey:    `grn:accrual:${grn._id}`,
        lines: [
          { accountId: invAcc._id,  type: 'debit',  amount: inventoryValue, description: 'Inventory received' },
          { accountId: grniAcc._id, type: 'credit', amount: inventoryValue, description: 'Goods received not invoiced' },
        ],
      }, { session: s });

      for (const { ri, acceptedQty, unitCost } of stockedLines) {
        await inventoryService.applyPurchaseStock(
          grn.businessId, ri.inventoryItemId, acceptedQty, unitCost,
          { userId: user._id, vendorId: grn.vendorId || null, session: s },
        );
        applied.push({ inventoryItemId: ri.inventoryItemId, name: ri.name, qty: acceptedQty, unitCost });
      }

      grn.glJournalId        = je._id;
      grn.inventoryApplied   = true;
      grn.inventoryAppliedAt = new Date();
      await grn.save({ session: s });
    });

    if (applied.length > 0) {
      // best-effort: analytics/forecasting broadcast; never blocks the receipt.
      // Posted OUTSIDE the transaction so a subscriber error can't roll back the ledger.
      businessEvents.emit(EVENTS.GOODS_RECEIVED, {
        businessId:      grn.businessId.toString(),
        userId:          user._id,
        entityType:      ENTITY_TYPES.GOODS_RECEIPT,
        entityId:        grn._id,
        grnNumber:       grn.grnNumber,
        purchaseOrderId: grn.purchaseOrderId || null,
        vendorId:        grn.vendorId || null,
        items:           applied,
        lineCount:       applied.length,
      });
      logger.info(`[grn] ${grn.grnNumber}: received ${applied.length} item(s) into inventory`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Reconcile discrepancies
  // ─────────────────────────────────────────────────────────────────────────

  async reconcile(id, resolutions, user, ipAddress) {
    const grn = await this._loadOrThrow(id, user?.businessId);
    if (grn.state !== GRN_STATES.DISCREPANCY_REPORTED) {
      throw new ApiError(409, 'Only GRNs in discrepancy_reported state can be reconciled');
    }

    // Apply resolution to each discrepancy
    for (const res of (resolutions || [])) {
      const disc = grn.discrepancies.id(res.discrepancyId);
      if (disc) {
        disc.resolution  = res.resolution;
        disc.resolvedAt  = new Date();
        disc.resolvedBy  = user._id;
        disc.notes       = res.notes || disc.notes;
      }
    }

    const allResolved = grn.discrepancies.every(
      (d) => d.resolution && d.resolution !== 'pending'
    );
    if (!allResolved) {
      grn.lastModifiedBy = user._id;
      await grn.save();
      return grn; // partial resolution — stay in discrepancy_reported
    }

    return this._applyStateChange(grn, GRN_STATES.RECONCILED, user, {
      reason: 'All discrepancies resolved',
      ipAddress,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Link bill
  // ─────────────────────────────────────────────────────────────────────────

  async linkBill(id, billId, user) {
    const grn = await this._loadOrThrow(id, user?.businessId);
    if (!grn.linkedBillIds.some((b) => b.toString() === billId.toString())) {
      grn.linkedBillIds.push(billId);
      grn.lastModifiedBy = user._id;
      await grn.save();
    }
    return grn;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cancel + archive
  // ─────────────────────────────────────────────────────────────────────────

  async cancel(id, user, reason, ipAddress) {
    const grn = await this._loadOrThrow(id, user?.businessId);

    // A13 — if this GRN had a GRNI accrual journal posted on confirm, reverse it so
    // the cancellation nets to zero in the GL (DR GRNI / CR Inventory). Must happen
    // BEFORE the state transition so a failure rolls back without leaving a
    // partially-cancelled record. Re-throw on failure — never swallow.
    if (grn.glJournalId) {
      const transactionService = require('./transaction.service');
      await transactionService.reverseTransaction(
        grn.glJournalId.toString(),
        grn.businessId.toString(),
        { reason: `GRN ${grn.grnNumber} cancelled` },
        user._id,
        ipAddress,
      );
      grn.glJournalId = null;
    }

    // Reverse physical stock increments applied on confirm so the subledger nets to zero.
    if (grn.inventoryApplied) {
      for (const ri of (grn.receivedItems || [])) {
        if (!ri.inventoryItemId) continue; // service / untracked — no stock leg
        const acceptedQty = Math.max(0, Number(ri.quantityReceived || 0) - Number(ri.quantityRejected || 0));
        if (acceptedQty <= 0) continue;
        try {
          await inventoryService.reduceStock(grn.businessId.toString(), ri.inventoryItemId, acceptedQty);
        } catch (e) {
          // Log and re-throw: a stock reversal failure means GL and subledger are out
          // of sync — the caller must retry, not swallow.
          logger.error(`[grn] cancel: stock reversal failed for item ${ri.inventoryItemId}: ${e.message}`);
          throw e;
        }
      }
      grn.inventoryApplied = false;
    }

    return this._applyStateChange(grn, GRN_STATES.CANCELLED, user, { reason, ipAddress });
  }

  async softDelete(id, user, ipAddress) {
    const grn = await this._loadOrThrow(id, user?.businessId);
    if (grn.isArchived) return grn;
    grn.isArchived = true;
    grn.archivedAt = new Date();
    grn.lastModifiedBy = user._id;
    await grn.save();
    try {
      await auditService.logDelete(
        ENTITY_TYPES.GOODS_RECEIPT,
        grn._id,
        grn.businessId,
        user._id,
        grn.toObject(),
        ipAddress
      );
    } catch (e) {
      // best-effort: audit-log write is observability only; the soft-delete was already committed.
      logger.warn(`[grn] audit logDelete failed: ${e.message}`);
    }
    return grn;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Read APIs
  // ─────────────────────────────────────────────────────────────────────────

  async getById(id, businessId) {
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid GRN id');
    const query = { _id: id };
    if (businessId) query.businessId = businessId;
    const grn = await GoodsReceipt.findOne(query)
      .populate('purchaseOrderId', 'poNumber state totalAmount')
      .populate('vendorId', 'vendorName email')
      .populate('linkedBillIds', 'billNumber state totalAmount');
    if (!grn) throw new ApiError(404, 'Goods receipt not found');
    return grn;
  }

  async list(businessId, filters = {}, pagination = {}) {
    const { page = 1, limit = 25 } = pagination;
    const q = { businessId, isArchived: { $ne: true } };
    if (filters.state)           q.state = filters.state;
    if (filters.vendorId)        q.vendorId = filters.vendorId;
    if (filters.purchaseOrderId) q.purchaseOrderId = filters.purchaseOrderId;
    if (filters.hasDiscrepancies !== undefined) q.hasDiscrepancies = filters.hasDiscrepancies;
    if (filters.search)          q.grnNumber = { $regex: filters.search, $options: 'i' };
    if (filters.startDate || filters.endDate) {
      q.receivedDate = {};
      if (filters.startDate) q.receivedDate.$gte = new Date(filters.startDate);
      if (filters.endDate)   q.receivedDate.$lte = new Date(filters.endDate);
    }
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      GoodsReceipt.find(q)
        .populate('vendorId', 'vendorName')
        .populate('purchaseOrderId', 'poNumber')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      GoodsReceipt.countDocuments(q),
    ]);
    return { data, total, page, limit };
  }
}

module.exports = new GoodsReceiptService();
