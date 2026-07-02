'use strict';
jest.mock('../../../services/aiCalibration.service', () => ({ computeAcceptanceStats: jest.fn(), getEffectiveAutoPostThreshold: jest.fn() }));
jest.mock('../../../services/stpScorecard.service', () => ({ getScorecard: jest.fn() }));
jest.mock('../../../services/closeReadiness.service', () => ({ getReadiness: jest.fn() }));
jest.mock('../../../services/businessHealth.service', () => ({ getHealthScore: jest.fn() }));
jest.mock('../../../models/EntityMemory.model', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const calibration = require('../../../services/aiCalibration.service');
const stpScorecard = require('../../../services/stpScorecard.service');
const closeReadiness = require('../../../services/closeReadiness.service');
const businessHealth = require('../../../services/businessHealth.service');
const EntityMemory = require('../../../models/EntityMemory.model');
const svc = require('../../../services/brainContext.service');
const BIZ = '507f1f77bcf86cd799439099';

function allHealthy() {
  calibration.computeAcceptanceStats.mockResolvedValue({ resolved: 40, acceptanceRate: 0.9, reversalRate: 0.02 });
  calibration.getEffectiveAutoPostThreshold.mockResolvedValue(0.98);
  stpScorecard.getScorecard.mockResolvedValue({ stpScore: 0.7, windowDays: 90 });
  closeReadiness.getReadiness.mockResolvedValue({ closeable: true, score: 90, ready: false });
  businessHealth.getHealthScore.mockResolvedValue({ insufficient: false, overall: 78, level: 'good' });
  EntityMemory.find.mockReturnValue({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([
    { kind: 'nl_description_accounts', key: 'paid electricity bill', hits: 6 },
  ]) }) }) });
  EntityMemory.countDocuments.mockResolvedValue(12);
}

beforeEach(() => { jest.clearAllMocks(); allHealthy(); });

describe('brainContext.service.getContext', () => {
  it('aggregates learning, calibration, automation, close, and health into one context', async () => {
    const ctx = await svc.getContext(BIZ);
    expect(ctx.learning.totalLearnedFacts).toBe(12);
    expect(ctx.learning.recent[0].key).toBe('paid electricity bill');
    expect(ctx.calibration.effectiveAutoPostThreshold).toBe(0.98);
    expect(ctx.automation.stpScore).toBe(0.7);
    expect(ctx.close.score).toBe(90);
    expect(ctx.health.overall).toBe(78);
    expect(ctx.asOf).toBeTruthy();
  });

  it('every section is tenant-scoped', async () => {
    await svc.getContext(BIZ);
    expect(calibration.computeAcceptanceStats).toHaveBeenCalledWith(BIZ, expect.any(Object));
    expect(stpScorecard.getScorecard).toHaveBeenCalledWith(BIZ, expect.any(Object));
    expect(EntityMemory.countDocuments).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ }));
  });

  it('is fault-isolated — a failing section reports null, the rest still load', async () => {
    businessHealth.getHealthScore.mockRejectedValue(new Error('reports down'));
    const ctx = await svc.getContext(BIZ);
    expect(ctx.health).toBeNull();
    expect(ctx.automation.stpScore).toBe(0.7);
  });
});
