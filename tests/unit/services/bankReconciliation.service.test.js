'use strict';

const mongoose = require('mongoose');
const bankStatementRepository = require('../../../repositories/bankStatement.repository');
const accountRepository = require('../../../repositories/account.repository');
const transactionRepository = require('../../../repositories/transaction.repository');
const auditService = require('../../../services/audit.service');
const bankReconciliationService = require('../../../services/bankReconciliation.service');

jest.mock('../../../repositories/bankStatement.repository');
jest.mock('../../../repositories/account.repository');
jest.mock('../../../repositories/transaction.repository');
jest.mock('../../../services/audit.service');

describe('bankReconciliation.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('autoMatch', () => {
    it('should match unmatched lines that have a proposed match >= 85 score', async () => {
      const statementId = new mongoose.Types.ObjectId().toString();
      const businessId = new mongoose.Types.ObjectId().toString();
      const mockStatement = {
        _id: statementId,
        businessId: businessId,
        bankAccountId: new mongoose.Types.ObjectId().toString(),
        lines: [
          {
            lineRef: 'L1',
            status: 'unmatched',
            proposedMatches: [
              { journalEntryId: 'JE1', score: 90, amountExact: true },
              { journalEntryId: 'JE2', score: 70, amountExact: true }
            ]
          },
          {
            lineRef: 'L2',
            status: 'unmatched',
            proposedMatches: [
              { journalEntryId: 'JE3', score: 80, amountExact: true }
            ]
          }
        ],
        save: jest.fn().mockResolvedValue(true)
      };

      bankStatementRepository.findOneByBusinessAndId = jest.fn().mockResolvedValue(mockStatement);
      bankStatementRepository.matchedJournalEntryIds = jest.fn().mockResolvedValue(new Set());

      const result = await bankReconciliationService.autoMatch(businessId, statementId, { id: 'user1' });

      expect(result.autoMatchedCount).toBe(1);
      expect(mockStatement.lines[0].status).toBe('matched');
      expect(mockStatement.lines[0].matchedJournalEntryId).toBe('JE1');
      expect(mockStatement.lines[1].status).toBe('unmatched');
      expect(mockStatement.save).toHaveBeenCalled();
    });
  });

  describe('acceptBatch', () => {
    it('should accept a batch of lines and match them to their top proposed match', async () => {
      const statementId = new mongoose.Types.ObjectId().toString();
      const businessId = new mongoose.Types.ObjectId().toString();
      const mockStatement = {
        _id: statementId,
        businessId: businessId,
        lines: [
          {
            lineRef: 'L1',
            status: 'unmatched',
            proposedMatches: [
              { journalEntryId: 'JE1', score: 80, amountExact: true }
            ]
          },
          {
            lineRef: 'L2',
            status: 'unmatched',
            proposedMatches: [
              { journalEntryId: 'JE2', score: 82, amountExact: true }
            ]
          }
        ],
        save: jest.fn().mockResolvedValue(true)
      };

      bankStatementRepository.findOneByBusinessAndId = jest.fn().mockResolvedValue(mockStatement);
      bankStatementRepository.matchedJournalEntryIds = jest.fn().mockResolvedValue(new Set());

      const result = await bankReconciliationService.acceptBatch(businessId, statementId, ['L1', 'L2'], { id: 'user1' });

      expect(result.acceptedCount).toBe(2);
      expect(mockStatement.lines[0].status).toBe('matched');
      expect(mockStatement.lines[0].matchedJournalEntryId).toBe('JE1');
      expect(mockStatement.lines[1].status).toBe('matched');
      expect(mockStatement.lines[1].matchedJournalEntryId).toBe('JE2');
      expect(mockStatement.save).toHaveBeenCalled();
    });
  });
});
