// utils/mt940Parser.util.js — Phase 8 FR-01.5
//
// Pure function: parseMT940(text) → { accountId, currency, transactions: [{ date, amount, description, fitid }] }
//
// MT940 is a SWIFT bank statement format.
// Key fields:
//   :20:  — reference / statement identifier
//   :25:  — account number (IBAN or local)
//   :28C: — statement number / sequence
//   :60F: — opening balance (C/D prefix + date + currency + amount with comma)
//   :61:  — transaction line: YYMMDD[MMDD][C|D]amount[N]type[reference]
//   :86:  — narrative / description for the preceding :61: line
//   :62F: — closing balance
//
// Returns { transactions: [] } on any error — never throws.
'use strict';

/**
 * Parse an MT940 date: YYMMDD → Date in 20YY.
 */
function parseMT940Date(yymmdd) {
  if (!yymmdd || yymmdd.length < 6) return null;
  const yy = parseInt(yymmdd.slice(0, 2), 10);
  const mm = parseInt(yymmdd.slice(2, 4), 10) - 1; // 0-indexed
  const dd = parseInt(yymmdd.slice(4, 6), 10);
  const year = yy + 2000; // assume 20YY
  const d = new Date(Date.UTC(year, mm, dd));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Parse amount string: replace comma with dot, return number.
 * e.g. '25000,00' → 25000
 */
function parseMT940Amount(amtStr) {
  const n = parseFloat(String(amtStr || '').replace(',', '.'));
  return isFinite(n) ? n : null;
}

/**
 * parseMT940 — parse a SWIFT MT940 statement text.
 *
 * @param {string|null|undefined} text
 * @returns {{ accountId: string|null, currency: string|null, transactions: Array }}
 */
function parseMT940(text) {
  const empty = { accountId: null, currency: null, transactions: [] };

  try {
    if (!text) return empty;
    const str = String(text).trim();
    if (!str) return empty;

    // Must look like MT940 — should have a :20: or :25: tag
    if (!/:\d{2}[A-Z]?:/.test(str)) return empty;

    // ── Extract account number from :25: ─────────────────────────────────────
    let accountId = null;
    const accMatch = str.match(/:25:(.+?)(?=\r?\n)/);
    if (accMatch) accountId = accMatch[1].trim();

    // ── Extract currency from :60F: or :60M: ─────────────────────────────────
    let currency = null;
    const balMatch = str.match(/:60[FM]:[CD]\d{6}([A-Z]{3})/);
    if (balMatch) currency = balMatch[1];

    // ── Parse :61: transaction lines + :86: narratives ───────────────────────
    const transactions = [];

    // Split by MT940 tags — each tag starts at beginning of line with :XX:
    const tagSplitRe = /^:(\d{2}[A-Z]?):([\s\S]*?)(?=^:\d{2}[A-Z]?:|\s*$)/gm;
    const tags = {};
    let tm;
    while ((tm = tagSplitRe.exec(str)) !== null) {
      const tagId  = tm[1];
      const tagVal = tm[2].trim();
      if (!tags[tagId]) tags[tagId] = [];
      tags[tagId].push(tagVal);
    }

    // Alternative: scan lines for :61: and :86: in sequence
    const lines = str.split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      // :61: value date YYMMDD [booking date MMDD] C|D[R] amount[,cents] N[type][reference]
      const txnMatch = line.match(/^:61:(\d{6})(\d{4})?([CD]R?)(\d[\d,]+)([A-Z]{4})([^\r\n]*)/);
      if (txnMatch) {
        const dateStr       = txnMatch[1]; // YYMMDD
        const creditDebit   = txnMatch[3]; // C, D, CR, DR
        const rawAmount     = txnMatch[4]; // e.g. 25000,00

        const date   = parseMT940Date(dateStr);
        const absAmt = parseMT940Amount(rawAmount);

        // C = credit (money in, positive), D = debit (money out, negative)
        const isDebit = creditDebit.startsWith('D');
        const amount  = absAmt != null ? (isDebit ? -absAmt : absAmt) : null;

        // Look for the :86: narrative on the next line(s)
        let description = '';
        let j = i + 1;
        while (j < lines.length && lines[j].startsWith(':86:')) {
          description += lines[j].replace(/^:86:/, '').trim() + ' ';
          j++;
        }
        description = description.trim();

        // fitid: use reference field if present
        const fitid = txnMatch[6] ? txnMatch[6].trim() : '';

        if (date && amount != null) {
          transactions.push({ date, amount, description, fitid });
        }
      }
      i++;
    }

    return { accountId, currency, transactions };
  } catch {
    return empty;
  }
}

module.exports = { parseMT940 };
