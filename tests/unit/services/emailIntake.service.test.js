'use strict';
jest.mock('../../../models/Business.model', () => ({ findOne: jest.fn(), findById: jest.fn() }));
jest.mock('../../../services/bookkeeper.service', () => ({ ingest: jest.fn() }));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const Business = require('../../../models/Business.model');
const bookkeeper = require('../../../services/bookkeeper.service');
const svc = require('../../../services/emailIntake.service');

beforeEach(() => jest.clearAllMocks());

describe('emailIntake.service.captureEmail', () => {
  it('resolves the business by token and ingests the email', async () => {
    Business.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: 'biz1', aiSettings: { emailIntakeToken: 'tok-abc' } }) });
    bookkeeper.ingest.mockResolvedValue({ document: { _id: 'doc1' } });
    const out = await svc.captureEmail('tok-abc', { subject: 'Bill from AWS', text: 'Rs 5000 hosting' });
    expect(Business.findOne).toHaveBeenCalledWith({ 'aiSettings.emailIntakeToken': 'tok-abc' });
    expect(bookkeeper.ingest).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'biz1', source: 'email' }));
    expect(out.document._id).toBe('doc1');
  });

  it('rejects an unknown/blank token before doing any work', async () => {
    Business.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    await expect(svc.captureEmail('nope', { subject: 'x', text: 'y' })).rejects.toMatchObject({ statusCode: 401 });
    await expect(svc.captureEmail('', { subject: 'x', text: 'y' })).rejects.toMatchObject({ statusCode: 401 });
    expect(bookkeeper.ingest).not.toHaveBeenCalled();
  });

  it('rejects an email with nothing readable (400)', async () => {
    Business.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: 'biz1' }) });
    await expect(svc.captureEmail('tok-abc', { subject: '', text: '' })).rejects.toMatchObject({ statusCode: 400 });
    expect(bookkeeper.ingest).not.toHaveBeenCalled();
  });
});

describe('emailIntake.service.enableForBusiness', () => {
  it('generates and persists a token', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    Business.findById.mockResolvedValue({ _id: 'biz1', aiSettings: {}, save });
    const res = await svc.enableForBusiness('biz1');
    expect(res.emailIntakeToken).toMatch(/^[a-f0-9]{32}$/);
    expect(save).toHaveBeenCalled();
  });
});
