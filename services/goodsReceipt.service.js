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
const auditService = require('./audit.service');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const {
  GRN_STATES,
  AUDIT_ACTIONS,
  ENTITY_TYPES,
} = require('../config/constants');

class GoodsReceiptService {
  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  async _loadOrThrow(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid GRN id');
    const grn = await GoodsReceipt.findById(id);
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
      logger.warn(`[grn] audit logCreate failed: ${e.message}`);
    }
    return grn;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Confirm (transitions to CONFIRMED or DISCREPANCY_REPORTED)
  // ─────────────────────────────────────────────────────────────────────────

  async confirm(id, user, ipAddress) {
    const grn = await this._loadOrThrow(id);
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
      logger.warn(`[grn] failed to update PO quantities: ${e.message}`);
    }

    return this._applyStateChange(grn, targetState, user, {
      reason: targetState === GRN_STATES.DISCREPANCY_REPORTED
        ? `${grn.discrepancies.length} discrepancies detected`
        : 'All items received as ordered',
      ipAddress,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Reconcile discrepancies
  // ─────────────────────────────────────────────────────────────────────────

  async reconcile(id, resolutions, user, ipAddress) {
    const grn = await this._loadOrThrow(id);
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
    const grn = await this._loadOrThrow(id);
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
    const grn = await this._loadOrThrow(id);
    return this._applyStateChange(grn, GRN_STATES.CANCELLED, user, { reason, ipAddress });
  }

  async softDelete(id, user, ipAddress) {
    const grn = await this._loadOrThrow(id);
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
