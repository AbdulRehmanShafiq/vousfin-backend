// controllers/fixedAsset.controller.js — Fixed Asset Register
'use strict';
const fixedAssetService = require('../services/fixedAsset.service');
const ApiResponse = require('../utils/ApiResponse');

exports.create = async (req, res, next) => {
  try {
    const asset = await fixedAssetService.createAsset(req.user.businessId, req.body, req.user);
    ApiResponse.created(res, asset, 'Fixed asset added');
  } catch (e) { next(e); }
};

exports.list = async (req, res, next) => {
  try {
    ApiResponse.success(res, await fixedAssetService.listAssets(req.user.businessId), 'Fixed assets retrieved');
  } catch (e) { next(e); }
};

exports.get = async (req, res, next) => {
  try {
    ApiResponse.success(res, await fixedAssetService.getAsset(req.params.id, req.user.businessId), 'Fixed asset retrieved');
  } catch (e) { next(e); }
};

exports.schedule = async (req, res, next) => {
  try {
    const asset = await fixedAssetService.getAsset(req.params.id, req.user.businessId);
    ApiResponse.success(res, fixedAssetService.computeDepreciationSchedule(asset), 'Depreciation schedule');
  } catch (e) { next(e); }
};

exports.depreciate = async (req, res, next) => {
  try {
    ApiResponse.success(res, await fixedAssetService.postDepreciation(req.params.id, req.user.businessId), 'Depreciation posted');
  } catch (e) { next(e); }
};

exports.dispose = async (req, res, next) => {
  try {
    ApiResponse.success(res, await fixedAssetService.disposeAsset(req.params.id, req.user.businessId, req.body), 'Asset disposed');
  } catch (e) { next(e); }
};
