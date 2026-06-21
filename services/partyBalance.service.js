/**
 * partyBalance.service.js — ERP Integration Refactor, Step 4
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  CENTRALIZED AR / AP PARTY-BALANCE ENGINE                                  │
 * │                                                                            │
 * │  Single source of truth for mutating a Customer's receivable balance and  │
 * │  a Vendor's payable balance. Every place in the system that changes what  │
 * │  a customer owes us (AR) or what we owe a vendor (AP) routes through here  │
 * │  so the running balance and the broadcast event stay in lock-step.         │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * WHY THIS EXISTS (the gap it closes):
 *   Before Step 4, AR/AP balances were mutated by ad-hoc `repo.$inc` calls
 *   scattered across transaction.service (10 call-sites), while bill.service and
 *   invoice.service never touched party balances at all. Nothing broadcast a
 *   "balance changed" event, so the dashboard, forecasting feed and aging
 *   reports never learned a party's exposure had moved.
 *
 *   This service consolidates the mutation + the broadcast into ONE place:
 *     • transaction.service   → routes its 10 call-sites here
 *     • bill.service          → increments on AP recognition, decrements on pay
 *     • invoice.service       → increments on AR recognition, decrements on pay
 *
 * DESIGN PRINCIPLES (aligned with the refactor's mandatory rules):
 *   • The balance write is AWAITED — it is a real ledger-adjacent mutation that
 *     must complete. (Rule 5 — double-entry integrity: GL control account ==
 *     sum of party balances.)
 *   • The event broadcast is FIRE-AND-FORGET via businessEvents.emit — a
 *     subscriber failure can never roll back a balance write or break journal
 *     balancing. (Rule 3)
 *   • Every mutation carries businessId; the repos validate the party id is a
 *     real ObjectId. Tenant isolation is preserved end-to-end. (Rule 10)
 *   • No-ops are cheap and safe: a missing party id or a zero delta short-circuits
 *     before any DB call, so callers don't need to guard.
 *
 * USAGE
 * ─────
 *   const partyBalanceService = require('./partyBalance.service');
 *
 *   // Customer now owes 1000 more (a credit sale was recognized):
 *   await partyBalanceService.adjustReceivable(businessId, customerId, +1000, {
 *     userId, reason: 'credit_sale', entityType: 'journal_entry', entityId: txId,
 *   });
 *
 *   // We now owe a vendor 500 less (a bill was paid):
 *   await partyBalanceService.adjustPayable(businessId, vendorId, -500, {
 *     userId, reason: 'bill_paid', entityType: 'bill', entityId: billId,
 *   });
 */

'use strict';

const { ApiError } = require('../utils/ApiError');
const customerRepository = require('../repositories/customer.repository');
const vendorRepository = require('../repositories/vendor.repository');
const { businessEvents, EVENTS } = require('./businessEventEngine.service');

/** Round to 2dp so floating-point drift never accumulates on a balance. */
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

class PartyBalanceService {
  /**
   * Adjust a customer's outstanding receivable (what they owe us) and broadcast
   * CUSTOMER_BALANCE_CHANGED.
   *
   * @param {string} businessId
   * @param {string} customerId   may be a populated doc or raw id; null skips
   * @param {number} delta        +ve increases AR (new sale), -ve decreases (payment/reversal)
   * @param {Object} [ctx]
   * @param {string} [ctx.userId]
   * @param {string} [ctx.reason]      e.g. 'credit_sale' | 'payment_received' | 'reversal'
   * @param {string} [ctx.entityType]  source entity that drove the change
   * @param {string} [ctx.entityId]
   * @returns {Promise<Object|null>}   the updated customer doc, or null on no-op
   */
  async adjustReceivable(businessId, customerId, delta, ctx = {}) {
    const id = this._normalizeId(customerId);
    const amount = round2(delta);
    if (!id || amount === 0) return null; // nothing to do — safe no-op

    const updated = await customerRepository.updateReceivableBalance(id, amount, ctx.session || null);
    if (!updated) {
      // The party was deleted between the ledger write and this balance update.
      // Throw so the enclosing transaction rolls back — a posted AR move with no
      // matching customer balance is a real divergence, not something to swallow
      // (audit Phase 1.4).
      throw new ApiError(404, `Cannot update receivable: customer ${id} not found.`);
    }

    businessEvents.emit(EVENTS.CUSTOMER_BALANCE_CHANGED, {
      businessId,
      userId:     ctx.userId || null,
      entityType: 'customer',
      entityId:   updated._id,
      customerId: updated._id,
      delta:      amount,
      newBalance: round2(updated.currentReceivableBalance),
      reason:     ctx.reason || 'adjustment',
      sourceType: ctx.entityType || null,
      sourceId:   ctx.entityId != null ? String(ctx.entityId) : null,
    });

    return updated;
  }

  /**
   * Adjust a vendor's outstanding payable (what we owe them) and broadcast
   * VENDOR_BALANCE_CHANGED.
   *
   * @param {string} businessId
   * @param {string} vendorId     may be a populated doc or raw id; null skips
   * @param {number} delta        +ve increases AP (new bill), -ve decreases (payment/reversal)
   * @param {Object} [ctx]        same shape as adjustReceivable's ctx
   * @returns {Promise<Object|null>}   the updated vendor doc, or null on no-op
   */
  async adjustPayable(businessId, vendorId, delta, ctx = {}) {
    const id = this._normalizeId(vendorId);
    const amount = round2(delta);
    if (!id || amount === 0) return null; // nothing to do — safe no-op

    const updated = await vendorRepository.updatePayableBalance(id, amount, ctx.session || null);
    if (!updated) {
      throw new ApiError(404, `Cannot update payable: vendor ${id} not found.`);
    }

    businessEvents.emit(EVENTS.VENDOR_BALANCE_CHANGED, {
      businessId,
      userId:     ctx.userId || null,
      entityType: 'vendor',
      entityId:   updated._id,
      vendorId:   updated._id,
      delta:      amount,
      newBalance: round2(updated.currentPayableBalance),
      reason:     ctx.reason || 'adjustment',
      sourceType: ctx.entityType || null,
      sourceId:   ctx.entityId != null ? String(ctx.entityId) : null,
    });

    return updated;
  }

  /**
   * Accept either a raw id, a string, or a populated Mongoose doc/sub-doc and
   * return a usable id string (or null). Lets callers pass `tx.customerId`
   * whether it's populated (`{ _id }`) or a bare ObjectId.
   * @private
   */
  _normalizeId(ref) {
    if (ref == null) return null;
    if (typeof ref === 'string') return ref;
    if (typeof ref === 'object') {
      if (ref._id != null) return String(ref._id);
      return String(ref);
    }
    return String(ref);
  }
}

module.exports = new PartyBalanceService();
