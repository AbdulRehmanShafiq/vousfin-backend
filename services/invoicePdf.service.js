// services/invoicePdf.service.js
//
// Phase 2 — Server-side PDF generation for invoices.
//
// Uses PDFKit (lightweight, zero-dependency PDF lib for Node.js).
// Generates professional invoices with:
//   - Company header / logo placeholder
//   - Customer details
//   - Line items table
//   - Dynamic totals breakdown
//   - Tax summary
//   - Bank / payment details
//   - Payment terms & notes
//   - QR code placeholder (for future e-invoicing / SRB compliance)
//
// Public API:
//   generatePdf(invoice, business)  → Buffer (PDF bytes)
//   streamPdf(invoice, business, res) → pipes PDF to Express response
//

const logger = require('../config/logger');

// Lazy-load PDFKit to avoid startup cost and allow graceful fallback
let PDFDocument;
try {
  PDFDocument = require('pdfkit');
} catch {
  logger.warn('[invoicePdf] pdfkit not installed — PDF generation unavailable. Run: npm install pdfkit');
}

// ── Layout constants ─────────────────────────────────────────────────────────
const PAGE = { width: 595.28, height: 841.89 }; // A4 points
const M = { top: 50, right: 50, bottom: 60, left: 50 };
const CW = PAGE.width - M.left - M.right; // content width
const COLORS = {
  primary:   '#0891B2', // cyan-600
  dark:      '#0F172A',
  muted:     '#64748B',
  border:    '#E2E8F0',
  bg:        '#F8FAFC',
  white:     '#FFFFFF',
};

class InvoicePdfService {
  /**
   * Generate a PDF buffer for an invoice.
   *
   * @param {Object} invoice  — Mongoose document or plain object
   * @param {Object} business — { businessName, address, phone, email, taxId, logoUrl? }
   * @returns {Promise<Buffer>}
   */
  async generatePdf(invoice, business = {}) {
    if (!PDFDocument) {
      throw new Error('pdfkit is not installed. Run: npm install pdfkit');
    }

    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: 'A4',
          margin: M.top,
          info: {
            Title: `Invoice ${invoice.invoiceNumber}`,
            Author: business.businessName || 'VousFin',
          },
        });

        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        this._render(doc, invoice, business);
        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Stream PDF directly to an Express response (for download endpoint).
   */
  async streamPdf(invoice, business, res) {
    if (!PDFDocument) {
      throw new Error('pdfkit is not installed');
    }

    const doc = new PDFDocument({ size: 'A4', margin: M.top });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Invoice-${invoice.invoiceNumber}.pdf"`);
    doc.pipe(res);
    this._render(doc, invoice, business);
    doc.end();
  }

  // ── Internal render ────────────────────────────────────────────────────────

  _render(doc, inv, biz) {
    const r2 = (v) => (Number(v) || 0).toFixed(2);
    const fmt = (v, cur) => `${cur || inv.currencyCode || 'PKR'} ${r2(v)}`;
    let y = M.top;

    // ── Header: Company info + Invoice title ──────────────────────────
    doc.fontSize(20).fillColor(COLORS.primary).text('INVOICE', M.left, y, { align: 'right' });
    doc.fontSize(11).fillColor(COLORS.dark).text(biz.businessName || 'Your Company', M.left, y);
    y += 18;
    doc.fontSize(8).fillColor(COLORS.muted);
    if (biz.address) { doc.text(biz.address, M.left, y); y += 11; }
    if (biz.phone)   { doc.text(`Phone: ${biz.phone}`, M.left, y); y += 11; }
    if (biz.email)   { doc.text(biz.email, M.left, y); y += 11; }
    if (biz.taxId)   { doc.text(`Tax ID: ${biz.taxId}`, M.left, y); y += 11; }

    // ── Invoice meta ─────────────────────────────────────────────────
    y += 10;
    doc.moveTo(M.left, y).lineTo(PAGE.width - M.right, y).strokeColor(COLORS.border).lineWidth(1).stroke();
    y += 12;

    const metaLeft = M.left;
    const metaRight = PAGE.width / 2 + 20;

    doc.fontSize(9).fillColor(COLORS.dark);
    doc.text(`Invoice #: ${inv.invoiceNumber}`, metaLeft, y);
    doc.text(`Date: ${this._fmtDate(inv.issueDate)}`, metaRight, y);
    y += 14;
    if (inv.dueDate) {
      doc.text(`Due Date: ${this._fmtDate(inv.dueDate)}`, metaRight, y);
    }
    doc.text(`Status: ${(inv.state || 'draft').toUpperCase()}`, metaLeft, y);
    y += 14;
    if (inv.currencyCode && inv.currencyCode !== 'PKR') {
      doc.text(`Currency: ${inv.currencyCode} (Rate: ${inv.exchangeRate || 1})`, metaLeft, y);
      y += 14;
    }

    // ── Bill To ──────────────────────────────────────────────────────
    y += 6;
    doc.fontSize(9).fillColor(COLORS.primary).text('BILL TO', metaLeft, y);
    y += 14;
    doc.fillColor(COLORS.dark);
    const cs = inv.customerSnapshot || {};
    if (cs.fullName || cs.businessName) {
      doc.fontSize(10).text(cs.businessName || cs.fullName, metaLeft, y);
      y += 13;
    }
    if (cs.email) { doc.fontSize(8).fillColor(COLORS.muted).text(cs.email, metaLeft, y); y += 11; }
    if (cs.phone) { doc.text(cs.phone, metaLeft, y); y += 11; }
    if (cs.taxId) { doc.text(`Tax ID: ${cs.taxId}`, metaLeft, y); y += 11; }

    // ── Line items table ─────────────────────────────────────────────
    y += 15;
    const items = inv.lineItems || [];
    if (items.length > 0) {
      y = this._renderLineItems(doc, items, y, inv.currencyCode);
    } else {
      // Legacy invoice with no line items — show single row
      doc.fontSize(9).fillColor(COLORS.dark);
      doc.text(inv.description || 'Invoice amount', M.left, y);
      doc.text(fmt(inv.totalAmount), PAGE.width - M.right - 100, y, { width: 100, align: 'right' });
      y += 20;
    }

    // ── Totals panel ─────────────────────────────────────────────────
    y += 10;
    y = this._renderTotals(doc, inv, y, fmt);

    // ── Bank details ─────────────────────────────────────────────────
    if (inv.bankDetails && (inv.bankDetails.bankName || inv.bankDetails.iban)) {
      y += 20;
      y = this._renderBankDetails(doc, inv.bankDetails, y);
    }

    // ── Payment terms & notes ────────────────────────────────────────
    if (inv.paymentTermsText || inv.notes) {
      y += 15;
      if (inv.paymentTermsText) {
        doc.fontSize(8).fillColor(COLORS.primary).text('PAYMENT TERMS', M.left, y);
        y += 12;
        doc.fillColor(COLORS.muted).text(inv.paymentTermsText, M.left, y, { width: CW });
        y += doc.heightOfString(inv.paymentTermsText, { width: CW }) + 8;
      }
      if (inv.notes) {
        doc.fontSize(8).fillColor(COLORS.primary).text('NOTES', M.left, y);
        y += 12;
        doc.fillColor(COLORS.muted).text(inv.notes, M.left, y, { width: CW });
      }
    }

    // ── Footer ───────────────────────────────────────────────────────
    const footY = PAGE.height - M.bottom + 10;
    doc.moveTo(M.left, footY).lineTo(PAGE.width - M.right, footY)
      .strokeColor(COLORS.border).lineWidth(0.5).stroke();
    doc.fontSize(7).fillColor(COLORS.muted)
      .text('Generated by VousFin Smart Accountant', M.left, footY + 6, { align: 'center', width: CW });
  }

  _renderLineItems(doc, items, startY, currency) {
    let y = startY;
    const cols = [
      { label: '#',           x: M.left,      w: 25 },
      { label: 'Item',        x: M.left + 25, w: 180 },
      { label: 'Qty',         x: 260,         w: 50,  align: 'right' },
      { label: 'Unit Price',  x: 315,         w: 70,  align: 'right' },
      { label: 'Disc.',       x: 390,         w: 55,  align: 'right' },
      { label: 'Tax',         x: 445,         w: 50,  align: 'right' },
      { label: 'Total',       x: 495,         w: 50,  align: 'right' },
    ];

    // Header row
    doc.rect(M.left, y, CW, 20).fill(COLORS.primary);
    doc.fontSize(7).fillColor(COLORS.white);
    for (const c of cols) {
      doc.text(c.label, c.x + 4, y + 6, { width: c.w - 8, align: c.align || 'left' });
    }
    y += 20;

    // Data rows
    doc.fillColor(COLORS.dark).fontSize(8);
    for (let i = 0; i < items.length; i++) {
      const li = items[i];
      const rowH = 18;
      if (i % 2 === 1) {
        doc.rect(M.left, y, CW, rowH).fill(COLORS.bg);
        doc.fillColor(COLORS.dark);
      }
      const r2 = (v) => (Number(v) || 0).toFixed(2);
      doc.text(String(i + 1), cols[0].x + 4, y + 5, { width: cols[0].w - 8 });
      doc.text(li.name || '', cols[1].x + 4, y + 5, { width: cols[1].w - 8 });
      doc.text(String(li.quantity || 0), cols[2].x + 4, y + 5, { width: cols[2].w - 8, align: 'right' });
      doc.text(r2(li.unitPrice), cols[3].x + 4, y + 5, { width: cols[3].w - 8, align: 'right' });
      doc.text(r2(li.discountAmount || 0), cols[4].x + 4, y + 5, { width: cols[4].w - 8, align: 'right' });
      doc.text(r2(li.taxAmount || 0), cols[5].x + 4, y + 5, { width: cols[5].w - 8, align: 'right' });
      doc.text(r2(li.lineTotal || 0), cols[6].x + 4, y + 5, { width: cols[6].w - 8, align: 'right' });
      y += rowH;
    }

    // Bottom border
    doc.moveTo(M.left, y).lineTo(PAGE.width - M.right, y).strokeColor(COLORS.border).lineWidth(0.5).stroke();
    return y;
  }

  _renderTotals(doc, inv, startY, fmt) {
    let y = startY;
    const rightX = PAGE.width - M.right - 200;
    const valX = PAGE.width - M.right - 90;
    const lineH = 16;

    const addRow = (label, value, bold = false) => {
      doc.fontSize(bold ? 10 : 8).fillColor(bold ? COLORS.dark : COLORS.muted);
      doc.text(label, rightX, y, { width: 100, align: 'right' });
      doc.fillColor(COLORS.dark).fontSize(bold ? 10 : 9);
      doc.text(value, valX, y, { width: 90, align: 'right' });
      y += lineH;
    };

    if (inv.lineItems && inv.lineItems.length > 0) {
      addRow('Subtotal', fmt(inv.subtotal || 0));
      if (inv.totalLineDiscount > 0) addRow('Line Discounts', `- ${fmt(inv.totalLineDiscount)}`);
      if (inv.invoiceDiscountAmount > 0) addRow('Invoice Discount', `- ${fmt(inv.invoiceDiscountAmount)}`);
      if (inv.totalTax > 0 || inv.taxAmount > 0) addRow('Tax', fmt(inv.totalTax || inv.taxAmount || 0));
      if (inv.shippingCharges > 0) addRow('Shipping', fmt(inv.shippingCharges));
      if (inv.roundingAdjustment) addRow('Rounding', fmt(inv.roundingAdjustment));
    }

    // Separator
    doc.moveTo(rightX, y).lineTo(PAGE.width - M.right, y).strokeColor(COLORS.primary).lineWidth(1).stroke();
    y += 6;
    addRow('TOTAL', fmt(inv.totalAmount || 0), true);

    if (inv.paidAmount > 0) {
      addRow('Paid', `- ${fmt(inv.paidAmount)}`);
      addRow('Balance Due', fmt(inv.remainingBalance ?? (inv.totalAmount - inv.paidAmount)), true);
    }

    if (inv.totalCredited > 0) {
      addRow('Credited', `- ${fmt(inv.totalCredited)}`);
    }

    return y;
  }

  _renderBankDetails(doc, bank, startY) {
    let y = startY;
    doc.fontSize(8).fillColor(COLORS.primary).text('BANK DETAILS', M.left, y);
    y += 14;
    doc.fontSize(8).fillColor(COLORS.muted);
    if (bank.bankName) { doc.text(`Bank: ${bank.bankName}`, M.left, y); y += 11; }
    if (bank.accountTitle) { doc.text(`Account: ${bank.accountTitle}`, M.left, y); y += 11; }
    if (bank.accountNumber) { doc.text(`A/C #: ${bank.accountNumber}`, M.left, y); y += 11; }
    if (bank.iban) { doc.text(`IBAN: ${bank.iban}`, M.left, y); y += 11; }
    if (bank.swiftCode) { doc.text(`SWIFT: ${bank.swiftCode}`, M.left, y); y += 11; }
    return y;
  }

  _fmtDate(d) {
    if (!d) return '—';
    const dt = new Date(d);
    return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }
}

module.exports = new InvoicePdfService();
