#!/usr/bin/env node
/**
 * scripts/backfillStockMovements.js
 *
 * Inventory Engine Phase 1 — seed OPENING BALANCES into the stock sub-ledger.
 *
 * Stock bought before the sub-ledger existed has no movements, so an item's
 * cached quantity/value legitimately exceeds Σ(movements) and the integrity
 * gate reports false drift. This script writes ONE `opening` movement per item
 * representing the position the sub-ledger never saw.
 *
 * It posts NO journal entry — the general ledger already booked that stock when
 * it was purchased. This only seeds the sub-ledger projection so it agrees with
 * the books that already exist.
 *
 * Opening quantity is derived, not assumed:
 *   - no movements yet      → opening = the item's current cached position
 *   - movements exist       → opening = (first movement's balance-after) minus
 *                             that movement's own effect  ← the position it started from
 *
 * Idempotent: an item that already has an `opening` movement is skipped.
 *
 * Usage:
 *   node scripts/backfillStockMovements.js                 # dry run (default)
 *   node scripts/backfillStockMovements.js --apply         # write
 *   node scripts/backfillStockMovements.js --apply --business=<id>
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const InventoryItem = require('../models/InventoryItem.model');
const StockMovement = require('../models/StockMovement.model');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const businessArg = args.find((a) => a.startsWith('--business='));
const BUSINESS_ID = businessArg ? businessArg.split('=')[1] : null;

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');
  await mongoose.connect(uri);
  console.log(`[backfill] connected — mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  const itemFilter = BUSINESS_ID ? { businessId: new mongoose.Types.ObjectId(BUSINESS_ID) } : {};
  const items = await InventoryItem.find(itemFilter).select('businessId name sku currentStock unitCostPrice').lean();
  console.log(`[backfill] ${items.length} item(s) in scope`);

  let seeded = 0, skipped = 0, zero = 0;

  for (const item of items) {
    const existingOpening = await StockMovement.findOne({
      businessId: item.businessId, itemId: item._id, movementType: 'opening',
    }).select('_id').lean();
    if (existingOpening) { skipped += 1; continue; }

    const first = await StockMovement.findOne({ businessId: item.businessId, itemId: item._id })
      .sort({ movementDate: 1, _id: 1 })
      .select('direction qty value balanceQtyAfter balanceValueAfter movementDate')
      .lean();

    let openQty, openValue, when;
    if (!first) {
      // Nothing recorded yet — the whole cached position is the opening balance.
      openQty = r2(item.currentStock || 0);
      openValue = r2((item.currentStock || 0) * (item.unitCostPrice || 0));
      when = new Date();
    } else {
      // Rewind the first movement to find the position it started from.
      const sign = first.direction === 'in' ? 1 : -1;
      openQty = r2((first.balanceQtyAfter || 0) - sign * (first.qty || 0));
      openValue = r2((first.balanceValueAfter || 0) - sign * (first.value || 0));
      when = new Date(new Date(first.movementDate).getTime() - 1000); // strictly before
    }

    if (openQty <= 0 && Math.abs(openValue) < 0.01) { zero += 1; continue; }

    const unitCost = openQty > 0 ? r2(openValue / openQty) : 0;
    console.log(
      `[backfill] ${APPLY ? 'seed' : 'would seed'} "${item.name}"${item.sku ? ` (${item.sku})` : ''}: ` +
      `${openQty} @ ${unitCost} = ${openValue}`
    );

    if (APPLY) {
      await StockMovement.create([{
        businessId: item.businessId,
        itemId: item._id,
        direction: 'in',
        movementType: 'opening',
        qty: openQty,
        unitCost,
        value: openValue,
        balanceQtyAfter: openQty,
        balanceValueAfter: openValue,
        source: { docType: 'OpeningBalance', docId: null },
        journalEntryId: null, // the GL already carries this stock — no journal here
        movementDate: when,
        reason: 'count_correction',
        notes: 'Opening balance — stock recorded before the stock ledger existed',
      }]);
    }
    seeded += 1;
  }

  console.log(`[backfill] ${APPLY ? 'seeded' : 'would seed'}: ${seeded} · already seeded: ${skipped} · nothing to seed: ${zero}`);
  if (!APPLY) console.log('[backfill] dry run — re-run with --apply to write');
  await mongoose.disconnect();
}

main().catch((e) => { console.error('[backfill] failed:', e); process.exit(1); });
