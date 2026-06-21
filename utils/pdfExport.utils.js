// utils/pdfExport.utils.js — Professional ERP-quality PDF generation
const PDFDocument = require('pdfkit');
const path        = require('path');
const fs          = require('fs');
const logger      = require('../config/logger');

// VousFin brand logo path — silently skipped if file is absent
const LOGO_PATH = path.join(__dirname, '../assets/vousfin-logo.png');
const LOGO_EXISTS = fs.existsSync(LOGO_PATH);

// ── Design constants ──────────────────────────────────────────────────────────
const COLORS = {
  primary:    '#1a365d',   // dark navy
  accent:     '#2b6cb0',   // blue
  success:    '#276749',
  danger:     '#c53030',
  text:       '#1a202c',
  muted:      '#4a5568',
  light:      '#718096',
  border:     '#cbd5e0',
  rowEven:    '#f7fafc',
  rowOdd:     '#ffffff',
  headerBg:   '#2d3748',
  sectionBg:  '#ebf4ff',
};

const MARGIN  = 40;
const PAGE_W  = 595;  // A4 width in points
const COL_L   = MARGIN;
const COL_R   = PAGE_W - MARGIN;
const CONTENT_W = COL_R - COL_L;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(amount, currency = 'PKR') {
  if (typeof amount !== 'number' || isNaN(amount)) amount = 0;
  const abs    = Math.abs(amount);
  const sign   = amount < 0 ? '(' : '';
  const close  = amount < 0 ? ')' : '';
  return `${sign}${currency} ${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${close}`;
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function docHeader(doc, businessName, title, subtitle) {
  const genDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  // Top bar
  doc.rect(0, 0, PAGE_W, 70).fill(COLORS.headerBg);
  doc.fillColor('#ffffff').fontSize(18).font('Helvetica-Bold')
     .text(businessName, MARGIN, 14, { width: CONTENT_W, align: 'center' });
  doc.fontSize(12).font('Helvetica')
     .text(title, MARGIN, 36, { width: CONTENT_W, align: 'center' });

  doc.fillColor(COLORS.light).fontSize(8)
     .text(`Generated: ${genDate}`, MARGIN, 56, { width: CONTENT_W, align: 'right' });

  // Subtitle band
  doc.rect(0, 70, PAGE_W, 22).fill(COLORS.accent);
  doc.fillColor('#ffffff').fontSize(9).font('Helvetica')
     .text(subtitle, MARGIN, 77, { width: CONTENT_W, align: 'center' });

  doc.moveDown(0.5);
  doc.y = 102;
}

function sectionHeader(doc, text) {
  doc.moveDown(0.4);
  doc.rect(COL_L, doc.y, CONTENT_W, 18).fill(COLORS.sectionBg);
  doc.fillColor(COLORS.primary).font('Helvetica-Bold').fontSize(10)
     .text(text, COL_L + 8, doc.y + 4);
  doc.moveDown(0.2);
}

function lineItem(doc, label, amount, currency, indent = 0, rowIndex = 0) {
  const y = doc.y;
  if (rowIndex % 2 === 0) doc.rect(COL_L, y, CONTENT_W, 14).fill(COLORS.rowEven);
  doc.fillColor(COLORS.text).font('Helvetica').fontSize(9)
     .text(label,  COL_L + 8 + indent, y + 2, { width: CONTENT_W - 130 })
     .text(fmt(amount, currency), COL_L + CONTENT_W - 120, y + 2, { width: 110, align: 'right' });
  doc.moveDown(0.05);
}

function subtotalLine(doc, label, amount, currency) {
  doc.moveDown(0.1);
  doc.strokeColor(COLORS.border).lineWidth(0.5)
     .moveTo(COL_L, doc.y).lineTo(COL_R, doc.y).stroke();
  doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(9)
     .text(label,  COL_L + 8, doc.y + 3, { width: CONTENT_W - 130 })
     .text(fmt(amount, currency), COL_L + CONTENT_W - 120, doc.y, { width: 110, align: 'right' });
  doc.strokeColor(COLORS.border).lineWidth(0.5)
     .moveTo(COL_L, doc.y + 14).lineTo(COL_R, doc.y + 14).stroke();
  doc.moveDown(0.8);
}

function totalLine(doc, label, amount, currency, highlight = true) {
  doc.moveDown(0.3);
  const y = doc.y;
  if (highlight) doc.rect(COL_L, y, CONTENT_W, 20).fill(COLORS.primary);
  const textColor = highlight ? '#ffffff' : COLORS.text;
  const amtColor  = amount >= 0
    ? (highlight ? '#68d391' : COLORS.success)
    : (highlight ? '#fc8181' : COLORS.danger);
  doc.fillColor(textColor).font('Helvetica-Bold').fontSize(11)
     .text(label, COL_L + 8, y + 5, { width: CONTENT_W - 130 });
  doc.fillColor(amtColor).font('Helvetica-Bold').fontSize(11)
     .text(fmt(amount, currency), COL_L + CONTENT_W - 120, y + 5, { width: 110, align: 'right' });
  doc.moveDown(1.2);
}

function pageFooter(doc) {
  // Footer must stay inside PDFKit's safe zone: 0 to (page.height - bottom margin).
  // Placing text beyond that triggers an automatic new page — which is what caused
  // the blank-page explosion when finalise() iterated over buffered pages.
  const safeBottom = doc.page.height - MARGIN; // 841.89 - 40 = 801.89
  const footerH = 20;
  const y = safeBottom - footerH; // ~781

  doc.rect(0, y, PAGE_W, footerH).fill(COLORS.headerBg);

  // Disclaimer text (centred, leaves space on the right for the VousFin brand)
  doc.fillColor('#a0aec0').fontSize(7).font('Helvetica')
     .text(
       'This is a system-generated report. For accounting purposes only.',
       MARGIN, y + 7, { width: CONTENT_W - 90, align: 'center', lineBreak: false }
     );

  // VousFin brand mark — bottom-right, low opacity
  try {
    const logoSize = 13;
    const logoX = PAGE_W - MARGIN - logoSize - 44;
    const textX  = logoX + logoSize + 3;

    if (LOGO_EXISTS) {
      doc.save();
      doc.opacity(0.35);
      doc.image(LOGO_PATH, logoX, y + 3, { width: logoSize, height: logoSize });
      doc.restore();
    }

    // "VousFin" text beside logo, same low opacity
    doc.save();
    doc.opacity(0.4);
    doc.fillColor('#e2e8f0').font('Helvetica-Bold').fontSize(7)
       .text('VousFin', textX, y + 7, { width: 42, lineBreak: false });
    doc.restore();
  } catch (_) {
    // Never let a branding error crash the PDF
  }
}

function buildDoc() {
  const doc = new PDFDocument({ margin: MARGIN, size: 'A4', bufferPages: true });
  const buffers = [];
  doc.on('data', b => buffers.push(b));
  return { doc, buffers };
}

function finalise(doc, buffers) {
  return new Promise((resolve, reject) => {
    doc.on('end',   () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      pageFooter(doc);
    }
    doc.end();
  });
}

// ── 1. Income Statement ───────────────────────────────────────────────────────

async function generateIncomeStatementPDF({ businessName, data, dateRange, currency = 'PKR' }) {
  const { doc, buffers } = buildDoc();
  // Suppress zero-balance individual account rows; section totals always print.
  const nz = (accts) => (accts || []).filter(a => (a.balance || 0) !== 0);
  try {
    docHeader(doc, businessName, 'Income Statement (Profit & Loss)', `For the period: ${dateRange}`);

    sectionHeader(doc, 'REVENUE');
    nz(data.revenue?.accounts || data.revenue).forEach((a, i) => lineItem(doc, a.accountName, a.balance, currency, 0, i));
    subtotalLine(doc, 'Total Revenue', data.totalRevenue || data.revenue?.total || 0, currency);

    if ((data.cogs?.total || 0) > 0) {
      sectionHeader(doc, 'COST OF GOODS SOLD');
      nz(data.cogs?.accounts).forEach((a, i) => lineItem(doc, a.accountName, a.balance, currency, 0, i));
      subtotalLine(doc, 'Total COGS', data.cogs.total, currency);
    }

    totalLine(doc, 'GROSS PROFIT', data.grossProfit || 0, currency, false);

    sectionHeader(doc, 'OPERATING EXPENSES');
    nz(data.operatingExpenses?.accounts).forEach((a, i) => lineItem(doc, a.accountName, a.balance, currency, 0, i));
    subtotalLine(doc, 'Total Operating Expenses', data.operatingExpenses?.total || 0, currency);

    if ((data.depreciationAmortization?.total || 0) !== 0) {
      sectionHeader(doc, 'DEPRECIATION & AMORTIZATION');
      nz(data.depreciationAmortization?.accounts).forEach((a, i) => lineItem(doc, a.accountName, a.balance, currency, 0, i));
      subtotalLine(doc, 'Total D&A', data.depreciationAmortization.total, currency);
    }

    totalLine(doc, 'OPERATING PROFIT (EBIT)', data.operatingProfit || 0, currency, false);

    doc.fillColor(COLORS.muted).fontSize(8).font('Helvetica')
       .text(`EBITDA: ${fmt(data.ebitda || 0, currency)}`, COL_L + 8, doc.y);
    doc.moveDown(0.6);

    if ((data.interestExpense?.total || 0) !== 0) {
      sectionHeader(doc, 'INTEREST EXPENSE');
      nz(data.interestExpense?.accounts).forEach((a, i) => lineItem(doc, a.accountName, a.balance, currency, 0, i));
      subtotalLine(doc, 'Total Interest', data.interestExpense.total, currency);
    }

    totalLine(doc, 'NET PROFIT / (LOSS)', data.netIncome ?? data.netProfit ?? 0, currency);

    return finalise(doc, buffers);
  } catch (err) {
    logger.error('PDF generation failed (Income Statement):', err);
    throw err;
  }
}

// ── 2. Balance Sheet ──────────────────────────────────────────────────────────

async function generateBalanceSheetPDF({ businessName, data, asOfDate, currency = 'PKR' }) {
  const { doc, buffers } = buildDoc();
  // Suppress zero-balance individual account rows; group subtotals always print.
  const nz = (accts) => (accts || []).filter(a => (a.balance || 0) !== 0);
  try {
    docHeader(doc, businessName, 'Balance Sheet', `As of ${fmtDate(asOfDate)}`);

    // Assets
    sectionHeader(doc, 'ASSETS');
    const assetGroups = data.assets?.groups || null;

    if (assetGroups && assetGroups.length) {
      assetGroups.forEach(g => {
        doc.fillColor(COLORS.accent).font('Helvetica-Bold').fontSize(8)
           .text(g.label.toUpperCase(), COL_L + 8, doc.y + 4);
        doc.moveDown(0.3);
        nz(g.accounts).forEach((a, i) => lineItem(doc, a.accountName, a.balance, currency, 16, i));
        subtotalLine(doc, `Total ${g.label}`, g.total, currency);
      });
    } else {
      nz(data.assets?.accounts).forEach((a, i) => lineItem(doc, a.accountName, a.balance, currency, 0, i));
    }
    totalLine(doc, 'TOTAL ASSETS', data.totalAssets || 0, currency, false);

    // Liabilities
    sectionHeader(doc, 'LIABILITIES');
    const liabGroups = data.liabilities?.groups || null;

    if (liabGroups && liabGroups.length) {
      liabGroups.forEach(g => {
        doc.fillColor(COLORS.accent).font('Helvetica-Bold').fontSize(8)
           .text(g.label.toUpperCase(), COL_L + 8, doc.y + 4);
        doc.moveDown(0.3);
        nz(g.accounts).forEach((a, i) => lineItem(doc, a.accountName, a.balance, currency, 16, i));
        subtotalLine(doc, `Total ${g.label}`, g.total, currency);
      });
    } else {
      nz(data.liabilities?.accounts).forEach((a, i) => lineItem(doc, a.accountName, a.balance, currency, 0, i));
    }
    subtotalLine(doc, 'Total Liabilities', data.totalLiabilities || 0, currency);

    // Equity
    sectionHeader(doc, 'EQUITY');
    nz(data.equity?.accounts).forEach((a, i) => lineItem(doc, a.accountName, a.balance, currency, 0, i));
    subtotalLine(doc, 'Total Equity', data.totalEquity || 0, currency);

    totalLine(doc, 'TOTAL LIABILITIES & EQUITY', data.totalLiabilitiesAndEquity || (data.totalLiabilities + data.totalEquity), currency);

    // Equation check
    const valid = data.equationValid;
    const checkY = doc.y;
    doc.rect(COL_L, checkY, CONTENT_W, 18)
       .fill(valid ? '#c6f6d5' : '#fed7d7');
    doc.fillColor(valid ? COLORS.success : COLORS.danger).font('Helvetica-Bold').fontSize(9)
       .text(
         valid ? '✓ Accounting Equation Satisfied (Assets = Liabilities + Equity)' : '✗ Accounting Equation IMBALANCE — investigate journal entries',
         COL_L + 8, checkY + 4, { width: CONTENT_W - 16 }
       );
    doc.moveDown(1);

    return finalise(doc, buffers);
  } catch (err) {
    logger.error('PDF generation failed (Balance Sheet):', err);
    throw err;
  }
}

// ── 3. Cash Flow Statement ────────────────────────────────────────────────────

async function generateCashFlowPDF({ businessName, data, dateRange, currency = 'PKR' }) {
  const { doc, buffers } = buildDoc();
  try {
    docHeader(doc, businessName, 'Statement of Cash Flows', `For the period: ${dateRange}`);

    const drawSection = (title, section) => {
      sectionHeader(doc, title.toUpperCase());
      const items = section?.items || (Array.isArray(section) ? section : []);
      items.forEach((item, i) =>
        lineItem(doc, item.description || item.name, item.amount, currency, 0, i)
      );
      const total = section?.total ?? items.reduce((s, i) => s + (i.amount || 0), 0);
      subtotalLine(doc, `Net Cash from ${title}`, total, currency);
    };

    drawSection('Operating Activities', data.operating);
    drawSection('Investing Activities', data.investing);
    drawSection('Financing Activities', data.financing);

    totalLine(doc, 'NET INCREASE (DECREASE) IN CASH', data.netCashFlow || 0, currency);

    doc.fillColor(COLORS.light).fontSize(8).font('Helvetica')
       .text('Positive amounts = cash inflows. Parentheses = cash outflows.', COL_L + 8, doc.y);

    return finalise(doc, buffers);
  } catch (err) {
    logger.error('PDF generation failed (Cash Flow):', err);
    throw err;
  }
}

// ── 4. Trial Balance ──────────────────────────────────────────────────────────

async function generateTrialBalancePDF({ businessName, data, asOfDate, currency = 'PKR' }) {
  const { doc, buffers } = buildDoc();
  try {
    const hasOpening = data.rows?.some(r => r.openingDebit > 0 || r.openingCredit > 0);
    docHeader(doc, businessName, 'Trial Balance', `As of ${fmtDate(asOfDate)}`);

    // Table header
    const y0 = doc.y;
    doc.rect(COL_L, y0, CONTENT_W, 18).fill(COLORS.primary);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
    const c = hasOpening
      ? [180, 70, 70, 90, 90]
      : [280, 120, 120];
    let x = COL_L + 4;
    const headers = hasOpening
      ? ['Account', 'Opening Dr', 'Opening Cr', 'Closing Dr', 'Closing Cr']
      : ['Account', 'Debit', 'Credit'];
    headers.forEach((h, i) => {
      doc.text(h, x, y0 + 5, { width: c[i], align: i === 0 ? 'left' : 'right' });
      x += c[i];
    });
    doc.moveDown(0.1);

    const rows = data.rows || [];
    rows.forEach((r, idx) => {
      if (doc.y > doc.page.height - 80) {
        doc.addPage();
        doc.y = MARGIN;
      }
      const ry = doc.y;
      if (idx % 2 === 0) doc.rect(COL_L, ry, CONTENT_W, 14).fill(COLORS.rowEven);
      doc.fillColor(COLORS.text).font('Helvetica').fontSize(8);
      let rx = COL_L + 4;
      const rowVals = hasOpening
        ? [r.accountName, r.openingDebit || 0, r.openingCredit || 0, r.closingDebit || r.debit || 0, r.closingCredit || r.credit || 0]
        : [r.accountName, r.debit || 0, r.credit || 0];
      rowVals.forEach((v, i) => {
        const isNum = typeof v === 'number';
        doc.text(
          isNum ? (v > 0 ? fmt(v, currency) : '-') : v,
          rx, ry + 3, { width: c[i], align: i === 0 ? 'left' : 'right' }
        );
        rx += c[i];
      });
      doc.moveDown(0.05);
    });

    // Totals row
    doc.moveDown(0.3);
    const ty = doc.y;
    doc.rect(COL_L, ty, CONTENT_W, 18).fill(COLORS.primary);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9);
    let tx = COL_L + 4;
    const totals = hasOpening
      ? ['TOTAL', data.totals?.opening?.debit || 0, data.totals?.opening?.credit || 0, data.totalDebits || 0, data.totalCredits || 0]
      : ['TOTAL', data.totalDebits || 0, data.totalCredits || 0];
    totals.forEach((v, i) => {
      doc.text(typeof v === 'number' ? fmt(v, currency) : v, tx, ty + 5, { width: c[i], align: i === 0 ? 'left' : 'right' });
      tx += c[i];
    });
    doc.moveDown(0.8);

    const balanced = data.isBalanced;
    const balY = doc.y;
    doc.rect(COL_L, balY, CONTENT_W, 18).fill(balanced ? '#c6f6d5' : '#fed7d7');
    doc.fillColor(balanced ? COLORS.success : COLORS.danger).font('Helvetica-Bold').fontSize(9)
       .text(balanced ? '✓ Books are Balanced' : '✗ Books are Out of Balance', COL_L + 8, balY + 4);
    doc.moveDown(1);

    return finalise(doc, buffers);
  } catch (err) {
    logger.error('PDF generation failed (Trial Balance):', err);
    throw err;
  }
}

// ── 5. General Ledger ─────────────────────────────────────────────────────────

async function generateGeneralLedgerPDF({ businessName, data, dateRange, currency = 'PKR' }) {
  const { doc, buffers } = buildDoc();
  try {
    docHeader(doc, businessName, 'General Ledger', `For the period: ${dateRange}`);

    for (const account of data.accounts || []) {
      if (doc.y > doc.page.height - 120) doc.addPage();

      // Account header
      const ah = doc.y;
      doc.rect(COL_L, ah, CONTENT_W, 20).fill(COLORS.accent);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10)
         .text(`${account.accountCode ? account.accountCode + ' — ' : ''}${account.accountName}`, COL_L + 8, ah + 5, { width: CONTENT_W - 200 });
      doc.fillColor('#e2e8f0').font('Helvetica').fontSize(8)
         .text(`Opening Balance: ${fmt(account.openingBalance, currency)}`, COL_L + CONTENT_W - 180, ah + 7, { width: 170, align: 'right' });
      doc.moveDown(0.2);

      // Column headers
      const ch = doc.y;
      doc.rect(COL_L, ch, CONTENT_W, 14).fill(COLORS.primary);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7);
      const cols = [55, 180, 75, 75, 95];
      const hds  = ['Date', 'Description', 'Debit', 'Credit', 'Balance'];
      let cx = COL_L + 2;
      hds.forEach((h, i) => {
        doc.text(h, cx, ch + 4, { width: cols[i], align: i > 1 ? 'right' : 'left' });
        cx += cols[i];
      });
      doc.moveDown(0.1);

      for (const [ei, entry] of (account.entries || []).entries()) {
        if (doc.y > doc.page.height - 50) doc.addPage();
        const ry = doc.y;
        if (ei % 2 === 0) doc.rect(COL_L, ry, CONTENT_W, 13).fill(COLORS.rowEven);
        doc.fillColor(COLORS.text).font('Helvetica').fontSize(7);
        let ex = COL_L + 2;
        const vals = [
          new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: '2-digit' }),
          (entry.description || '').substring(0, 40),
          entry.debit  > 0 ? fmt(entry.debit,  currency) : '',
          entry.credit > 0 ? fmt(entry.credit, currency) : '',
          fmt(entry.runningBalance, currency),
        ];
        vals.forEach((v, i) => {
          doc.text(v, ex, ry + 3, { width: cols[i], align: i > 1 ? 'right' : 'left' });
          ex += cols[i];
        });
        doc.moveDown(0.05);
      }

      // Closing balance
      const cb = doc.y;
      doc.rect(COL_L, cb, CONTENT_W, 16).fill(COLORS.sectionBg);
      doc.fillColor(COLORS.primary).font('Helvetica-Bold').fontSize(8)
         .text('Closing Balance', COL_L + 8, cb + 4, { width: 200 })
         .text(fmt(account.closingBalance, currency), COL_L + CONTENT_W - 100, cb + 4, { width: 90, align: 'right' });
      doc.moveDown(1);
    }

    return finalise(doc, buffers);
  } catch (err) {
    logger.error('PDF generation failed (General Ledger):', err);
    throw err;
  }
}

// ── 6. Aging Report ───────────────────────────────────────────────────────────

async function generateAgingPDF({ businessName, data, currency = 'PKR' }) {
  const { doc, buffers } = buildDoc();
  try {
    const typeLabel = data.type === 'receivable' ? 'Accounts Receivable' : 'Accounts Payable';
    docHeader(doc, businessName, `${typeLabel} Aging Report`, `As of ${fmtDate(new Date())}`);

    // Summary buckets
    sectionHeader(doc, 'AGING SUMMARY');
    const bucketOrder = ['current', 'days_1_30', 'days_31_60', 'days_61_90', 'days_over_90'];
    bucketOrder.forEach((key, i) => {
      const b = data.buckets?.[key];
      if (!b) return;
      lineItem(doc, b.label, b.total, currency, 0, i);
    });
    totalLine(doc, `TOTAL ${typeLabel.toUpperCase()}`, data.grandTotal || 0, currency);

    // Detail by bucket
    for (const key of bucketOrder) {
      const b = data.buckets?.[key];
      if (!b || b.items.length === 0) continue;

      sectionHeader(doc, `${b.label} — ${fmt(b.total, currency)}`);
      const colW = [100, 140, 75, 75, 90];
      const hds  = ['Party', 'Description', 'Due Date', 'Original', 'Balance'];
      const hy   = doc.y;
      doc.rect(COL_L, hy, CONTENT_W, 14).fill(COLORS.primary);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7);
      let hx = COL_L + 2;
      hds.forEach((h, i) => {
        doc.text(h, hx, hy + 3, { width: colW[i], align: i > 2 ? 'right' : 'left' });
        hx += colW[i];
      });
      doc.moveDown(0.1);

      b.items.forEach((item, idx) => {
        if (doc.y > doc.page.height - 50) doc.addPage();
        const ry = doc.y;
        if (idx % 2 === 0) doc.rect(COL_L, ry, CONTENT_W, 13).fill(COLORS.rowEven);
        const severity = item.severity;
        const textColor = severity === 'critical' ? COLORS.danger : severity === 'medium' ? '#c05621' : COLORS.text;
        doc.fillColor(textColor).font('Helvetica').fontSize(7);
        let rx = COL_L + 2;
        const vals = [
          (item.party || '').substring(0, 18),
          (item.description || '').substring(0, 25),
          item.dueDate ? new Date(item.dueDate).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: '2-digit' }) : '-',
          fmt(item.originalAmount, currency),
          fmt(item.remainingBalance, currency),
        ];
        vals.forEach((v, i) => {
          doc.text(v, rx, ry + 3, { width: colW[i], align: i > 2 ? 'right' : 'left' });
          rx += colW[i];
        });
        doc.moveDown(0.05);
      });
    }

    return finalise(doc, buffers);
  } catch (err) {
    logger.error('PDF generation failed (Aging Report):', err);
    throw err;
  }
}

// ── 7. Statement of Changes in Equity ────────────────────────────────────────

async function generateEquityStatementPDF({ businessName, data, dateRange, currency = 'PKR' }) {
  const { doc, buffers } = buildDoc();
  try {
    docHeader(doc, businessName, 'Statement of Changes in Equity', `For the period: ${dateRange}`);

    // Build component list from the first row's values keys
    const components = data.components || [];
    const rows       = data.rows       || [];

    // Column layout: label column + one column per component + total column
    const colCount   = 1 + components.length + 1;
    const labelW     = 130;
    const amtW       = Math.floor((CONTENT_W - labelW) / (components.length + 1));

    // Header row
    const hy = doc.y;
    doc.rect(COL_L, hy, CONTENT_W, 18).fill(COLORS.primary);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
    doc.text('', COL_L + 4, hy + 5, { width: labelW });
    components.forEach((c, i) => {
      const x = COL_L + labelW + i * amtW;
      doc.text(c.label || c.key || '', x, hy + 5, { width: amtW, align: 'right' });
    });
    doc.text('Total', COL_L + labelW + components.length * amtW, hy + 5, { width: amtW, align: 'right' });
    doc.moveDown(0.1);

    // Data rows
    rows.forEach((row, idx) => {
      if (doc.y > doc.page.height - 60) doc.addPage();
      const ry = doc.y;
      if (idx % 2 === 0) doc.rect(COL_L, ry, CONTENT_W, 14).fill(COLORS.rowEven);

      const isBold = row.key === 'opening' || row.key === 'closing';
      doc.fillColor(COLORS.text)
         .font(isBold ? 'Helvetica-Bold' : 'Helvetica')
         .fontSize(8);
      doc.text(row.label || row.key || '', COL_L + 4, ry + 3, { width: labelW - 4 });
      components.forEach((c, i) => {
        const val = (row.values || {})[c.key] || 0;
        const x   = COL_L + labelW + i * amtW;
        doc.text(fmt(val, currency), x, ry + 3, { width: amtW, align: 'right' });
      });
      const total = typeof row.total === 'number' ? row.total : 0;
      doc.text(fmt(total, currency), COL_L + labelW + components.length * amtW, ry + 3, { width: amtW, align: 'right' });
      doc.moveDown(0.05);
    });

    // Reconciliation footer
    doc.moveDown(0.5);
    const reconciles = data.reconciliation?.reconciles;
    const recY = doc.y;
    doc.rect(COL_L, recY, CONTENT_W, 18)
       .fill(reconciles ? '#c6f6d5' : '#fed7d7');
    doc.fillColor(reconciles ? COLORS.success : COLORS.danger)
       .font('Helvetica-Bold').fontSize(9)
       .text(
         reconciles
           ? '✓ Equity reconciles — closing balance matches balance sheet equity'
           : '✗ Equity does not reconcile — review journal entries',
         COL_L + 8, recY + 4, { width: CONTENT_W - 16 }
       );
    doc.moveDown(1);

    return finalise(doc, buffers);
  } catch (err) {
    logger.error('PDF generation failed (Equity Statement):', err);
    throw err;
  }
}

// ── Legacy aliases (backward compat) ─────────────────────────────────────────

const generateIncomeStatement     = generateIncomeStatementPDF;
const generateBalanceSheet        = generateBalanceSheetPDF;
const generateCashFlowStatement   = generateCashFlowPDF;

async function generateTransactionListPDF({ businessName, transactions, dateRange }) {
  const { doc, buffers } = buildDoc();
  docHeader(doc, businessName, 'Transaction History', `Period: ${dateRange}`);
  const cols = [80, 160, 110, 100, 80];
  const hds  = ['Date', 'Description', 'Type', 'Amount', 'Status'];
  const hy   = doc.y;
  doc.rect(COL_L, hy, CONTENT_W, 16).fill(COLORS.primary);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
  let hx = COL_L + 2;
  hds.forEach((h, i) => { doc.text(h, hx, hy + 4, { width: cols[i] }); hx += cols[i]; });
  doc.moveDown(0.1);

  (transactions || []).slice(0, 100).forEach((t, idx) => {
    if (doc.y > doc.page.height - 50) doc.addPage();
    const ry = doc.y;
    if (idx % 2 === 0) doc.rect(COL_L, ry, CONTENT_W, 13).fill(COLORS.rowEven);
    doc.fillColor(COLORS.text).font('Helvetica').fontSize(8);
    let rx = COL_L + 2;
    const vals = [
      new Date(t.transactionDate).toLocaleDateString(),
      (t.description || '').substring(0, 28),
      t.transactionType || '',
      fmt(t.amount),
      t.status || '',
    ];
    vals.forEach((v, i) => { doc.text(v, rx, ry + 2, { width: cols[i] }); rx += cols[i]; });
    doc.moveDown(0.05);
  });

  return finalise(doc, buffers);
}

module.exports = {
  // New named exports
  generateIncomeStatementPDF,
  generateBalanceSheetPDF,
  generateCashFlowPDF,
  generateTrialBalancePDF,
  generateGeneralLedgerPDF,
  generateAgingPDF,
  generateEquityStatementPDF,
  // Backward-compat aliases
  generateIncomeStatement,
  generateBalanceSheet,
  generateCashFlowStatement,
  generateTransactionListPDF,
};
