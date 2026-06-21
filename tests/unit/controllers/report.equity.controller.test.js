'use strict';
// Unit test for the equity statement controller handler.
// No test-auth helper exists, so we test the controller directly by mocking
// its service dependency and asserting correct date parsing + response shape.

jest.mock('../../../services/report.service');

const reportService = require('../../../services/report.service');
const ApiResponse   = require('../../../utils/ApiResponse');

// Pull the handler under test after mocks are in place
const ctrl = require('../../../controllers/report.controller');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(query = {}) {
  return {
    query,
    user: { businessId: 'biz123' },
  };
}

function makeRes() {
  const res = {};
  res.status  = jest.fn().mockReturnValue(res);
  res.json    = jest.fn().mockReturnValue(res);
  return res;
}

const SAMPLE_EQUITY_DATA = {
  components: [{ key: 'share_capital', label: 'Share Capital' }],
  rows: [
    { key: 'opening', label: 'Opening balance', values: { share_capital: 1000 }, total: 1000 },
    { key: 'profit',  label: 'Net profit',      values: { share_capital: 500  }, total: 500  },
    { key: 'closing', label: 'Closing balance', values: { share_capital: 1500 }, total: 1500 },
  ],
  reconciliation: { reconciles: true },
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('getStatementOfChangesInEquity controller', () => {
  let res, next;

  beforeEach(() => {
    jest.clearAllMocks();
    res  = makeRes();
    next = jest.fn();
    // Mock ApiResponse.success so we can inspect its call without needing a real Express res
    jest.spyOn(ApiResponse, 'success').mockImplementation(() => {});
  });

  test('calls reportService with toStartOfDay(startDate) and toEndOfDay(endDate)', async () => {
    reportService.getStatementOfChangesInEquity = jest.fn().mockResolvedValue(SAMPLE_EQUITY_DATA);

    const req = makeReq({ startDate: '2026-01-01', endDate: '2026-12-31' });
    await ctrl.getStatementOfChangesInEquity(req, res, next);

    expect(reportService.getStatementOfChangesInEquity).toHaveBeenCalledTimes(1);
    const [bizId, start, end] = reportService.getStatementOfChangesInEquity.mock.calls[0];
    expect(bizId).toBe('biz123');
    // toStartOfDay keeps midnight UTC
    expect(start).toEqual(new Date('2026-01-01'));
    // toEndOfDay pushes plain date to 23:59:59.999 UTC
    expect(end.getUTCHours()).toBe(23);
    expect(end.getUTCMinutes()).toBe(59);
    expect(end.getUTCSeconds()).toBe(59);
  });

  test('passes service result to ApiResponse.success', async () => {
    reportService.getStatementOfChangesInEquity = jest.fn().mockResolvedValue(SAMPLE_EQUITY_DATA);

    const req = makeReq({ startDate: '2026-01-01', endDate: '2026-12-31' });
    await ctrl.getStatementOfChangesInEquity(req, res, next);

    expect(ApiResponse.success).toHaveBeenCalledWith(
      res,
      SAMPLE_EQUITY_DATA,
      'Statement of changes in equity generated'
    );
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next(err) when service throws', async () => {
    const boom = new Error('DB error');
    reportService.getStatementOfChangesInEquity = jest.fn().mockRejectedValue(boom);

    const req = makeReq({ startDate: '2026-01-01', endDate: '2026-12-31' });
    await ctrl.getStatementOfChangesInEquity(req, res, next);

    expect(next).toHaveBeenCalledWith(boom);
  });

  test('defaults to current year start / today when no dates supplied', async () => {
    reportService.getStatementOfChangesInEquity = jest.fn().mockResolvedValue(SAMPLE_EQUITY_DATA);

    const req = makeReq({}); // no dates
    await ctrl.getStatementOfChangesInEquity(req, res, next);

    const [, start, end] = reportService.getStatementOfChangesInEquity.mock.calls[0];
    const now = new Date();
    expect(start.getUTCFullYear()).toBe(now.getFullYear());
    expect(start.getUTCMonth()).toBe(0);   // January
    expect(start.getUTCDate()).toBe(1);
    expect(end.getUTCHours()).toBe(23);    // end-of-day applied
  });
});

describe('getRevenueNotes controller stub', () => {
  let res, next;

  beforeEach(() => {
    jest.clearAllMocks();
    res  = makeRes();
    next = jest.fn();
    jest.spyOn(ApiResponse, 'success').mockImplementation(() => {});
  });

  test('calls next(err) when getRevenueNotes is not yet implemented on service', async () => {
    reportService.getRevenueNotes = jest.fn().mockRejectedValue(new Error('Not implemented'));

    const req = makeReq({ startDate: '2026-01-01', endDate: '2026-12-31' });
    await ctrl.getRevenueNotes(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Not implemented' }));
  });
});
