'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../services/reconciler.service', () => ({ scanBusiness: jest.fn() }));
jest.mock('../../../services/collector.service', () => ({ scanBusiness: jest.fn() }));
jest.mock('../../../services/paymentsAgent.service', () => ({ scanBusiness: jest.fn() }));
jest.mock('../../../services/closeAgent.service', () => ({ scanBusiness: jest.fn() }));
jest.mock('../../../models/PlanRun.model', () => ({ create: jest.fn(), findOne: jest.fn() }), { virtual: true });

const reconciler = require('../../../services/reconciler.service');
const collector = require('../../../services/collector.service');
const paymentsAgent = require('../../../services/paymentsAgent.service');
const closeAgent = require('../../../services/closeAgent.service');
const PlanRun = require('../../../models/PlanRun.model');
const orchestrator = require('../../../services/orchestrator.service');

const BIZ = 'biz1';

beforeEach(() => {
  jest.clearAllMocks();
  reconciler.scanBusiness.mockResolvedValue(2);
  collector.scanBusiness.mockResolvedValue(1);
  paymentsAgent.scanBusiness.mockResolvedValue(3);
  closeAgent.scanBusiness.mockResolvedValue(1);
  // create() returns a live doc whose steps array the orchestrator mutates.
  PlanRun.create.mockImplementation((doc) => Promise.resolve({
    ...doc, save: jest.fn().mockResolvedValue({}), toObject() { return { ...this }; },
  }));
});

describe('listPlaybooks', () => {
  it('offers the weekly cash cycle and the monthly close, in step order', () => {
    const pbs = orchestrator.listPlaybooks();
    const keys = pbs.map(p => p.key);
    expect(keys).toEqual(expect.arrayContaining(['weekly_cash', 'monthly_close']));
    const cash = pbs.find(p => p.key === 'weekly_cash');
    expect(cash.steps.map(s => s.capability)).toEqual(['reconciliation', 'collections', 'payments']);
  });
});

describe('runPlaybook', () => {
  it('runs each step in order, records what each surfaced, and completes', async () => {
    const run = await orchestrator.runPlaybook(BIZ, 'weekly_cash', { id: 'u1' });
    expect(reconciler.scanBusiness).toHaveBeenCalledWith(BIZ, { id: 'u1' });
    expect(collector.scanBusiness).toHaveBeenCalledWith(BIZ, { id: 'u1' });
    expect(paymentsAgent.scanBusiness).toHaveBeenCalledWith(BIZ, { id: 'u1' });
    expect(run.status).toBe('completed');
    expect(run.totalProposed).toBe(6); // 2 + 1 + 3
    expect(run.steps.map(s => [s.capability, s.proposed, s.status])).toEqual([
      ['reconciliation', 2, 'done'],
      ['collections', 1, 'done'],
      ['payments', 3, 'done'],
    ]);
  });

  it('includes the close step for the monthly close', async () => {
    const run = await orchestrator.runPlaybook(BIZ, 'monthly_close', { id: 'u1' });
    expect(closeAgent.scanBusiness).toHaveBeenCalled();
    expect(run.steps.map(s => s.capability)).toEqual(['reconciliation', 'collections', 'payments', 'close']);
    expect(run.totalProposed).toBe(7);
  });

  it('records a failed step but still completes the run', async () => {
    collector.scanBusiness.mockRejectedValue(new Error('collector down'));
    const run = await orchestrator.runPlaybook(BIZ, 'weekly_cash', {});
    expect(run.status).toBe('completed');
    expect(run.steps[1]).toMatchObject({ capability: 'collections', status: 'failed', error: 'collector down' });
    expect(run.totalProposed).toBe(5); // 2 + 0 + 3
  });

  it('rejects an unknown routine', async () => {
    await expect(orchestrator.runPlaybook(BIZ, 'nope', {})).rejects.toThrow(/Unknown routine/i);
  });
});

describe('getLatestPlan', () => {
  it('returns the most recent plan run', async () => {
    PlanRun.findOne.mockReturnValue({ sort: () => ({ lean: () => Promise.resolve({ playbook: 'weekly_cash' }) }) });
    expect(await orchestrator.getLatestPlan(BIZ)).toMatchObject({ playbook: 'weekly_cash' });
  });
});
