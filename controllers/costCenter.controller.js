// controllers/costCenter.controller.js — SRS FR-07.1
const costCenterService = require('../services/costCenter.service');
const ApiResponse = require('../utils/ApiResponse');

exports.createCostCenter = async (req, res, next) => {
  try {
    const cc = await costCenterService.createCostCenter(req.user.businessId, req.body);
    ApiResponse.created(res, cc, 'Cost centre created');
  } catch (err) { next(err); }
};

exports.listCostCenters = async (req, res, next) => {
  try {
    const activeOnly = req.query.activeOnly === 'true';
    const data = await costCenterService.listCostCenters(req.user.businessId, { activeOnly });
    ApiResponse.success(res, data, 'Cost centres retrieved');
  } catch (err) { next(err); }
};

exports.getTree = async (req, res, next) => {
  try {
    const data = await costCenterService.getTree(req.user.businessId);
    ApiResponse.success(res, data, 'Cost centre tree retrieved');
  } catch (err) { next(err); }
};

exports.getCostCenter = async (req, res, next) => {
  try {
    const cc = await costCenterService.getCostCenterById(req.params.id, req.user.businessId);
    ApiResponse.success(res, cc, 'Cost centre retrieved');
  } catch (err) { next(err); }
};

exports.updateCostCenter = async (req, res, next) => {
  try {
    const cc = await costCenterService.updateCostCenter(req.params.id, req.user.businessId, req.body);
    ApiResponse.success(res, cc, 'Cost centre updated');
  } catch (err) { next(err); }
};

exports.deleteCostCenter = async (req, res, next) => {
  try {
    await costCenterService.deleteCostCenter(req.params.id, req.user.businessId);
    ApiResponse.success(res, null, 'Cost centre deleted');
  } catch (err) { next(err); }
};
