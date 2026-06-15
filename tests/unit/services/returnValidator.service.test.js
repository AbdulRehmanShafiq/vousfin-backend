'use strict';

const mockBusiness = { findById: jest.fn() };
const mockPending  = { countDocuments: jest.fn() };
jest.mock('mongoose', () => ({
  model: (name) => (name === 'PendingTransaction' ? mockPending : mockBusiness),
  Types: { ObjectId: (v) => v },
}));
jest.mock('../../../repositories/taxReturn.repository', () => ({ findById: jest.fn(), update: jest.fn() }));

const repo      = require('../../../repositories/taxReturn.repository');
const validator = require('../../../services/returnValidator.service');

const BIZ = 'biz1';

function mockNtn(ntn = '1234567') {
  mockBusiness.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ taxConfig: { taxRegistrationNumber: ntn } }) }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockNtn('1234567');
  mockPending.countDocuments.mockResolvedValue(0);
  repo.update.mockImplementation((id, u) => Promise.resolve({ _id: id, ...u.$set }));
});

const gstReturn = (over = {}) => ({
  _id: 'r1', businessId: BIZ, returnType: 'GST-01', status: 'draft',
  data: { fields: { outputTax: 0, inputTax: 0, netPayable: 0 }, annexes: { A: [], C: [] } },
  ...over,
});

describe('returnValidator.validateReturn', () => {
  it('passes a clean nil return and transitions draft → validated', async () => {
    repo.findById.mockResolvedValue(gstReturn());
    const out = await validator.validateReturn(BIZ, 'r1');
    expect(out['validation.passed']).toBe(true);
    expect(out.status).toBe('validated');
    expect(out['validation.errors']).toEqual([]);
  });

  it('fails when the header output tax does not tie to Annex-C, with a fix', async () => {
    repo.findById.mockResolvedValue(gstReturn({
      data: { fields: { outputTax: 2000, inputTax: 0, netPayable: 2000 }, annexes: { A: [], C: [] } },
    }));
    const out = await validator.validateReturn(BIZ, 'r1');
    expect(out['validation.passed']).toBe(false);
    expect(out.status).toBeUndefined();   // stays draft (no transition)
    const err = out['validation.errors'].find(e => e.code === 'OUTPUT_LT_ANNEX');
    expect(err.fix).toMatch(/Annex-C/);
  });

  it('fails on a missing NTN', async () => {
    mockNtn(null);
    repo.findById.mockResolvedValue(gstReturn());
    const out = await validator.validateReturn(BIZ, 'r1');
    expect(out['validation.passed']).toBe(false);
    expect(out['validation.errors'].some(e => e.code === 'NTN_MISSING')).toBe(true);
  });

  it('flags unposted transactions in the period', async () => {
    mockPending.countDocuments.mockResolvedValue(2);
    repo.findById.mockResolvedValue(gstReturn());
    const out = await validator.validateReturn(BIZ, 'r1');
    expect(out['validation.errors'].some(e => e.code === 'PERIOD_NOT_CLOSED')).toBe(true);
  });

  it('passes when only warnings are present (negative liability)', async () => {
    repo.findById.mockResolvedValue(gstReturn({
      // Annex-A ties to the header, so the only violation is the negative-liability warning.
      data: { fields: { outputTax: 0, inputTax: 500, netPayable: -500 }, annexes: { A: [{ inputTax: 500 }], C: [] } },
    }));
    const out = await validator.validateReturn(BIZ, 'r1');
    expect(out['validation.passed']).toBe(true);   // warning doesn't block
    expect(out.status).toBe('validated');
    expect(out['validation.errors'].some(e => e.code === 'NEGATIVE_LIABILITY_NO_REFUND_FLAG')).toBe(true);
  });

  it('404s on a return belonging to another business', async () => {
    repo.findById.mockResolvedValue(gstReturn({ businessId: 'other' }));
    await expect(validator.validateReturn(BIZ, 'r1')).rejects.toThrow(/not found/i);
  });
});
