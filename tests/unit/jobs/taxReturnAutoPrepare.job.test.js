'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../../../models/Business.model', () => ({ findById: jest.fn() }));
jest.mock('../../../repositories/taxReturn.repository', () => ({ findByPeriod: jest.fn() }));
jest.mock('../../../services/returnPrepare.service', () => ({ prepare: jest.fn() }));
jest.mock('../../../services/returnValidator.service', () => ({ validateReturn: jest.fn() }));

const Business        = require('../../../models/Business.model');
const taxReturnRepo   = require('../../../repositories/taxReturn.repository');
const returnPrepare   = require('../../../services/returnPrepare.service');
const returnValidator = require('../../../services/returnValidator.service');
const job             = require('../../../jobs/taxReturnAutoPrepare.job');

function mockBiz(taxConfig = { country: 'PK', autoPrepareDaysBefore: 5 }) {
  Business.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ taxConfig }) }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBiz();
  taxReturnRepo.findByPeriod.mockResolvedValue(null);
  returnPrepare.prepare.mockResolvedValue({ _id: 'ret1' });
  returnValidator.validateReturn.mockResolvedValue({});
});

describe('taxReturnAutoPrepare.prepareDueForBusiness', () => {
  it('auto-prepares + validates the GST-01 when it is exactly N days before the deadline', async () => {
    // GST-01 due 18th; as of 13 June → 5 days out → matches autoPrepareDaysBefore=5.
    const stats = await job.prepareDueForBusiness('biz1', new Date(2026, 5, 13));
    expect(returnPrepare.prepare).toHaveBeenCalledWith('biz1', 'GST-01', { year: 2026, month: 5 }, null);
    expect(returnValidator.validateReturn).toHaveBeenCalledWith('biz1', 'ret1');
    expect(stats.prepared).toBe(1);
  });

  it('is idempotent — skips a period already prepared past draft', async () => {
    taxReturnRepo.findByPeriod.mockResolvedValue({ _id: 'ret1', status: 'validated' });
    const stats = await job.prepareDueForBusiness('biz1', new Date(2026, 5, 13));
    expect(returnPrepare.prepare).not.toHaveBeenCalled();
    expect(stats.skipped).toBe(1);
  });

  it('does nothing when no deadline is N days out', async () => {
    const stats = await job.prepareDueForBusiness('biz1', new Date(2026, 5, 1)); // nothing 5 days out
    expect(returnPrepare.prepare).not.toHaveBeenCalled();
    expect(stats.prepared).toBe(0);
  });
});

describe('taxReturnAutoPrepare.scheduleAutoPrepare', () => {
  it('registers a daily cron', () => {
    const cron = require('node-cron');
    job.scheduleAutoPrepare();
    expect(cron.schedule).toHaveBeenCalledWith(expect.any(String), expect.any(Function), expect.objectContaining({ timezone: expect.any(String) }));
  });
});
