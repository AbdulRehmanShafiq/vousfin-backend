// tests/unit/services/eventSubscribers.budget.test.js
'use strict';
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../utils/reportCache', () => ({ invalidate: jest.fn() }));
jest.mock('../../../services/variance.service', () => ({ checkBreaches: jest.fn().mockResolvedValue() }));
jest.mock('../../../services/eventLog.service', () => ({ record: jest.fn().mockResolvedValue() }));
jest.mock('../../../services/arApReconciliation.service', () => ({ reconcileByJournalEntryId: jest.fn().mockResolvedValue() }));

const { businessEvents, EVENTS } = require('../../../services/businessEventEngine.service');
const subscribers = require('../../../services/eventSubscribers.service');
const variance = require('../../../services/variance.service');

describe('eventSubscribers — budget variance', () => {
  test('transaction.created triggers variance.checkBreaches with affected accounts', async () => {
    subscribers._resetForTest();
    subscribers.registerAll();
    businessEvents.emit(EVENTS.TRANSACTION_CREATED, {
      businessId: 'biz1',
      after: {
        transactionDate: new Date('2026-07-15'),
        debitAccountId: 'a1', creditAccountId: 'a2',
        journalLines: [{ accountId: 'a1', type: 'debit', amount: 100 }, { accountId: 'a2', type: 'credit', amount: 100 }],
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(variance.checkBreaches).toHaveBeenCalledWith('biz1',
      expect.arrayContaining(['a1', 'a2']), expect.objectContaining({ entryDate: expect.anything() }));
  });
});
