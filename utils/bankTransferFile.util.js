// utils/bankTransferFile.util.js — FR-08.3 (NIFT/SBP-style net-pay transfer file)
'use strict';

const esc = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * @param {Object} run  payroll run ({ period })
 * @param {Array}  rows [{ bankAccountTitle, iban, netPay }]
 * @returns {string} CSV text
 */
function buildBankTransferCsv(run, rows) {
  const header = 'Account Title,IBAN,Amount,Reference';
  const body = rows.map((row) =>
    [esc(row.bankAccountTitle), esc(row.iban), esc(row.netPay), esc(`Salary ${run.period}`)].join(',')
  );
  return [header, ...body].join('\n') + '\n';
}

module.exports = { buildBankTransferCsv };
