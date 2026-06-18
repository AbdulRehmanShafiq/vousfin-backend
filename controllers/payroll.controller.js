// controllers/payroll.controller.js — FR-08
'use strict';
const ApiResponse = require('../utils/ApiResponse');
const { ApiError } = require('../utils/ApiError');
const employeeRepo = require('../repositories/employee.repository');
const payroll = require('../services/payroll.service');
const payrollTax = require('../services/payrollTax.service');
const { buildPayslipPdf, buildCertificatePdf } = require('../utils/payslipPdf.util');

const biz = (req) => req.user.businessId;
const actor = (req) => ({ id: req.user.id, role: req.user.role });

exports.listEmployees = async (req, res, next) => {
  try { return ApiResponse.success(res, await employeeRepo.findByBusiness(biz(req))); }
  catch (e) { next(e); }
};

exports.createEmployee = async (req, res, next) => {
  try {
    const dup = await employeeRepo.findByCode(biz(req), req.body.code);
    if (dup) throw new ApiError(409, `Employee code ${req.body.code} already exists.`);
    const emp = await employeeRepo.create({ ...req.body, businessId: biz(req) });
    return ApiResponse.created(res, emp, 'Employee added.');
  } catch (e) { next(e); }
};

exports.updateEmployee = async (req, res, next) => {
  try {
    const owned = await employeeRepo.findOwned(biz(req), req.params.id);
    if (!owned) throw new ApiError(404, 'Employee not found.');
    const updated = await employeeRepo.update(req.params.id, req.body);
    return ApiResponse.success(res, updated, 'Employee updated.');
  } catch (e) { next(e); }
};

exports.listRuns = async (req, res, next) => {
  try { return ApiResponse.success(res, await payroll.listRuns(biz(req))); } catch (e) { next(e); }
};

exports.getRun = async (req, res, next) => {
  try { return ApiResponse.success(res, await payroll.getRun(biz(req), req.params.id)); } catch (e) { next(e); }
};

exports.processRun = async (req, res, next) => {
  try {
    const run = await payroll.processRun(biz(req), req.body.period,
      { employeeIds: req.body.employeeIds, adjustments: req.body.adjustments }, actor(req));
    return ApiResponse.success(res, run, 'Payroll calculated.');
  } catch (e) { next(e); }
};

exports.postRun = async (req, res, next) => {
  try {
    const run = await payroll.postToGL(biz(req), req.params.id, actor(req), req.ip);
    return ApiResponse.success(res, run, 'Payroll posted to the books.');
  } catch (e) { next(e); }
};

exports.payRun = async (req, res, next) => {
  try {
    const run = await payroll.markPaid(biz(req), req.params.id, req.body.bankAccountId, actor(req), req.ip);
    return ApiResponse.success(res, run, 'Payroll marked as paid.');
  } catch (e) { next(e); }
};

exports.reverseRun = async (req, res, next) => {
  try {
    const run = await payroll.reverseRun(biz(req), req.params.id, actor(req), req.ip);
    return ApiResponse.success(res, run, 'Payroll reversed.');
  } catch (e) { next(e); }
};

exports.certificate = async (req, res, next) => {
  try {
    const cert = await payrollTax.generateSalaryCertificate(biz(req), req.params.employeeId, req.params.taxYear);
    return ApiResponse.success(res, cert);
  } catch (e) { next(e); }
};

exports.bankFile = async (req, res, next) => {
  try {
    const csv = await payroll.bankFileFor(biz(req), req.params.id);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="payroll-${req.params.id}.csv"`);
    return res.send(csv);
  } catch (e) { next(e); }
};

exports.payslips = async (req, res, next) => {
  try {
    const run = await payroll.getRun(biz(req), req.params.id);
    const line = run.lines.find((l) => String(l.employeeId) === String(req.query.employeeId)) || run.lines[0];
    if (!line) throw new ApiError(404, 'No payslip lines in this run.');
    const pdf = await buildPayslipPdf({ business: { name: req.user.businessName }, line, period: run.period });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="payslip-${line.employeeCode}-${run.period}.pdf"`);
    return res.send(pdf);
  } catch (e) { next(e); }
};

exports.certificatePdf = async (req, res, next) => {
  try {
    const cert = await payrollTax.generateSalaryCertificate(biz(req), req.params.employeeId, req.params.taxYear);
    const pdf = await buildCertificatePdf({ business: { name: req.user.businessName }, certificate: cert });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="salary-certificate-${req.params.taxYear}.pdf"`);
    return res.send(pdf);
  } catch (e) { next(e); }
};
