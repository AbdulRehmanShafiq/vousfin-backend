// tests/unit/services/retention.service.test.js — FR-10.4
'use strict';

jest.mock('../../../models/RetentionPolicy.model', () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

const RetentionPolicy = require('../../../models/RetentionPolicy.model');
const retentionService = require('../../../services/retention.service');
const { ApiError } = require('../../../utils/ApiError');

beforeEach(() => jest.clearAllMocks());

const BIZ = 'biz001';

describe('getEffectivePolicy', () => {
  it('returns a custom policy when one exists for the business+docType', async () => {
    const custom = { businessId: BIZ, docType: 'financial_record', retentionYears: 10, archiveAfterYears: 3 };
    RetentionPolicy.findOne.mockResolvedValue(custom);

    const policy = await retentionService.getEffectivePolicy(BIZ, 'financial_record');
    expect(policy.retentionYears).toBe(10); // custom overrides default 7
  });

  it('returns the default policy when no custom policy exists', async () => {
    RetentionPolicy.findOne.mockResolvedValue(null);

    const policy = await retentionService.getEffectivePolicy(BIZ, 'financial_record');
    expect(policy.retentionYears).toBe(7);  // default
    expect(policy.archiveAfterYears).toBe(2);
  });

  it('falls back to financial_record default for unknown docType', async () => {
    RetentionPolicy.findOne.mockResolvedValue(null);
    const policy = await retentionService.getEffectivePolicy(BIZ, 'unknown_type');
    expect(policy.docType).toBe('financial_record');
  });
});

describe('checkDeletion', () => {
  it('throws 403 for a newly created document (cannot delete)', async () => {
    RetentionPolicy.findOne.mockResolvedValue(null); // use default 7yr

    const newDoc = new Date(); // created right now

    await expect(
      retentionService.checkDeletion(BIZ, 'financial_record', newDoc)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('returns true for an 8-year-old financial record (past 7yr retention)', async () => {
    RetentionPolicy.findOne.mockResolvedValue(null); // default 7yr

    const eightYearsAgo = new Date();
    eightYearsAgo.setFullYear(eightYearsAgo.getFullYear() - 8);

    const result = await retentionService.checkDeletion(BIZ, 'financial_record', eightYearsAgo);
    expect(result).toBe(true);
  });

  it('throws 403 for a 6-year-old document under 7yr policy', async () => {
    RetentionPolicy.findOne.mockResolvedValue(null);

    const sixYearsAgo = new Date();
    sixYearsAgo.setFullYear(sixYearsAgo.getFullYear() - 6);

    await expect(
      retentionService.checkDeletion(BIZ, 'financial_record', sixYearsAgo)
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('checkArchival', () => {
  it('returns true for a 3-year-old document with a 2yr archive threshold', async () => {
    RetentionPolicy.findOne.mockResolvedValue(null); // default archiveAfterYears=2

    const threeYearsAgo = new Date();
    threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);

    const result = await retentionService.checkArchival(BIZ, 'financial_record', threeYearsAgo);
    expect(result).toBe(true);
  });

  it('returns false for a 1-year-old document with a 2yr archive threshold', async () => {
    RetentionPolicy.findOne.mockResolvedValue(null);

    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const result = await retentionService.checkArchival(BIZ, 'financial_record', oneYearAgo);
    expect(result).toBe(false);
  });
});
