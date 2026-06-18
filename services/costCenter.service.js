// services/costCenter.service.js
//
// SRS FR-07.1 — cost / profit centre management. CRUD over the CostCenter
// dimension plus the hierarchy tree and the `validateAssignable` guard the
// transaction engine uses when a journal line is tagged to a cost centre.
//
'use strict';
const { ApiError } = require('../utils/ApiError');
const repo = require('../repositories/costCenter.repository');

class CostCenterService {
  /** Create a cost centre (optionally under a parent of the same business). */
  async createCostCenter(businessId, data) {
    if (await repo.findByCode(businessId, data.code)) {
      throw new ApiError(409, `A cost centre with code "${data.code}" already exists`);
    }
    if (data.parentId) await this._assertParent(businessId, data.parentId);
    return repo.create({
      businessId,
      code: data.code,
      name: data.name,
      type: data.type,
      parentId: data.parentId || null,
      description: data.description || '',
      isActive: data.isActive !== undefined ? data.isActive : true,
    });
  }

  async getCostCenterById(id, businessId) {
    const cc = await repo.findOwned(businessId, id);
    if (!cc) throw new ApiError(404, 'Cost centre not found');
    return cc;
  }

  async listCostCenters(businessId, { activeOnly = false } = {}) {
    return repo.findByBusiness(businessId, { activeOnly });
  }

  /** The cost-centre hierarchy as a nested tree (roots first). */
  async getTree(businessId) {
    const flat = await repo.findByBusiness(businessId);
    const byId = new Map(flat.map((cc) => [String(cc._id), { ...cc, children: [] }]));
    const roots = [];
    for (const node of byId.values()) {
      const parent = node.parentId ? byId.get(String(node.parentId)) : null;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  async updateCostCenter(id, businessId, data) {
    await this.getCostCenterById(id, businessId); // ownership
    if (data.parentId) {
      if (String(data.parentId) === String(id)) throw new ApiError(400, 'A cost centre cannot be its own parent');
      await this._assertParent(businessId, data.parentId);
    }
    if (data.code) {
      const clash = await repo.findByCode(businessId, data.code);
      if (clash && String(clash._id) !== String(id)) {
        throw new ApiError(409, `A cost centre with code "${data.code}" already exists`);
      }
    }
    return repo.update(id, data);
  }

  /** Delete a leaf cost centre. Parents (with children) must be reorganised first. */
  async deleteCostCenter(id, businessId) {
    await this.getCostCenterById(id, businessId);
    if (await repo.hasChildren(businessId, id)) {
      throw new ApiError(409, 'This cost centre has child cost centres — move or delete them first, or just deactivate it.');
    }
    return repo.delete(id);
  }

  /**
   * Guard used by the transaction engine: a tag is optional (null → null), but
   * if given it must be an active cost centre that belongs to this business.
   * @returns the cost centre, or null when none was supplied.
   */
  async validateAssignable(businessId, costCenterId) {
    if (!costCenterId) return null;
    const cc = await repo.findOwned(businessId, costCenterId);
    if (!cc) throw new ApiError(400, 'Cost centre not found for this business');
    if (!cc.isActive) throw new ApiError(400, 'That cost centre is inactive — reactivate it or pick another');
    return cc;
  }

  async _assertParent(businessId, parentId) {
    const parent = await repo.findOwned(businessId, parentId);
    if (!parent) throw new ApiError(400, 'Parent cost centre not found for this business');
    return parent;
  }
}

module.exports = new CostCenterService();
