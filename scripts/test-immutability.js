require('dotenv').config({ path: '.env.local' });
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
const mongoose = require('mongoose');
const JournalEntry = require('../models/JournalEntry.model');
const connectDB = require('../config/database');
const { JOURNAL_STATUS } = require('../config/constants');
const logger = require('../config/logger');

async function testHook() {
  await connectDB();
  
  // Find a posted journal entry
  const entry = await JournalEntry.findOne({ status: JOURNAL_STATUS.POSTED });
  if (!entry) {
    logger.info('No posted journal entries found to test.');
    process.exit(0);
  }

  logger.info(`Found posted journal entry ${entry._id}. Attempting to mutate its amount...`);

  try {
    await JournalEntry.findOneAndUpdate(
      { _id: entry._id },
      { $set: { amount: entry.amount + 100 } }
    );
    logger.error('FAIL: Hook did not block the mutation!');
    process.exit(1);
  } catch (err) {
    if (err.statusCode === 403 && err.message.includes('Cannot mutate financial fields')) {
      logger.info('PASS: Immutability hook successfully blocked the mutation with a 403.');
    } else {
      logger.error(`FAIL: Hook threw unexpected error: ${err.message}`);
      process.exit(1);
    }
  }

  logger.info('Attempting to mutate a non-financial field (notes)...');
  try {
    await JournalEntry.findOneAndUpdate(
      { _id: entry._id },
      { $set: { notes: 'Updated notes during test' } }
    );
    logger.info('PASS: Hook correctly allowed non-financial field mutation.');
    process.exit(0);
  } catch (err) {
    logger.error(`FAIL: Hook blocked a non-financial mutation: ${err.message}`);
    process.exit(1);
  }
}

testHook();
