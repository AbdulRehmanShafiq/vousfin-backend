// controllers/customer.controller.js
const customerService = require('../services/customer.service');
const ApiResponse = require('../utils/ApiResponse');

exports.createCustomer = async (req, res, next) => {
  try {
    const customer = await customerService.createCustomer(req.user.businessId, req.body);
    ApiResponse.created(res, customer, 'Customer created successfully');
  } catch (error) {
    next(error);
  }
};

exports.listCustomers = async (req, res, next) => {
  try {
    const filters = {
      search: req.query.search,
      isActive: req.query.isActive !== undefined ? req.query.isActive === 'true' : undefined,
    };
    const pagination = {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 25,
      sortBy: req.query.sortBy || 'fullName',
      sortOrder: parseInt(req.query.sortOrder, 10) || 1,
    };
    const result = await customerService.listCustomers(req.user.businessId, filters, pagination);
    ApiResponse.success(res, result, 'Customers retrieved successfully');
  } catch (error) {
    next(error);
  }
};

exports.getCustomerById = async (req, res, next) => {
  try {
    const customer = await customerService.getCustomerById(req.params.id, req.user.businessId);
    ApiResponse.success(res, customer, 'Customer retrieved successfully');
  } catch (error) {
    next(error);
  }
};

exports.updateCustomer = async (req, res, next) => {
  try {
    const customer = await customerService.updateCustomer(req.params.id, req.user.businessId, req.body);
    ApiResponse.success(res, customer, 'Customer updated successfully');
  } catch (error) {
    next(error);
  }
};

exports.getCustomerBalance = async (req, res, next) => {
  try {
    const balance = await customerService.getCustomerBalance(req.params.id, req.user.businessId);
    ApiResponse.success(res, { balance }, 'Customer balance retrieved');
  } catch (error) {
    next(error);
  }
};

exports.getCustomerTransactions = async (req, res, next) => {
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
    const result = await customerService.getCustomerTransactionHistory(req.params.id, req.user.businessId, filters, pagination);
    ApiResponse.success(res, result, 'Customer transactions retrieved');
  } catch (error) {
    next(error);
  }
};

exports.toggleActive = async (req, res, next) => {
  try {
    const customer = await customerService.toggleCustomerActive(req.params.id, req.user.businessId);
    ApiResponse.success(res, customer, `Customer ${customer.isActive ? 'activated' : 'deactivated'} successfully`);
  } catch (error) {
    next(error);
  }
};
