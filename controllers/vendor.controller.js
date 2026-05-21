// controllers/vendor.controller.js
const vendorService = require('../services/vendor.service');
const ApiResponse = require('../utils/ApiResponse');

exports.createVendor = async (req, res, next) => {
  try {
    const vendor = await vendorService.createVendor(req.user.businessId, req.body);
    ApiResponse.created(res, vendor, 'Vendor created successfully');
  } catch (error) {
    next(error);
  }
};

exports.listVendors = async (req, res, next) => {
  try {
    const filters = {
      search: req.query.search,
      isActive: req.query.isActive !== undefined ? req.query.isActive === 'true' : undefined,
    };
    const pagination = {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 25,
      sortBy: req.query.sortBy || 'vendorName',
      sortOrder: parseInt(req.query.sortOrder, 10) || 1,
    };
    const result = await vendorService.listVendors(req.user.businessId, filters, pagination);
    ApiResponse.success(res, result, 'Vendors retrieved successfully');
  } catch (error) {
    next(error);
  }
};

exports.getVendorById = async (req, res, next) => {
  try {
    const vendor = await vendorService.getVendorById(req.params.id, req.user.businessId);
    ApiResponse.success(res, vendor, 'Vendor retrieved successfully');
  } catch (error) {
    next(error);
  }
};

exports.updateVendor = async (req, res, next) => {
  try {
    const vendor = await vendorService.updateVendor(req.params.id, req.user.businessId, req.body);
    ApiResponse.success(res, vendor, 'Vendor updated successfully');
  } catch (error) {
    next(error);
  }
};

exports.getVendorBalance = async (req, res, next) => {
  try {
    const balance = await vendorService.getVendorPayableBalance(req.params.id, req.user.businessId);
    ApiResponse.success(res, { balance }, 'Vendor balance retrieved');
  } catch (error) {
    next(error);
  }
};

exports.getVendorTransactions = async (req, res, next) => {
  try {
    const filters = {
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      status: req.query.status,
      paymentStatus: req.query.paymentStatus,
    };
    const pagination = {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 25,
      sortBy: req.query.sortBy || 'transactionDate',
      sortOrder: parseInt(req.query.sortOrder, 10) || -1,
    };
    const result = await vendorService.getVendorTransactionHistory(req.params.id, req.user.businessId, filters, pagination);
    ApiResponse.success(res, result, 'Vendor transactions retrieved');
  } catch (error) {
    next(error);
  }
};

exports.toggleActive = async (req, res, next) => {
  try {
    const vendor = await vendorService.toggleVendorActive(req.params.id, req.user.businessId);
    ApiResponse.success(res, vendor, `Vendor ${vendor.isActive ? 'activated' : 'deactivated'} successfully`);
  } catch (error) {
    next(error);
  }
};
