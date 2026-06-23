// scripts/backfillOwnerMemberships.js — Phase 6A
//
// Ensures every existing business owner has an `owner` Membership (idempotent),
// so legacy single-user businesses keep full access under the new RBAC layer.
// Read-only by default; pass --apply to write.
//
//   node scripts/backfillOwnerMemberships.js          # dry-run (report only)
//   node scripts/backfillOwnerMemberships.js --apply  # create missing owner memberships
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

(async () => {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI);
  // Register every model so refs resolve.
  const modelsDir = path.join(__dirname, '..', 'models');
  for (const f of fs.readdirSync(modelsDir).filter((x) => x.endsWith('.model.js'))) require(path.join(modelsDir, f));

  const User = require('../models/User.model');
  const membershipRepo = require('../repositories/membership.repository');
  const membershipService = require('../services/membership.service');

  // Every user that owns/belongs to a business.
  const users = await User.find({ businessId: { $ne: null } }).select('_id businessId email').lean();
  let created = 0, already = 0;
  for (const u of users) {
    const existing = await membershipRepo.findByBusinessAndUser(u.businessId, u._id);
    if (existing) { already++; continue; }
    if (apply) {
      await membershipService.ensureOwnerMembership(u.businessId, u._id);
      created++;
      console.log(`+ owner membership: user ${u.email || u._id} → business ${u.businessId}`);
    } else {
      console.log(`WOULD create owner membership: user ${u.email || u._id} → business ${u.businessId}`);
      created++;
    }
  }

  console.log(`\nSummary: ${users.length} business user(s); ${created} ${apply ? 'created' : 'would create'}, ${already} already had a membership.${apply ? '' : '  (dry-run — re-run with --apply to write)'}`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error('backfill failed:', e.message); process.exit(1); });
