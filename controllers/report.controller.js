// controllers/report.controller.js
const reportService      = require('../services/report.service');
const booksAssurance     = require('../services/booksAssurance.service');
const ApiResponse        = require('../utils/ApiResponse');
const { ApiError }       = require('../utils/ApiError');
const pdfExport          = require('../utils/pdfExport.utils');
const excelExport        = require('../utils/excelExport.utils');
const auditService       = require('../services/audit.service');
const businessRepository = require('../repositories/business.repository');
const logger             = require('../config/logger');

// ─── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Parse a date string and, if it has no time component (i.e. it was a plain
 * "YYYY-MM-DD" from an <input type="date">), extend it to 23:59:59.999 UTC.
 *
 * Why this matters: `new Date("2026-06-03")` is midnight UTC.  Every
 * transaction posted that calendar day has a transactionDate AFTER that
 * instant, so a naïve `$lte: new Date(asOfDate)` silently excludes all
 * same-day entries.  Accountants naturally expect "as of June 3" to mean
 * "include everything that happened on June 3", so we honour that.
 *
 * @param {string|Date} dateStr
 * @returns {Date}
 */
function toEndOfDay(dateStr) {
  const d = new Date(dateStr);
  if (
    d.getUTCHours()        === 0 &&
    d.getUTCMinutes()      === 0 &&
    d.getUTCSeconds()      === 0 &&
    d.getUTCMilliseconds() === 0
  ) {
    d.setUTCHours(23, 59, 59, 999);
  }
  return d;
}

/** Parse a start-of-period date (keeps it at midnight — already correct). */
const toStartOfDay = (dateStr) => new Date(dateStr);

/**
 * Resolve report date params with sensible defaults.
 * - asOfDate  → today (end-of-day)
 * - startDate → 1 Jan of current year
 * - endDate   → today
 * All return ISO date strings so toEndOfDay / toStartOfDay keep working.
 */
function resolveReportDates(query) {
  const now      = new Date();
  const today    = now.toISOString().split('T')[0];
  const yearStart = `${now.getFullYear()}-01-01`;
  return {
    asOfDate:  query.asOfDate  || today,
    startDate: query.startDate || yearStart,
    endDate:   query.endDate   || today,
  };
}

// ─── Income Statement ────────────────────────────────────────────────────────

const getIncomeStatement = async (req, res, next) => {
  try {
    const { startDate, endDate } = resolveReportDates(req.query);
    const data = await reportService.getIncomeStatement(
      req.user.businessId, toStartOfDay(startDate), toEndOfDay(endDate)
    );
    ApiResponse.success(res, data, 'Income statement generated');
  } catch (err) { next(err); }
};

// ─── Balance Sheet ────────────────────────────────────────────────────────────

const getBalanceSheet = async (req, res, next) => {
  try {
    const { asOfDate } = resolveReportDates(req.query);
    const { compareDate } = req.query;
    const data = await reportService.getBalanceSheet(
      req.user.businessId,
      toEndOfDay(asOfDate),
      compareDate ? toEndOfDay(compareDate) : null
    );
    ApiResponse.success(res, data, 'Balance sheet generated');
  } catch (err) { next(err); }
};

// ─── Cash Flow ────────────────────────────────────────────────────────────────

const getCashFlowStatement = async (req, res, next) => {
  try {
    const { startDate, endDate } = resolveReportDates(req.query);
    const data = await reportService.getCashFlowStatement(
      req.user.businessId, toStartOfDay(startDate), toEndOfDay(endDate)
    );
    ApiResponse.success(res, data, 'Cash flow statement generated');
  } catch (err) { next(err); }
};

// ─── Trial Balance ────────────────────────────────────────────────────────────

/**
 * GET /reports/books-assurance — do the books still add up?
 *
 * The standing check behind the product's claim: not "we hope so", but four
 * invariants re-derived from the accounting records on every request. Nothing is
 * stored or cached — a verdict with a shelf life would be the very thing this
 * exists to disprove.
 */
const getBooksAssurance = async (req, res, next) => {
  try {
    const { asOfDate } = resolveReportDates(req.query);
    const data = await booksAssurance.verify(req.user.businessId, { asOf: toEndOfDay(asOfDate) });
    ApiResponse.success(
      res,
      data,
      data.correct ? 'Your books add up' : data.summary
    );
  } catch (err) { next(err); }
};

const getTrialBalance = async (req, res, next) => {
  try {
    const { asOfDate } = resolveReportDates(req.query);
    const { fromDate } = req.query;
    const data = await reportService.getTrialBalance(
      req.user.businessId,
      toEndOfDay(asOfDate),
      fromDate ? toStartOfDay(fromDate) : null
    );
    ApiResponse.success(res, data, 'Trial balance generated');
  } catch (err) { next(err); }
};

// ─── General Ledger ───────────────────────────────────────────────────────────

const getGeneralLedger = async (req, res, next) => {
  try {
    const { startDate, endDate } = resolveReportDates(req.query);
    const { accountId } = req.query;
    const data = await reportService.getGeneralLedger(
      req.user.businessId, toStartOfDay(startDate), toEndOfDay(endDate), accountId || null
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
      req.user.businessId, asOfDate ? toEndOfDay(asOfDate) : new Date()
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
      toStartOfDay(currentStart), toEndOfDay(currentEnd),
      toStartOfDay(priorStart),   toEndOfDay(priorEnd)
    );
    ApiResponse.success(res, data, 'Comparative income statement generated');
  } catch (err) { next(err); }
};

const getComparativeBalanceSheet = async (req, res, next) => {
  try {
    const { currentDate, priorDate } = req.query;
    const data = await reportService.getComparativeBalanceSheet(
      req.user.businessId,
      toEndOfDay(currentDate), toEndOfDay(priorDate)
    );
    ApiResponse.success(res, data, 'Comparative balance sheet generated');
  } catch (err) { next(err); }
};

// ─── KPI Summary ─────────────────────────────────────────────────────────────

const getKPISummary = async (req, res, next) => {
  try {
    let { startDate, endDate } = req.query;
    let start, end;
    if (!startDate || !endDate) {
      end   = new Date();
      start = new Date(end.getFullYear(), end.getMonth(), 1);
    } else {
      start = toStartOfDay(startDate);
      end   = toEndOfDay(endDate);
    }
    const data = await reportService.getKPISummary(req.user.businessId, start, end);
    ApiResponse.success(res, data, 'KPI summary generated');
  } catch (err) { next(err); }
};

// ─── Statement of Changes in Equity ──────────────────────────────────────────

const getStatementOfChangesInEquity = async (req, res, next) => {
  try {
    const { startDate, endDate } = resolveReportDates(req.query);
    const data = await reportService.getStatementOfChangesInEquity(
      req.user.businessId, toStartOfDay(startDate), toEndOfDay(endDate)
    );
    ApiResponse.success(res, data, 'Statement of changes in equity generated');
  } catch (err) { next(err); }
};

// ─── Revenue Notes (IFRS-15) — stub; service built in Task 3 ─────────────────

const getRevenueNotes = async (req, res, next) => {
  try {
    const { startDate, endDate } = resolveReportDates(req.query);
    const data = await reportService.getRevenueNotes(
      req.user.businessId, toStartOfDay(startDate), toEndOfDay(endDate)
    );
    ApiResponse.success(res, data, 'Revenue notes generated');
  } catch (err) { next(err); }
};

// ─── Export (PDF / Excel) ─────────────────────────────────────────────────────

const exportReport = async (req, res, next) => {
  try {
    const { type, format, startDate, endDate, asOfDate } = req.query;
    const businessId = req.user.businessId;

    // Fetch the real business name and currency from the database.
    // req.user only carries auth-essential fields from the JWT; businessName
    // is stored on the Business document, not in the token payload.
    const business     = await businessRepository.findById(businessId);
    const businessName = business?.businessName || 'My Business';
    const currency     = business?.currency     || 'PKR';

    let reportData, fileBuffer, filename, contentType;

    switch (type) {
      case 'incomeStatement': {
        reportData = await reportService.getIncomeStatement(businessId, toStartOfDay(startDate), toEndOfDay(endDate));
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
        reportData = await reportService.getBalanceSheet(businessId, toEndOfDay(asOfDate));
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
        reportData = await reportService.getCashFlowStatement(businessId, toStartOfDay(startDate), toEndOfDay(endDate));
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
        reportData = await reportService.getTrialBalance(businessId, toEndOfDay(asOfDate));
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
        reportData = await reportService.getGeneralLedger(businessId, toStartOfDay(startDate), toEndOfDay(endDate), accountId || null);
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
      case 'equity': {
        reportData = await reportService.getStatementOfChangesInEquity(businessId, toStartOfDay(startDate), toEndOfDay(endDate));
        const period = `${startDate} to ${endDate}`;
        if (format === 'pdf') {
          fileBuffer  = await pdfExport.generateEquityStatementPDF({ businessName, data: reportData, dateRange: period, currency });
          filename    = `statement_of_changes_in_equity_${startDate}_to_${endDate}.pdf`;
          contentType = 'application/pdf';
        } else {
          fileBuffer  = await excelExport.generateExcelReport('equityStatement', reportData, { startDate, endDate });
          filename    = `statement_of_changes_in_equity_${startDate}_to_${endDate}.xlsx`;
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

/**
 * FR-02.2 — AI-narrated financial statements (English + Urdu).
 * GET /api/v1/reports/narrative?period=month|quarter
 * Grounded by construction: every figure is computed from the GL and returned
 * with a drill-down link.
 */
const getNarrative = async (req, res, next) => {
  try {
    const narrativeService = require('../services/narrative.service');
    const period = req.query.period === 'quarter' ? 'quarter' : 'month';
    const data = await narrativeService.getNarrative(req.user.businessId, { period });
    ApiResponse.success(res, data, 'Narrative generated');
  } catch (err) { next(err); }
};

module.exports = {
  getBooksAssurance,
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
  getNarrative,
  getStatementOfChangesInEquity,
  getRevenueNotes,
};
