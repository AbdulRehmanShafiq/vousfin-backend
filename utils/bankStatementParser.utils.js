// utils/bankStatementParser.utils.js
//
// Parses a bank statement (.csv / .xlsx / .xls / .ofx / .qfx / .mt940 / .sta) Buffer into normalised lines:
//   { lineRef, date, description, reference, amount (>=0), direction 'in'|'out', runningBalance }
//
// Format detection order:
//   1. OFX 1.x  — starts with "OFXHEADER:" or <?OFX
//   2. OFX 2.x  — starts with "<?xml"
//   3. MT940     — starts with ":20:" (SWIFT)
//   4. CSV/XLSX  — fallback (existing logic)
//
'use strict';
const XLSX = require('xlsx');
const crypto = require('crypto');
const { parseOFX }   = require('./ofxParser.util');
const { parseMT940 } = require('./mt940Parser.util');

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/[._]/g, ' ').replace(/\s+/g, ' ');

const COLS = {
  date:        ['date', 'transaction date', 'txn date', 'value date', 'posting date', 'date of transaction', 'trans date', 'tran date'],
  description: ['description', 'narration', 'details', 'particulars', 'memo', 'remarks', 'transaction details', 'narrative', 'detail'],
  amount:      ['amount', 'value', 'transaction amount', 'amount pkr', 'net amount'],
  debit:       ['debit', 'withdrawal', 'withdrawals', 'paid out', 'dr', 'money out', 'debit amount', 'withdrawal amt', 'out'],
  credit:      ['credit', 'deposit', 'deposits', 'paid in', 'cr', 'money in', 'credit amount', 'deposit amt', 'in'],
  balance:     ['balance', 'running balance', 'closing balance', 'available balance', 'ledger balance'],
  reference:   ['reference', 'ref', 'ref no', 'cheque no', 'cheque', 'transaction id', 'txn id', 'instrument no', 'utr'],
};

function matchCol(header) {
  const h = norm(header);
  for (const [key, aliases] of Object.entries(COLS)) {
    if (aliases.includes(h)) return key;
  }
  // loose contains-match as a fallback
  for (const [key, aliases] of Object.entries(COLS)) {
    if (aliases.some((a) => h === a || h.includes(a))) return key;
  }
  return null;
}

function toNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const cleaned = String(v).replace(/[^0-9.\-()]/g, '').replace(/\((.*)\)/, '-$1'); // (123) → -123
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toDate(v) {
  if (v instanceof Date && !isNaN(v)) return v;
  if (typeof v === 'number') {
    // Excel serial date
    const d = XLSX.SSF ? XLSX.SSF.parse_date_code(v) : null;
    if (d) return new Date(Date.UTC(d.y, d.m - 1, d.d));
  }
  const s = String(v || '').trim();
  if (!s) return null;
  // DD/MM/YYYY or DD-MM-YYYY (Pakistan default) — disambiguate from ISO
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    let [, dd, mm, yy] = m;
    dd = +dd; mm = +mm; yy = +yy;
    if (yy < 100) yy += 2000;
    // If first part > 12 it must be the day; otherwise assume DD/MM (PK locale)
    if (mm > 12 && dd <= 12) [dd, mm] = [mm, dd];
    const d = new Date(Date.UTC(yy, mm - 1, dd));
    return isNaN(d) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

/**
 * @returns {{ lines: Array, columns: Object, warnings: string[] }}
 */
/**
 * Convert an OFX/MT940 transactions array into the normalised bank-statement
 * lines format used by bankReconciliation.service.
 */
function _normaliseParsedTransactions(transactions) {
  return transactions.map(t => ({
    lineRef: crypto.randomUUID(),
    date: t.date,
    description: String(t.description || '').slice(0, 500),
    reference: String(t.fitid || '').slice(0, 100),
    amount: Math.abs(Number(t.amount) || 0),
    direction: (Number(t.amount) || 0) < 0 ? 'out' : 'in',
    runningBalance: null,
  })).filter(l => l.amount > 0 && l.date instanceof Date && !isNaN(l.date));
}

function parseBankStatement(buffer, fileName = '') {
  const warnings = [];

  // ── Format detection: try to read as text first ─────────────────────────
  let textContent = null;
  try {
    textContent = Buffer.isBuffer(buffer)
      ? buffer.toString('utf8')
      : (typeof buffer === 'string' ? buffer : null);
  } catch { /* ignore decode errors — will fall through to XLSX */ }

  if (textContent) {
    const trimmed = textContent.trimStart();

    // OFX 1.x (SGML)
    if (/^OFXHEADER:/i.test(trimmed) || /^<\?OFX/i.test(trimmed)) {
      const parsed = parseOFX(trimmed);
      const lines = _normaliseParsedTransactions(parsed.transactions);
      if (lines.length) return { lines, columns: { format: 'OFX' }, warnings };
    }

    // OFX 2.x (XML)
    if (/^<\?xml/i.test(trimmed) && /<OFX/i.test(trimmed)) {
      const parsed = parseOFX(trimmed);
      const lines = _normaliseParsedTransactions(parsed.transactions);
      if (lines.length) return { lines, columns: { format: 'OFX-XML' }, warnings };
    }

    // MT940 (SWIFT)
    if (/^:20:/m.test(trimmed)) {
      const parsed = parseMT940(trimmed);
      const lines = _normaliseParsedTransactions(parsed.transactions);
      if (lines.length) return { lines, columns: { format: 'MT940' }, warnings };
    }
  }

  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('The file has no readable sheet');

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
  if (!rows.length) throw new Error('The file is empty');

  // Find the header row: the first row that maps to a date column AND (amount OR debit/credit)
  let headerIdx = -1, colMap = null;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const map = {};
    rows[i].forEach((cell, idx) => {
      const key = matchCol(cell);
      if (key && map[key] === undefined) map[key] = idx;
    });
    if (map.date !== undefined && (map.amount !== undefined || map.debit !== undefined || map.credit !== undefined)) {
      headerIdx = i; colMap = map; break;
    }
  }
  if (headerIdx === -1) {
    throw new Error('Could not find the columns. Make sure the file has a Date column and an Amount (or Debit/Credit) column.');
  }

  const lines = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => c === '' || c == null)) continue;

    const date = toDate(row[colMap.date]);
    if (!date) continue; // skip rows without a usable date (totals, footers)

    const description = String(row[colMap.description] != null ? row[colMap.description] : '').trim();
    const reference   = colMap.reference !== undefined ? String(row[colMap.reference] || '').trim() : '';
    const runningBalance = colMap.balance !== undefined ? toNumber(row[colMap.balance]) : null;

    let amount = null, direction = null;
    if (colMap.amount !== undefined) {
      const a = toNumber(row[colMap.amount]);
      if (a == null || a === 0) continue;
      direction = a < 0 ? 'out' : 'in';
      amount = Math.abs(a);
    } else {
      const dr = colMap.debit  !== undefined ? toNumber(row[colMap.debit])  : null;
      const cr = colMap.credit !== undefined ? toNumber(row[colMap.credit]) : null;
      if (dr && dr !== 0)      { direction = 'out'; amount = Math.abs(dr); }
      else if (cr && cr !== 0) { direction = 'in';  amount = Math.abs(cr); }
      else continue;
    }

    lines.push({
      lineRef: crypto.randomUUID(),
      date, description, reference, amount, direction, runningBalance,
    });
  }

  if (!lines.length) throw new Error('No transaction rows were found in the file.');

  return {
    lines,
    columns: Object.fromEntries(Object.entries(colMap).map(([k, v]) => [k, rows[headerIdx][v]])),
    warnings,
  };
}

module.exports = { parseBankStatement };
