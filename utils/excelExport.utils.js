const ExcelJS = require('exceljs');

const addLineItems = (sheet, title, items, nameKey = 'name', amountKey = 'amount') => {
  sheet.addRow([title]);
  sheet.getRow(sheet.rowCount).font = { bold: true };
  const rows = items || [];
  if (rows.length === 0) {
    sheet.addRow(['(none)', 0]);
    return 0;
  }
  let total = 0;
  rows.forEach((item) => {
    const name = item[nameKey] || item.accountName || 'Item';
    const amount = item[amountKey] ?? item.runningBalance ?? 0;
    sheet.addRow([name, amount]);
    total += amount;
  });
  sheet.addRow([`Total ${title}`, total]).font = { bold: true };
  sheet.addRow([]);
  return total;
};

/**
 * Generate an Excel workbook buffer for financial reports.
 * @param {'incomeStatement'|'balanceSheet'|'cashFlow'} reportType
 * @param {Object} reportData
 * @param {Object} meta
 * @returns {Promise<Buffer>}
 */
const generateExcelReport = async (reportType, reportData, meta = {}) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Report');
  sheet.columns = [
    { header: 'Description', key: 'description', width: 40 },
    { header: 'Amount', key: 'amount', width: 18 },
  ];

  if (reportType === 'incomeStatement') {
    sheet.addRow(['Income Statement', meta.startDate && meta.endDate ? `${meta.startDate} to ${meta.endDate}` : '']);
    sheet.addRow([]);
    addLineItems(sheet, 'Revenue', reportData.revenue);
    addLineItems(sheet, 'Expenses', reportData.expenses);
    sheet.addRow(['Net Profit', reportData.netProfit ?? 0]).font = { bold: true };
  } else if (reportType === 'balanceSheet') {
    sheet.addRow(['Balance Sheet', meta.asOfDate ? `As of ${meta.asOfDate}` : '']);
    sheet.addRow([]);
    addLineItems(sheet, 'Assets', reportData.assets, 'accountName', 'runningBalance');
    addLineItems(sheet, 'Liabilities', reportData.liabilities, 'accountName', 'runningBalance');
    addLineItems(sheet, 'Equity', reportData.equity, 'accountName', 'runningBalance');
    sheet.addRow(['Total Assets', reportData.totalAssets ?? 0]).font = { bold: true };
    sheet.addRow(['Total Liabilities + Equity', (reportData.totalLiabilities ?? 0) + (reportData.totalEquity ?? 0)]).font = { bold: true };
  } else if (reportType === 'cashFlow') {
    sheet.addRow(['Cash Flow Statement', meta.startDate && meta.endDate ? `${meta.startDate} to ${meta.endDate}` : '']);
    sheet.addRow([]);
    addLineItems(sheet, 'Operating', reportData.operating);
    addLineItems(sheet, 'Investing', reportData.investing);
    addLineItems(sheet, 'Financing', reportData.financing);
    sheet.addRow(['Net Cash Flow', reportData.netCashFlow ?? 0]).font = { bold: true };
  } else {
    throw new Error(`Unsupported report type: ${reportType}`);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
};

module.exports = {
  generateExcelReport,
};
