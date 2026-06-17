'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../services/actionRouter.service', () => ({ propose: jest.fn() }));
jest.mock('../../../services/recognitionSchedule.service', () => ({ postDueRecognitions: jest.fn() }));
jest.mock('../../../services/cfoReport.service', () => ({ generate: jest.fn() }));
jest.mock('../../../services/accountingPeriod.service', () => ({ closePeriod: jest.fn(), reopenPeriod: jest.fn() }));
jest.mock('../../../models/AccountingPeriod.model', () => ({ findOne: jest.fn() }), { virtual: true });
jest.mock('../../../models/RecognitionSchedule.model', () => ({ countDocuments: jest.fn() }), { virtual: true });
jest.mock('../../../repositories/proposedAction.repository', () => ({ latestBySource: jest.fn() }));

const actionRouter = require('../../../services/actionRouter.service');
const recognitionSchedule = require('../../../services/recognitionSchedule.service');
const cfoReport = require('../../../services/cfoReport.service');
const accountingPeriod = require('../../../services/accountingPeriod.service');
const AccountingPeriod = require('../../../models/AccountingPeriod.model');
const RecognitionSchedule = require('../../../models/RecognitionSchedule.model');
const repo = require('../../../repositories/proposedAction.repository');
const agent = require('../../../services/closeAgent.service');

const BIZ = 'biz1';
const NOW = new Date('2026-06-17T00:00:00Z');
const PERIOD = { _id: 'per1', name: 'May 2026', periodType: 'monthly', startDate: '2026-05-01', endDate: '2026-05-31', status: 'open' };
// findOne(...).sort(...).lean()  AND  findOne(...).lean()
const chain = (v) => ({ sort: () => chain(v), lean: () => Promise.resolve(v) });

beforeEach(() => {
  jest.clearAllMocks();
  AccountingPeriod.findOne.mockReturnValue(chain(PERIOD));
  RecognitionSchedule.countDocuments.mockResolvedValue(0);
  repo.latestBySource.mockResolvedValue(null);
  actionRouter.propose.mockResolvedValue({ _id: 'a1', status: 'queued' });
});

describe('findCloseablePeriod', () => {
  it('queries for an ended-but-open monthly period', async () => {
    const p = await agent.findCloseablePeriod(BIZ, NOW);
    expect(AccountingPeriod.findOne).toHaveBeenCalledWith(expect.objectContaining({
      businessId: BIZ, periodType: 'monthly', status: 'open', endDate: { $lt: NOW },
    }));
    expect(p).toBe(PERIOD);
  });
});

describe('scanBusiness', () => {
  it('proposes a close_month when a month has ended and is still open', async () => {
    RecognitionSchedule.countDocuments.mockResolvedValue(2);
    const n = await agent.scanBusiness(BIZ, { id: 'u1' }, NOW);
    expect(n).toBe(1);
    expect(actionRouter.propose).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'close', type: 'close_month',
      title: 'Close May 2026',
      payload: expect.objectContaining({ periodId: 'per1', dueRecognitions: 2 }),
      sourceType: 'period_close', sourceId: 'per1',
    }));
    expect(actionRouter.propose.mock.calls[0][0].summary).toMatch(/Post 2 recognition entries/);
  });

  it('proposes nothing when there is no closeable period', async () => {
    AccountingPeriod.findOne.mockReturnValue(chain(null));
    expect(await agent.scanBusiness(BIZ, {}, NOW)).toBe(0);
    expect(actionRouter.propose).not.toHaveBeenCalled();
  });

  it('skips a period already proposed/handled', async () => {
    repo.latestBySource.mockResolvedValue({ status: 'queued' });
    expect(await agent.scanBusiness(BIZ, {}, NOW)).toBe(0);
  });
});

describe('executeCloseMonth', () => {
  const action = { businessId: BIZ, payload: { periodId: 'per1', periodName: 'May 2026', userId: 'u1' } };

  it('posts due recognitions, files the CFO report, and closes the period', async () => {
    recognitionSchedule.postDueRecognitions.mockResolvedValue({ linesPosted: 3 });
    cfoReport.generate.mockResolvedValue({ month: '2026-05' });
    accountingPeriod.closePeriod.mockResolvedValue({ status: 'closed' });
    const r = await agent.executeCloseMonth(action);
    expect(recognitionSchedule.postDueRecognitions).toHaveBeenCalledWith(BIZ, expect.any(Date));
    expect(cfoReport.generate).toHaveBeenCalled();
    expect(accountingPeriod.closePeriod).toHaveBeenCalledWith(BIZ, 'per1', 'u1', expect.any(String));
    expect(r).toMatchObject({ periodClosed: true, recognitionsPosted: 3, reportMonth: '2026-05' });
  });

  it('refuses to close a period that is already closed', async () => {
    AccountingPeriod.findOne.mockReturnValue(chain({ ...PERIOD, status: 'closed' }));
    await expect(agent.executeCloseMonth(action)).rejects.toThrow(/already closed/i);
    expect(accountingPeriod.closePeriod).not.toHaveBeenCalled();
  });

  it('still closes even if recognition posting or the report fails (best-effort)', async () => {
    recognitionSchedule.postDueRecognitions.mockRejectedValue(new Error('recog down'));
    cfoReport.generate.mockRejectedValue(new Error('report down'));
    accountingPeriod.closePeriod.mockResolvedValue({ status: 'closed' });
    const r = await agent.executeCloseMonth(action);
    expect(r).toMatchObject({ periodClosed: true, recognitionsPosted: 0, reportMonth: null });
    expect(accountingPeriod.closePeriod).toHaveBeenCalled();
  });
});

describe('reverseCloseMonth', () => {
  it('reopens the period', async () => {
    accountingPeriod.reopenPeriod.mockResolvedValue({ status: 'open' });
    const r = await agent.reverseCloseMonth({ businessId: BIZ, payload: { periodId: 'per1', periodName: 'May 2026', userId: 'u1' } });
    expect(accountingPeriod.reopenPeriod).toHaveBeenCalledWith(BIZ, 'per1', 'u1', expect.any(String));
    expect(r).toMatchObject({ reopened: true });
  });
});
