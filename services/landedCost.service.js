// services/landedCost.service.js
//
// Inventory Engine Phase 4 — landed costs.
//
// Freight, duty and insurance are part of what stock COST you (IAS 2.11), not
// a period expense. This service spreads those charges across the goods on a
// receipt and capitalizes them into the items' cost, so margin tells the truth.
//
//   DR 1150 Inventory            (allocated to each item)
//   CR 1157 Landed Cost Clearing (total)
//
// The clearing account is the honest half: it holds the charge until the
// freight/customs bill actually arrives and is coded to 1157, which drains it
// to zero. A balance left in 1157 means a bill you are still expecting.
//
// Quantity never moves — these are value-only movements (qty 0).
'use strict';

const mongoose = require('mongoose');
const GoodsReceipt = require('../models/GoodsReceipt.model');
const InventoryItem = require('../models/InventoryItem.model');
const inventoryService = require('./inventory.service');
const stockMovementService = require('./stockMovement.service');
const { postCompoundJournal } = require('./ledgerPosting.service');
const { withTransaction } = require('../utils/withTransaction');
const { allocateByWeights, addValueToLayers, r2 } = require('../utils/inventoryCosting.util');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const {
  TRANSACTION_TYPES, TRANSACTION_SOURCES, JOURNAL_STATUS, INPUT_METHODS,
} = require('../config/constants');

const ALLOCATION_METHODS = ['value', 'quantity', 'weight'];
const actorId = (user) => user?._id || user?.id || null;

class LandedCostService {
  /**
   * Spread additional costs over the stocked lines of a goods receipt.
   *
   * @param {string} businessId
   * @param {Object} p  { grnId, charges: [{ description, amount }], method,
   *                      weights?: { [inventoryItemId]: number }, date?, notes? }
   * @param {Object} user
   * @returns {Promise<{ total, method, allocations, journalEntryId }>}
   */
  async apply(businessId, p = {}, user) {
    if (!businessId) throw new ApiError(400, 'Business ID is required');
    if (!mongoose.Types.ObjectId.isValid(String(p.grnId))) throw new ApiError(400, 'Invalid goods receipt id');

    const method = p.method || 'value';
    if (!ALLOCATION_METHODS.includes(method)) {
      throw new ApiError(400, `Allocation method must be one of: ${ALLOCATION_METHODS.join(', ')}`);
    }
    const charges = (p.charges || []).filter((c) => Number(c?.amount) > 0);
    if (charges.length === 0) throw new ApiError(400, 'Add at least one cost (freight, duty, insurance…) with an amount');
    const total = r2(charges.reduce((s, c) => s + Number(c.amount), 0));

    const grn = await GoodsReceipt.findOne({ _id: p.grnId, businessId });
    if (!grn) throw new ApiError(404, 'Goods receipt not found');
    if (!grn.inventoryApplied) {
      throw new ApiError(400, `Goods receipt ${grn.grnNumber} has not been received into stock yet — confirm it first, then add the shipping costs.`);
    }

    // Only stocked lines can carry cost; services and untracked lines cannot.
    const lines = (grn.receivedItems || [])
      .filter((ri) => ri.inventoryItemId)
      .map((ri) => ({
        itemId: ri.inventoryItemId,
        name: ri.name,
        qty: Math.max(0, Number(ri.quantityReceived || 0) - Number(ri.quantityRejected || 0)),
        unitCost: Number(ri.unitCost) || 0,
      }))
      .filter((l) => l.qty > 0);
    if (lines.length === 0) {
      throw new ApiError(400, `Goods receipt ${grn.grnNumber} has no stocked items to carry these costs.`);
    }

    const weights = lines.map((l) => {
      if (method === 'quantity') return l.qty;
      if (method === 'weight') return Number(p.weights?.[String(l.itemId)]) || 0;
      return r2(l.qty * l.unitCost); // value (default)
    });
    if (method === 'weight' && weights.every((w) => w <= 0)) {
      throw new ApiError(400, 'Allocating by weight needs a weight for at least one item.');
    }
    const shares = allocateByWeights(weights, total);

    const { inventoryAccountId } = await inventoryService.resolveCostAccounts(businessId);
    const ChartOfAccount = require('../models/ChartOfAccount.model');
    const clearing = await ChartOfAccount.findOne({ businessId, accountCode: '1157' }).lean();
    if (!inventoryAccountId || !clearing) {
      throw new ApiError(400,
        'Your chart of accounts is missing the Inventory (1150) or Landed Cost Clearing (1157) account, so these shipping costs cannot be added. Open Chart of Accounts once to add the defaults, then try again.');
    }

    const when = p.date ? new Date(p.date) : new Date();
    const allocations = [];
    let journalEntryId = null;

    await withTransaction(async (s) => {
      // One compound journal: every item's share debited, the clearing credited.
      const journalLines = lines.map((l, i) => ({
        type: 'debit', accountId: inventoryAccountId, amount: shares[i],
        description: `Landed cost — ${l.name}`,
      })).filter((jl) => jl.amount > 0);
      journalLines.push({
        type: 'credit', accountId: clearing._id, amount: total,
        description: charges.map((c) => c.description || 'cost').join(', '),
      });

      const je = await postCompoundJournal({
        businessId,
        transactionDate: when,
        description: `Shipping and import costs added to stock — ${grn.grnNumber}`,
        transactionType: TRANSACTION_TYPES.JOURNAL_ENTRY,
        amount: total,
        journalLines,
        status: JOURNAL_STATUS.POSTED,
        transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
        inputMethod: INPUT_METHODS.FORM,
        vendorId: grn.vendorId || null,
        createdBy: actorId(user),
        lastModifiedBy: actorId(user),
        metadata: { idempotencyKey: `landed:${grn._id}:${when.getTime()}` },
      }, { session: s });
      journalEntryId = je._id;

      // Capitalize each share into the item's cost — value up, quantity flat.
      for (let i = 0; i < lines.length; i += 1) {
        const share = shares[i];
        if (share <= 0) continue;
        const l = lines[i];
        const item = await InventoryItem.findOne({ _id: l.itemId, businessId }).session(s);
        if (!item) throw new ApiError(404, `Item "${l.name}" from this receipt no longer exists`);

        if (item.valuationMethod === 'fifo') {
          const res = addValueToLayers(item.costLayers || [], l.qty, share);
          item.costLayers = res.layers;
          const totQty = res.layers.reduce((sum, x) => sum + x.qty, 0);
          const totVal = res.layers.reduce((sum, x) => sum + x.qty * x.unitCost, 0);
          if (totQty > 0) item.unitCostPrice = r2(totVal / totQty);
        } else if (item.valuationMethod === 'standard') {
          // Standard cost is a policy, not a consequence of one shipment: the
          // charge belongs in variance, not in the item's carrying cost.
          logger.info(`[landedCost] "${item.name}" is standard-costed — ${share} left in variance, cost unchanged`);
        } else {
          const value = r2(item.currentStock * item.unitCostPrice + share);
          if (item.currentStock > 0) item.unitCostPrice = r2(value / item.currentStock);
        }
        await item.save({ session: s });

        await stockMovementService.record({
          businessId, itemId: item._id, direction: 'in', movementType: 'landed_cost',
          qty: 0, unitCost: item.unitCostPrice, value: share,
          balanceQtyAfter: item.currentStock,
          balanceValueAfter: r2(item.currentStock * item.unitCostPrice),
          source: { docType: 'GoodsReceipt', docId: grn._id },
          journalEntryId: je._id, movementDate: when,
          notes: p.notes || `Shipping/import costs — ${grn.grnNumber}`,
          createdBy: actorId(user),
        }, { session: s });

        allocations.push({ itemId: item._id, name: l.name, amount: share, newUnitCost: item.unitCostPrice });
      }
    });

    logger.info(`[landedCost] ${grn.grnNumber}: ${total} spread over ${allocations.length} item(s) by ${method}`);
    return { total, method, allocations, journalEntryId };
  }
}

module.exports = new LandedCostService();
module.exports.ALLOCATION_METHODS = ALLOCATION_METHODS;
