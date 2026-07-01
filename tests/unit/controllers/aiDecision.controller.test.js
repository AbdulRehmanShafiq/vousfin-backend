'use strict';
jest.mock('../../../services/aiDecision.service', () => ({ list: jest.fn(), getById: jest.fn(), applyUserOutcome: jest.fn() }));
jest.mock('../../../services/aiExplain.service', () => ({ explainById: jest.fn() }));
jest.mock('../../../services/aiCalibration.service', () => ({ computeAcceptanceStats: jest.fn(), getEffectiveAutoPostThreshold: jest.fn() }));
jest.mock('../../../services/learnedResolution.service', () => ({ learnAccountsFromConfirmation: jest.fn() }));
const service = require('../../../services/aiDecision.service');
const explainService = require('../../../services/aiExplain.service');
const calibration = require('../../../services/aiCalibration.service');
const learnedResolution = require('../../../services/learnedResolution.service');
const ctrl = require('../../../controllers/aiDecision.controller');
const { ApiError } = require('../../../utils/ApiError');

const mockRes = () => { const r = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); return r; };
const req = (over = {}) => ({ user: { id: 'u1', businessId: 'biz1' }, query: {}, params: {}, body: {}, ...over });
const next = jest.fn();
beforeEach(() => jest.clearAllMocks());

describe('aiDecision.controller', () => {
  test('list returns paginated decisions for the tenant', async () => {
    service.list.mockResolvedValue({ data: [{ _id: 'd1' }], total: 1, page: 1, limit: 25 });
    const res = mockRes();
    await ctrl.list(req({ query: { kind: 'parse' } }), res, next);
    expect(service.list).toHaveBeenCalledWith('biz1', expect.objectContaining({ kind: 'parse' }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('getById 404s when not found', async () => {
    service.getById.mockResolvedValue(null);
    await ctrl.getById(req({ params: { id: 'missing' } }), mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });

  test('getById returns the decision when found', async () => {
    service.getById.mockResolvedValue({ _id: 'd1', kind: 'parse' });
    const res = mockRes();
    await ctrl.getById(req({ params: { id: 'd1' } }), res, next);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('aiDecision.controller — explain', () => {
  test('returns a grounded explanation', async () => {
    explainService.explainById.mockResolvedValue({ decision: { _id: 'd1' }, explanation: { text: 'because…', faithful: true } });
    const res = mockRes();
    await ctrl.explain(req({ params: { id: 'd1' } }), res, next);
    expect(explainService.explainById).toHaveBeenCalledWith('d1', 'biz1');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('404s when the decision is not found', async () => {
    explainService.explainById.mockResolvedValue(null);
    await ctrl.explain(req({ params: { id: 'missing' } }), mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });
});

describe('aiDecision.controller — setOutcome', () => {
  test('records an accepted outcome', async () => {
    service.getById.mockResolvedValue({ _id: 'd1', inputsSummary: 'Paid rent' });
    service.applyUserOutcome.mockResolvedValue({ _id: 'd1', outcome: 'accepted' });
    const res = mockRes();
    await ctrl.setOutcome(req({ params: { id: 'd1' }, body: { outcome: 'accepted' } }), res, next);
    expect(service.applyUserOutcome).toHaveBeenCalledWith('d1', 'biz1', 'accepted', null);
    expect(learnedResolution.learnAccountsFromConfirmation).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('a correction feeds the learning loop', async () => {
    service.getById.mockResolvedValue({ _id: 'd1', inputsSummary: 'Paid electricity bill' });
    service.applyUserOutcome.mockResolvedValue({ _id: 'd1', outcome: 'corrected' });
    const res = mockRes();
    await ctrl.setOutcome(req({
      params: { id: 'd1' },
      body: { outcome: 'corrected', correctedTo: { debitAccountName: 'Utilities Expense', creditAccountName: 'Cash' } },
    }), res, next);
    expect(learnedResolution.learnAccountsFromConfirmation).toHaveBeenCalledWith(
      'biz1', 'Paid electricity bill', { debitAccountName: 'Utilities Expense', creditAccountName: 'Cash' },
    );
  });

  test('rejects an invalid outcome value with 400', async () => {
    await ctrl.setOutcome(req({ params: { id: 'd1' }, body: { outcome: 'banana' } }), mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  test('404s when the decision is not found', async () => {
    service.getById.mockResolvedValue(null);
    await ctrl.setOutcome(req({ params: { id: 'missing' }, body: { outcome: 'accepted' } }), mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });

  test('409s when the outcome was already set', async () => {
    service.getById.mockResolvedValue({ _id: 'd1', inputsSummary: 'x' });
    service.applyUserOutcome.mockRejectedValue(new Error('AIDecision outcome already set'));
    await ctrl.setOutcome(req({ params: { id: 'd1' }, body: { outcome: 'reversed' } }), mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
  });
});

describe('aiDecision.controller — stats', () => {
  test('returns calibration stats and the effective threshold', async () => {
    calibration.computeAcceptanceStats.mockResolvedValue({ resolved: 100, acceptanceRate: 0.9, reversalRate: 0.02 });
    calibration.getEffectiveAutoPostThreshold.mockResolvedValue(0.98);
    const res = mockRes();
    await ctrl.stats(req(), res, next);
    expect(calibration.computeAcceptanceStats).toHaveBeenCalledWith('biz1', expect.any(Object));
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.effectiveAutoPostThreshold).toBe(0.98);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
