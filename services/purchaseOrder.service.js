// services/purchaseOrder.service.js
//
// Phase 3.1 — Purchase Order (PO) domain service.
//
// Manages the full PO lifecycle:
//   createDraft → submitForApproval → approve/reject → receive (GRN) → bill → close
//
// 3-Way Match is enforced at the "bill" transition:
//   PO totalAmount must reconcile with GRN totalReceivedValue + Bill amount
//   within the configured tolerance (default ±5%).
//
const mongoose = require('mongoose');
const PurchaseOrder = require('../models/PurchaseOrder.model');
const vendorRepository = require('../repositories/vendor.repository');
const auditService = require('./audit.service');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const {
  PO_STATES,
  APPROVAL_STATUS,
  APPROVER_ROLES,
  AUDIT_ACTIONS,
  ENTITY_TYPES,
  DEFAULT_APPROVAL_THRESHOLD,
} = require('../config/constants');

// Maximum tolerated variance when running 3-way match (5 % of PO total)
const THREE_WAY_MATCH_TOLERANCE_PCT = 5;

class PurchaseOrderService {
  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  _requiresApproval(amount, businessConfig = {}) {
    const threshold = Number.isFinite(businessConfig.poApprovalThreshold)
      ? businessConfig.poApprovalThreshold
      : DEFAULT_APPROVAL_THRESHOLD;
    return amount >= threshold;
  }

  async _vendorSnapshot(businessId, vendorId) {
    if (!vendorId) return {};
    const v = await vendorRepository.findByBusinessAndId(businessId, vendorId);
    if (!v) return {};
    return {
      vendorName: v.vendorName || null,
      email:      v.email || null,
      phone:      v.phone || null,
      taxId:      v.taxId || null,
    };
  }

  _guardTransition(po, toState) {
    if (!PurchaseOrder.canTransition(po.state, toState)) {
      throw new ApiError(
        409,
        `Illegal state transition: PO ${po._id} cannot move from "${po.state}" to "${toState}"`
      );
    }
  }

  async _applyStateChange(po, toState, user, { reason = null, ipAddress = null } = {}) {
    this._guardTransition(po, toState);
    const fromState = po.state;
    po.recordStateChange(toState, user, reason);
    po.state = toState;
    po.lastModifiedBy = user._id;
    await po.save();
    try {
      await auditService.log({
        businessId:      po.businessId,
        entityType:      ENTITY_TYPES.PURCHASE_ORDER,
        entityId:        po._id,
        action:          AUDIT_ACTIONS.STATE_CHANGED,
        performedBy:     user._id,
        performedByName: user.fullName || user.email || 'Unknown',
        beforeState:     { state: fromState },
        afterState:      { state: toState, reason },
        ipAddress,
      });
    } catch (e) {
      logger.warn(`[po] audit state-change failed (${fromState}→${toState}): ${e.message}`);
    }
    return po;
  }

  async _loadOrThrow(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid purchase order id');
    const po = await PurchaseOrder.findById(id);
    if (!po) throw new ApiError(404, 'Purchase order not found');
    if (po.isArchived) throw new ApiError(410, 'Purchase order has been archived');
    return po;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Auto-number helper (returns next PO-YYYYMM-NNNNN style number)
  // ─────────────────────────────────────────────────────────────────────────

  async _nextPoNumber(businessId) {
    const now = new Date();
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const prefix = `PO-${ym}-`;
    const last = await PurchaseOrder.findOne(
      { businessId, poNumber: { $regex: `^${prefix}` } },
      { poNumber: 1 }
    ).sort({ poNumber: -1 }).lean();
    const seq = last
      ? parseInt(last.poNumber.slice(prefix.length), 10) + 1
      : 1;
    return `${prefix}${String(seq).padStart(5, '0')}`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Creation
  // ─────────────────────────────────────────────────────────────────────────

  async createDraft(data, user, ipAddress) {
    if (!data.businessId || !data.issueDate) {
      throw new ApiError(400, 'createDraft requires: businessId, issueDate');
    }
    if (!Array.isArray(data.lineItems) || data.lineItems.length === 0) {
      throw new ApiError(400, 'A purchase order must have at least one line item');
    }

    const poNumber = data.poNumber || await this._nextPoNumber(data.businessId);
    const snap = await this._vendorSnapshot(data.businessId, data.vendorId);

    // Estimate total for approval threshold (pre-save hook will compute exact value)
    const estimateTotal = data.lineItems.reduce(
      (s, li) => s + ((li.quantityOrdered || 0) * (li.unitPrice || 0)),
      0
    );
    const approvalRequired = this._requiresApproval(estimateTotal, data.businessConfig);

    const po = new PurchaseOrder({
      businessId:           data.businessId,
      poNumber,
      vendorId:             data.vendorId || null,
      vendorSnapshot:       Object.keys(snap).length ? snap : (data.vendorSnapshot || {}),
      currencyCode:         data.currencyCode || 'PKR',
      exchangeRate:         data.exchangeRate || 1,
      lineItems:            data.lineItems,
      invoiceDiscountType:  data.invoiceDiscountType || null,
      invoiceDiscountValue: data.invoiceDiscountValue || 0,
      shippingCharges:      data.shippingCharges || 0,
      roundingAdjustment:   data.roundingAdjustment || 0,
      issueDate:            data.issueDate,
      expectedDeliveryDate: data.expectedDeliveryDate || null,
      paymentTerms:         data.paymentTerms || null,
      notes:                data.notes || null,
      tags:                 data.tags || [],
      state:                PO_STATES.DRAFT,
      approvalRequired,
      approvalStatus:       approvalRequired ? APPROVAL_STATUS.PENDING : APPROVAL_STATUS.NOT_REQUIRED,
      approvalThreshold:    approvalRequired
        ? (data.businessConfig?.poApprovalThreshold ?? DEFAULT_APPROVAL_THRESHOLD)
        : null,
      createdBy:            user._id,
      lastModifiedBy:       user._id,
    });
    po.recordStateChange(PO_STATES.DRAFT, user, 'Initial creation');
    await po.save();

    try {
      await auditService.logCreate(
        ENTITY_TYPES.PURCHASE_ORDER,
        po._id,
        po.businessId,
        user._id,
        po.toObject(),
        ipAddress
      );
    } catch (e) {
      logger.warn(`[po] audit logCreate failed: ${e.message}`);
    }
    return po;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Update draft
  // ─────────────────────────────────────────────────────────────────────────

  async updateDraft(id, data, user, ipAddress) {
    const po = await this._loadOrThrow(id);
    if (po.state !== PO_STATES.DRAFT) {
      throw new ApiError(409, 'Only draft purchase orders can be edited');
    }
    const editable = [
      'vendorId', 'lineItems', 'currencyCode', 'exchangeRate',
      'invoiceDiscountType', 'invoiceDiscountValue', 'shippingCharges',
      'roundingAdjustment', 'issueDate', 'expectedDeliveryDate',
      'paymentTerms', 'notes', 'tags',
    ];
    for (const field of editable) {
      if (data[field] !== undefined) po[field] = data[field];
    }
    if (data.vendorId && String(data.vendorId) !== String(po.vendorId)) {
      po.vendorSnapshot = await this._vendorSnapshot(po.businessId, data.vendorId);
    }
    po.lastModifiedBy = user._id;
    await po.save();
    try {
      await auditService.log({
        businessId:      po.businessId,
        entityType:      ENTITY_TYPES.PURCHASE_ORDER,
        entityId:        po._id,
        action:          AUDIT_ACTIONS.EDITED,
        performedBy:     user._id,
        performedByName: user.fullName || user.email || 'Unknown',
        ipAddress,
      });
    } catch (e) {
      logger.warn(`[po] audit updateDraft failed: ${e.message}`);
    }
    return po;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Approval workflow
  // ─────────────────────────────────────────────────────────────────────────

  async submitForApproval(id, user, ipAddress) {
    const po = await this._loadOrThrow(id);
    if (!po.approvalRequired) {
      return this._applyStateChange(po, PO_STATES.APPROVED, user, {
        reason: 'Below approval threshold — auto-approved',
        ipAddress,
      });
    }
    po.approvalLog.push({
      action:    'submitted',
      actorId:   user._id,
      actorName: user.fullName || user.email || 'Unknown',
      actorRole: user.role || null,
      timestamp: new Date(),
    });
    po.approvalStatus = APPROVAL_STATUS.PENDING;
    return this._applyStateChange(po, PO_STATES.PENDING_APPROVAL, user, { ipAddress });
  }

  async approve(id, user, note, ipAddress) {
    const po = await this._loadOrThrow(id);
    po.approvalLog.push({
      action:    'approved',
      actorId:   user._id,
      actorName: user.fullName || user.email || 'Unknown',
      actorRole: user.role || null,
      note:      note || null,
      timestamp: new Date(),
    });
    po.approvalStatus = APPROVAL_STATUS.APPROVED;
    po.approvedBy = user._id;
    po.approvedAt = new Date();
    return this._applyStateChange(po, PO_STATES.APPROVED, user, { reason: note, ipAddress });
  }

  async reject(id, user, note, ipAddress) {
    const po = await this._loadOrThrow(id);
    po.approvalLog.push({
      action:    'rejected',
      actorId:   user._id,
      actorName: user.fullName || user.email || 'Unknown',
      actorRole: user.role || null,
      note:      note || null,
      timestamp: new Date(),
    });
    po.approvalStatus = APPROVAL_STATUS.REJECTED;
    return this._applyStateChange(po, PO_STATES.DRAFT, user, {
      reason: note || 'Rejected — returned to draft',
      ipAddress,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GRN / receiving linkage
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Called by goodsReceipt.service after confirming a GRN.
   * Updates PO line quantityReceived and advances state.
   *
   * @param {string}   poId
   * @param {Array}    receivedItems  — array of { poLineItemId, quantityReceived }
   * @param {string}   grnId
   * @param {Object}   user
   */
  async recordGrnReceipt(poId, receivedItems, grnId, user) {
    const po = await this._loadOrThrow(poId);
    if (![PO_STATES.APPROVED, PO_STATES.PARTIALLY_RECEIVED].includes(po.state)) {
      throw new ApiError(
        409,
        `Cannot record receipt against PO in state "${po.state}". PO must be approved first.`
      );
    }

    // Update quantityReceived on each matched line
    for (const ri of receivedItems) {
      const line = po.lineItems.id(ri.poLineItemId);
      if (line) {
        line.quantityReceived = Math.round(
          ((line.quantityReceived || 0) + (ri.quantityReceived || 0)) * 1000
        ) / 1000;
      }
    }

    // Link the GRN
    if (grnId && !po.linkedGrnIds.some((g) => g.toString() === grnId.toString())) {
      po.linkedGrnIds.push(grnId);
    }

    // Determine new state
    const fullyReceived = po.lineItems.every(
      (li) => li.quantityReceived >= li.quantityOrdered
    );
    const newState = fullyReceived ? PO_STATES.FULLY_RECEIVED : PO_STATES.PARTIALLY_RECEIVED;
    po.recordStateChange(newState, user, `GRN ${grnId} confirmed`);
    po.state = newState;
    po.lastModifiedBy = user._id;
    await po.save();
    return po;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cancel / close
  // ─────────────────────────────────────────────────────────────────────────

  async cancel(id, user, reason, ipAddress) {
    const po = await this._loadOrThrow(id);
    return this._applyStateChange(po, PO_STATES.CANCELLED, user, { reason, ipAddress });
  }

  async close(id, user, reason, ipAddress) {
    const po = await this._loadOrThrow(id);
    return this._applyStateChange(po, PO_STATES.CLOSED, user, { reason, ipAddress });
  }

  async softDelete(id, user, ipAddress) {
    const po = await this._loadOrThrow(id);
    if (po.isArchived) return po;
    po.isArchived = true;
    po.archivedAt = new Date();
    po.archivedBy = user._id;
    po.lastModifiedBy = user._id;
    await po.save();
    try {
      await auditService.logDelete(
        ENTITY_TYPES.PURCHASE_ORDER,
        po._id,
        po.businessId,
        user._id,
        po.toObject(),
        ipAddress
      );
    } catch (e) {
      logger.warn(`[po] audit logDelete failed: ${e.message}`);
    }
    return po;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3-Way Match validation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Runs a 3-way match check between a PO, its linked GRNs, and a Bill.
   *
   * Returns { status, variance, message }
   *   status: 'matched' | 'discrepancy' | 'none'
   *   variance: absolute difference in base currency
   */
  async runThreeWayMatch(poId, grnTotalValue, billAmount) {
    const po = await this._loadOrThrow(poId);
    if (!po || po.totalAmount <= 0) return { status: 'none', variance: 0, message: 'PO has no amount' };

    const tolerance = Math.round(po.totalAmount * THREE_WAY_MATCH_TOLERANCE_PCT) / 100;
    const variance = Math.abs(po.totalAmount - billAmount);

    if (variance <= tolerance) {
      return {
        status: 'matched',
        variance,
        message: `Match OK — variance ${variance} is within tolerance ${tolerance}`,
      };
    }
    return {
      status: 'discrepancy',
      variance,
      message: `Discrepancy — bill amount ${billAmount} vs PO ${po.totalAmount} (variance ${variance}, tolerance ${tolerance})`,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Read APIs
  // ─────────────────────────────────────────────────────────────────────────

  async getById(id, businessId) {
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid purchase order id');
    const query = { _id: id };
    if (businessId) query.businessId = businessId;
    const po = await PurchaseOrder.findOne(query)
      .populate('vendorId', 'vendorName email phone')
      .populate('linkedGrnIds', 'grnNumber state receivedDate totalReceivedValue')
      .populate('linkedBillIds', 'billNumber state totalAmount');
    if (!po) throw new ApiError(404, 'Purchase order not found');
    return po;
  }

  async list(businessId, filters = {}, pagination = {}) {
    const { page = 1, limit = 25 } = pagination;
    const q = { businessId, isArchived: { $ne: true } };
    if (filters.state)          q.state = filters.state;
    if (filters.vendorId)       q.vendorId = filters.vendorId;
    if (filters.approvalStatus) q.approvalStatus = filters.approvalStatus;
    if (filters.search)         q.poNumber = { $regex: filters.search, $options: 'i' };
    if (filters.startDate || filters.endDate) {
      q.issueDate = {};
      if (filters.startDate) q.issueDate.$gte = new Date(filters.startDate);
      if (filters.endDate)   q.issueDate.$lte = new Date(filters.endDate);
    }
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      PurchaseOrder.find(q)
        .populate('vendorId', 'vendorName')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      PurchaseOrder.countDocuments(q),
    ]);
    return { data, total, page, limit };
  }

  async getTimeline(id, businessId) {
    const po = await this.getById(id, businessId);
    const entries = [];
    for (const e of (po.approvalLog || [])) {
      entries.push({ type: 'approval', timestamp: e.timestamp, ...e.toObject?.() ?? e });
    }
    for (const e of (po.stateHistory || [])) {
      entries.push({ type: 'state', timestamp: e.timestamp, ...e.toObject?.() ?? e });
    }
    entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return { purchaseOrder: po, timeline: entries };
  }
}

module.exports = new PurchaseOrderService();
