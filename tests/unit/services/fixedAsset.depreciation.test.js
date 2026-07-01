// tests/unit/services/fixedAsset.depreciation.test.js
//
// Scheduled/batch depreciation: an "is this annual period actually due?" gate
// (so we don't post a year prematurely) + a sweep that posts every due asset,
// idempotent and fault-isolated (one asset's failure never aborts the run).
'use strict';

jest.mock('../../../models/FixedAsset.model', () => ({ find: jest.fn(), findOne: jest.fn(), create: jest.fn() }));
jest.mock('../../../repositories/account.repository');
jest.mock('../../../services/ledgerPosting.service', () => ({ postCompoundJournal: jest.fn() }));

const FixedAsset = require('../../../models/FixedAsset.model');
const service = require('../../../services/fixedAsset.service');

const yearsAgo = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d; };
const asset = (over = {}) => ({
  _id: 'a1', businessId: 'b1', name: 'Laptop', status: 'active',
  acquisitionDate: yearsAgo(3), acquisitionCost: 3000, salvageValue: 0,
  usefulLifeYears: 3, depreciationMethod: 'straight_line', depreciationPostedYears: 0,
  ...over,
});

describe('isDepreciationDue', () => {
  const asOf = new Date();

  it('is due when a full year has elapsed beyond what has been posted', () => {
    expect(service.isDepreciationDue(asset({ depreciationPostedYears: 0 }), asOf)).toBe(true);  // 3y elapsed, 0 posted
    expect(service.isDepreciationDue(asset({ depreciationPostedYears: 2 }), asOf)).toBe(true);  // 3y elapsed, 2 posted → yr3 due
  });

  it('is NOT due when the next period year has not yet elapsed', () => {
    // acquired 1 year ago, already posted year 1 → year 2 not yet elapsed.
    expect(service.isDepreciationDue(asset({ acquisitionDate: yearsAgo(1), depreciationPostedYears: 1 }), asOf)).toBe(false);
  });

  it('is NOT due for non-active or fully-depreciated assets', () => {
    expect(service.isDepreciationDue(asset({ status: 'disposed' }), asOf)).toBe(false);
    expect(service.isDepreciationDue(asset({ depreciationPostedYears: 3 }), asOf)).toBe(false); // life exhausted
  });
});

describe('runDueDepreciation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('posts each due asset and isolates failures', async () => {
    FixedAsset.find.mockReturnValue({ lean: () => Promise.resolve([
      asset({ _id: 'due1', depreciationPostedYears: 0 }),                                   // due
      asset({ _id: 'notdue', acquisitionDate: yearsAgo(1), depreciationPostedYears: 1 }),   // not due
      asset({ _id: 'boom', depreciationPostedYears: 0 }),                                   // due but throws
    ]) });
    const spy = jest.spyOn(service, 'postDepreciation').mockImplementation(async (id) => {
      if (id === 'boom') throw new Error('accounts missing');
      return { posted: true, journalEntryId: 'je-' + id };
    });

    const r = await service.runDueDepreciation(new Date());
    expect(r.scanned).toBe(3);
    expect(r.due).toBe(2);
    expect(r.posted).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(spy).toHaveBeenCalledWith('due1', 'b1');
    expect(spy).not.toHaveBeenCalledWith('notdue', 'b1');
    spy.mockRestore();
  });

  it('returns a clean zero result when nothing is due', async () => {
    FixedAsset.find.mockReturnValue({ lean: () => Promise.resolve([
      asset({ acquisitionDate: yearsAgo(1), depreciationPostedYears: 1 }),
    ]) });
    const r = await service.runDueDepreciation(new Date());
    expect(r.due).toBe(0);
    expect(r.posted).toBe(0);
    expect(r.errors).toHaveLength(0);
  });
});
