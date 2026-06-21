// utils/excelExport.utils.js — Professional ERP-quality Excel generation
const ExcelJS = require('exceljs');

// ── Style constants ───────────────────────────────────────────────────────────
const STYLES = {
  headerFill:   { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D3748' } },
  sectionFill:  { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEBF4FF' } },
  totalFill:    { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A365D' } },
  subtotalFill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } },
  evenFill:     { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7FAFC' } },
  white:        { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } },
  successFill:  { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6F6D5' } },
  dangerFill:   { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFED7D7' } },
  headerFont:   { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 },
  sectionFont:  { bold: true, color: { argb: 'FF1A365D' }, size: 10 },
  totalFont:    { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 },
  subtotalFont: { bold: true, color: { argb: 'FF4A5568' }, size: 10 },
  bodyFont:     { size: 10 },
  currency:     '#,##0.00',
  thin:         { style: 'thin', color: { argb: 'FFCBD5E0' } },
};

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function applyBorders(row) {
  row.eachCell(cell => {
    cell.border = {
      top:    STYLES.thin,
      bottom: STYLES.thin,
      left:   STYLES.thin,
      right:  STYLES.thin,
    };
  });
}

function addDocHeader(sheet, businessName, title, subtitle, colCount) {
  // Title row
  sheet.mergeCells(1, 1, 1, colCount);
  const titleRow = sheet.getRow(1);
  titleRow.height = 30;
  const titleCell = titleRow.getCell(1);
  titleCell.value         = businessName;
  titleCell.font          = { bold: true, size: 16, color: { argb: 'FF1A365D' } };
  titleCell.alignment     = { horizontal: 'center', vertical: 'middle' };
  titleCell.fill          = STYLES.white;

  sheet.mergeCells(2, 1, 2, colCount);
  const subRow = sheet.getRow(2);
  subRow.height = 22;
  const subCell = subRow.getCell(1);
  subCell.value     = title;
  subCell.font      = { bold: true, size: 13, color: { argb: 'FF2D3748' } };
  subCell.alignment = { horizontal: 'center', vertical: 'middle' };
  subCell.fill      = STYLES.white;

  sheet.mergeCells(3, 1, 3, colCount);
  const periodRow = sheet.getRow(3);
  periodRow.height = 18;
  const periodCell = periodRow.getCell(1);
  periodCell.value     = subtitle;
  periodCell.font      = { italic: true, size: 10, color: { argb: 'FF718096' } };
  periodCell.alignment = { horizontal: 'center', vertical: 'middle' };
  periodCell.fill      = STYLES.white;

  // Generated date
  sheet.mergeCells(4, 1, 4, colCount);
  const genRow = sheet.getRow(4);
  genRow.height = 14;
  const genCell = genRow.getCell(1);
  genCell.value     = `Generated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`;
  genCell.font      = { size: 8, color: { argb: 'FF718096' } };
  genCell.alignment = { horizontal: 'right' };
  genCell.fill      = STYLES.white;

  // Spacer
  sheet.getRow(5).height = 8;

  return 5; // last used row
}

function addColHeaders(sheet, startRow, headers, colWidths) {
  const row = sheet.getRow(startRow);
  row.height = 20;
  headers.forEach((h, i) => {
    const cell       = row.getCell(i + 1);
    cell.value       = h;
    cell.font        = STYLES.headerFont;
    cell.fill        = STYLES.headerFill;
    cell.alignment   = { horizontal: i === 0 ? 'left' : 'right', vertical: 'middle' };
    sheet.getColumn(i + 1).width = colWidths[i];
  });
  applyBorders(row);
  return startRow + 1;
}

function addSectionHeader(sheet, startRow, text, colCount) {
  sheet.mergeCells(startRow, 1, startRow, colCount);
  const row       = sheet.getRow(startRow);
  row.height      = 18;
  const cell      = row.getCell(1);
  cell.value      = text;
  cell.font       = STYLES.sectionFont;
  cell.fill       = STYLES.sectionFill;
  cell.alignment  = { horizontal: 'left', vertical: 'middle', indent: 1 };
  applyBorders(row);
  return startRow + 1;
}

function addLineItems(sheet, startRow, items, nameKey, amountKey, indent = 1) {
  let row = startRow;
  const accs = Array.isArray(items) ? items : [];
  accs.forEach((item, idx) => {
    const r        = sheet.getRow(row);
    r.height       = 16;
    const nameCell = r.getCell(1);
    nameCell.value     = item[nameKey] || item.accountName || item.name || item.description || '';
    nameCell.font      = STYLES.bodyFont;
    nameCell.alignment = { horizontal: 'left', indent };
    nameCell.fill      = idx % 2 === 0 ? STYLES.evenFill : STYLES.white;

    const amtCell    = r.getCell(2);
    amtCell.value    = typeof item[amountKey] === 'number'
      ? item[amountKey]
      : (typeof item.balance === 'number' ? item.balance : (item.amount || 0));
    amtCell.numFmt   = STYLES.currency;
    amtCell.font     = STYLES.bodyFont;
    amtCell.alignment = { horizontal: 'right' };
    amtCell.fill      = nameCell.fill;

    applyBorders(r);
    row++;
  });
  return row;
}

function addSubtotal(sheet, startRow, label, amount, colCount = 2) {
  const r       = sheet.getRow(startRow);
  r.height      = 17;
  r.getCell(1).value     = label;
  r.getCell(1).font      = STYLES.subtotalFont;
  r.getCell(1).fill      = STYLES.subtotalFill;
  r.getCell(1).alignment = { horizontal: 'left', indent: 1 };
  r.getCell(2).value     = amount;
  r.getCell(2).numFmt    = STYLES.currency;
  r.getCell(2).font      = STYLES.subtotalFont;
  r.getCell(2).fill      = STYLES.subtotalFill;
  r.getCell(2).alignment = { horizontal: 'right' };
  applyBorders(r);
  return startRow + 1;
}

function addTotal(sheet, startRow, label, amount, colCount = 2) {
  const r       = sheet.getRow(startRow);
  r.height      = 22;
  sheet.mergeCells(startRow, 1, startRow, colCount > 2 ? colCount - 1 : 1);
  r.getCell(1).value     = label;
  r.getCell(1).font      = STYLES.totalFont;
  r.getCell(1).fill      = STYLES.totalFill;
  r.getCell(1).alignment = { horizontal: 'left', indent: 1 };
  r.getCell(colCount).value    = amount;
  r.getCell(colCount).numFmt   = STYLES.currency;
  r.getCell(colCount).font     = { ...STYLES.totalFont, color: { argb: amount >= 0 ? 'FF68D391' : 'FFFC8181' } };
  r.getCell(colCount).fill     = STYLES.totalFill;
  r.getCell(colCount).alignment = { horizontal: 'right' };
  applyBorders(r);
  return startRow + 2;
}

function addSpacer(sheet, row) {
  sheet.getRow(row).height = 6;
  return row + 1;
}

// ── Report generators ─────────────────────────────────────────────────────────

async function generateExcelReport(reportType, reportData, meta = {}) {
  const wb    = new ExcelJS.Workbook();
  wb.creator  = 'VousFin Smart Accountant';
  wb.created  = new Date();

  switch (reportType) {
    case 'incomeStatement':  return _incomeStatement(wb, reportData, meta);
    case 'balanceSheet':     return _balanceSheet(wb, reportData, meta);
    case 'cashFlow':         return _cashFlow(wb, reportData, meta);
    case 'trialBalance':     return _trialBalance(wb, reportData, meta);
    case 'generalLedger':    return _generalLedger(wb, reportData, meta);
    case 'aging':            return _agingReport(wb, reportData, meta);
    case 'equityStatement':  return _equityStatement(wb, reportData, meta);
    default:
      throw new Error(`Unsupported report type: ${reportType}`);
  }
}

async function _incomeStatement(wb, d, meta) {
  const sh = wb.addWorksheet('Income Statement');
  let row  = addDocHeader(sh, meta.businessName || 'Business', 'Income Statement', `For the period: ${meta.startDate} to ${meta.endDate}`, 2) + 1;
  row = addColHeaders(sh, row, ['Account / Description', 'Amount'], [50, 20]) + 1;

  row = addSectionHeader(sh, row, 'REVENUE', 2) + 1;
  row = addLineItems(sh, row, d.revenue?.accounts || [], 'accountName', 'balance');
  row = addSubtotal(sh, row, 'Total Revenue', d.totalRevenue || d.revenue?.total || 0);
  row = addSpacer(sh, row);

  if ((d.cogs?.total || 0) > 0) {
    row = addSectionHeader(sh, row, 'COST OF GOODS SOLD', 2) + 1;
    row = addLineItems(sh, row, d.cogs?.accounts || [], 'accountName', 'balance');
    row = addSubtotal(sh, row, 'Total COGS', d.cogs.total);
    row = addSpacer(sh, row);
  }
  row = addTotal(sh, row, 'GROSS PROFIT', d.grossProfit || 0);

  row = addSectionHeader(sh, row, 'OPERATING EXPENSES', 2) + 1;
  row = addLineItems(sh, row, d.operatingExpenses?.accounts || [], 'accountName', 'balance');
  row = addSubtotal(sh, row, 'Total Operating Expenses', d.operatingExpenses?.total || 0);
  row = addSpacer(sh, row);

  if ((d.depreciationAmortization?.total || 0) !== 0) {
    row = addSectionHeader(sh, row, 'DEPRECIATION & AMORTIZATION', 2) + 1;
    row = addLineItems(sh, row, d.depreciationAmortization?.accounts || [], 'accountName', 'balance');
    row = addSubtotal(sh, row, 'Total D&A', d.depreciationAmortization.total);
    row = addSpacer(sh, row);
  }

  row = addSubtotal(sh, row, 'OPERATING PROFIT (EBIT)', d.operatingProfit || 0);

  // EBITDA annotation
  sh.mergeCells(row, 1, row, 2);
  const ebitdaCell = sh.getRow(row).getCell(1);
  ebitdaCell.value     = `EBITDA: ${(d.ebitda || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  ebitdaCell.font      = { italic: true, size: 9, color: { argb: 'FF718096' } };
  ebitdaCell.alignment = { horizontal: 'right' };
  row++;
  row = addSpacer(sh, row);

  if ((d.interestExpense?.total || 0) !== 0) {
    row = addSectionHeader(sh, row, 'INTEREST EXPENSE', 2) + 1;
    row = addLineItems(sh, row, d.interestExpense?.accounts || [], 'accountName', 'balance');
    row = addSubtotal(sh, row, 'Total Interest', d.interestExpense.total);
    row = addSpacer(sh, row);
  }

  addTotal(sh, row, 'NET PROFIT / (LOSS)', d.netIncome ?? d.netProfit ?? 0);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

async function _balanceSheet(wb, d, meta) {
  const sh = wb.addWorksheet('Balance Sheet');
  let row  = addDocHeader(sh, meta.businessName || 'Business', 'Balance Sheet', `As of ${fmtDate(meta.asOfDate)}`, 2) + 1;
  row = addColHeaders(sh, row, ['Account', 'Balance'], [50, 20]);

  row = addSectionHeader(sh, row, 'ASSETS', 2) + 1;
  const assetGroups = d.assets?.groups || [];
  if (assetGroups.length) {
    for (const g of assetGroups) {
      row = addSectionHeader(sh, row, `  ${g.label}`, 2) + 1;
      row = addLineItems(sh, row, g.accounts, 'accountName', 'balance', 2);
      row = addSubtotal(sh, row, `Total ${g.label}`, g.total);
    }
  } else {
    row = addLineItems(sh, row, d.assets?.accounts || [], 'accountName', 'balance');
  }
  row = addTotal(sh, row, 'TOTAL ASSETS', d.totalAssets || 0);

  row = addSectionHeader(sh, row, 'LIABILITIES', 2) + 1;
  const liabGroups = d.liabilities?.groups || [];
  if (liabGroups.length) {
    for (const g of liabGroups) {
      row = addSectionHeader(sh, row, `  ${g.label}`, 2) + 1;
      row = addLineItems(sh, row, g.accounts, 'accountName', 'balance', 2);
      row = addSubtotal(sh, row, `Total ${g.label}`, g.total);
    }
  } else {
    row = addLineItems(sh, row, d.liabilities?.accounts || [], 'accountName', 'balance');
  }
  row = addSubtotal(sh, row, 'Total Liabilities', d.totalLiabilities || 0);
  row = addSpacer(sh, row);

  row = addSectionHeader(sh, row, 'EQUITY', 2) + 1;
  row = addLineItems(sh, row, d.equity?.accounts || [], 'accountName', 'balance');
  row = addSubtotal(sh, row, 'Total Equity', d.totalEquity || 0);
  row = addSpacer(sh, row);

  row = addTotal(sh, row, 'TOTAL LIABILITIES & EQUITY', d.totalLiabilitiesAndEquity || (d.totalLiabilities + d.totalEquity) || 0);

  // Equation check
  const eqRow = sh.getRow(row);
  sh.mergeCells(row, 1, row, 2);
  eqRow.height = 18;
  const eqCell = eqRow.getCell(1);
  eqCell.value     = d.equationValid ? '✓ Accounting Equation Satisfied' : '✗ Accounting Equation IMBALANCE';
  eqCell.font      = { bold: true, size: 10, color: { argb: d.equationValid ? 'FF276749' : 'FFC53030' } };
  eqCell.fill      = d.equationValid ? STYLES.successFill : STYLES.dangerFill;
  eqCell.alignment = { horizontal: 'center' };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

async function _cashFlow(wb, d, meta) {
  const sh = wb.addWorksheet('Cash Flow Statement');
  let row  = addDocHeader(sh, meta.businessName || 'Business', 'Cash Flow Statement', `For the period: ${meta.startDate} to ${meta.endDate}`, 2) + 1;
  row = addColHeaders(sh, row, ['Activity / Description', 'Amount'], [50, 20]);

  const drawSection = (title, section) => {
    row = addSectionHeader(sh, row, title, 2) + 1;
    const items = section?.items || (Array.isArray(section) ? section : []);
    row = addLineItems(sh, row, items, 'description', 'amount');
    const total = section?.total ?? items.reduce((s, i) => s + (i.amount || 0), 0);
    row = addSubtotal(sh, row, `Net Cash from ${title}`, total);
    row = addSpacer(sh, row);
  };

  drawSection('Operating Activities', d.operating);
  drawSection('Investing Activities', d.investing);
  drawSection('Financing Activities', d.financing);

  addTotal(sh, row, 'NET INCREASE (DECREASE) IN CASH', d.netCashFlow || 0);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

async function _trialBalance(wb, d, meta) {
  const hasOpening = d.rows?.some(r => r.openingDebit > 0 || r.openingCredit > 0);
  const headers = hasOpening
    ? ['Code', 'Account Name', 'Account Type', 'Opening Debit', 'Opening Credit', 'Period Debit', 'Period Credit', 'Closing Debit', 'Closing Credit']
    : ['Code', 'Account Name', 'Account Type', 'Debit', 'Credit'];
  const widths  = hasOpening
    ? [10, 35, 18, 16, 16, 16, 16, 16, 16]
    : [10, 45, 18, 20, 20];

  const sh = wb.addWorksheet('Trial Balance');
  let row  = addDocHeader(sh, meta.businessName || 'Business', 'Trial Balance', `As of ${fmtDate(meta.asOfDate)}`, headers.length) + 1;
  row = addColHeaders(sh, row, headers, widths);

  (d.rows || []).forEach((r, idx) => {
    const exRow = sh.getRow(row);
    exRow.height = 16;
    const vals = hasOpening
      ? [r.accountCode || '', r.accountName, r.accountType, r.openingDebit || 0, r.openingCredit || 0,
         r.periodDebit || 0, r.periodCredit || 0, r.closingDebit || r.debit || 0, r.closingCredit || r.credit || 0]
      : [r.accountCode || '', r.accountName, r.accountType, r.debit || 0, r.credit || 0];
    vals.forEach((v, i) => {
      const cell     = exRow.getCell(i + 1);
      cell.value     = v;
      cell.font      = STYLES.bodyFont;
      cell.fill      = idx % 2 === 0 ? STYLES.evenFill : STYLES.white;
      cell.alignment = { horizontal: i < 3 ? 'left' : 'right' };
      if (typeof v === 'number') cell.numFmt = STYLES.currency;
    });
    applyBorders(exRow);
    row++;
  });

  // Totals
  const totRow = sh.getRow(row);
  totRow.height = 20;
  const totVals = hasOpening
    ? ['', 'TOTAL', '', d.totals?.opening?.debit || 0, d.totals?.opening?.credit || 0,
       d.totals?.period?.debit || 0, d.totals?.period?.credit || 0, d.totalDebits || 0, d.totalCredits || 0]
    : ['', 'TOTAL', '', d.totalDebits || 0, d.totalCredits || 0];
  totVals.forEach((v, i) => {
    const cell     = totRow.getCell(i + 1);
    cell.value     = v;
    cell.font      = STYLES.totalFont;
    cell.fill      = STYLES.totalFill;
    cell.alignment = { horizontal: i < 3 ? 'left' : 'right' };
    if (typeof v === 'number') cell.numFmt = STYLES.currency;
  });
  applyBorders(totRow);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

async function _generalLedger(wb, d, meta) {
  for (const account of d.accounts || []) {
    const shName = `${account.accountCode || account.accountId.toString().slice(-4)} ${account.accountName}`.substring(0, 31);
    const sh     = wb.addWorksheet(shName);
    let row      = addDocHeader(sh, meta.businessName || 'Business', `General Ledger — ${account.accountName}`,
      `For the period: ${meta.startDate} to ${meta.endDate}`, 5) + 1;

    // Opening balance
    const obRow = sh.getRow(row);
    sh.mergeCells(row, 1, row, 4);
    obRow.getCell(1).value     = `Opening Balance: ${account.accountName}`;
    obRow.getCell(1).font      = STYLES.sectionFont;
    obRow.getCell(1).fill      = STYLES.sectionFill;
    obRow.getCell(5).value     = account.openingBalance || 0;
    obRow.getCell(5).numFmt    = STYLES.currency;
    obRow.getCell(5).font      = STYLES.subtotalFont;
    obRow.getCell(5).fill      = STYLES.sectionFill;
    obRow.getCell(5).alignment = { horizontal: 'right' };
    applyBorders(obRow);
    row += 2;

    row = addColHeaders(sh, row, ['Date', 'Description', 'Debit', 'Credit', 'Balance'], [14, 40, 18, 18, 18]);

    (account.entries || []).forEach((e, idx) => {
      const er = sh.getRow(row);
      er.height = 15;
      const vals = [
        new Date(e.date).toLocaleDateString('en-US'),
        e.description || '',
        e.debit  > 0 ? e.debit  : null,
        e.credit > 0 ? e.credit : null,
        e.runningBalance,
      ];
      vals.forEach((v, i) => {
        const cell     = er.getCell(i + 1);
        cell.value     = v;
        cell.font      = STYLES.bodyFont;
        cell.fill      = idx % 2 === 0 ? STYLES.evenFill : STYLES.white;
        cell.alignment = { horizontal: i < 2 ? 'left' : 'right' };
        if (typeof v === 'number' && v !== null) cell.numFmt = STYLES.currency;
      });
      applyBorders(er);
      row++;
    });

    // Closing balance
    const cbRow = sh.getRow(row + 1);
    sh.mergeCells(row + 1, 1, row + 1, 4);
    cbRow.getCell(1).value     = 'Closing Balance';
    cbRow.getCell(1).font      = STYLES.totalFont;
    cbRow.getCell(1).fill      = STYLES.totalFill;
    cbRow.getCell(5).value     = account.closingBalance || 0;
    cbRow.getCell(5).numFmt    = STYLES.currency;
    cbRow.getCell(5).font      = STYLES.totalFont;
    cbRow.getCell(5).fill      = STYLES.totalFill;
    cbRow.getCell(5).alignment = { horizontal: 'right' };
    applyBorders(cbRow);
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

async function _agingReport(wb, d, meta) {
  const sh    = wb.addWorksheet(`${d.type === 'receivable' ? 'AR' : 'AP'} Aging`);
  const title = d.type === 'receivable' ? 'Accounts Receivable Aging' : 'Accounts Payable Aging';
  let row     = addDocHeader(sh, meta.businessName || 'Business', title, `As of ${new Date().toLocaleDateString()}`, 6) + 1;

  // Summary
  row = addColHeaders(sh, row, ['Bucket', 'Amount', '', '', '', ''], [30, 20, 1, 1, 1, 1]);
  const bucketOrder = ['current', 'days_1_30', 'days_31_60', 'days_61_90', 'days_over_90'];
  bucketOrder.forEach((key, idx) => {
    const b = d.buckets?.[key];
    if (!b) return;
    const r    = sh.getRow(row);
    r.height   = 16;
    r.getCell(1).value     = b.label;
    r.getCell(2).value     = b.total;
    r.getCell(2).numFmt    = STYLES.currency;
    r.getCell(1).fill = r.getCell(2).fill = idx % 2 === 0 ? STYLES.evenFill : STYLES.white;
    r.getCell(1).font = r.getCell(2).font = STYLES.bodyFont;
    r.getCell(2).alignment = { horizontal: 'right' };
    applyBorders(r);
    row++;
  });
  row = addTotal(sh, row, 'TOTAL', d.grandTotal || 0, 2);
  row++;

  // Detail sheets per bucket
  for (const key of bucketOrder) {
    const b = d.buckets?.[key];
    if (!b || b.items.length === 0) continue;

    const dsh = wb.addWorksheet(b.label.substring(0, 31));
    let dr    = addDocHeader(dsh, meta.businessName || 'Business', `${title} — ${b.label}`, `As of ${new Date().toLocaleDateString()}`, 6) + 1;
    dr = addColHeaders(dsh, dr, ['Party', 'Invoice #', 'Date', 'Due Date', 'Original Amt', 'Balance Due'], [25, 18, 14, 14, 18, 18]);

    b.items.forEach((item, idx) => {
      const ir = dsh.getRow(dr);
      ir.height = 15;
      const isOverdue = item.isOverdue;
      const fill = isOverdue ? (item.severity === 'critical' ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF5F5' } } : STYLES.evenFill) : STYLES.white;
      const vals = [
        item.party || '',
        item.invoiceNumber || '',
        item.date ? new Date(item.date).toLocaleDateString() : '',
        item.dueDate ? new Date(item.dueDate).toLocaleDateString() : '',
        item.originalAmount || 0,
        item.remainingBalance || 0,
      ];
      vals.forEach((v, i) => {
        const cell    = ir.getCell(i + 1);
        cell.value    = v;
        cell.fill     = fill;
        cell.font     = typeof v === 'number' && isOverdue ? { ...STYLES.bodyFont, color: { argb: 'FFC53030' } } : STYLES.bodyFont;
        cell.alignment = { horizontal: i > 3 ? 'right' : 'left' };
        if (typeof v === 'number') cell.numFmt = STYLES.currency;
      });
      applyBorders(ir);
      dr++;
    });
    addSubtotal(dsh, dr + 1, `Total ${b.label}`, b.total, 6);
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

async function _equityStatement(wb, d, meta) {
  const components = d.components || [];
  const rows       = d.rows       || [];

  // Column headers: blank label column + one per component + Total
  const headers  = ['', ...components.map(c => c.label || c.key || ''), 'Total'];
  const colCount = headers.length;
  // Widths: label 35, each component 18, total 18
  const widths   = [35, ...components.map(() => 18), 18];

  const sh = wb.addWorksheet('Equity Statement');
  let row  = addDocHeader(
    sh,
    meta.businessName || 'Business',
    'Statement of Changes in Equity',
    `For the period: ${meta.startDate} to ${meta.endDate}`,
    colCount
  ) + 1;

  row = addColHeaders(sh, row, headers, widths);

  rows.forEach((r, idx) => {
    const exRow = sh.getRow(row);
    exRow.height = 17;
    const isBold = r.key === 'opening' || r.key === 'closing';

    // Label cell
    const labelCell     = exRow.getCell(1);
    labelCell.value     = r.label || r.key || '';
    labelCell.font      = isBold ? STYLES.subtotalFont : STYLES.bodyFont;
    labelCell.fill      = isBold ? STYLES.subtotalFill : (idx % 2 === 0 ? STYLES.evenFill : STYLES.white);
    labelCell.alignment = { horizontal: 'left', indent: 1 };

    // Component value cells
    components.forEach((c, i) => {
      const cell      = exRow.getCell(i + 2);
      const val       = (r.values || {})[c.key] || 0;
      cell.value      = val;
      cell.numFmt     = STYLES.currency;
      cell.font       = isBold ? STYLES.subtotalFont : STYLES.bodyFont;
      cell.fill       = labelCell.fill;
      cell.alignment  = { horizontal: 'right' };
    });

    // Total cell
    const totalCell      = exRow.getCell(colCount);
    totalCell.value      = typeof r.total === 'number' ? r.total : 0;
    totalCell.numFmt     = STYLES.currency;
    totalCell.font       = isBold ? STYLES.subtotalFont : STYLES.bodyFont;
    totalCell.fill       = labelCell.fill;
    totalCell.alignment  = { horizontal: 'right' };

    applyBorders(exRow);
    row++;
  });

  // Reconciliation footer
  const rec      = d.reconciliation || {};
  const recRow   = sh.getRow(row + 1);
  sh.mergeCells(row + 1, 1, row + 1, colCount);
  recRow.height  = 18;
  const recCell  = recRow.getCell(1);
  recCell.value  = rec.reconciles
    ? '✓ Equity reconciles — closing balance matches balance sheet equity'
    : '✗ Equity does not reconcile — review journal entries';
  recCell.font   = { bold: true, size: 10, color: { argb: rec.reconciles ? 'FF276749' : 'FFC53030' } };
  recCell.fill   = rec.reconciles ? STYLES.successFill : STYLES.dangerFill;
  recCell.alignment = { horizontal: 'center' };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

module.exports = { generateExcelReport };
