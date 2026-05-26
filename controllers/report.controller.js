// controllers/report.controller.js
const reportService  = require('../services/report.service');
const ApiResponse    = require('../utils/ApiResponse');
const { ApiError }   = require('../utils/ApiError');
const pdfExport      = require('../utils/pdfExport.utils');
const excelExport    = require('../utils/excelExport.utils');
const auditService   = require('../services/audit.service');
const logger         = require('../config/logger');

// ─── Income Statement ────────────────────────────────────────────────────────

const getIncomeStatement = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const data = await reportService.getIncomeStatement(
      req.user.businessId, new Date(startDate), new Date(endDate)
    );
    ApiResponse.success(res, data, 'Income statement generated');
  } catch (err) { next(err); }
};

// ─── Balance Sheet ────────────────────────────────────────────────────────────

const getBalanceSheet = async (req, res, next) => {
  try {
    const { asOfDate, compareDate } = req.query;
    const data = await reportService.getBalanceSheet(
      req.user.businessId, new Date(asOfDate), compareDate ? new Date(compareDate) : null
    );
    ApiResponse.success(res, data, 'Balance sheet generated');
  } catch (err) { next(err); }
};

// ─── Cash Flow ────────────────────────────────────────────────────────────────

const getCashFlowStatement = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const data = await reportService.getCashFlowStatement(
      req.user.businessId, new Date(startDate), new Date(endDate)
    );
    ApiResponse.success(res, data, 'Cash flow statement generated');
  } catch (err) { next(err); }
};

// ─── Trial Balance ────────────────────────────────────────────────────────────

const getTrialBalance = async (req, res, next) => {
  try {
    const { asOfDate, fromDate } = req.query;
    const data = await reportService.getTrialBalance(
      req.user.businessId, new Date(asOfDate), fromDate ? new Date(fromDate) : null
    );
    ApiResponse.success(res, data, 'Trial balance generated');
  } catch (err) { next(err); }
};

// ─── General Ledger ───────────────────────────────────────────────────────────

const getGeneralLedger = async (req, res, next) => {
  try {
    const { startDate, endDate, accountId } = req.query;
    const data = await reportService.getGeneralLedger(
      req.user.businessId, new Date(startDate), new Date(endDate), accountId || null
    );
    ApiResponse.success(res, data, 'General ledger generated');
  } catch (err) { next(err); }
};

// ─── Aging Reports ────────────────────────────────────────────────────────────

const getAgingReport = async (req, res, next) => {
  try {
    const { type } = req.query; // 'receivable' | 'payable'
    if (!type) throw new ApiError(400, 'type query parameter is required (receivable or payable)');
    const data = await reportService.getAgingReport(req.user.businessId, type);
    ApiResponse.success(res, data, `${type} aging report generated`);
  } catch (err) { next(err); }
};

// ─── Tax Summary ──────────────────────────────────────────────────────────────

const getTaxSummary = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const data = await reportService.getTaxSummary(req.user.businessId, startDate, endDate);
    ApiResponse.success(res, data, 'Tax summary generated');
  } catch (err) { next(err); }
};

// ─── Liability Report ─────────────────────────────────────────────────────────

const getLiabilityReport = async (req, res, next) => {
  try {
    const { asOfDate } = req.query;
    const data = await reportService.getLiabilityReport(
      req.user.businessId, asOfDate ? new Date(asOfDate) : new Date()
    );
    ApiResponse.success(res, data, 'Liability report generated');
  } catch (err) { next(err); }
};

// ─── Comparative Reports ──────────────────────────────────────────────────────

const getComparativeIncomeStatement = async (req, res, next) => {
  try {
    const { currentStart, currentEnd, priorStart, priorEnd } = req.query;
    const data = await reportService.getComparativeIncomeStatement(
      req.user.businessId,
      new Date(currentStart), new Date(currentEnd),
      new Date(priorStart),   new Date(priorEnd)
    );
    ApiResponse.success(res, data, 'Comparative income statement generated');
  } catch (err) { next(err); }
};

const getComparativeBalanceSheet = async (req, res, next) => {
  try {
    const { currentDate, priorDate } = req.query;
    const data = await reportService.getComparativeBalanceSheet(
      req.user.businessId,
      new Date(currentDate), new Date(priorDate)
    );
    ApiResponse.success(res, data, 'Comparative balance sheet generated');
  } catch (err) { next(err); }
};

// ─── KPI Summary ─────────────────────────────────────────────────────────────

const getKPISummary = async (req, res, next) => {
  try {
    let { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      const now = new Date();
      endDate   = now;
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
      startDate = new Date(startDate);
      endDate   = new Date(endDate);
    }
    const data = await reportService.getKPISummary(req.user.businessId, startDate, endDate);
    ApiResponse.success(res, data, 'KPI summary generated');
  } catch (err) { next(err); }
};

// ─── Export (PDF / Excel) ─────────────────────────────────────────────────────

const exportReport = async (req, res, next) => {
  try {
    const { type, format, startDate, endDate, asOfDate } = req.query;
    const businessId   = req.user.businessId;
    const businessName = req.user.businessName || 'My Business';
    const currency     = req.user.currency || 'PKR';

    let reportData, fileBuffer, filename, contentType;

    switch (type) {
      case 'incomeStatement': {
        reportData = await reportService.getIncomeStatement(businessId, new Date(startDate), new Date(endDate));
        const period = `${startDate} to ${endDate}`;
        if (format === 'pdf') {
          fileBuffer  = await pdfExport.generateIncomeStatementPDF({ businessName, data: reportData, dateRange: period, currency });
          filename    = `income_statement_${startDate}_to_${endDate}.pdf`;
          contentType = 'application/pdf';
        } else {
          fileBuffer  = await excelExport.generateExcelReport('incomeStatement', reportData, { startDate, endDate });
          filename    = `income_statement_${startDate}_to_${endDate}.xlsx`;
          contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        }
        break;
      }
      case 'balanceSheet': {
        reportData = await reportService.getBalanceSheet(businessId, new Date(asOfDate));
        if (format === 'pdf') {
          fileBuffer  = await pdfExport.generateBalanceSheetPDF({ businessName, data: reportData, asOfDate, currency });
          filename    = `balance_sheet_${asOfDate}.pdf`;
          contentType = 'application/pdf';
        } else {
          fileBuffer  = await excelExport.generateExcelReport('balanceSheet', reportData, { asOfDate });
          filename    = `balance_sheet_${asOfDate}.xlsx`;
          contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        }
        break;
      }
      case 'cashFlow': {
        reportData = await reportService.getCashFlowStatement(businessId, new Date(startDate), new Date(endDate));
        const period = `${startDate} to ${endDate}`;
        if (format === 'pdf') {
          fileBuffer  = await pdfExport.generateCashFlowPDF({ businessName, data: reportData, dateRange: period, currency });
          filename    = `cash_flow_${startDate}_to_${endDate}.pdf`;
          contentType = 'application/pdf';
        } else {
          fileBuffer  = await excelExport.generateExcelReport('cashFlow', reportData, { startDate, endDate });
          filename    = `cash_flow_${startDate}_to_${endDate}.xlsx`;
          contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        }
        break;
      }
      case 'trialBalance': {
        reportData = await reportService.getTrialBalance(businessId, new Date(asOfDate));
        if (format === 'pdf') {
          fileBuffer  = await pdfExport.generateTrialBalancePDF({ businessName, data: reportData, asOfDate, currency });
          filename    = `trial_balance_${asOfDate}.pdf`;
          contentType = 'application/pdf';
        } else {
          fileBuffer  = await excelExport.generateExcelReport('trialBalance', reportData, { asOfDate });
          filename    = `trial_balance_${asOfDate}.xlsx`;
          contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        }
        break;
      }
      case 'generalLedger': {
        const { accountId } = req.query;
        reportData = await reportService.getGeneralLedger(businessId, new Date(startDate), new Date(endDate), accountId || null);
        if (format === 'pdf') {
          fileBuffer  = await pdfExport.generateGeneralLedgerPDF({ businessName, data: reportData, dateRange: `${startDate} to ${endDate}`, currency });
          filename    = `general_ledger_${startDate}_to_${endDate}.pdf`;
          contentType = 'application/pdf';
        } else {
          fileBuffer  = await excelExport.generateExcelReport('generalLedger', reportData, { startDate, endDate });
          filename    = `general_ledger_${startDate}_to_${endDate}.xlsx`;
          contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        }
        break;
      }
      case 'aging': {
        const { agingType } = req.query;
        reportData = await reportService.getAgingReport(businessId, agingType || 'receivable');
        if (format === 'pdf') {
          fileBuffer  = await pdfExport.generateAgingPDF({ businessName, data: reportData, currency });
          filename    = `aging_${agingType || 'receivable'}_${new Date().toISOString().split('T')[0]}.pdf`;
          contentType = 'application/pdf';
        } else {
          fileBuffer  = await excelExport.generateExcelReport('aging', reportData, { type: agingType || 'receivable' });
          filename    = `aging_${agingType || 'receivable'}_${new Date().toISOString().split('T')[0]}.xlsx`;
          contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        }
        break;
      }
      default:
        throw new ApiError(400, 'Invalid report type');
    }

    try {
      await auditService.logExport(
        'report', businessId, businessId, req.user.id,
        { reportType: type, format, dateRange: startDate ? `${startDate} to ${endDate}` : asOfDate },
        req.ip
      );
    } catch (auditErr) {
      logger.warn('Audit log failed for report export:', auditErr.message);
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(fileBuffer);
  } catch (err) { next(err); }
};

module.exports = {
  getIncomeStatement,
  getBalanceSheet,
  getCashFlowStatement,
  getTrialBalance,
  getGeneralLedger,
  getAgingReport,
  getTaxSummary,
  getLiabilityReport,
  getComparativeIncomeStatement,
  getComparativeBalanceSheet,
  getKPISummary,
  exportReport,
};
