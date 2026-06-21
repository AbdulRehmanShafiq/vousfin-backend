const repo = require('../../../repositories/reportTemplate.repository');
const ReportTemplate = require('../../../models/ReportTemplate.model');

jest.mock('../../../models/ReportTemplate.model');

describe('reportTemplate.repository', () => {
  beforeEach(() => jest.clearAllMocks());

  test('findScheduledDue queries enabled + due templates', async () => {
    const lean = jest.fn().mockResolvedValue([{ _id: 't1' }]);
    ReportTemplate.find.mockReturnValue({ lean });
    const now = new Date('2026-06-21T06:00:00Z');
    const r = await repo.findScheduledDue(now);
    expect(ReportTemplate.find).toHaveBeenCalledWith({
      'schedule.enabled': true,
      'schedule.nextRunAt': { $lte: now },
    });
    expect(r).toEqual([{ _id: 't1' }]);
  });
});
