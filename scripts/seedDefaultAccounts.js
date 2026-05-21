// scripts/seedDefaultAccounts.js
const mongoose = require('mongoose');
const readline = require('readline');
const config = require('../config');
const Business = require('../models/Business.model');
const ChartOfAccount = require('../models/ChartOfAccount.model');
const { DEFAULT_ACCOUNTS } = require('../config/constants');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

/**
 * Seed default accounts for a specific business.
 * @param {string} businessId
 * @returns {Promise<number>} Number of accounts inserted
 */
const seedAccountsForBusiness = async (businessId) => {
  // Check if accounts already exist for this business
  const existingCount = await ChartOfAccount.countDocuments({ businessId });
  if (existingCount > 0) {
    console.log(`⚠️  Business ${businessId} already has ${existingCount} accounts.`);
    const answer = await question('Do you want to delete existing accounts and reseed? (y/n): ');
    if (answer.toLowerCase() !== 'y') {
      console.log('❌ Aborted');
      return 0;
    }
    await ChartOfAccount.deleteMany({ businessId });
    console.log('✅ Existing accounts deleted');
  }

  // Prepare accounts
  const accountsToInsert = DEFAULT_ACCOUNTS.map(acc => ({
    ...acc,
    businessId,
    runningBalance: 0,
  }));

  const result = await ChartOfAccount.insertMany(accountsToInsert);
  console.log(`✅ Inserted ${result.length} default accounts for business ${businessId}`);
  return result.length;
};

/**
 * Main function.
 */
const seedDefaultAccounts = async () => {
  try {
    await mongoose.connect(config.MONGO_URI);
    console.log('✅ Connected to MongoDB');

    // Ask for business identifier
    console.log('You can provide a business ID or a user email to look up the business.\n');
    const input = await question('Enter Business ID or User Email: ');
    let business;

    // Check if input is a valid ObjectId
    const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(input);
    if (isValidObjectId) {
      business = await Business.findById(input);
    } else {
      // Treat as email – find user first, then business
      const User = require('../models/User.model');
      const user = await User.findOne({ email: input.toLowerCase() });
      if (!user) {
        throw new Error(`User not found with email: ${input}`);
      }
      business = await Business.findOne({ userId: user._id });
      if (!business) {
        throw new Error(`No business found for user ${input}`);
      }
    }

    if (!business) {
      throw new Error(`Business not found for input: ${input}`);
    }

    console.log(`\nFound business: ${business.businessName} (ID: ${business._id})`);
    const confirm = await question('Seed default accounts for this business? (y/n): ');
    if (confirm.toLowerCase() !== 'y') {
      console.log('❌ Aborted');
      process.exit(0);
    }

    const count = await seedAccountsForBusiness(business._id);
    if (count > 0) {
      console.log(`✅ Successfully seeded ${count} default accounts.`);
    }
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    rl.close();
  }
};

seedDefaultAccounts();