'use strict';
jest.mock('../../../services/closeAgent.service', () => ({
  findCloseablePeriod: jest.fn(), dueRecognitionCount: jest.fn(),
}));
jest.mock('../../../services/fixedAsset.service', () => ({ isDepreciationDue: jest.fn() }));
jest.mock('../../../services/ledgerIntegrity.service', () => ({ computeDrift: jest.fn() }));
jest.mock('../../../models/FixedAsset.model', () => ({ find: jest.fn() }));
jest.mock('../../../models/PendingTransaction.model', () => ({ countDocuments: jest.fn() }));
jest.mock('../../../models/BankStatement.model', () => ({ aggregate: jest.fn() }));
jest.mock('../../../repositories/aiDecision.repository', () => ({ outcomeBreakdown: jest.fn() }));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const closeAgent = require('../../../services/closeAgent.service');
const fixedAsset = require('../../../services/fixedAsset.service');
const ledgerIntegrity = require('../../../services/ledgerIntegrity.service');
const FixedAsset = require('../../../models/FixedAsset.model');
const PendingTransaction = require('../../../models/PendingTransaction.model');
const BankStatement = require('../../../models/BankStatement.model');
const aiDecisionRepo = require('../../../repositories/aiDecision.repository');
const svc = require('../../../services/closeReadiness.service');
const BIZ = '507f1f77bcf86cd799439099';

const PERIOD = { _id: 'p1', name: 'June 2026', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-30'), status: 'open' };

function allClearMocks() {
  closeAgent.findCloseablePeriod.mockResolvedValue(PERIOD);
  closeAgent.dueRecognitionCount.mockResolvedValue(0);
  FixedAsset.find.mockReturnValue({ lean: () => Promise.resolve([]) });
  fixedAsset.isDepreciationDue.mockReturnValue(false);
  PendingTransaction.countDocuments.mockResolvedValue(0);
  BankStatement.aggregate.mockResolvedValue([]);
  ledgerIntegrity.computeDrift.mockResolvedValue({ balanced: true, driftedCount: 0, totalAbsDrift: 0 });
  aiDecisionRepo.outcomeBreakdown.mockResolvedValue({ pending: 0, accepted: 0, corrected: 0, reversed: 0 });
}

beforeEach(() => { jest.clearAllMocks(); allClearMocks(); });

describe('closeReadiness.service.getReadiness', () => {
  it('returns 100/ready with every check green', async () => {
    const r = await svc.getReadiness(BIZ);
    expect(r.closeable).toBe(true);
    expect(r.period.name).toBe('June 2026');
    expect(r.score).toBe(100);
    expect(r.ready).toBe(true);
    expect(r.checks.every(c => c.ok)).toBe(true);
  });

  it('reports no closeable period without inventing a checklist', async () => {
    closeAgent.findCloseablePeriod.mockResolvedValue(null);
    const r = await svc.getReadiness(BIZ);
    expect(r.closeable).toBe(false);
    expect(r.checks).toHaveLength(0);
  });

  it('an unbalanced ledger blocks readiness (heaviest check)', async () => {
    ledgerIntegrity.computeDrift.mockResolvedValue({ balanced: false, driftedCount: 2, totalAbsDrift: 500 });
    const r = await svc.getReadiness(BIZ);
    expect(r.ready).toBe(false);
    expect(r.blockers[0].key).toBe('ledger');
    expect(r.score).toBeLessThan(100);
  });

  it('due depreciation and pending approvals fail their checks with counts', async () => {
    FixedAsset.find.mockReturnValue({ lean: () => Promise.resolve([{ _id: 'a1' }, { _id: 'a2' }]) });
    fixedAsset.isDepreciationDue.mockReturnValueOnce(true).mockReturnValueOnce(false);
    PendingTransaction.countDocuments.mockResolvedValue(3);
    const r = await svc.getReadiness(BIZ);
    const dep = r.checks.find(c => c.key === 'depreciation');
    const app = r.checks.find(c => c.key === 'approvals');
    expect(dep.ok).toBe(false); expect(dep.count).toBe(1);
    expect(app.ok).toBe(false); expect(app.count).toBe(3);
  });

  it('is fault-isolated — a failing source becomes a failed check, not a crash', async () => {
    ledgerIntegrity.computeDrift.mockRejectedValue(new Error('db down'));
    const r = await svc.getReadiness(BIZ);
    const ledger = r.checks.find(c => c.key === 'ledger');
    expect(ledger.ok).toBe(false);
    expect(r.ready).toBe(false);
  });
});
