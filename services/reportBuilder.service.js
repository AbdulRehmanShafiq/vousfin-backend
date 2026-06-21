'use strict';

const reportTemplateRepo = require('../repositories/reportTemplate.repository');
const reportService = require('./report.service');
const accountRepository = require('../repositories/account.repository');
const transactionRepository = require('../repositories/transaction.repository');
const { ApiError } = require('../utils/ApiError');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const DAY = 86400000;

/** Pure: compute the comparative prior window for a given mode. */
function computeComparativeWindow(mode, startDate, endDate, custom = {}) {
  const s = new Date(startDate), e = new Date(endDate);
  if (mode === 'custom') {
    return { priorStart: new Date(custom.priorStart), priorEnd: new Date(custom.priorEnd) };
  }
  if (mode === 'prior-year') {
    const priorStart = new Date(s); priorStart.setFullYear(s.getFullYear() - 1);
    const priorEnd = new Date(e); priorEnd.setFullYear(e.getFullYear() - 1);
    return { priorStart, priorEnd };
  }
  // prior-period: immediately preceding window of equal length
  const len = e.getTime() - s.getTime();
  const priorEnd = new Date(s.getTime() - DAY);
  const priorStart = new Date(priorEnd.getTime() - len);
  return { priorStart, priorEnd };
}

/** Seed a starter layout from the chart of accounts. */
function defaultLayoutFor(baseType, accounts) {
  const mk = (id, kind, label, extra = {}) => ({ id, kind, label, visible: true, metric: 'balance', ...extra });
  if (baseType === 'pl') {
    const rev = accounts.filter(a => a.accountType === 'Revenue').map(a => a._id);
    const exp = accounts.filter(a => ['Expense', 'Direct Cost'].includes(a.accountType)).map(a => a._id);
    return [
      mk('s-rev', 'section', 'Income'),
      mk('g-rev', 'account-group', 'Revenue', { accountType: 'Revenue', accountIds: rev, metric: 'flow' }),
      mk('s-exp', 'section', 'Spending'),
      mk('g-exp', 'account-group', 'Expenses', { accountType: 'Expense', accountIds: exp, metric: 'flow' }),
      mk('sub-net', 'subtotal', 'Profit (Income − Spending)', { metric: 'flow' }),
    ];
  }
  if (baseType === 'bs') {
    const byType = (t) => accounts.filter(a => a.accountType === t).map(a => a._id);
    return [
      mk('s-as', 'section', 'What the business owns'),
      mk('g-as', 'account-group', 'Assets', { accountType: 'Asset', accountIds: byType('Asset') }),
      mk('s-li', 'section', 'What the business owes'),
      mk('g-li', 'account-group', 'Liabilities', { accountType: 'Liability', accountIds: byType('Liability') }),
      mk('s-eq', 'section', "Owners' stake"),
      mk('g-eq', 'account-group', 'Equity', { accountType: 'Equity', accountIds: byType('Equity') }),
    ];
  }
  return [mk('s-1', 'section', 'New section')];
}

/** Sum a layout row's accounts from balance + flow maps (economic, signed by normalBalance). */
function _rowValue(row, accMap, balMap, flowMap) {
  if (!['account', 'account-group'].includes(row.kind)) return 0;
  const ids = row.accountIds || [];
  const map = row.metric === 'flow' ? flowMap : balMap;
  let v = 0;
  for (const id of ids) v += map.get(String(id)) || 0;
  return r2(v);
}

/** Build an economic balance map: { accountId -> signed amount } from a getBalancesAsOf result. */
function _toBalMap(balancesObj) {
  return new Map(Object.entries(balancesObj || {}));
}

/** Build an economic flow map from getDebitCreditTotalsBetween, signed by normalBalance. */
function _toFlowMap(movements, accById) {
  const dMap = new Map(movements.debitTotals.map(x => [x._id.toString(), x.total]));
  const cMap = new Map(movements.creditTotals.map(x => [x._id.toString(), x.total]));
  const out = new Map();
  for (const [id, acc] of accById) {
    const d = dMap.get(id) || 0, c = cMap.get(id) || 0;
    out.set(id, acc.normalBalance === 'Debit' ? (d - c) : (c - d));
  }
  return out;
}

async function _assemble(businessId, template, dateOpts) {
  const startDate = dateOpts.startDate, endDate = dateOpts.endDate;
  const asOfDate = dateOpts.asOfDate || endDate;
  const comparative = template.comparative || { enabled: false };

  const accounts = await accountRepository.findByBusiness(businessId);
  const accById = new Map(accounts.map(a => [a._id.toString(), a]));

  // Current columns
  const [curBal, curMove] = await Promise.all([
    reportService.getBalancesAsOf(businessId, asOfDate),
    transactionRepository.getDebitCreditTotalsBetween(businessId, startDate, endDate),
  ]);
  const curBalMap = _toBalMap(curBal);
  const curFlowMap = _toFlowMap(curMove, accById);

  // Prior columns (optional)
  let priBalMap = null, priFlowMap = null, priorWindow = null;
  if (comparative.enabled) {
    priorWindow = computeComparativeWindow(comparative.mode, startDate, endDate, comparative);
    const [priBal, priMove] = await Promise.all([
      reportService.getBalancesAsOf(businessId, priorWindow.priorEnd),
      transactionRepository.getDebitCreditTotalsBetween(businessId, priorWindow.priorStart, priorWindow.priorEnd),
    ]);
    priBalMap = _toBalMap(priBal);
    priFlowMap = _toFlowMap(priMove, accById);
  }

  const rows = [];
  let runningSub = 0, runningSubPrior = 0;
  for (const row of (template.layout || [])) {
    if (row.visible === false) continue;
    let current = 0, prior = null;
    if (row.kind === 'subtotal') {
      current = r2(runningSub); prior = comparative.enabled ? r2(runningSubPrior) : null;
      runningSub = 0; runningSubPrior = 0;
    } else if (['account', 'account-group'].includes(row.kind)) {
      current = _rowValue(row, accById, curBalMap, curFlowMap);
      runningSub += current;
      if (comparative.enabled) { prior = _rowValue(row, accById, priBalMap, priFlowMap); runningSubPrior += prior; }
    }
    const out = { id: row.id, kind: row.kind, label: row.label, current };
    if (comparative.enabled && ['account', 'account-group', 'subtotal'].includes(row.kind)) {
      out.prior = prior;
      out.change = r2(current - prior);
      out.changePct = prior !== 0 ? r2(((current - prior) / Math.abs(prior)) * 100) : null;
    }
    rows.push(out);
  }

  return {
    template: { id: template._id || null, name: template.name, baseType: template.baseType, comparative },
    columns: comparative.enabled
      ? ['Current', 'Prior', 'Change', 'Change %']
      : ['Amount'],
    rows,
    period: { startDate, endDate, asOfDate, prior: priorWindow },
    generatedAt: new Date(),
  };
}

async function renderTemplate(businessId, templateId, dateOpts) {
  const template = await reportTemplateRepo.findOwnedById(businessId, templateId);
  if (!template) throw new ApiError(404, 'Report not found');
  return _assemble(businessId, template, dateOpts);
}

async function previewLayout(businessId, payload, dateOpts) {
  const template = {
    _id: null,
    name: payload.name || 'Preview',
    baseType: payload.baseType || 'custom',
    layout: payload.layout || [],
    filters: payload.filters || {},
    comparative: payload.comparative || { enabled: false },
  };
  return _assemble(businessId, template, dateOpts);
}

module.exports = {
  renderTemplate,
  previewLayout,
  defaultLayoutFor,
  computeComparativeWindow,
};
