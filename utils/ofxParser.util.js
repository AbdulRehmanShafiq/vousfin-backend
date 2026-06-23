// utils/ofxParser.util.js — Phase 8 FR-01.5
//
// Pure function: parseOFX(text) → { accountId, currency, transactions: [{ date, amount, description, fitid }] }
//
// Handles both OFX 1.x (SGML, no closing tags) and OFX 2.x (XML).
// Returns { transactions: [] } on any error — never throws.
'use strict';

/**
 * Parse an OFX date string (YYYYMMDD or YYYYMMDDHHMMSS[.mmm][+-zone]) to a Date.
 * @param {string} s
 * @returns {Date|null}
 */
function parseOFXDate(s) {
  if (!s) return null;
  const str = String(s).trim().split('[')[0]; // strip timezone annotation
  if (str.length < 8) return null;
  const year  = parseInt(str.slice(0, 4), 10);
  const month = parseInt(str.slice(4, 6), 10) - 1; // 0-indexed
  const day   = parseInt(str.slice(6, 8), 10);
  const hour  = str.length >= 10 ? parseInt(str.slice(8, 10), 10)  : 0;
  const min   = str.length >= 12 ? parseInt(str.slice(10, 12), 10) : 0;
  const sec   = str.length >= 14 ? parseInt(str.slice(12, 14), 10) : 0;
  const d = new Date(Date.UTC(year, month, day, hour, min, sec));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Extract the content of an OFX 1.x tag (no closing tag required).
 * e.g. extractTag('<DTPOSTED>20240315', 'DTPOSTED') → '20240315'
 */
function extractTag(block, tag) {
  const re = new RegExp(`<${tag}>([^\r\n<]+)`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

/**
 * Extract all STMTTRN blocks from OFX 1.x SGML text.
 * In SGML OFX, blocks may or may not have a closing </STMTTRN> tag.
 */
function extractSGMLTransactions(text) {
  const transactions = [];
  // Find each opening <STMTTRN> tag
  const re = /<STMTTRN>([\s\S]*?)(?=<STMTTRN>|<\/BANKTRANLIST>|<\/STMTTRNRS>|$)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const block = m[1];
    const rawDate = extractTag(block, 'DTPOSTED');
    const rawAmt  = extractTag(block, 'TRNAMT');
    const memo    = extractTag(block, 'MEMO') || extractTag(block, 'NAME') || '';
    const fitid   = extractTag(block, 'FITID') || '';

    const date   = parseOFXDate(rawDate);
    const amount = rawAmt != null ? parseFloat(rawAmt) : null;

    if (date && amount != null && isFinite(amount)) {
      transactions.push({ date, amount, description: memo, fitid });
    }
  }
  return transactions;
}

/**
 * Extract all STMTTRN blocks from OFX 2.x XML text using regex.
 * We avoid a full XML parser for portability.
 */
function extractXMLTransactions(text) {
  const transactions = [];
  // Match each <STMTTRN>…</STMTTRN> block
  const blockRe = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    const block = m[1];

    // In XML both <TAG>value</TAG> and <TAG>value forms may appear
    const getVal = (tag) => {
      const re = new RegExp(`<${tag}>([^<]+)<\\/${tag}>`, 'i');
      const m2 = block.match(re);
      if (m2) return m2[1].trim();
      // No closing tag (some OFX 2 exporters omit closing tags in STMTTRN)
      const re2 = new RegExp(`<${tag}>([^\r\n<]+)`, 'i');
      const m3 = block.match(re2);
      return m3 ? m3[1].trim() : null;
    };

    const rawDate = getVal('DTPOSTED');
    const rawAmt  = getVal('TRNAMT');
    const memo    = getVal('MEMO') || getVal('NAME') || '';
    const fitid   = getVal('FITID') || '';

    const date   = parseOFXDate(rawDate);
    const amount = rawAmt != null ? parseFloat(rawAmt) : null;

    if (date && amount != null && isFinite(amount)) {
      transactions.push({ date, amount, description: memo, fitid });
    }
  }
  return transactions;
}

/**
 * parseOFX — parse OFX 1.x (SGML) or 2.x (XML) bank statement text.
 *
 * @param {string|null|undefined} text
 * @returns {{ accountId: string|null, currency: string|null, transactions: Array }}
 */
function parseOFX(text) {
  const empty = { accountId: null, currency: null, transactions: [] };

  try {
    if (!text) return empty;
    const str = String(text).trim();
    if (!str) return empty;

    const isXml = /^<\?xml/i.test(str) || /^<\?OFX/i.test(str);

    const transactions = isXml
      ? extractXMLTransactions(str)
      : extractSGMLTransactions(str);

    // Extract account ID
    let accountId = null;
    const accMatch = str.match(/<ACCTID>([^\r\n<]+)/i);
    if (!accMatch) {
      const accMatch2 = str.match(/<ACCTID>([^<]+)<\/ACCTID>/i);
      if (accMatch2) accountId = accMatch2[1].trim();
    } else {
      accountId = accMatch[1].trim();
    }

    // Extract currency
    let currency = null;
    const curMatch = str.match(/<CURDEF>([^\r\n<]+)/i);
    if (!curMatch) {
      const curMatch2 = str.match(/<CURDEF>([^<]+)<\/CURDEF>/i);
      if (curMatch2) currency = curMatch2[1].trim();
    } else {
      currency = curMatch[1].trim();
    }

    return { accountId, currency, transactions };
  } catch {
    return empty;
  }
}

module.exports = { parseOFX };
