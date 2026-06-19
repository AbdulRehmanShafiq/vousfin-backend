/**
 * tests/unit/models/journalEntry.immutability.test.js
 *
 * Verifies that the JournalEntry model prevents creation and modification
 * of records falling into closed or locked accounting periods.
 */
'use strict';

const mongoose = require('mongoose');

jest.mock('../../../models/AccountingPeriod.model', () => {
  return {
    findCoveringPeriod: jest.fn(),
  };
});

const JournalEntry = require('../../../models/JournalEntry.model');
const AccountingPeriod = require('../../../models/AccountingPeriod.model');
const { PERIOD_STATUS, PERIOD_TYPE, TRANSACTION_TYPES, INPUT_METHODS, ENTRY_TYPE, TRANSACTION_SOURCES } = require('../../../config/constants');
const { ApiError } = require('../../../utils/ApiError');

describe('JournalEntry Period Immutability', () => {
  const businessId = new mongoose.Types.ObjectId();
  const debitAccountId = new mongoose.Types.ObjectId();
  const creditAccountId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();

  const mockJournalEntryData = (date) => ({
    businessId,
    transactionDate: date,
    description: 'Test entry',
    transactionType: TRANSACTION_TYPES.EXPENSE,
    amount: 100,
    debitAccountId,
    creditAccountId,
    inputMethod: INPUT_METHODS.FORM,
    createdBy: userId,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Default to no covering period
    AccountingPeriod.findCoveringPeriod.mockResolvedValue(null);
    
    // Mock the Mongoose model lookup used inside JournalEntry schema hooks
    mongoose.model = jest.fn((modelName) => {
      if (modelName === 'AccountingPeriod') {
        return AccountingPeriod;
      }
      return mongoose.models[modelName];
    });
  });

  describe('Pre-save Hook', () => {
    it('allows saving an entry when no covering period exists', async () => {
      const entry = new JournalEntry(mockJournalEntryData(new Date('2026-06-01')));
      
      // Override internal validate/save for unit testing the hook logic
      // We just want to execute the pre-save hooks manually to see if they throw
      await expect(entry.validate()).resolves.toBeUndefined();
    });

    it('allows saving an entry in an OPEN period', async () => {
      AccountingPeriod.findCoveringPeriod.mockResolvedValue({ status: PERIOD_STATUS.OPEN });
      const entry = new JournalEntry(mockJournalEntryData(new Date('2026-06-15')));
      
      let error;
      try {
        await entry.save({ validateBeforeSave: false }); // Will fail because no DB, but hook runs first
      } catch (e) {
        error = e;
      }
      // If it fails, it should NOT be our ApiError for closed periods
      expect(error).not.toBeInstanceOf(ApiError);
    });

    it('blocks saving an entry in a CLOSED period', async () => {
      AccountingPeriod.findCoveringPeriod.mockResolvedValue({ status: PERIOD_STATUS.CLOSED });
      const entry = new JournalEntry(mockJournalEntryData(new Date('2026-06-15')));
      
      await expect(entry.save({ validateBeforeSave: false })).rejects.toThrow(ApiError);
      await expect(entry.save({ validateBeforeSave: false })).rejects.toThrow(/closed accounting period/i);
    });

    it('blocks saving an entry in a LOCKED period', async () => {
      AccountingPeriod.findCoveringPeriod.mockResolvedValue({ status: PERIOD_STATUS.LOCKED });
      const entry = new JournalEntry(mockJournalEntryData(new Date('2026-06-15')));

      await expect(entry.save({ validateBeforeSave: false })).rejects.toThrow(ApiError);
      await expect(entry.save({ validateBeforeSave: false })).rejects.toThrow(/locked accounting period/i);
    });

    it('ALLOWS a system-generated closing entry into a CLOSED period (year-end close)', async () => {
      AccountingPeriod.findCoveringPeriod.mockResolvedValue({ status: PERIOD_STATUS.CLOSED });
      const entry = new JournalEntry({
        ...mockJournalEntryData(new Date('2026-12-31')),
        entryType: ENTRY_TYPE.CLOSING,
        transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
      });

      let error;
      try {
        await entry.save({ validateBeforeSave: false }); // fails on no DB, but our hook must NOT block
      } catch (e) {
        error = e;
      }
      expect(error).not.toBeInstanceOf(ApiError);
    });

    it('still BLOCKS a system-generated closing entry in a LOCKED period', async () => {
      AccountingPeriod.findCoveringPeriod.mockResolvedValue({ status: PERIOD_STATUS.LOCKED });
      const entry = new JournalEntry({
        ...mockJournalEntryData(new Date('2026-12-31')),
        entryType: ENTRY_TYPE.CLOSING,
        transactionSource: TRANSACTION_SOURCES.SYSTEM_GENERATED,
      });

      await expect(entry.save({ validateBeforeSave: false })).rejects.toThrow(/locked accounting period/i);
    });
  });
});
