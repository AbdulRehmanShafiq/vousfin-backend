// scripts/requireEmailVerification.js
// Enforce "everyone must verify" for EXISTING accounts created while verification
// was switched off: flips active local accounts back to PENDING with a fresh
// verification token, so they must verify on next login (Google accounts are
// already verified and are left alone). Read-only by default.
//
// SAFETY: run ONLY after the resend/verify flow is confirmed working and the
// owner's own account can be re-verified — this WILL require every listed user to
// re-verify before their next login.
//
//   node scripts/requireEmailVerification.js                       # dry-run (list who'd be affected)
//   node scripts/requireEmailVerification.js --apply               # apply to all active local users
//   node scripts/requireEmailVerification.js --apply --except a@b.com,c@d.com   # skip some
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');

(async () => {
  const apply = process.argv.includes('--apply');
  const exceptArg = process.argv.find((a) => a.startsWith('--except='))
    || (process.argv.includes('--except') ? process.argv[process.argv.indexOf('--except') + 1] : '');
  const except = String(exceptArg).replace('--except=', '').split(',').map((s) => s.toLowerCase().trim()).filter(Boolean);

  await mongoose.connect(process.env.MONGO_URI);
  const User = require('../models/User.model');
  const { USER_STATUS, AUTH_PROVIDERS } = require('../config/constants');

  const localProvider = (AUTH_PROVIDERS && AUTH_PROVIDERS.LOCAL) || 'local';
  const candidates = await User.find({
    status: USER_STATUS.ACTIVE,
    authProvider: localProvider,
    email: { $nin: except },
  }).select('_id email');

  console.log(`${candidates.length} active local account(s) would be required to re-verify` + (except.length ? ` (excluding ${except.join(', ')})` : '') + ':');
  candidates.forEach((u) => console.log(`  - ${u.email}`));

  if (!apply) {
    console.log('\n[dry-run] no changes made. Re-run with --apply to enforce.');
  } else {
    let n = 0;
    for (const u of candidates) {
      u.status = USER_STATUS.PENDING;
      u.verificationToken = crypto.randomBytes(32).toString('hex');
      await u.save();
      n += 1;
    }
    console.log(`\n✓ ${n} account(s) set to PENDING — they must verify their email on next login.`);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
