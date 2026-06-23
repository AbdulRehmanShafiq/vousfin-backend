// tests/unit/services/impairment.service.test.js — FR-10.2
'use strict';

jest.mock('../../../models/ImpairmentCheck.model', () => ({
  create: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
}));
jest.mock('../../../services/ledgerPosting.service', () => ({ postCompoundJournal: jest.fn().mockResolvedValue({ _id: 'je1' }) }));
jest.mock('../../../repositories/account.repository', () => ({
  findAll: jest.fn().mockResolvedValue({ data: [{ _id: 'acc001' }] }),
}));

const ImpairmentCheck = require('../../../models/ImpairmentCheck.model');
const impairmentService = require('../../../services/impairment.service');

beforeEach(() => jest.clearAllMocks());

const BIZ = 'biz001';

describe('createAssessment', () => {
  it('computes impairmentLoss as max(0, carrying - recoverable)', async () => {
    ImpairmentCheck.create.mockResolvedValue({ _id: 'imp1', impairmentLoss: 5000, status: 'assessed' });

    await impairmentService.createAssessment(BIZ, {
      assetName: 'Machine A',
      carryingAmount: 100000,
      recoverableAmount: 95000,
    }, { _id: 'user1' });

    const call = ImpairmentCheck.create.mock.calls[0][0];
    expect(call.impairmentLoss).toBe(5000);
    expect(call.status).toBe('assessed');
  });

  it('sets status to no_impairment when recoverableAmount >= carryingAmount', async () => {
    ImpairmentCheck.create.mockResolvedValue({ _id: 'imp2', impairmentLoss: 0, status: 'no_impairment' });

    await impairmentService.createAssessment(BIZ, {
      assetName: 'Building B',
      carryingAmount: 50000,
      recoverableAmount: 60000,
    }, { _id: 'user1' });

    const call = ImpairmentCheck.create.mock.calls[0][0];
    expect(call.impairmentLoss).toBe(0);
    expect(call.status).toBe('no_impairment');
  });

  it('impairmentLoss is 0 when carrying equals recoverable', async () => {
    ImpairmentCheck.create.mockResolvedValue({ impairmentLoss: 0, status: 'no_impairment' });
    await impairmentService.createAssessment(BIZ, {
      assetName: 'Asset C',
      carryingAmount: 100000,
      recoverableAmount: 100000,
    }, {});
    expect(ImpairmentCheck.create.mock.calls[0][0].impairmentLoss).toBe(0);
  });
});

describe('postImpairmentLoss', () => {
  it('throws 409 if already posted', async () => {
    ImpairmentCheck.findOne.mockResolvedValue({ _id: 'imp1', status: 'loss_posted', impairmentLoss: 5000, save: jest.fn() });
    await expect(impairmentService.postImpairmentLoss('imp1', BIZ)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('throws 400 if impairmentLoss is 0', async () => {
    ImpairmentCheck.findOne.mockResolvedValue({ _id: 'imp2', status: 'assessed', impairmentLoss: 0, save: jest.fn() });
    await expect(impairmentService.postImpairmentLoss('imp2', BIZ)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws 404 if not found', async () => {
    ImpairmentCheck.findOne.mockResolvedValue(null);
    await expect(impairmentService.postImpairmentLoss('nope', BIZ)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('sets status to loss_posted after posting', async () => {
    const mockSave = jest.fn().mockResolvedValue(undefined);
    const fakeCheck = {
      _id: 'imp3', status: 'assessed', impairmentLoss: 10000,
      assetName: 'Asset D', assetAccountId: 'acc001',
      save: mockSave,
    };
    ImpairmentCheck.findOne.mockResolvedValue(fakeCheck);

    await impairmentService.postImpairmentLoss('imp3', BIZ);
    expect(fakeCheck.status).toBe('loss_posted');
    expect(mockSave).toHaveBeenCalled();
  });
});
