/**
 * Migration script to add advanced transaction fields to existing JournalEntries.
 * This is a safe, additive migration. It does not overwrite any existing data.
 * Run via mongo shell or within a node script.
 */

const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/vousfin';

async function migrate() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('Connected.');

  const db = mongoose.connection.db;
  const journalEntries = db.collection('journalentries');

  console.log('Starting migration for advanced transaction fields...');

  const result = await journalEntries.updateMany(
    { paymentStatus: { $exists: false } },
    {
      $set: {
        transactionMode: 'cash',
        customerId: null,
        vendorId: null,
        dueDate: null,
        paymentStatus: null,
        remainingBalance: null,
        partiallyPaidAmount: 0,
        settlements: [],
        parentTransactionId: null,
        relatedTransactions: [],
        installmentPlanId: null,
        transactionReference: null,
        transactionCategory: null,
        transactionSource: 'manual',
        paymentTerms: null,
        notes: null,
        tags: [],
        attachmentUrls: [],
        metadata: {},
        affectsCashFlow: true,
        affectsProfitLoss: true,
        affectsBalanceSheet: true,
        currencyCode: null,
        exchangeRate: 1,
        baseCurrencyAmount: null, // Will need to be set properly if multi-currency used
        isArchived: false,
        archivedAt: null,
        archivedBy: null,
        journalLines: [],
      }
    }
  );

  console.log(`Migration completed. Modified ${result.modifiedCount} documents.`);

  // Fix baseCurrencyAmount based on existing amount where missing
  const currencyFixResult = await journalEntries.updateMany(
    { baseCurrencyAmount: null, amount: { $exists: true } },
    [{ $set: { baseCurrencyAmount: "$amount" } }]
  );

  console.log(`Fixed baseCurrencyAmount on ${currencyFixResult.modifiedCount} documents.`);

  await mongoose.disconnect();
  console.log('Disconnected from MongoDB.');
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
