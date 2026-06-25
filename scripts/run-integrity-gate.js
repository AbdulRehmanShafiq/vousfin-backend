require('dotenv').config({ path: '.env.local' });
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
const mongoose = require('mongoose');
const { computeDrift } = require('../services/ledgerIntegrity.service');
const Business = require('../models/Business.model');
const connectDB = require('../config/database');
const logger = require('../config/logger');

async function runGate() {
  logger.info('Starting Ledger Integrity CI Gate...');
  
  if (!process.env.MONGO_URI) {
    logger.error('MONGO_URI is missing. Set it in .env.local or environment.');
    process.exit(1);
  }

  try {
    await connectDB();
    logger.info('Connected to database.');

    const businesses = await Business.find({ isActive: true }).select('_id name').lean();
    if (businesses.length === 0) {
      logger.info('No active businesses found. Skipping scan. Gate Passed.');
      process.exit(0);
    }

    let failed = false;

    for (const b of businesses) {
      try {
        const drift = await computeDrift(String(b._id));
        if (drift.driftedCount > 0 || !drift.balanced) {
          logger.error(`\n[FAILED] Business ${b.name} (${b._id}) has ledger drift!`);
          logger.error(`  Balanced: ${drift.balanced}`);
          logger.error(`  Total Debits: ${drift.totalDebits}`);
          logger.error(`  Total Credits: ${drift.totalCredits}`);
          logger.error(`  Accounts Drifted: ${drift.driftedCount}`);
          logger.error(`  Total Absolute Drift: ${drift.totalAbsDrift}`);
          
          drift.accounts.filter(a => a.drift !== 0).forEach(a => {
            logger.error(`    - Account ${a.name} (${a.code}): Cached ${a.cached}, Derived ${a.derived}, Drift: ${a.drift}`);
          });

          failed = true;
        } else {
          logger.info(`[PASS] Business ${b.name} (${b._id}) is balanced with 0 drift.`);
        }
      } catch (err) {
        logger.error(`Error scanning business ${b.name} (${b._id}): ${err.message}`);
        failed = true;
      }
    }

    if (failed) {
      logger.error('\nCI Gate FAILED: Ledger integrity compromised. Rejecting deployment/commit.');
      process.exit(1);
    } else {
      logger.info('\nCI Gate PASSED: All ledgers are perfectly balanced.');
      process.exit(0);
    }

  } catch (err) {
    logger.error(`CI Gate Error: ${err.message}`);
    process.exit(1);
  }
}

runGate();
