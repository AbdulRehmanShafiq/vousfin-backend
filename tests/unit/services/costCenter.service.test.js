'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../repositories/costCenter.repository', () => ({
  create: jest.fn(), update: jest.fn(), delete: jest.fn(),
  findByBusiness: jest.fn(), findOwned: jest.fn(), hasChildren: jest.fn(), findByCode: jest.fn(),
}));

const repo = require('../../../repositories/costCenter.repository');
const svc = require('../../../services/costCenter.service');

const BIZ = 'biz1';

beforeEach(() => {
  jest.clearAllMocks();
  repo.create.mockImplementation((d) => Promise.resolve({ _id: 'cc1', ...d }));
  repo.findOwned.mockResolvedValue(null);
  repo.findByCode.mockResolvedValue(null);
  repo.hasChildren.mockResolvedValue(false);
  repo.update.mockImplementation((id, u) => Promise.resolve({ _id: id, ...u }));
});

describe('createCostCenter', () => {
  it('creates a top-level cost centre', async () => {
    const cc = await svc.createCostCenter(BIZ, { code: 'SALES', name: 'Sales Dept', type: 'department' });
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ businessId: BIZ, code: 'SALES' }));
    expect(cc._id).toBe('cc1');
  });

  it('rejects a parent that does not belong to the business', async () => {
    repo.findOwned.mockResolvedValue(null); // parent not owned
    await expect(svc.createCostCenter(BIZ, { code: 'X', name: 'X', parentId: 'p1' })).rejects.toThrow(/parent/i);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('accepts a valid parent', async () => {
    repo.findOwned.mockResolvedValue({ _id: 'p1', businessId: BIZ });
    await svc.createCostCenter(BIZ, { code: 'X', name: 'X', parentId: 'p1' });
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ parentId: 'p1' }));
  });

  it('rejects a duplicate code with a 409', async () => {
    repo.findByCode.mockResolvedValue({ _id: 'existing', code: 'SALES' });
    await expect(svc.createCostCenter(BIZ, { code: 'SALES', name: 'Sales' })).rejects.toThrow(/already exists/i);
    expect(repo.create).not.toHaveBeenCalled();
  });
});

describe('getCostCenterById', () => {
  it('returns an owned cost centre', async () => {
    repo.findOwned.mockResolvedValue({ _id: 'cc1', businessId: BIZ });
    expect(await svc.getCostCenterById('cc1', BIZ)).toMatchObject({ _id: 'cc1' });
  });
  it('404s when not owned', async () => {
    repo.findOwned.mockResolvedValue(null);
    await expect(svc.getCostCenterById('cc1', BIZ)).rejects.toThrow(/not found/i);
  });
});

describe('getTree', () => {
  it('nests children under their parents', async () => {
    repo.findByBusiness.mockResolvedValue([
      { _id: 'a', code: 'A', parentId: null },
      { _id: 'b', code: 'B', parentId: 'a' },
      { _id: 'c', code: 'C', parentId: 'a' },
      { _id: 'd', code: 'D', parentId: 'b' },
    ]);
    const tree = await svc.getTree(BIZ);
    expect(tree).toHaveLength(1);            // one root: A
    expect(tree[0].children.map(c => c.code)).toEqual(['B', 'C']);
    expect(tree[0].children[0].children[0].code).toBe('D');
  });
});

describe('updateCostCenter', () => {
  it('prevents a cost centre from being its own parent', async () => {
    repo.findOwned.mockResolvedValue({ _id: 'cc1', businessId: BIZ });
    await expect(svc.updateCostCenter('cc1', BIZ, { parentId: 'cc1' })).rejects.toThrow(/own parent/i);
  });
});

describe('deleteCostCenter', () => {
  it('blocks deletion when it has children', async () => {
    repo.findOwned.mockResolvedValue({ _id: 'cc1', businessId: BIZ });
    repo.hasChildren.mockResolvedValue(true);
    await expect(svc.deleteCostCenter('cc1', BIZ)).rejects.toThrow(/child/i);
    expect(repo.delete).not.toHaveBeenCalled();
  });
  it('deletes a leaf cost centre', async () => {
    repo.findOwned.mockResolvedValue({ _id: 'cc1', businessId: BIZ });
    repo.hasChildren.mockResolvedValue(false);
    repo.delete.mockResolvedValue({});
    await svc.deleteCostCenter('cc1', BIZ);
    expect(repo.delete).toHaveBeenCalledWith('cc1');
  });
});

describe('validateAssignable', () => {
  it('returns the cost centre when active and owned', async () => {
    repo.findOwned.mockResolvedValue({ _id: 'cc1', businessId: BIZ, isActive: true });
    expect(await svc.validateAssignable(BIZ, 'cc1')).toMatchObject({ _id: 'cc1' });
  });
  it('throws for an unknown cost centre', async () => {
    repo.findOwned.mockResolvedValue(null);
    await expect(svc.validateAssignable(BIZ, 'nope')).rejects.toThrow(/not found/i);
  });
  it('throws for an inactive cost centre', async () => {
    repo.findOwned.mockResolvedValue({ _id: 'cc1', businessId: BIZ, isActive: false });
    await expect(svc.validateAssignable(BIZ, 'cc1')).rejects.toThrow(/inactive/i);
  });
  it('returns null when no cost centre id is given (tagging is optional)', async () => {
    expect(await svc.validateAssignable(BIZ, null)).toBeNull();
  });
});
