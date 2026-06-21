// tests/unit/controllers/bill.controller.test.js
// Unit tests for bill controller – no real Express server or DB needed.

jest.mock('../../../services/bill.service');
jest.mock('../../../services/invoicePdf.service');
jest.mock('../../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const billController = require('../../../controllers/bill.controller');
const billService    = require('../../../services/bill.service');
const { ApiError }   = require('../../../utils/ApiError');

// ── helpers ───────────────────────────────────────────────────────────────────
const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res;
};

const mockNext = jest.fn();

const mockUser = {
  id:         'u1',
  fullName:   'Test User',
  email:      'test@example.com',
  role:       'admin',
  businessId: 'biz1',
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ── approve ───────────────────────────────────────────────────────────────────
describe('billController.approve()', () => {
  test('forwards override:true from body into billService.approve 5th arg', async () => {
    billService.approve.mockResolvedValue({ _id: 'b1', approvalStatus: 'APPROVED' });
    const req = {
      params: { id: 'b1' },
      body:   { note: 'manager ok', override: true },
      user:   mockUser,
      ip:     '0.0.0.0',
    };
    const res = mockRes();

    await billController.approve(req, res, mockNext);

    expect(billService.approve).toHaveBeenCalledWith(
      'b1',
      {
        _id:        'u1',
        fullName:   'Test User',
        email:      'test@example.com',
        role:       'admin',
        businessId: 'biz1',
      },
      'manager ok',
      '0.0.0.0',
      { override: true }
    );
    expect(mockNext).not.toHaveBeenCalled();
  });

  test('forwards override:false when body.override is absent', async () => {
    billService.approve.mockResolvedValue({ _id: 'b2', approvalStatus: 'APPROVED' });
    const req = {
      params: { id: 'b2' },
      body:   { note: 'ok' },
      user:   mockUser,
      ip:     '1.2.3.4',
    };
    const res = mockRes();

    await billController.approve(req, res, mockNext);

    expect(billService.approve).toHaveBeenCalledWith(
      'b2',
      expect.objectContaining({ _id: 'u1' }),
      'ok',
      '1.2.3.4',
      { override: false }
    );
  });

  test('coerces truthy non-boolean override to true', async () => {
    billService.approve.mockResolvedValue({ _id: 'b3' });
    const req = {
      params: { id: 'b3' },
      body:   { override: 1 },  // numeric truthy
      user:   mockUser,
      ip:     '0.0.0.0',
    };
    const res = mockRes();

    await billController.approve(req, res, mockNext);

    expect(billService.approve).toHaveBeenCalledWith(
      'b3',
      expect.any(Object),
      undefined,
      '0.0.0.0',
      { override: true }
    );
  });

  test('calls next(error) when billService.approve throws', async () => {
    billService.approve.mockRejectedValue(new ApiError(409, 'Match BLOCKED'));
    const req = {
      params: { id: 'b4' },
      body:   {},
      user:   mockUser,
      ip:     '0.0.0.0',
    };
    const res = mockRes();

    await billController.approve(req, res, mockNext);

    expect(mockNext).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 409 })
    );
  });
});
