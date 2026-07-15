/**
 * tests/live/indexes.live.test.js
 *
 * Every declared index must actually be creatable by mongod.
 *
 * This exists because seven were not — and nobody could tell, because an index
 * that mongod rejects fails at build time, and nothing ever built them. Mongoose
 * only creates indexes lazily against a live connection, and no test in this
 * repo had one. So these silently did not exist, in test AND in production:
 *
 *   JournalEntry  idx_tax_report        sparse + partialFilterExpression
 *   JournalEntry  idx_je_invoice_number sparse + partialFilterExpression (UNIQUE)
 *   InventoryItem barcode               sparse + partialFilterExpression (UNIQUE)
 *   InventoryItem sku                   $ne in partialFilterExpression  (UNIQUE)
 *   Customer      email                 $ne in partialFilterExpression  (UNIQUE)
 *   Vendor        email                 $ne in partialFilterExpression  (UNIQUE)
 *   PayrollRun    businessId+period     $ne in partialFilterExpression  (UNIQUE)
 *
 * Five were UNIQUE constraints protecting nothing: duplicate invoice numbers,
 * SKUs, barcodes, customer/vendor emails, and duplicate payroll runs for one
 * period were all silently possible.
 *
 * mongod accepts only equality, $exists:true, $gt/$gte/$lt/$lte, $type, $in and
 * top-level $and in a partialFilterExpression. It rejects any negation —
 * $ne, $not, $nin, $exists:false — and rejects mixing `sparse` with
 * `partialFilterExpression` at all.
 */
'use strict';

const mongoose = require('mongoose');
const { startLiveDb, stopLiveDb } = require('./harness');

jest.setTimeout(120000);

beforeAll(startLiveDb);
afterAll(stopLiveDb);

describe('index specifications', () => {
  it('every declared index in every model is creatable by mongod', async () => {
    const rejected = [];
    for (const [name, Model] of Object.entries(mongoose.models)) {
      try {
        await Model.createIndexes();
      } catch (err) {
        rejected.push(`${name}: ${err.message.split('::').pop().trim().split('\n')[0]}`);
      }
    }
    expect(rejected).toEqual([]);
  });

  it('no partialFilterExpression uses an operator mongod rejects', async () => {
    // Belt and braces: createIndexes() above would already fail, but this names
    // the offending spec instead of just the model, which is what you actually
    // need at 2am.
    const BANNED = ['$ne', '$not', '$nin'];
    const offenders = [];
    for (const [name, Model] of Object.entries(mongoose.models)) {
      for (const [keys, opts] of Model.schema.indexes()) {
        const pfe = opts?.partialFilterExpression;
        if (!pfe) continue;
        const json = JSON.stringify(pfe);
        for (const op of BANNED) {
          if (json.includes(`"${op}"`)) offenders.push(`${name} ${JSON.stringify(keys)} uses ${op}`);
        }
        if (opts.sparse) offenders.push(`${name} ${JSON.stringify(keys)} mixes sparse with partialFilterExpression`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the unique constraints that were never real', () => {
  it('rejects a duplicate invoice number within one business', async () => {
    const JournalEntry = require('../../models/JournalEntry.model');
    await JournalEntry.createIndexes();
    const businessId = new mongoose.Types.ObjectId();
    const doc = () => ({
      businessId,
      invoiceNumber: 'INV-DUP-1',
      transactionDate: new Date(),
      description: 'dup test',
      transactionType: 'journal_entry',
      amount: 10,
      debitAccountId: new mongoose.Types.ObjectId(),
      creditAccountId: new mongoose.Types.ObjectId(),
      status: 'posted',
      inputMethod: 'form',
      createdBy: new mongoose.Types.ObjectId(),
    });

    await mongoose.connection.db.collection('journalentries').insertOne(doc());
    await expect(
      mongoose.connection.db.collection('journalentries').insertOne(doc())
    ).rejects.toThrow(/E11000|duplicate/i);
  });

  it('lets the same invoice number exist in a different business', async () => {
    const JournalEntry = require('../../models/JournalEntry.model');
    await JournalEntry.createIndexes();
    const doc = (businessId) => ({
      businessId,
      invoiceNumber: 'INV-SHARED',
      transactionDate: new Date(),
      amount: 10,
      status: 'posted',
    });
    const col = mongoose.connection.db.collection('journalentries');
    await col.insertOne(doc(new mongoose.Types.ObjectId()));
    await expect(col.insertOne(doc(new mongoose.Types.ObjectId()))).resolves.toBeTruthy();
  });

  it('still allows many entries that carry no invoice number at all', async () => {
    // The partial filter must exclude nulls, or a unique index would allow only
    // ONE journal entry per business — which is why the filter exists.
    const JournalEntry = require('../../models/JournalEntry.model');
    await JournalEntry.createIndexes();
    const businessId = new mongoose.Types.ObjectId();
    const col = mongoose.connection.db.collection('journalentries');
    const doc = () => ({ businessId, invoiceNumber: null, amount: 1, status: 'posted' });
    await col.insertOne(doc());
    await expect(col.insertOne(doc())).resolves.toBeTruthy();
  });

  it('rejects a second live payroll run for the same period, but allows one after a reversal', async () => {
    const PayrollRun = require('../../models/PayrollRun.model');
    await PayrollRun.createIndexes();
    const businessId = new mongoose.Types.ObjectId();
    const col = mongoose.connection.db.collection('payrollruns');

    await col.insertOne({ businessId, period: '2026-03', status: 'posted' });
    await expect(
      col.insertOne({ businessId, period: '2026-03', status: 'posted' })
    ).rejects.toThrow(/E11000|duplicate/i);

    // A reversed run leaves the period free to be run again.
    await col.updateOne({ businessId, period: '2026-03' }, { $set: { status: 'reversed' } });
    await expect(
      col.insertOne({ businessId, period: '2026-03', status: 'posted' })
    ).resolves.toBeTruthy();
  });
});
