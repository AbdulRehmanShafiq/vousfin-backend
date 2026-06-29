const crypto = require('crypto');
const JournalEntry = require('../models/JournalEntry.model');
const AnomalyAlert = require('../models/AnomalyAlert.model');
const Invoice = require('../models/Invoice.model');
const Bill = require('../models/Bill.model');
const BankStatement = require('../models/BankStatement.model');
const Budget = require('../models/Budget.model');
const TaxPositionSnapshot = require('../models/TaxPositionSnapshot.model');
const transactionRepository = require('../repositories/transaction.repository');

const MAX_RECORDS_PER_TYPE = parseInt(process.env.RAG_INDEX_MAX_RECORDS_PER_TYPE, 10) || 5000;

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function periodFromDate(date = new Date()) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return 'unknown-period';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function roundAmount(amount) {
  const numeric = Number(amount || 0);
  if (!numeric) return 0;
  const rounded = Math.round(Math.abs(numeric) / 1000) * 1000;
  return rounded === 0 ? 1000 : rounded;
}

function formatAmount(amount) {
  const rounded = roundAmount(amount);
  if (rounded >= 1000000) {
    const value = rounded / 1000000;
    return `~PKR ${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}M`;
  }
  return `~PKR ${(rounded / 1000).toFixed(0)}K`;
}

function sanitizeText(value) {
  return String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[phone redacted]')
    .replace(/\b(?:NTN|STRN|CNIC|GST|VAT|TAX)\s*[:#-]?\s*[A-Z0-9-]{4,}\b/gi, '[tax id redacted]')
    .replace(/\b(?:INV|INVOICE|BILL|PO|GRN|REF)\s*[-#:]*\s*[A-Z0-9-]{3,}\b/gi, '[reference redacted]')
    .replace(/\b\d{5,}\b/g, '[number redacted]')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanAccountName(account) {
  const name = account?.accountName || account?.name || account || 'an accounting category';
  return sanitizeText(name)
    .replace(/\b\d{3,}[-\w]*\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function daysOverdue(record) {
  if (!record?.dueDate) return 0;
  const due = new Date(record.dueDate);
  if (Number.isNaN(due.getTime())) return 0;
  return Math.max(0, Math.ceil((Date.now() - due.getTime()) / 86400000));
}

function makeSummary(dataType, recordId, period, summary, metadata = {}) {
  return {
    dataType,
    recordId: String(recordId),
    period,
    summary,
    hash: hash(summary),
    metadata,
  };
}

function paymentState(record) {
  if (record.paymentStatus) return record.paymentStatus.replace(/_/g, ' ');
  if (record.remainingBalance > 0) return 'outstanding';
  return 'posted';
}

async function summarizeInvoices(businessId, invoices) {
  return invoices.map((inv, index) => {
    const amount = formatAmount(inv.totalAmount ?? inv.amount ?? inv.remainingBalance);
    const issueDate = inv.issueDate || inv.transactionDate || inv.createdAt || new Date();
    const overdueDays = daysOverdue(inv);
    const period = periodFromDate(issueDate);

    let summary = `A customer receivable for ${amount} was recorded in ${period}.`;
    if (overdueDays > 0 || inv.status === 'overdue' || inv.paymentStatus === 'overdue') {
      summary += ` It is overdue by approximately ${overdueDays || 1} day${overdueDays === 1 ? '' : 's'}.`;
    } else if (inv.status === 'paid' || inv.paymentStatus === 'paid') {
      summary += ' It has been settled.';
    } else {
      summary += ` It is currently ${paymentState(inv)}.`;
    }

    return makeSummary(
      'invoice_summary',
      inv._id || `invoice-${index}`,
      period,
      summary,
      { sourceModel: 'JournalEntry', sourceRole: 'receivable' }
    );
  });
}

async function summarizeBills(businessId, bills) {
  return bills.map((bill, index) => {
    const amount = formatAmount(bill.totalAmount ?? bill.amount ?? bill.remainingBalance);
    const entryDate = bill.issueDate || bill.transactionDate || bill.createdAt || new Date();
    const overdueDays = daysOverdue(bill);
    const period = periodFromDate(entryDate);

    let summary = `A supplier payable for ${amount} was recorded in ${period}.`;
    if (overdueDays > 0 || bill.status === 'overdue' || bill.paymentStatus === 'overdue') {
      summary += ` It is overdue by approximately ${overdueDays || 1} day${overdueDays === 1 ? '' : 's'}.`;
    } else if (bill.status === 'paid' || bill.paymentStatus === 'paid') {
      summary += ' It has been settled.';
    } else {
      summary += ` It is currently ${paymentState(bill)}.`;
    }

    return makeSummary(
      'bill_summary',
      bill._id || `bill-${index}`,
      period,
      summary,
      { sourceModel: 'JournalEntry', sourceRole: 'payable' }
    );
  });
}

async function summarizePayments(businessId, payments) {
  return payments.map((payment, index) => {
    const amount = formatAmount(payment.amount);
    const period = periodFromDate(payment.transactionDate || payment.updatedAt || new Date());
    const type = String(payment.transactionType || 'payment').toLowerCase();
    const summary = `A ${type} of ${amount} was recorded in ${period}. It changed settlement activity without exposing party details.`;

    return makeSummary(
      'payment_summary',
      payment._id || `payment-${index}`,
      period,
      summary,
      { sourceModel: 'JournalEntry' }
    );
  });
}

async function summarizeJournalEntries(businessId, entries) {
  return entries.map((entry, index) => {
    const period = periodFromDate(entry.transactionDate || entry.createdAt || new Date());
    const amount = formatAmount(entry.amount);
    const debit = cleanAccountName(entry.debitAccountId || entry.debitAccount);
    const credit = cleanAccountName(entry.creditAccountId || entry.creditAccount);
    const type = String(entry.transactionType || 'journal activity').toLowerCase();
    const cashFlow = entry.affectsCashFlow === false ? 'It does not directly affect cash flow.' : 'It affects cash flow reporting.';
    const summary = `A ${type} journal entry for ${amount} was posted in ${period}, moving value between ${debit} and ${credit}. ${cashFlow} Payment state: ${paymentState(entry)}.`;

    return makeSummary(
      'journal_entry_summary',
      entry._id || `journal-${index}`,
      period,
      summary,
      { sourceModel: 'JournalEntry' }
    );
  });
}

async function summarizePnL(businessId, period, pnlData = {}) {
  const totalRevenue = Number(pnlData.totalRevenue || pnlData.revenue?.total || 0);
  const totalExpenses = Number(pnlData.totalExpenses || 0);
  const grossProfit = Number(pnlData.grossProfit || 0);
  const netIncome = Number(pnlData.netIncome ?? pnlData.netProfit ?? 0);
  const operatingExpenses = Number(pnlData.operatingExpenses?.total || pnlData.operatingExpenses || 0);
  const grossMargin = totalRevenue ? Math.round((grossProfit / totalRevenue) * 100) : 0;
  const opexRatio = totalRevenue ? Math.round((operatingExpenses / totalRevenue) * 100) : 0;

  let trend = '';
  if (typeof pnlData.revenueGrowth === 'number' && Number.isFinite(pnlData.revenueGrowth)) {
    trend = pnlData.revenueGrowth >= 0
      ? ` Revenue grew approximately ${Math.round(pnlData.revenueGrowth)}% versus the prior period.`
      : ` Revenue declined approximately ${Math.abs(Math.round(pnlData.revenueGrowth))}% versus the prior period.`;
  }

  const profitPhrase = netIncome >= 0
    ? `Net income was ${formatAmount(netIncome)}.`
    : `The period produced a net loss of ${formatAmount(netIncome)}.`;

  const summary = `Financial performance for ${period}: revenue was ${formatAmount(totalRevenue)} and expenses were ${formatAmount(totalExpenses)}. Gross margin was approximately ${grossMargin}%.${trend} ${profitPhrase} Operating expenses consumed approximately ${opexRatio}% of revenue.`;

  return makeSummary('monthly_pnl', `pnl-${period}`, period, summary, {
    sourceModel: 'ReportService',
    totalRevenueRounded: roundAmount(totalRevenue),
  });
}

async function summarizeCashFlow(businessId, period, cashFlowData = {}) {
  const netCashFlow = Number(cashFlowData.netCashFlow || 0);
  const operatingCashFlow = Number(cashFlowData.operating?.total || 0);
  const direction = netCashFlow >= 0 ? 'positive' : 'negative';
  const summary = `Cash flow for ${period}: net cash flow was ${direction} at ${formatAmount(netCashFlow)}. Operating cash flow was approximately ${formatAmount(operatingCashFlow)}.`;

  return makeSummary('monthly_cashflow', `cashflow-${period}`, period, summary, {
    sourceModel: 'ReportService',
  });
}

async function summarizeAgingReport(businessId, period, type, aging = {}) {
  const total = Number(aging.total || 0);
  const overdue = Number(aging.days_1_30 || 0) + Number(aging.days_31_60 || 0) + Number(aging.days_61_90 || 0) + Number(aging.days_over_90 || 0);
  const label = type === 'payable' ? 'payables' : 'receivables';
  const summary = `Aging summary for ${period}: ${label} total approximately ${formatAmount(total)}, with overdue balances of approximately ${formatAmount(overdue)}.`;

  return makeSummary(`${type}_aging_summary`, `${type}-aging-${period}`, period, summary, {
    sourceModel: 'ReportService',
  });
}

async function summarizeAnomaly(businessId, alert) {
  const period = periodFromDate(alert.detectedAt || alert.journalEntryId?.transactionDate || new Date());
  const amount = formatAmount(alert.featureVector?.amount || alert.journalEntryId?.amount || 0);
  const severity = alert.anomalyScore <= -0.5 ? 'high' : alert.anomalyScore <= -0.25 ? 'medium' : 'low';
  const summary = `An unusual accounting pattern was detected in ${period}. The anomaly involved approximately ${amount}; severity is ${severity}. Reason category: ${String(alert.reason || 'unusual transaction pattern').replace(/\b\d[\d,]*(\.\d+)?\b/g, 'amount')}.`;

  return makeSummary('anomaly_summary', alert._id, period, summary, {
    sourceModel: 'AnomalyAlert',
    status: alert.status,
  });
}

async function summarizeAnomalies(businessId, alerts) {
  return Promise.all(alerts.map((alert) => summarizeAnomaly(businessId, alert)));
}

async function summarizeBankStatements(businessId, statements) {
  return statements.map((statement, index) => {
    const period = periodFromDate(statement.periodEnd || statement.periodStart || statement.createdAt || new Date());
    const lines = Array.isArray(statement.lines) ? statement.lines : [];
    const unmatched = lines.filter((line) => line.status === 'unmatched').length;
    const matched = lines.filter((line) => line.matchedJournalEntryId || line.status === 'matched').length;
    const totalIn = lines
      .filter((line) => String(line.direction || '').toLowerCase().includes('in'))
      .reduce((sum, line) => sum + Number(line.amount || 0), 0);
    const totalOut = lines
      .filter((line) => String(line.direction || '').toLowerCase().includes('out'))
      .reduce((sum, line) => sum + Number(line.amount || 0), 0);

    const summary = `Bank statement activity for ${period}: ${lines.length} imported bank line${lines.length === 1 ? '' : 's'}, ${matched} matched and ${unmatched} unmatched. Inflows were approximately ${formatAmount(totalIn)} and outflows were approximately ${formatAmount(totalOut)}. Statement status is ${sanitizeText(statement.status || 'in progress')}.`;

    return makeSummary('bank_statement_summary', statement._id || `bank-statement-${index}`, period, summary, {
      sourceModel: 'BankStatement',
      bankAccountId: statement.bankAccountId ? String(statement.bankAccountId) : null,
    });
  });
}

async function summarizeBudgets(businessId, budgets) {
  return budgets.map((budget, index) => {
    const period = budget.createdAt ? String(new Date(budget.createdAt).getFullYear()) : 'budget-period';
    const lines = Array.isArray(budget.lines) ? budget.lines : [];
    const annualTotal = lines.reduce((sum, line) => {
      const monthly = Array.isArray(line.monthly) ? line.monthly : [];
      return sum + monthly.reduce((inner, amount) => inner + Number(amount || 0), 0);
    }, 0);
    const threshold = Number(budget.defaultThresholdPct || 0);
    const summary = `Budget plan ${sanitizeText(budget.scenario || 'base')} for ${period}: ${lines.length} budget line${lines.length === 1 ? '' : 's'} with annual planned spend of approximately ${formatAmount(annualTotal)}. Default variance threshold is about ${Math.round(threshold)}%. Current status is ${sanitizeText(budget.status || 'draft')}.`;

    return makeSummary('budget_summary', budget._id || `budget-${index}`, period, summary, {
      sourceModel: 'Budget',
      scenario: budget.scenario,
      status: budget.status,
    });
  });
}

async function summarizeTaxPositionSnapshots(businessId, snapshots) {
  return snapshots.map((snapshot, index) => {
    const period = snapshot.date ? String(snapshot.date).slice(0, 7) : periodFromDate(snapshot.capturedAt || new Date());
    const taxes = Array.isArray(snapshot.taxes) ? snapshot.taxes : [];
    const topTax = taxes
      .slice()
      .sort((a, b) => Number(b.liability || 0) - Number(a.liability || 0))[0];
    const topPhrase = topTax
      ? ` Largest tracked tax line is ${sanitizeText(topTax.taxType)} at approximately ${formatAmount(topTax.liability)}.`
      : '';
    const summary = `Tax position snapshot for ${period}: total payable was approximately ${formatAmount(snapshot.totalPayable)} across ${taxes.length} tracked tax line${taxes.length === 1 ? '' : 's'}.${topPhrase}`;

    return makeSummary('tax_position_summary', snapshot._id || `tax-position-${index}`, period, summary, {
      sourceModel: 'TaxPositionSnapshot',
      date: snapshot.date,
    });
  });
}

async function summarize(businessId, dataType, records) {
  switch (dataType) {
    case 'invoice':
    case 'invoice_summary':
    case 'receivable':
      return summarizeInvoices(businessId, records);
    case 'bill':
    case 'bill_summary':
    case 'payable':
      return summarizeBills(businessId, records);
    case 'payment':
    case 'payment_summary':
      return summarizePayments(businessId, records);
    case 'journal_entry':
    case 'journal_entry_summary':
      return summarizeJournalEntries(businessId, records);
    case 'anomaly':
    case 'anomaly_summary':
      return summarizeAnomalies(businessId, records);
    case 'bank_statement':
    case 'bank_statement_summary':
      return summarizeBankStatements(businessId, records);
    case 'budget':
    case 'budget_summary':
      return summarizeBudgets(businessId, records);
    case 'tax_position':
    case 'tax_position_summary':
      return summarizeTaxPositionSnapshots(businessId, records);
    default:
      throw new Error(`Unsupported summarizer data type: ${dataType}`);
  }
}

async function getModifiedRecords(businessId, dataType, since = new Date(0)) {
  const changedSince = since instanceof Date ? since : new Date(since || 0);
  const updatedFilter = { $gte: changedSince };

  switch (dataType) {
    case 'invoice':
    case 'invoice_summary': {
      const records = await Invoice.find({
        businessId,
        isArchived: { $ne: true },
        updatedAt: updatedFilter,
      })
        .sort({ issueDate: -1 })
        .limit(MAX_RECORDS_PER_TYPE)
        .lean();
      if (records.length) return records;
      const fallback = await transactionRepository.getOutstandingReceivables(businessId);
      return fallback.filter((record) => !record.updatedAt || new Date(record.updatedAt) >= changedSince);
    }
    case 'bill':
    case 'bill_summary': {
      const records = await Bill.find({
        businessId,
        isArchived: { $ne: true },
        updatedAt: updatedFilter,
      })
        .sort({ issueDate: -1 })
        .limit(MAX_RECORDS_PER_TYPE)
        .lean();
      if (records.length) return records;
      const fallback = await transactionRepository.getOutstandingPayables(businessId);
      return fallback.filter((record) => !record.updatedAt || new Date(record.updatedAt) >= changedSince);
    }
    case 'payment':
    case 'payment_summary':
      return JournalEntry.find({
        businessId,
        isArchived: { $ne: true },
        $or: [
          { paymentStatus: 'paid' },
          { transactionType: { $in: ['Payment Received', 'Payment Made', 'Installment Payment'] } },
        ],
        updatedAt: updatedFilter,
      })
        .sort({ transactionDate: -1 })
        .limit(MAX_RECORDS_PER_TYPE)
        .lean();
    case 'journal_entry':
    case 'journal_entry_summary':
      return JournalEntry.find({
        businessId,
        isArchived: { $ne: true },
        updatedAt: updatedFilter,
      })
        .populate('debitAccountId', 'accountName accountType')
        .populate('creditAccountId', 'accountName accountType')
        .sort({ transactionDate: -1 })
        .limit(MAX_RECORDS_PER_TYPE)
        .lean();
    case 'anomaly':
    case 'anomaly_summary':
      return AnomalyAlert.find({
        businessId,
        detectedAt: updatedFilter,
      })
        .populate('journalEntryId', 'amount transactionDate transactionType')
        .sort({ detectedAt: -1 })
        .limit(MAX_RECORDS_PER_TYPE)
        .lean();
    case 'bank_statement':
    case 'bank_statement_summary':
      return BankStatement.find({
        businessId,
        updatedAt: updatedFilter,
      })
        .sort({ periodEnd: -1, createdAt: -1 })
        .limit(MAX_RECORDS_PER_TYPE)
        .lean();
    case 'budget':
    case 'budget_summary':
      return Budget.find({
        businessId,
        updatedAt: updatedFilter,
      })
        .sort({ updatedAt: -1 })
        .limit(MAX_RECORDS_PER_TYPE)
        .lean();
    case 'tax_position':
    case 'tax_position_summary':
      return TaxPositionSnapshot.find({
        businessId,
        updatedAt: updatedFilter,
      })
        .sort({ date: -1 })
        .limit(MAX_RECORDS_PER_TYPE)
        .lean();
    default:
      return [];
  }
}

module.exports = {
  summarize,
  summarizeInvoices,
  summarizeBills,
  summarizePayments,
  summarizeJournalEntries,
  summarizePnL,
  summarizeCashFlow,
  summarizeAgingReport,
  summarizeAnomaly,
  summarizeAnomalies,
  summarizeBankStatements,
  summarizeBudgets,
  summarizeTaxPositionSnapshots,
  getModifiedRecords,
  sanitizeText,
  formatAmount,
  roundAmount,
  periodFromDate,
};
