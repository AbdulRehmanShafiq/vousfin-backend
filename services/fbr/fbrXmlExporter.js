// services/fbr/fbrXmlExporter.js — FR-04.3
//
// Serialises a prepared return into FBR IRIS-compatible XML. Self-contained (no
// XML dependency): the element trees are simple and we escape all text. This is
// the GUARANTEED filing path — always available, even when IRIS is unreachable.
//
'use strict';

const esc  = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const el   = (tag, content) => `<${tag}>${content}</${tag}>`;
const leaf = (tag, val) => el(tag, esc(val));
const join = (arr, fn) => (Array.isArray(arr) ? arr : []).map(fn).join('');

function periodStr(period) {
  if (!period) return '';
  return period.month ? `${period.year}-${String(period.month).padStart(2, '0')}` : String(period.year);
}
function dateStr(d) {
  if (!d) return '';
  const dt = new Date(d);
  return isNaN(dt) ? '' : dt.toISOString().slice(0, 10);
}

function gst01Xml(doc, ntn) {
  const f = doc.data?.fields || {};
  const header =
    leaf('NTN', ntn) + leaf('Period', periodStr(doc.period)) +
    leaf('TotalTaxableSales', f.totalTaxableSales) + leaf('OutputTax', f.outputTax) +
    leaf('TotalTaxablePurchases', f.totalTaxablePurchases) + leaf('InputTax', f.inputTax) +
    leaf('NetPayable', f.netPayable);

  const annexC = el('AnnexC', join(doc.data?.annexes?.C, (l) =>
    el('Item', leaf('Serial', l.serial) + leaf('Date', dateStr(l.date)) + leaf('Description', l.description) +
               leaf('Value', l.value) + leaf('Rate', l.taxRate) + leaf('SalesTax', l.salesTax))));
  const annexA = el('AnnexA', join(doc.data?.annexes?.A, (l) =>
    el('Item', leaf('Serial', l.serial) + leaf('Date', dateStr(l.date)) + leaf('Description', l.description) +
               leaf('Value', l.value) + leaf('Rate', l.taxRate) + leaf('InputTax', l.inputTax))));

  return el('GSTReturn', el('Header', header) + annexC + annexA);
}

function wht165Xml(doc, ntn) {
  const f = doc.data?.fields || {};
  const header = leaf('WithholdingAgentNTN', ntn) + leaf('Period', periodStr(doc.period)) + leaf('TotalWithheld', f.totalWithheld);
  const lines = join(doc.data?.lines, (l) =>
    el('Line', leaf('Serial', l.serial) + leaf('VendorName', l.vendorName) + leaf('NTN_CNIC', l.taxId) +
               leaf('Section', l.section) + leaf('GrossAmount', l.grossAmount) + leaf('TaxWithheld', l.taxWithheld)));
  return el('WHTStatement', el('Header', header) + el('Lines', lines));
}

function itReturnXml(doc, ntn) {
  const f = doc.data?.fields || {};
  return el('IncomeTaxReturn',
    leaf('NTN', ntn) + leaf('TaxYear', periodStr(doc.period)) +
    leaf('Revenue', f.revenue) + leaf('IncomeFromBusiness', f.incomeFromBusiness) +
    leaf('TaxableIncome', f.taxableIncome) + leaf('TaxChargeable', f.taxChargeable) +
    leaf('AdvanceTaxAdjusted', f.advanceTaxAdjusted) + leaf('BalancePayable', f.balancePayable));
}

/**
 * @param {object} returnDoc  a TaxReturn (with .returnType, .period, .data)
 * @param {string} ntn        the filer NTN
 * @returns {string} XML
 */
function toXML(returnDoc, ntn) {
  const body =
    returnDoc.returnType === 'GST-01'   ? gst01Xml(returnDoc, ntn)  :
    returnDoc.returnType === 'WHT-165'  ? wht165Xml(returnDoc, ntn) :
    returnDoc.returnType === 'IT-RETURN'? itReturnXml(returnDoc, ntn) :
    el('TaxReturn', leaf('Type', returnDoc.returnType));
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
}

module.exports = { toXML };
