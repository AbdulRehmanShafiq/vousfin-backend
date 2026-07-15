// services/assembly.service.js
//
// Inventory Engine Phase 9 — assemblies / manufacturing.
//
// Building turns components into a finished good. Value is CONSERVED, not
// created: the finished good is worth exactly what went into it (components at
// their real cost + any labour). Nothing is earned by building — profit is
// earned when it sells.
//
//   components out (their cost)  →  finished good in (rolled-up cost)
//
// Because both sides hit the same Inventory account, a components-only build
// nets to zero and needs NO journal — posting one would debit and credit 1150
// for the same amount, which says nothing. A journal IS posted when labour is
// capitalized, since that moves value from Direct Labour into Inventory:
//
//   DR 1150 Inventory / CR 5120 Direct Labour
'use strict';

const mongoose = require('mongoose');
const BillOfMaterials = require('../models/BillOfMaterials.model');
const InventoryItem = require('../models/InventoryItem.model');
const inventoryService = require('./inventory.service');
const { postBalancedJournal } = require('./ledgerPosting.service');
const { withTransaction } = require('../utils/withTransaction');
const { quoteConsumption, r2 } = require('../utils/inventoryCosting.util');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const {
  TRANSACTION_TYPES, TRANSACTION_SOURCES, JOURNAL_STATUS, INPUT_METHODS,
} = require('../config/constants');

const actorId = (user) => user?._id || user?.id || null;

class AssemblyService {
  async createBom(businessId, data, user) {
    if (!businessId) throw new ApiError(400, 'Business ID is required');
    if (!mongoose.Types.ObjectId.isValid(String(data?.itemId))) throw new ApiError(400, 'Choose which item this recipe makes');
    const components = (data.components || []).filter((c) => c?.itemId && Number(c.qtyPerUnit) > 0);
    if (components.length === 0) throw new ApiError(400, 'A recipe needs at least one component');
    if (components.some((c) => String(c.itemId) === String(data.itemId))) {
      throw new ApiError(400, 'An item cannot be made out of itself');
    }
    const item = await InventoryItem.findOne({ _id: data.itemId, businessId }).lean();
    if (!item) throw new ApiError(404, 'Inventory item not found');

    return BillOfMaterials.create({
      businessId,
      itemId: data.itemId,
      name: data.name || `${item.name} recipe`,
      outputQty: Number(data.outputQty) > 0 ? Number(data.outputQty) : 1,
      components,
      labourCostPerRun: Number(data.labourCostPerRun) || 0,
      notes: data.notes || null,
      createdBy: actorId(user),
    });
  }

  async listBoms(businessId, { itemId = null } = {}) {
    const q = { businessId, isActive: true };
    if (itemId) q.itemId = itemId;
    return BillOfMaterials.find(q)
      .populate('itemId', 'name sku unit')
      .populate('components.itemId', 'name sku unit currentStock unitCostPrice')
      .sort({ createdAt: -1 })
      .lean();
  }

  /**
   * What one run would cost and whether it can be built right now — a pure
   * read used to preview a build (and to answer "can I make 10 of these?").
   */
  async quoteBuild(businessId, bomId, runs = 1) {
    const bom = await BillOfMaterials.findOne({ _id: bomId, businessId }).lean();
    if (!bom) throw new ApiError(404, 'Recipe not found');
    const n = Number(runs) > 0 ? Number(runs) : 1;

    const needs = [];
    let componentCost = 0;
    let buildable = true;

    for (const c of bom.components) {
      const item = await InventoryItem.findOne({ _id: c.itemId, businessId }).lean();
      if (!item) throw new ApiError(404, 'A component of this recipe no longer exists');
      const need = r2(c.qtyPerUnit * n * (1 + (c.scrapPct || 0) / 100));
      const { cogsAmount } = quoteConsumption(item, need);
      componentCost = r2(componentCost + cogsAmount);
      const short = need > item.currentStock;
      if (short) buildable = false;
      needs.push({
        itemId: item._id, name: item.name, unit: item.unit,
        need, onHand: r2(item.currentStock), cost: cogsAmount,
        short: short ? r2(need - item.currentStock) : 0,
      });
    }

    const labour = r2((bom.labourCostPerRun || 0) * n);
    const outputQty = r2(bom.outputQty * n);
    const totalCost = r2(componentCost + labour);
    return {
      bomId: bom._id, runs: n, outputQty,
      componentCost, labourCost: labour, totalCost,
      unitCost: outputQty > 0 ? r2(totalCost / outputQty) : 0,
      components: needs, buildable,
    };
  }

  /**
   * Build it. Components leave stock at their real cost, the finished good
   * enters at the rolled-up total — atomically, with movements on both sides.
   */
  async build(businessId, p = {}, user) {
    const runs = Number(p.runs) > 0 ? Number(p.runs) : 1;
    const quote = await this.quoteBuild(businessId, p.bomId, runs);
    if (!quote.buildable) {
      const short = quote.components.filter((c) => c.short > 0)
        .map((c) => `${c.name} (short ${c.short} ${c.unit || 'units'})`).join(', ');
      throw new ApiError(400, `Not enough stock to build this: ${short}.`);
    }

    const bom = await BillOfMaterials.findOne({ _id: p.bomId, businessId }).lean();
    const when = p.date ? new Date(p.date) : new Date();
    let result = null;

    await withTransaction(async (s) => {
      // 1. Components out, at their real cost.
      let actualComponentCost = 0;
      for (const c of quote.components) {
        const res = await inventoryService.reduceStock(businessId, c.itemId, c.need, s, {
          movementType: 'assembly_out',
          source: { docType: 'Assembly', docId: bom._id },
          notes: p.notes || `Used to build ${quote.outputQty} × finished goods`,
          userId: actorId(user),
          warehouseId: p.warehouseId || null,
        });
        actualComponentCost = r2(actualComponentCost + (res.cogsAmount || 0));
      }

      // 2. Labour capitalized — the only leg with a real accounting effect.
      let journalEntryId = null;
      const labour = quote.labourCost;
      if (labour >= 0.01) {
        const ChartOfAccount = require('../models/ChartOfAccount.model');
        const { inventoryAccountId } = await inventoryService.resolveCostAccounts(businessId);
        const labourAcct = await ChartOfAccount.findOne({ businessId, accountCode: '5120' }).lean();
        if (!inventoryAccountId || !labourAcct) {
          throw new ApiError(400,
            'Your chart of accounts is missing the Inventory (1150) or Direct Labour (5120) account, so the labour on this build cannot be recorded. Open Chart of Accounts to restore the defaults, then try again.');
        }
        const je = await postBalancedJournal({
          businessId,
          transactionDate: when,
          description: `Labour built into stock — ${quote.outputQty} × ${bom.name || 'assembly'}`,
          transactionType: TRANSACTION_TYPES.JOURNAL_ENTRY,
          amount: labour,
          debitAccountId: inventoryAccountId, // value into the finished good
          creditAccountId: labourAcct._id,    // out of labour cost
          status: JOURNAL_STATUS.POSTED,
          transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
          inputMethod: INPUT_METHODS.FORM,
          createdBy: actorId(user),
          lastModifiedBy: actorId(user),
        }, { session: s });
        journalEntryId = je._id;
      }

      // 3. Finished good in, at what it actually cost to make.
      const totalCost = r2(actualComponentCost + labour);
      const unitCost = quote.outputQty > 0 ? r2(totalCost / quote.outputQty) : 0;
      await inventoryService.applyPurchaseStock(businessId, bom.itemId, quote.outputQty, unitCost, {
        session: s, userId: actorId(user),
        movementType: 'assembly_in',
        source: { docType: 'Assembly', docId: bom._id },
        journalEntryId,
        warehouseId: p.warehouseId || null,
        lot: p.lot || null,
        notes: p.notes || `Built from ${quote.components.length} component(s)`,
      });

      result = {
        bomId: bom._id, runs, outputQty: quote.outputQty,
        componentCost: actualComponentCost, labourCost: labour,
        totalCost, unitCost, journalEntryId,
      };
    });

    logger.info(`[assembly] built ${result.outputQty} of item ${bom.itemId} for ${result.totalCost} (${result.unitCost}/unit)`);
    return result;
  }
}

module.exports = new AssemblyService();
