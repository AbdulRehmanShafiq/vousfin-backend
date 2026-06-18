// utils/payslipPdf.util.js — FR-08.2 payslip + FR-08.4 certificate PDFs.
'use strict';
const PDFDocument = require('pdfkit');

/** Render a PDF and resolve a Buffer. */
function renderToBuffer(draw) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    draw(doc);
    doc.end();
  });
}

const money = (n) => `PKR ${Number(n || 0).toLocaleString('en-PK')}`;

function buildPayslipPdf({ business, line, period }) {
  return renderToBuffer((doc) => {
    doc.fontSize(18).text(business?.name || 'Payslip', { align: 'center' });
    doc.fontSize(11).text(`Payslip for ${period}`, { align: 'center' }).moveDown();
    doc.text(`Employee: ${line.employeeName} (${line.employeeCode})`).moveDown(0.5);
    doc.text('Earnings').moveDown(0.2);
    doc.text(`  Basic: ${money(line.basic)}`);
    doc.text(`  Allowances: ${money(line.allowancesTotal)}`);
    (line.additions || []).forEach((a) => doc.text(`  ${a.label}: ${money(a.amount)}`));
    doc.text(`  Gross: ${money(line.gross)}`).moveDown(0.4);
    doc.text('Deductions').moveDown(0.2);
    doc.text(`  Income tax: ${money(line.incomeTax)}`);
    doc.text(`  EOBI (you): ${money(line.eobiEmployee)}`);
    doc.text(`  Provident fund (you): ${money(line.pfEmployee)}`);
    (line.otherDeductions || []).forEach((d) => doc.text(`  ${d.label}: ${money(d.amount)}`));
    doc.moveDown(0.4).fontSize(13).text(`Net pay: ${money(line.netPay)}`, { underline: true });
  });
}

function buildCertificatePdf({ business, certificate }) {
  return renderToBuffer((doc) => {
    doc.fontSize(16).text(business?.name || 'Salary Tax Certificate', { align: 'center' });
    doc.fontSize(11).text(`Salary & Tax Certificate — Tax Year ${certificate.taxYear}`, { align: 'center' }).moveDown();
    doc.text(`Employee: ${certificate.employeeName}`).moveDown(0.5);
    certificate.months.forEach((m) =>
      doc.text(`  ${m.period}: gross ${money(m.gross)}, taxable ${money(m.taxableIncome)}, tax ${money(m.taxWithheld)}`));
    doc.moveDown(0.4).fontSize(12).text(
      `Total gross ${money(certificate.totals.gross)} · Total tax withheld ${money(certificate.totals.taxWithheld)}`);
  });
}

module.exports = { buildPayslipPdf, buildCertificatePdf };
