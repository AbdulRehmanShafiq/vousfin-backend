// scripts/recomputeLedgerBalances.js — canonical journal-lines program, Phase 5
//
// Repairs cached running-balance drift by setting each account to its
// journal-derived balance (the journal is authoritative). SAFE:
//   • dry-run by default — prints the per-account changes, writes nothing
//   • refuses to apply when a business's journal is unbalanced (Dr ≠ Cr)
//   • snapshots current runningBalances to a timestamped JSON before applying
//     (full rollback), then re-verifies drift → 0 after
//
//   node scripts/recomputeLedgerBalances.js                      # dry-run, all businesses
//   node scripts/recomputeLedgerBalances.js <businessId>         # dry-run, one business
//   node scripts/recomputeLedgerBalances.js <businessId> --apply # APPLY to one business
//   node scripts/recomputeLedgerBalances.js --all --apply        # APPLY to all (use with care)
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

(async () => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const all = args.includes('--all');
  const businessId = args.find((a) => !a.startsWith('--'));

  if (apply && !businessId && !all) {
    console.error('Refusing to --apply without a <businessId> or explicit --all.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  const modelsDir = path.join(__dirname, '..', 'models');
  for (const f of fs.readdirSync(modelsDir).filter((f) => f.endsWith('.model.js'))) require(path.join(modelsDir, f));

  const integrity = require('../services/ledgerIntegrity.service');
  const Business = require('../models/Business.model');
  const Account = require('../models/ChartOfAccount.model');

  const businesses = businessId
    ? [{ _id: businessId, businessName: '(requested)' }]
    : await Business.find({}).select('_id businessName').lean();

  // Snapshot BEFORE any write (rollback safety).
  if (apply) {
    const ids = businesses.map((b) => new mongoose.Types.ObjectId(String(b._id)));
    const snap = await Account.find({ businessId: { $in: ids } })
      .select('_id businessId accountCode runningBalance').lean();
    const file = path.join(__dirname, `balance-snapshot-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(snap, null, 2));
    console.log(`Snapshot of ${snap.length} account balances written to ${file} (rollback safety)\n`);
  }

  let totalChanged = 0;
  for (const b of businesses) {
    try {
      const res = await integrity.recomputeBusinessBalances(String(b._id), { apply });
      if (res.changeCount === 0) {
        console.log(`OK  ${b._id} ${b.businessName || ''} — no drift`);
        continue;
      }
      totalChanged += res.changeCount;
      console.log(`${apply ? 'FIXED' : 'WOULD FIX'}  ${b._id} ${b.businessName || ''} — ${res.changeCount} account(s), drift ${res.totalAbsDrift}`);
      for (const c of res.changes) {
        console.log(`     ${c.code} ${c.name}: ${c.from} → ${c.to}  (${c.delta >= 0 ? '+' : ''}${c.delta})`);
      }
      if (apply) {
        const after = await integrity.computeDrift(String(b._id));
        console.log(`     verify after: drift ${after.totalAbsDrift}, balanced ${after.balanced} ${after.totalAbsDrift === 0 ? '✓' : '✗ STILL DRIFTED'}`);
      }
    } catch (e) {
      console.error(`!!  ${b._id} ${b.businessName || ''} — ${e.message}`);
    }
  }

  console.log(`\n${apply ? 'Applied' : 'Dry-run'}: ${totalChanged} account balance(s) ${apply ? 'corrected' : 'would change'} across ${businesses.length} business(es).`);
  if (!apply && totalChanged > 0) console.log('Re-run with <businessId> --apply to write (a snapshot is taken first).');
  await mongoose.disconnect();
})().catch((e) => { console.error('recompute error:', e.message); process.exit(1); });
