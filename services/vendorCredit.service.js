// services/vendorCredit.service.js
//
// Phase 3.1 — Vendor Credit domain service.
//
// A Vendor Credit represents money owed TO US by a vendor.
// Common flows:
//   1. Goods returned  → GRN discrepancy resolved as "returned_to_vendor"
//                        → VendorCredit created with reason=goods_returned
//   2. Price dispute   → AP clerk opens credit manually with reason=price_adjustment
//   3. Overpayment     → Finance creates credit with reason=overpayment
//
// The credit reduces the AP balance when applied to an open Bill.
// The pre-save hook auto-manages state (open → partially_applied → fully_applied).
//
const mongoose = require('mongoose');
const VendorCredit = require('../models/VendorCredit.model');
const Bill = require('../models/Bill.model');
const vendorRepository = require('../repositories/vendor.repository');
const auditService = require('./audit.service');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const {
  VENDOR_CREDIT_STATES,
  AUDIT_ACTIONS,
  ENTITY_TYPES,
} = require('../config/constants');

class VendorCreditService {
  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  async _loadOrThrow(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid vendor credit id');
    const vc = await VendorCredit.findById(id);
    if (!vc) throw new ApiError(404, 'Vendor credit not found');
    if (vc.isArchived) throw new ApiError(410, 'Vendor credit has been archived');
    return vc;
  }

  async _nextCreditNumber(businessId) {
    const now = new Date();
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const prefix = `VC-${ym}-`;
    const last = await VendorCredit.findOne(
      { businessId, creditNumber: { $regex: `^${prefix}` } },
      { creditNumber: 1 }
    ).sort({ creditNumber: -1 }).lean();
    const seq = last
      ? parseInt(last.creditNumber.slice(prefix.length), 10) + 1
      : 1;
    return `${prefix}${String(seq).padStart(5, '0')}`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Creation
  // ─────────────────────────────────────────────────────────────────────────

  async create(data, user, ipAddress) {
    if (!data.businessId || !data.vendorId || !data.amount || !data.creditDate || !data.reason) {
      throw new ApiError(400, 'create requires: businessId, vendorId, amount, creditDate, reason');
    }
    if (data.amount <= 0) {
      throw new ApiError(400, 'Vendor credit amount must be greater than zero');
    }

    const creditNumber = data.creditNumber || await this._nextCreditNumber(data.businessId);

    const vc = new VendorCredit({
      businessId:        data.businessId,
      creditNumber,
      vendorId:          data.vendorId,
      sourceBillId:      data.sourceBillId  || null,
      sourceGrnId:       data.sourceGrnId   || null,
      creditDate:        data.creditDate,
      currencyCode:      data.currencyCode  || 'PKR',
      exchangeRate:      data.exchangeRate  || 1,
      amount:            data.amount,
      remainingAmount:   data.amount, // will be normalised by pre-save hook
      reason:            data.reason,
      reasonDescription: data.reasonDescription || null,
      notes:             data.notes || null,
      tags:              data.tags  || [],
      state:             VENDOR_CREDIT_STATES.OPEN,
      createdBy:         user._id,
      lastModifiedBy:    user._id,
    });
    await vc.save();

    try {
      await auditService.logCreate(
        ENTITY_TYPES.VENDOR_CREDIT,
        vc._id,
        vc.businessId,
        user._id,
        vc.toObject(),
        ipAddress
      );
    } catch (e) {
      logger.warn(`[vc] audit logCreate failed: ${e.message}`);
    }
    return vc;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Apply credit to a bill
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Applies a portion (or all) of a vendor credit against an open bill.
   *
   * @param {string} vcId         — VendorCredit._id
   * @param {string} billId       — Bill._id to apply against
   * @param {number} amount       — Amount to apply (must be <= remainingAmount)
   * @param {Object} user
   * @param {string} [notes]      — Optional notes for this application
   * @param {string} [ipAddress]
   */
  async applyToBill(vcId, billId, amount, user, notes, ipAddress) {
    const vc = await this._loadOrThrow(vcId);
    if (vc.state === VENDOR_CREDIT_STATES.CANCELLED) {
      throw new ApiError(409, 'Cannot apply a cancelled vendor credit');
    }
    if (vc.state === VENDOR_CREDIT_STATES.FULLY_APPLIED) {
      throw new ApiError(409, 'This vendor credit has already been fully applied');
    }
    if (!amount || amount <= 0) {
      throw new ApiError(400, 'Applied amount must be greater than zero');
    }
    const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
    if (r2(amount) > r2(vc.remainingAmount)) {
      throw new ApiError(
        400,
        `Applied amount ${amount} exceeds remaining credit balance ${vc.remainingAmount}`
      );
    }

    // Validate bill
    if (!mongoose.Types.ObjectId.isValid(billId)) throw new ApiError(400, 'Invalid bill id');
    const bill = await Bill.findOne({ _id: billId, businessId: vc.businessId });
    if (!bill) throw new ApiError(404, 'Bill not found');
    if (!['draft', 'awaiting_approval', 'approved', 'scheduled', 'overdue'].includes(bill.state)) {
      throw new ApiError(409, `Cannot apply credit to bill in state "${bill.state}"`);
    }

    // Record the application on the vendor credit
    vc.appliedTransactions.push({
      billId,
      billNumber:    bill.billNumber,
      appliedAmount: r2(amount),
      appliedAt:     new Date(),
      appliedBy:     user._id,
      notes:         notes || null,
    });
    // State and remainingAmount recomputed by pre-save hook
    vc.lastModifiedBy = user._id;
    await vc.save();

    // Reduce bill's remaining balance
    const newPaid = r2((bill.paidAmount || 0) + amount);
    bill.paidAmount = newPaid;
    bill.remainingBalance = r2(Math.max(0, bill.totalAmount - newPaid));
    bill.lastModifiedBy = user._id;
    await bill.save();

    try {
      await auditService.log({
        businessId:      vc.businessId,
        entityType:      ENTITY_TYPES.VENDOR_CREDIT,
        entityId:        vc._id,
        action:          AUDIT_ACTIONS.EDITED,
        performedBy:     user._id,
        performedByName: user.fullName || user.email || 'Unknown',
        afterState:      { appliedAmount: amount, billId, remainingAmount: vc.remainingAmount },
        ipAddress,
      });
    } catch (e) {
      logger.warn(`[vc] audit applyToBill failed: ${e.message}`);
    }
    return vc;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cancel
  // ─────────────────────────────────────────────────────────────────────────

  async cancel(id, user, reason, ipAddress) {
    const vc = await this._loadOrThrow(id);
    if (vc.state === VENDOR_CREDIT_STATES.FULLY_APPLIED) {
      throw new ApiError(409, 'A fully applied credit cannot be cancelled. Reverse the applications first.');
    }
    if (vc.appliedTransactions.length > 0) {
      throw new ApiError(
        409,
        'This credit has partial applications. Reverse those applications before cancelling.'
      );
    }
    vc.state = VENDOR_CREDIT_STATES.CANCELLED;
    vc.lastModifiedBy = user._id;
    await vc.save();
    try {
      await auditService.log({
        businessId:      vc.businessId,
        entityType:      ENTITY_TYPES.VENDOR_CREDIT,
        entityId:        vc._id,
        action:          AUDIT_ACTIONS.CANCELLED,
        performedBy:     user._id,
        performedByName: user.fullName || user.email || 'Unknown',
        afterState:      { state: VENDOR_CREDIT_STATES.CANCELLED, reason },
        ipAddress,
      });
    } catch (e) {
      logger.warn(`[vc] audit cancel failed: ${e.message}`);
    }
    return vc;
  }

  async softDelete(id, user, ipAddress) {
    const vc = await this._loadOrThrow(id);
    if (vc.isArchived) return vc;
    vc.isArchived = true;
    vc.archivedAt = new Date();
    vc.archivedBy = user._id;
    vc.lastModifiedBy = user._id;
    await vc.save();
    try {
      await auditService.logDelete(
        ENTITY_TYPES.VENDOR_CREDIT,
        vc._id,
        vc.businessId,
        user._id,
        vc.toObject(),
        ipAddress
      );
    } catch (e) {
      logger.warn(`[vc] audit logDelete failed: ${e.message}`);
    }
    return vc;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Read APIs
  // ─────────────────────────────────────────────────────────────────────────

  async getById(id, businessId) {
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid vendor credit id');
    const query = { _id: id };
    if (businessId) query.businessId = businessId;
    const vc = await VendorCredit.findOne(query)
      .populate('vendorId', 'vendorName email')
      .populate('sourceBillId', 'billNumber totalAmount')
      .populate('sourceGrnId', 'grnNumber totalReceivedValue')
      .populate('appliedTransactions.billId', 'billNumber');
    if (!vc) throw new ApiError(404, 'Vendor credit not found');
    return vc;
  }

  async list(businessId, filters = {}, pagination = {}) {
    const { page = 1, limit = 25 } = pagination;
    const q = { businessId, isArchived: { $ne: true } };
    if (filters.state)    q.state    = filters.state;
    if (filters.vendorId) q.vendorId = filters.vendorId;
    if (filters.reason)   q.reason   = filters.reason;
    if (filters.search)   q.creditNumber = { $regex: filters.search, $options: 'i' };
    if (filters.openOnly) {
      q.state = { $in: [VENDOR_CREDIT_STATES.OPEN, VENDOR_CREDIT_STATES.PARTIALLY_APPLIED] };
    }
    if (filters.startDate || filters.endDate) {
      q.creditDate = {};
      if (filters.startDate) q.creditDate.$gte = new Date(filters.startDate);
      if (filters.endDate)   q.creditDate.$lte = new Date(filters.endDate);
    }
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      VendorCredit.find(q)
        .populate('vendorId', 'vendorName')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      VendorCredit.countDocuments(q),
    ]);
    return { data, total, page, limit };
  }

  /**
   * Returns all open/partially-applied credits for a vendor so
   * the Bill editor can show available credit balance.
   */
  async getAvailableCredits(businessId, vendorId) {
    return VendorCredit.find({
      businessId,
      vendorId,
      isArchived: { $ne: true },
      state: { $in: [VENDOR_CREDIT_STATES.OPEN, VENDOR_CREDIT_STATES.PARTIALLY_APPLIED] },
    })
      .select('creditNumber amount remainingAmount reason creditDate')
      .sort({ creditDate: 1 })
      .lean();
  }
}

module.exports = new VendorCreditService();
