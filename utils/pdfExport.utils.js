// utils/pdfExport.utils.js
const PDFDocument = require('pdfkit');
const { Readable } = require('stream');
const logger = require('../config/logger');

/**
 * Helper to add a consistent header to each PDF report.
 * @param {PDFKit.PDFDocument} doc - PDF document instance
 * @param {string} businessName - Name of the business
 * @param {string} title - Report title (e.g., "Income Statement")
 * @param {string} period - Period description (e.g., "For the year ended Dec 31, 2025")
 * @param {string} generationDate - Formatted generation timestamp
 */
const generateHeader = (doc, businessName, title, period, generationDate) => {
  doc.fontSize(20).font('Helvetica-Bold').text(businessName, { align: 'center' });
  doc.fontSize(16).font('Helvetica-Bold').text(title, { align: 'center' });
  doc.fontSize(10).font('Helvetica').text(period, { align: 'center' });
  doc.fontSize(8).text(`Generated on: ${generationDate}`, { align: 'right' });
  doc.moveDown();
  doc.fontSize(10).font('Helvetica-Bold');
  // Draw a line separator
  doc.strokeColor('#cccccc').lineWidth(1).moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown(0.5);
};

/**
 * Helper to format currency amounts.
 * @param {number} amount
 * @returns {string}
 */
const formatCurrency = (amount, currency = 'PKR') => {
  return `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/**
 * Generate Income Statement PDF.
 * @param {Object} options
 * @param {string} options.businessName
 * @param {Object} options.data - { revenue: [{name, amount}], expenses: [{name, amount}], grossProfit, operatingProfit, netProfit }
 * @param {string} options.dateRange - e.g., "01 Jan 2025 - 31 Mar 2025"
 * @param {string} options.asOfDate - Not needed for income statement, kept for consistency
 * @param {string} options.currency - Default 'PKR'
 * @returns {Promise<Buffer>}
 */
const generateIncomeStatement = async ({ businessName, data, dateRange, currency = 'PKR' }) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });
      doc.on('error', reject);

      const generationDate = new Date().toLocaleString();
      generateHeader(doc, businessName, 'Income Statement', `For the period: ${dateRange}`, generationDate);

      // Revenue section
      doc.fontSize(12).font('Helvetica-Bold').text('Revenue', { underline: true });
      doc.moveDown(0.5);
      let totalRevenue = 0;
      if (data.revenue && data.revenue.length) {
        data.revenue.forEach(item => {
          doc.fontSize(10).font('Helvetica');
          const amountStr = formatCurrency(item.amount, currency);
          doc.text(`${item.name}`, { continued: true });
          doc.text(amountStr, { align: 'right' });
          totalRevenue += item.amount;
        });
      }
      doc.moveDown();
      doc.font('Helvetica-Bold');
      doc.text(`Total Revenue`, { continued: true });
      doc.text(formatCurrency(totalRevenue, currency), { align: 'right' });
      doc.moveDown();

      // Expenses section
      doc.fontSize(12).font('Helvetica-Bold').text('Expenses', { underline: true });
      doc.moveDown(0.5);
      let totalExpenses = 0;
      if (data.expenses && data.expenses.length) {
        data.expenses.forEach(item => {
          doc.fontSize(10).font('Helvetica');
          const amountStr = formatCurrency(item.amount, currency);
          doc.text(`${item.name}`, { continued: true });
          doc.text(amountStr, { align: 'right' });
          totalExpenses += item.amount;
        });
      }
      doc.moveDown();
      doc.font('Helvetica-Bold');
      doc.text(`Total Expenses`, { continued: true });
      doc.text(formatCurrency(totalExpenses, currency), { align: 'right' });
      doc.moveDown(2);

      // Net Profit
      const netProfit = totalRevenue - totalExpenses;
      doc.fontSize(12).font('Helvetica-Bold');
      doc.text(`Net Profit / (Loss)`, { continued: true });
      doc.text(formatCurrency(netProfit, currency), { align: 'right' });
      doc.moveDown();

      // Footer
      doc.fontSize(8).font('Helvetica-Oblique').text('* This is a system generated report.', { align: 'center' });

      doc.end();
    } catch (error) {
      logger.error('PDF generation failed (Income Statement):', error);
      reject(error);
    }
  });
};

/**
 * Generate Balance Sheet PDF.
 * @param {Object} options
 * @param {string} options.businessName
 * @param {Object} options.data - { assets: [{name, amount}], liabilities: [{name, amount}], equity: [{name, amount}], totalAssets, totalLiabilities, totalEquity }
 * @param {string} options.asOfDate - e.g., "As of 31 March 2025"
 * @param {string} options.currency
 * @returns {Promise<Buffer>}
 */
const generateBalanceSheet = async ({ businessName, data, asOfDate, currency = 'PKR' }) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });
      doc.on('error', reject);

      const generationDate = new Date().toLocaleString();
      generateHeader(doc, businessName, 'Balance Sheet', asOfDate, generationDate);

      // Assets column (left side)
      const leftX = 50;
      const rightX = 300;
      const startY = doc.y;

      doc.fontSize(11).font('Helvetica-Bold').text('ASSETS', leftX, startY);
      let totalAssets = 0;
      let yOffset = doc.y + 15;
      if (data.assets && data.assets.length) {
        data.assets.forEach(item => {
          doc.fontSize(9).font('Helvetica');
          doc.text(item.name, leftX, yOffset);
          doc.text(formatCurrency(item.amount, currency), rightX, yOffset, { width: 200, align: 'right' });
          yOffset += 15;
          totalAssets += item.amount;
        });
      }
      doc.font('Helvetica-Bold');
      doc.text('Total Assets', leftX, yOffset);
      doc.text(formatCurrency(totalAssets, currency), rightX, yOffset, { width: 200, align: 'right' });
      yOffset += 25;

      // Liabilities & Equity
      doc.fontSize(11).font('Helvetica-Bold').text('LIABILITIES & EQUITY', leftX, yOffset);
      yOffset += 15;
      let totalLiabilities = 0;
      if (data.liabilities && data.liabilities.length) {
        data.liabilities.forEach(item => {
          doc.fontSize(9).font('Helvetica');
          doc.text(item.name, leftX, yOffset);
          doc.text(formatCurrency(item.amount, currency), rightX, yOffset, { width: 200, align: 'right' });
          yOffset += 15;
          totalLiabilities += item.amount;
        });
      }
      doc.font('Helvetica-Bold');
      doc.text('Total Liabilities', leftX, yOffset);
      doc.text(formatCurrency(totalLiabilities, currency), rightX, yOffset, { width: 200, align: 'right' });
      yOffset += 15;

      let totalEquity = 0;
      if (data.equity && data.equity.length) {
        data.equity.forEach(item => {
          doc.fontSize(9).font('Helvetica');
          doc.text(item.name, leftX, yOffset);
          doc.text(formatCurrency(item.amount, currency), rightX, yOffset, { width: 200, align: 'right' });
          yOffset += 15;
          totalEquity += item.amount;
        });
      }
      doc.font('Helvetica-Bold');
      doc.text('Total Equity', leftX, yOffset);
      doc.text(formatCurrency(totalEquity, currency), rightX, yOffset, { width: 200, align: 'right' });
      yOffset += 20;

      // Verify equation
      const totalLiabEquity = totalLiabilities + totalEquity;
      doc.font('Helvetica-Bold').fontSize(10);
      doc.text('Verification: Assets = Liabilities + Equity', leftX, yOffset);
      yOffset += 12;
      doc.text(`${formatCurrency(totalAssets, currency)} = ${formatCurrency(totalLiabEquity, currency)}`, leftX, yOffset);
      if (Math.abs(totalAssets - totalLiabEquity) > 0.01) {
        doc.fillColor('red').text('WARNING: Equation does not balance!', leftX, yOffset + 15);
      }

      doc.end();
    } catch (error) {
      logger.error('PDF generation failed (Balance Sheet):', error);
      reject(error);
    }
  });
};

/**
 * Generate Cash Flow Statement PDF.
 * @param {Object} options
 * @param {string} options.businessName
 * @param {Object} options.data - { operating: [{name, amount}], investing: [{name, amount}], financing: [{name, amount}], netCashFlow }
 * @param {string} options.dateRange
 * @param {string} options.currency
 * @returns {Promise<Buffer>}
 */
const generateCashFlowStatement = async ({ businessName, data, dateRange, currency = 'PKR' }) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });
      doc.on('error', reject);

      const generationDate = new Date().toLocaleString();
      generateHeader(doc, businessName, 'Cash Flow Statement', `For the period: ${dateRange}`, generationDate);

      let y = doc.y;
      const leftX = 50;
      const rightX = 500;

      const drawSection = (title, items) => {
        doc.fontSize(11).font('Helvetica-Bold').text(title, leftX, y);
        y = doc.y + 5;
        if (items && items.length) {
          items.forEach(item => {
            doc.fontSize(9).font('Helvetica');
            doc.text(item.name, leftX, y);
            doc.text(formatCurrency(item.amount, currency), rightX, y, { align: 'right' });
            y += 15;
          });
        } else {
          doc.fontSize(9).font('Helvetica-Oblique').text('No activities', leftX, y);
          y += 15;
        }
        y += 5;
      };

      drawSection('Operating Activities', data.operating);
      drawSection('Investing Activities', data.investing);
      drawSection('Financing Activities', data.financing);
      y += 10;
      doc.fontSize(10).font('Helvetica-Bold');
      doc.text('Net Cash Flow', leftX, y);
      doc.text(formatCurrency(data.netCashFlow, currency), rightX, y, { align: 'right' });
      y += 25;
      doc.fontSize(8).font('Helvetica-Oblique')
        .text('* Positive = net cash inflow, Negative = net cash outflow.', leftX, y);

      doc.end();
    } catch (error) {
      logger.error('PDF generation failed (Cash Flow):', error);
      reject(error);
    }
  });
};

/**
 * Generic function to export transaction list as PDF (optional).
 * @param {Object} options
 * @param {string} businessName
 * @param {Array} transactions - list of transaction objects
 * @param {string} dateRange
 * @returns {Promise<Buffer>}
 */
const generateTransactionListPDF = async ({ businessName, transactions, dateRange }) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      const generationDate = new Date().toLocaleString();
      generateHeader(doc, businessName, 'Transaction History', `Period: ${dateRange}`, generationDate);

      doc.fontSize(8).font('Helvetica-Bold');
      const tableTop = doc.y;
      const colWidths = [80, 100, 100, 80, 80];
      const headers = ['Date', 'Description', 'Type', 'Amount', 'Status'];
      let x = 50;
      headers.forEach((header, i) => {
        doc.text(header, x, tableTop, { width: colWidths[i], align: 'center' });
        x += colWidths[i];
      });
      doc.strokeColor('#aaa').lineWidth(0.5).moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();
      let y = tableTop + 20;
      transactions.slice(0, 30).forEach(t => {
        doc.fontSize(8).font('Helvetica');
        let xPos = 50;
        doc.text(new Date(t.transactionDate).toLocaleDateString(), xPos, y, { width: colWidths[0] });
        xPos += colWidths[0];
        doc.text(t.description.substring(0, 30), xPos, y, { width: colWidths[1] });
        xPos += colWidths[1];
        doc.text(t.transactionType, xPos, y, { width: colWidths[2] });
        xPos += colWidths[2];
        doc.text(formatCurrency(t.amount), xPos, y, { width: colWidths[3] });
        xPos += colWidths[3];
        doc.text(t.status, xPos, y, { width: colWidths[4] });
        y += 15;
        if (y > 750) {
          doc.addPage();
          y = 50;
        }
      });
      doc.end();
    } catch (error) {
      logger.error('PDF generation failed (Transaction List):', error);
      reject(error);
    }
  });
};

module.exports = {
  generateIncomeStatement,
  generateBalanceSheet,
  generateCashFlowStatement,
  generateTransactionListPDF,
};