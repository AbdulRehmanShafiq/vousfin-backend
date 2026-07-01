// scripts/ledgerDrift.js — canonical journal-lines program, Phase 0
//
// READ-ONLY. Reports running-balance drift (cached vs journal-derived) for one
// business or all businesses. Run before/after any ledger migration.
//
//   node scripts/ledgerDrift.js              # all businesses, summary
//   node scripts/ledgerDrift.js <businessId> # one business, per-account detail
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  // Register every model so aggregations/populate resolve.
  const modelsDir = path.join(__dirname, '..', 'models');
  for (const f of fs.readdirSync(modelsDir).filter((f) => f.endsWith('.model.js'))) require(path.join(modelsDir, f));

  const integrity = require('../services/ledgerIntegrity.service');
  const Business = require('../models/Business.model');

  const target = process.argv[2];
  const businesses = target
    ? [{ _id: target, businessName: '(requested)' }]
    : await Business.find({}).select('_id businessName').lean();

  let worst = 0, anyUnbalanced = false;
  for (const b of businesses) {
    const d = await integrity.computeDrift(String(b._id));
    const flag = d.totalAbsDrift === 0 && d.balanced ? 'OK ' : '!! ';
    if (d.totalAbsDrift > worst) worst = d.totalAbsDrift;
    if (!d.balanced) anyUnbalanced = true;
    console.log(`${flag}${String(b._id)} ${b.businessName || ''} — drift ${d.totalAbsDrift} across ${d.driftedCount} acct(s), balanced=${d.balanced} (Dr ${d.totalDebits} / Cr ${d.totalCredits})`);
    if (target) {
      for (const a of d.accounts.filter((a) => a.drift !== 0)) {
        console.log(`     ${a.code} ${a.name}: cached ${a.cached} vs derived ${a.derived} → drift ${a.drift}`);
      }
    }
    // VE-5/VE-6 sub-ledger reconcile (party balances vs party-linked ledger).
    try {
      const s = await integrity.computeArApSubledgerDrift(String(b._id));
      if (!s.reconciled) anyUnbalanced = true;
      console.log(`   ${s.reconciled ? 'ok ' : '!! '}sub-ledger: AR drift ${s.ar.subledgerDrift} (unattributed ${s.ar.unattributed}), AP drift ${s.ap.subledgerDrift} (unattributed ${s.ap.unattributed})`);
    } catch (e) {
      console.log(`   -- sub-ledger check skipped: ${e.message}`);
    }
  }
  console.log(`\nSummary: ${businesses.length} business(es), worst drift ${worst}, any unbalanced: ${anyUnbalanced}`);
  await mongoose.disconnect();
})().catch((e) => { console.error('drift scan error:', e.message); process.exit(1); });
