// scripts/verifyUserEmail.js
// Safety hatch: mark a single account's email as verified (status -> active),
// e.g. to recover an owner who got blocked after verification was turned on.
// Read-only by default; pass --apply to write.
//
//   node scripts/verifyUserEmail.js owner@example.com          # dry-run
//   node scripts/verifyUserEmail.js owner@example.com --apply  # verify it
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  const email = (process.argv[2] || '').toLowerCase().trim();
  const apply = process.argv.includes('--apply');
  if (!email || email.startsWith('--')) {
    console.error('Usage: node scripts/verifyUserEmail.js <email> [--apply]');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  const User = require('../models/User.model');
  const { USER_STATUS } = require('../config/constants');

  const user = await User.findOne({ email });
  if (!user) {
    console.error(`No user with email ${email}`);
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`Found ${email} — status="${user.status}", authProvider="${user.authProvider}"`);
  if (user.status === USER_STATUS.ACTIVE) {
    console.log('Already active — nothing to do.');
  } else if (!apply) {
    console.log(`[dry-run] would set status -> active and clear verificationToken. Re-run with --apply.`);
  } else {
    user.status = USER_STATUS.ACTIVE;
    user.verificationToken = null;
    await user.save();
    console.log('✓ Verified — the account can now log in.');
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
