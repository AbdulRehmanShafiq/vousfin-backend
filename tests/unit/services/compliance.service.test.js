// tests/unit/services/compliance.service.test.js — FR-10.1
'use strict';

jest.mock('../../../models/ComplianceObligation.model', () => ({
  findOneAndUpdate: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  updateMany: jest.fn(),
}));

const ComplianceObligation = require('../../../models/ComplianceObligation.model');
const complianceService = require('../../../services/compliance.service');
const { COMPLIANCE_OBLIGATIONS } = require('../../../config/complianceCalendar');

beforeEach(() => jest.clearAllMocks());

const BIZ = 'biz001';

describe('generateObligations', () => {
  it('calls upsert for each in-scope template/month combination', async () => {
    ComplianceObligation.findOneAndUpdate.mockResolvedValue({});

    const year = 2026;
    const count = await complianceService.generateObligations(BIZ, year);

    // Count expected: monthly templates * 12 + quarterly * 4 + annual * N
    const expected = COMPLIANCE_OBLIGATIONS.reduce((acc, tpl) => {
      return acc + (tpl.dueMonths === null ? 12 : tpl.dueMonths.length);
    }, 0);

    expect(count).toBe(expected);
    expect(ComplianceObligation.findOneAndUpdate).toHaveBeenCalledTimes(expected);
  });

  it('calls upsert with correct period format', async () => {
    ComplianceObligation.findOneAndUpdate.mockResolvedValue({});
    await complianceService.generateObligations(BIZ, 2026);

    const call = ComplianceObligation.findOneAndUpdate.mock.calls[0];
    const filter = call[0];
    expect(filter.businessId).toBe(BIZ);
    expect(filter.period).toMatch(/^\d{4}-\d{2}$/);
  });

  it('does not upsert quarterly template for non-quarterly months', async () => {
    ComplianceObligation.findOneAndUpdate.mockResolvedValue({});
    await complianceService.generateObligations(BIZ, 2026);

    const calls = ComplianceObligation.findOneAndUpdate.mock.calls;
    // FBR_ADVANCE_TAX is quarterly: months [1,4,7,10] — should be called exactly 4 times
    const advanceTaxCalls = calls.filter((c) => c[0].code === 'FBR_ADVANCE_TAX');
    expect(advanceTaxCalls).toHaveLength(4);
    const periods = advanceTaxCalls.map((c) => c[0].period);
    expect(periods).toContain('2026-01');
    expect(periods).toContain('2026-04');
    expect(periods).toContain('2026-07');
    expect(periods).toContain('2026-10');
    expect(periods).not.toContain('2026-02');
  });
});

describe('completeObligation', () => {
  it('sets correct fields on the document', async () => {
    const mockSave = jest.fn().mockResolvedValue(undefined);
    const mockObl = {
      status: 'pending', completedAt: null, completedBy: null, referenceNumber: '', notes: '',
      save: mockSave,
    };
    ComplianceObligation.findOne.mockResolvedValue(mockObl);

    const actor = { _id: 'user1' };
    await complianceService.completeObligation('id1', BIZ, { referenceNumber: 'REF-001', notes: 'Filed online' }, actor);

    expect(mockObl.status).toBe('completed');
    expect(mockObl.completedBy).toBe('user1');
    expect(mockObl.referenceNumber).toBe('REF-001');
    expect(mockObl.notes).toBe('Filed online');
    expect(mockObl.completedAt).toBeInstanceOf(Date);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it('throws 404 when obligation not found', async () => {
    ComplianceObligation.findOne.mockResolvedValue(null);
    await expect(complianceService.completeObligation('bad', BIZ, {}, {})).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('checkAndMarkOverdue', () => {
  it('only marks pending obligations where dueDate < now', async () => {
    ComplianceObligation.updateMany.mockResolvedValue({ modifiedCount: 3 });

    const count = await complianceService.checkAndMarkOverdue(BIZ);

    expect(count).toBe(3);
    const call = ComplianceObligation.updateMany.mock.calls[0];
    const filter = call[0];
    expect(filter.status).toBe('pending');
    expect(filter.dueDate).toHaveProperty('$lt');
    expect(call[1]).toEqual({ $set: { status: 'overdue' } });
  });
});

describe('upcomingReminders', () => {
  it('queries for pending obligations within the window', async () => {
    const chainResult = [{ code: 'FBR_GST', period: '2026-07', dueDate: new Date() }];
    const leanMock = jest.fn().mockResolvedValue(chainResult);
    const sortMock = jest.fn().mockReturnValue({ lean: leanMock });
    ComplianceObligation.find.mockReturnValue({ sort: sortMock });

    const results = await complianceService.upcomingReminders(BIZ, 7);

    expect(results).toHaveLength(1);
    const call = ComplianceObligation.find.mock.calls[0];
    const filter = call[0];
    expect(filter.status).toBe('pending');
    expect(filter.dueDate).toHaveProperty('$gte');
    expect(filter.dueDate).toHaveProperty('$lte');
  });
});
