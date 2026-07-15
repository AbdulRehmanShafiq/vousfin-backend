// services/inventoryAdjustment.service.js
//
// Inventory Engine Phase 2 — stock adjustments, physical counts and
// revaluations (incl. IAS 2 NRV write-downs).
//
// Every adjustment is ONE atomic unit: item mutation + StockMovement + a
// balanced journal entry commit together or not at all. JE recipes (spec §2.3):
//   increase / count gain : DR 1150 Inventory        / CR 6495 Inventory Write-off (contra)
//   decrease / write-off  : DR 6495 Inventory Write-off / CR 1150 Inventory
//   revalue down (NRV)    : DR 6495                  / CR 1150   (value-only, qty 0)
//   revalue up            : DR 1150                  / CR 6495   (nrv_reversal capped per IAS 2.33)
'use strict';

const mongoose = require('mongoose');
const InventoryItem = require('../models/InventoryItem.model');
const inventoryService = require('./inventory.service');
const stockMovementService = require('./stockMovement.service');
const { postBalancedJournal } = require('./ledgerPosting.service');
const { withTransaction } = require('../utils/withTransaction');
const { quoteConsumption } = require('../utils/inventoryCosting.util');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const {
  TRANSACTION_TYPES, TRANSACTION_SOURCES, JOURNAL_STATUS, INPUT_METHODS,
} = require('../config/constants');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// The auth middleware attaches a plain `{ id, email, role, businessId }` object,
// while service-to-service callers pass a mongoose user doc (`_id`). Accept both
// so `createdBy` is never silently undefined (which the JE rejects at validation).
const actorId = (user) => user?._id || user?.id || null;

const ADJUSTMENT_TYPES = ['increase', 'decrease', 'write_off', 'count', 'revalue'];
const REASON_CODES = [
  'damaged', 'expired', 'lost', 'theft', 'found', 'count_correction',
  'nrv_write_down', 'nrv_reversal', 'cost_correction', 'other',
];

// Plain-language labels for JE descriptions (owners read these, not accountants).
const REASON_LABELS = {
  damaged: 'damaged stock', expired: 'expired stock', lost: 'lost stock',
  theft: 'stolen stock', found: 'stock found in count', count_correction: 'stock count correction',
  nrv_write_down: 'value written down to selling price (NRV)',
  nrv_reversal: 'earlier write-down reversed', cost_correction: 'cost correction', other: 'stock adjustment',
};

class InventoryAdjustmentService {
  /**
   * Resolve the Inventory (1150) + Inventory Write-off (6495) pair, fail-closed.
   */
  async _resolveAccounts(businessId) {
    const ChartOfAccount = require('../models/ChartOfAccount.model');
    const { inventoryAccountId } = await inventoryService.resolveCostAccounts(businessId);
    let writeOffAcct = await ChartOfAccount.findOne({ businessId, accountCode: '6495' }).lean();
    if (!writeOffAcct) {
      writeOffAcct = await ChartOfAccount.findOne({
        businessId, accountName: { $regex: /inventory write.?off/i },
      }).lean();
    }
    if (!inventoryAccountId || !writeOffAcct) {
      throw new ApiError(400,
        'Your chart of accounts is missing the Inventory (1150) or Inventory Write-off (6495) account, so this adjustment cannot be recorded. Open Chart of Accounts to restore the defaults, then try again.');
    }
    return { inventoryAccountId, writeOffAccountId: writeOffAcct._id };
  }

  /**
   * Apply one stock adjustment.
   *
   * @param {string} businessId
   * @param {string} itemId
   * @param {Object} p  { type, qty?, countedQty?, unitCost?, newUnitCost?, reason, notes?, date? }
   * @param {Object} user
   * @returns {Promise<Object>} summary { type, qtyDelta, valueDelta, journalEntryId, item }
   */
  async adjustStock(businessId, itemId, p = {}, user) {
    if (!businessId) throw new ApiError(400, 'Business ID is required');
    if (!mongoose.Types.ObjectId.isValid(String(itemId))) throw new ApiError(400, 'Invalid inventory item id');
    if (!ADJUSTMENT_TYPES.includes(p.type)) {
      throw new ApiError(400, `Adjustment type must be one of: ${ADJUSTMENT_TYPES.join(', ')}`);
    }
    const reason = p.reason || 'other';
    if (!REASON_CODES.includes(reason)) {
      throw new ApiError(400, `Reason must be one of: ${REASON_CODES.join(', ')}`);
    }

    const accounts = await this._resolveAccounts(businessId);
    const when = p.date ? new Date(p.date) : new Date();
    let result = null;

    await withTransaction(async (s) => {
      const item = await InventoryItem.findOne({ _id: itemId, businessId }).session(s);
      if (!item) throw new ApiError(404, 'Inventory item not found');

      if (p.type === 'revalue') {
        result = await this._revalue(item, p, reason, accounts, when, user, s);
        return;
      }

      // count → route the variance to increase/decrease with movementType 'count'
      let type = p.type;
      let qty = Number(p.qty);
      let movementType = null;
      if (p.type === 'count') {
        const counted = Number(p.countedQty);
        if (!(counted >= 0)) throw new ApiError(400, 'countedQty must be zero or more');
        const delta = r2(counted - item.currentStock);
        if (Math.abs(delta) < 0.0001) {
          result = { type: 'count', qtyDelta: 0, valueDelta: 0, journalEntryId: null, item, noChange: true };
          return;
        }
        type = delta > 0 ? 'increase' : 'decrease';
        qty = Math.abs(delta);
        movementType = 'count';
      }
      if (!(qty > 0)) throw new ApiError(400, 'Quantity must be greater than zero');

      if (type === 'increase') {
        const unitCost = Number(p.unitCost) > 0 ? Number(p.unitCost) : (item.unitCostPrice || 0);
        const value = r2(qty * unitCost);
        const je = await postBalancedJournal({
          businessId,
          transactionDate: when,
          description: `Stock increased — ${item.name}: ${qty} ${item.unit || 'units'} (${REASON_LABELS[reason]})`,
          // Repeatable on purpose: two identical write-offs/top-ups on the same
          // day are a real thing an owner does. Retry-safety belongs at the API.
          idempotencyKey: null,
          transactionType: TRANSACTION_TYPES.JOURNAL_ENTRY,
          amount: value,
          debitAccountId: accounts.inventoryAccountId,
          creditAccountId: accounts.writeOffAccountId,
          status: JOURNAL_STATUS.POSTED,
          transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
          inputMethod: INPUT_METHODS.FORM,
          inventoryItemId: item._id,
          inventoryQty: qty,
          createdBy: actorId(user),
          lastModifiedBy: actorId(user),
        }, { session: s });

        await inventoryService.applyPurchaseStock(businessId, item._id, qty, unitCost, {
          session: s, userId: actorId(user),
          movementType: movementType || 'adjustment_in',
          source: { docType: 'InventoryAdjustment', docId: je._id },
          journalEntryId: je._id, reason, notes: p.notes || null,
        });
        result = { type: p.type, qtyDelta: qty, valueDelta: value, journalEntryId: je._id, item };
        return;
      }

      // decrease / write_off — consume at the item's real cost (FIFO/WAC aware).
      if (qty > item.currentStock) {
        throw new ApiError(400, `Cannot remove ${qty} ${item.unit || 'units'} of "${item.name}" — only ${item.currentStock} in stock`);
      }
      const quote = quoteConsumption(item, qty);
      const je = await postBalancedJournal({
        businessId,
        transactionDate: when,
        description: `Stock ${type === 'write_off' ? 'written off' : 'decreased'} — ${item.name}: ${qty} ${item.unit || 'units'} (${REASON_LABELS[reason]})`,
        // Repeatable on purpose — see above.
        idempotencyKey: null,
        transactionType: TRANSACTION_TYPES.JOURNAL_ENTRY,
        amount: quote.cogsAmount,
        debitAccountId: accounts.writeOffAccountId,
        creditAccountId: accounts.inventoryAccountId,
        status: JOURNAL_STATUS.POSTED,
        transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
        inputMethod: INPUT_METHODS.FORM,
        inventoryItemId: item._id,
        inventoryQty: qty,
        createdBy: actorId(user),
        lastModifiedBy: actorId(user),
      }, { session: s });

      await inventoryService.reduceStock(businessId, item._id, qty, s, {
        movementType: movementType || (type === 'write_off' ? 'write_off' : 'adjustment_out'),
        source: { docType: 'InventoryAdjustment', docId: je._id },
        journalEntryId: je._id, reason, notes: p.notes || null, userId: actorId(user),
      });
      result = { type: p.type, qtyDelta: -qty, valueDelta: -quote.cogsAmount, journalEntryId: je._id, item };
    });

    logger.info(`[inventoryAdjustment] ${p.type} on item ${itemId} (${reason}): qtyΔ ${result?.qtyDelta}, valueΔ ${result?.valueDelta}`);
    return result;
  }

  /**
   * Value-only revaluation (weighted-average items). NRV write-downs use
   * reason 'nrv_write_down'; upward revaluations must be either a capped
   * 'nrv_reversal' (IAS 2.33 — never above the cumulative prior write-down)
   * or an explicit 'cost_correction'.
   * @private
   */
  async _revalue(item, p, reason, accounts, when, user, s) {
    if (item.valuationMethod === 'fifo') {
      throw new ApiError(400,
        `"${item.name}" uses FIFO batches — revalue it by adjusting stock out and back in at the new cost, or switch the item to weighted average first.`);
    }
    const newUnitCost = Number(p.newUnitCost);
    if (!(newUnitCost >= 0)) throw new ApiError(400, 'newUnitCost must be zero or more');
    const qtyOnHand = Number(item.currentStock) || 0;
    if (qtyOnHand <= 0) throw new ApiError(400, `"${item.name}" has no stock on hand to revalue`);

    const delta = r2(qtyOnHand * (newUnitCost - (item.unitCostPrice || 0)));
    if (Math.abs(delta) < 0.01) {
      return { type: 'revalue', qtyDelta: 0, valueDelta: 0, journalEntryId: null, item, noChange: true };
    }

    if (delta > 0) {
      if (reason === 'nrv_reversal') {
        // IAS 2.33 — a reversal never lifts value above the cumulative write-down.
        const StockMovement = require('../models/StockMovement.model');
        const [sums] = await StockMovement.aggregate([
          { $match: {
            businessId: new mongoose.Types.ObjectId(String(item.businessId)),
            itemId: item._id, movementType: 'revalue',
            reason: { $in: ['nrv_write_down', 'nrv_reversal'] },
          } },
          { $group: {
            _id: null,
            down: { $sum: { $cond: [{ $eq: ['$reason', 'nrv_write_down'] }, '$value', 0] } },
            up:   { $sum: { $cond: [{ $eq: ['$reason', 'nrv_reversal'] },   '$value', 0] } },
          } },
        ]).session(s);
        const headroom = r2((sums?.down || 0) - (sums?.up || 0));
        if (delta > headroom + 0.005) {
          throw new ApiError(400,
            `This reversal (${delta}) is more than the earlier write-downs still on the books (${Math.max(0, headroom)}). Inventory can only be written back up to its original cost.`);
        }
      } else if (reason !== 'cost_correction') {
        throw new ApiError(400,
          'Raising an item\'s value needs a reason: use "nrv_reversal" to undo an earlier write-down, or "cost_correction" to fix a wrong cost.');
      }
    }

    const down = delta < 0;
    const je = await postBalancedJournal({
      businessId: item.businessId,
      transactionDate: when,
      description: `Inventory revalued — ${item.name}: ${item.unitCostPrice} → ${newUnitCost} per ${item.unit || 'unit'} (${REASON_LABELS[reason]})`,
      // Repeatable on purpose: stock can be re-marked more than once.
      idempotencyKey: null,
      transactionType: TRANSACTION_TYPES.JOURNAL_ENTRY,
      amount: Math.abs(delta),
      debitAccountId: down ? accounts.writeOffAccountId : accounts.inventoryAccountId,
      creditAccountId: down ? accounts.inventoryAccountId : accounts.writeOffAccountId,
      status: JOURNAL_STATUS.POSTED,
      transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
      inputMethod: INPUT_METHODS.FORM,
      inventoryItemId: item._id,
      createdBy: actorId(user),
      lastModifiedBy: actorId(user),
    }, { session: s });

    item.unitCostPrice = newUnitCost;
    await item.save({ session: s });

    await stockMovementService.record({
      businessId: item.businessId, itemId: item._id,
      direction: down ? 'out' : 'in', movementType: 'revalue',
      qty: 0, unitCost: newUnitCost, value: Math.abs(delta),
      balanceQtyAfter: item.currentStock,
      balanceValueAfter: r2(item.currentStock * newUnitCost),
      source: { docType: 'InventoryAdjustment', docId: je._id },
      journalEntryId: je._id, reason, notes: p.notes || null, createdBy: actorId(user),
      movementDate: when,
    }, { session: s });

    return { type: 'revalue', qtyDelta: 0, valueDelta: delta, journalEntryId: je._id, item };
  }
}

module.exports = new InventoryAdjustmentService();
module.exports.ADJUSTMENT_TYPES = ADJUSTMENT_TYPES;
module.exports.REASON_CODES = REASON_CODES;
