// controllers/report.controller.js
const reportService = require('../services/report.service');
const ApiResponse = require('../utils/ApiResponse');
const { ApiError } = require('../utils/ApiError');
const { generateIncomeStatement, generateBalanceSheet, generateCashFlowStatement } = require('../utils/pdfExport.utils');
const { generateExcelReport } = require('../utils/excelExport.utils');
const auditService = require('../services/audit.service');
const logger = require('../config/logger');

/**
 * Get Income Statement for a date range.
 * GET /api/v1/reports/income-statement
 * Query: startDate, endDate (ISO strings)
 */
const getIncomeStatement = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const start = new Date(startDate);
    const end = new Date(endDate);
    const data = await reportService.getIncomeStatement(req.user.businessId, start, end);
    ApiResponse.success(res, data, 'Income statement generated');
  } catch (error) {
    next(error);
  }
};

/**
 * Get Balance Sheet as of a specific date.
 * GET /api/v1/reports/balance-sheet
 * Query: asOfDate (ISO string)
 */
const getBalanceSheet = async (req, res, next) => {
  try {
    const { asOfDate } = req.query;
    const date = new Date(asOfDate);
    const data = await reportService.getBalanceSheet(req.user.businessId, date);
    ApiResponse.success(res, data, 'Balance sheet generated');
  } catch (error) {
    next(error);
  }
};

/**
 * Get Cash Flow Statement for a date range.
 * GET /api/v1/reports/cash-flow
 * Query: startDate, endDate (ISO strings)
 */
const getCashFlowStatement = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const start = new Date(startDate);
    const end = new Date(endDate);
    const data = await reportService.getCashFlowStatement(req.user.businessId, start, end);
    ApiResponse.success(res, data, 'Cash flow statement generated');
  } catch (error) {
    next(error);
  }
};

/**
 * Get KPI summary (optional – can be used by dashboard or separate reporting).
 * GET /api/v1/reports/kpi
 * Query: startDate, endDate (optional, defaults to current month)
 */
const getKPISummary = async (req, res, next) => {
  try {
    let { startDate, endDate } = req.query;
    if (!startDate && !endDate) {
      const now = new Date();
      endDate = now;
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
      startDate = new Date(startDate);
      endDate = new Date(endDate);
    }
    const kpis = await reportService.getKPISummary(req.user.businessId, startDate, endDate);
    ApiResponse.success(res, kpis, 'KPI summary generated');
  } catch (error) {
    next(error);
  }
};

/**
 * Export a financial report to PDF or Excel.
 * GET /api/v1/reports/export
 * Query: type (incomeStatement, balanceSheet, cashFlow), format (pdf, xlsx),
 *        startDate, endDate (for incomeStatement/cashFlow), asOfDate (for balanceSheet)
 */
const exportReport = async (req, res, next) => {
  try {
    const { type, format, startDate, endDate, asOfDate } = req.query;
    const businessId = req.user.businessId;
    const businessName = req.user.businessName || 'My Business'; // you might need to fetch from businessService

    let reportData;
    let pdfBuffer;
    let filename;
    let contentType;

    // Generate report data based on type
    switch (type) {
      case 'incomeStatement':
        reportData = await reportService.getIncomeStatement(businessId, new Date(startDate), new Date(endDate));
        if (format === 'pdf') {
          pdfBuffer = await generateIncomeStatement({
            businessName,
            data: {
              revenue: reportData.revenue,
              expenses: reportData.expenses,
              grossProfit: reportData.grossProfit,
              operatingProfit: reportData.operatingProfit,
              netProfit: reportData.netProfit,
            },
            dateRange: `${startDate} to ${endDate}`,
            currency: 'PKR',
          });
          filename = `income_statement_${startDate}_to_${endDate}.pdf`;
          contentType = 'application/pdf';
        } else {
          // Excel export – you would need to implement generateExcelReport in excelExport.utils.js
          const excelBuffer = await generateExcelReport('incomeStatement', reportData, { startDate, endDate });
          filename = `income_statement_${startDate}_to_${endDate}.xlsx`;
          contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
          pdfBuffer = excelBuffer;
        }
        break;

      case 'balanceSheet':
        reportData = await reportService.getBalanceSheet(businessId, new Date(asOfDate));
        if (format === 'pdf') {
          pdfBuffer = await generateBalanceSheet({
            businessName,
            data: {
              assets: reportData.assets,
              liabilities: reportData.liabilities,
              equity: reportData.equity,
              totalAssets: reportData.totalAssets,
              totalLiabilities: reportData.totalLiabilities,
              totalEquity: reportData.totalEquity,
            },
            asOfDate: asOfDate,
            currency: 'PKR',
          });
          filename = `balance_sheet_${asOfDate}.pdf`;
          contentType = 'application/pdf';
        } else {
          // Excel export
          const excelBuffer = await generateExcelReport('balanceSheet', reportData, { asOfDate });
          filename = `balance_sheet_${asOfDate}.xlsx`;
          contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
          pdfBuffer = excelBuffer;
        }
        break;

      case 'cashFlow':
        reportData = await reportService.getCashFlowStatement(businessId, new Date(startDate), new Date(endDate));
        if (format === 'pdf') {
          pdfBuffer = await generateCashFlowStatement({
            businessName,
            data: {
              operating: reportData.operating,
              investing: reportData.investing,
              financing: reportData.financing,
              netCashFlow: reportData.netCashFlow,
            },
            dateRange: `${startDate} to ${endDate}`,
            currency: 'PKR',
          });
          filename = `cash_flow_${startDate}_to_${endDate}.pdf`;
          contentType = 'application/pdf';
        } else {
          const excelBuffer = await generateExcelReport('cashFlow', reportData, { startDate, endDate });
          filename = `cash_flow_${startDate}_to_${endDate}.xlsx`;
          contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
          pdfBuffer = excelBuffer;
        }
        break;

      default:
        throw new ApiError(400, 'Invalid report type');
    }

    // Log export action
    await auditService.logExport(
      'report',
      businessId,
      businessId,
      req.user.id,
      { reportType: type, format, dateRange: startDate ? `${startDate} to ${endDate}` : asOfDate },
      req.ip
    );

    // Set headers and send file
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (error) {
    next(error);
  }
};

/**
 * Get Trial Balance as of a specific date.
 * GET /api/v1/reports/trial-balance
 * Query: asOfDate (ISO string)
 */
const getTrialBalance = async (req, res, next) => {
  try {
    const { asOfDate } = req.query;
    const date = new Date(asOfDate);
    const data = await reportService.getTrialBalance(req.user.businessId, date);
    ApiResponse.success(res, data, 'Trial balance generated');
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getIncomeStatement,
  getBalanceSheet,
  getCashFlowStatement,
  getKPISummary,
  exportReport,
  getTrialBalance,
};