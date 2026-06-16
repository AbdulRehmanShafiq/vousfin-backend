'use strict';

const mockModel = { findOneAndUpdate: jest.fn(), findOne: jest.fn() };
jest.mock('mongoose', () => ({ model: () => mockModel, Types: { ObjectId: function (v) { this.v = v; } } }));
jest.mock('../../../config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mem = require('../../../services/entityMemory.service');
const BIZ = 'biz1';

beforeEach(() => jest.clearAllMocks());

describe('entityMemory.learn', () => {
  it('upserts the association and reinforces the hit count', async () => {
    mockModel.findOneAndUpdate.mockReturnValue({ lean: () => Promise.resolve({ value: 'acc1', hits: 2 }) });
    await mem.learn(BIZ, 'vendor_account', 'vendorX', 'acc1');
    const [filter, update, opts] = mockModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ businessId: BIZ, kind: 'vendor_account', key: 'vendorX' });
    expect(update.$set.value).toBe('acc1');
    expect(update.$inc).toEqual({ hits: 1 });
    expect(opts).toMatchObject({ upsert: true });
  });
  it('never throws (best-effort learning)', async () => {
    mockModel.findOneAndUpdate.mockImplementation(() => { throw new Error('db'); });
    await expect(mem.learn(BIZ, 'k', 'x', 'v')).resolves.toBeNull();
  });
});

describe('entityMemory.suggest', () => {
  it('returns the learned value + hits when present', async () => {
    mockModel.findOne.mockReturnValue({ lean: () => Promise.resolve({ value: 'acc1', hits: 5 }) });
    const s = await mem.suggest(BIZ, 'vendor_account', 'vendorX');
    expect(s).toEqual({ value: 'acc1', hits: 5 });
  });
  it('returns null when nothing has been learned', async () => {
    mockModel.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    expect(await mem.suggest(BIZ, 'vendor_account', 'unknown')).toBeNull();
  });
});
