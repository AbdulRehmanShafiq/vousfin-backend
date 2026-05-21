// utils/excelParser.utils.js
const ExcelJS = require('exceljs');
const config = require('../config');
const { TRANSACTION_TYPES } = require('../config/constants');
const logger = require('../config/logger');

/**
 * Expected column headers (case‑insensitive).
 * Users can map columns during import; this utility expects a mapping object.
 * For simplicity, we'll define default expected names.
 */
const DEFAULT_COLUMN_MAPPING = {
  date: ['Date', 'Transaction Date', 'Date'],
  description: ['Description', 'Narration', 'Details'],
  amount: ['Amount', 'Value', 'Total'],
  transactionType: ['Type', 'Transaction Type'],
  debitAccount: ['Debit Account', 'Debit Account Name'],
  creditAccount: ['Credit Account', 'Credit Account Name'],
};

/**
 * Normalize column name: lowercase, trim, remove spaces.
 */
const normalizeColumnName = (name) => {
  if (!name) return '';
  return name.toString().toLowerCase().trim().replace(/\s+/g, '');
};

/**
 * Get the actual column index based on mapping.
 * @param {Object} headerRow - Row object from ExcelJS
 * @param {Object} columnMapping - User provided mapping or default
 * @returns {Object} - { dateCol, descCol, amountCol, typeCol, debitCol, creditCol }
 */
const getColumnIndices = (headerRow, columnMapping) => {
  const indices = {};
  const mapping = columnMapping || DEFAULT_COLUMN_MAPPING;

  // Find index of each required column
  for (const [field, possibleNames] of Object.entries(mapping)) {
    let foundIndex = -1;
    headerRow.eachCell((cell, colNumber) => {
      const cellValue = cell.value ? cell.value.toString().trim() : '';
      if (possibleNames.some(name => name.toLowerCase() === cellValue.toLowerCase())) {
        foundIndex = colNumber;
      }
    });
    indices[`${field}Col`] = foundIndex;
  }
  return indices;
};

/**
 * Parse a cell date value (supports Excel serial number and string dates).
 * @param {*} cellValue - Cell value from ExcelJS
 * @returns {Date|null}
 */
const parseDate = (cellValue) => {
  if (!cellValue) return null;
  if (cellValue instanceof Date) return cellValue;
  if (typeof cellValue === 'number') {
    // Excel serial number: days since 1900-01-01
    const utcDays = cellValue - 25569; // Excel epoch offset
    return new Date(utcDays * 86400 * 1000);
  }
  // Try string parsing
  const parsed = new Date(cellValue);
  if (!isNaN(parsed.getTime())) return parsed;
  return null;
};

/**
 * Validate a single transaction row.
 * @param {Object} rowData - { date, description, amount, transactionType, debitAccount, creditAccount, rowNumber }
 * @returns {Object} - { isValid, errors: [] }
 */
const validateTransactionRow = (rowData) => {
  const errors = [];
  const { date, description, amount, transactionType, debitAccount, creditAccount, rowNumber } = rowData;

  // Date validation
  const parsedDate = parseDate(date);
  if (!parsedDate) {
    errors.push({ row: rowNumber, field: 'date', message: 'Invalid date format' });
  }

  // Description validation
  if (!description || description.trim() === '') {
    errors.push({ row: rowNumber, field: 'description', message: 'Description is required' });
  } else if (description.length > 500) {
    errors.push({ row: rowNumber, field: 'description', message: 'Description exceeds 500 characters' });
  }

  // Amount validation
  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    errors.push({ row: rowNumber, field: 'amount', message: 'Amount must be a positive number' });
  }

  // Transaction type validation
  const validTypes = Object.values(TRANSACTION_TYPES);
  if (!transactionType || !validTypes.includes(transactionType.trim())) {
    errors.push({ row: rowNumber, field: 'transactionType', message: `Type must be one of: ${validTypes.join(', ')}` });
  }

  // Account validation (basic presence – actual account IDs will be resolved later)
  if (!debitAccount || debitAccount.trim() === '') {
    errors.push({ row: rowNumber, field: 'debitAccount', message: 'Debit account name is required' });
  }
  if (!creditAccount || creditAccount.trim() === '') {
    errors.push({ row: rowNumber, field: 'creditAccount', message: 'Credit account name is required' });
  }
  if (debitAccount && creditAccount && debitAccount.trim() === creditAccount.trim()) {
    errors.push({ row: rowNumber, field: 'general', message: 'Debit and credit accounts must be different' });
  }

  return {
    isValid: errors.length === 0,
    errors,
    parsedData: {
      transactionDate: parsedDate,
      description: description ? description.trim() : '',
      amount: numAmount,
      transactionType: transactionType ? transactionType.trim() : '',
      debitAccountName: debitAccount ? debitAccount.trim() : '',
      creditAccountName: creditAccount ? creditAccount.trim() : '',
    },
  };
};

/**
 * Main function to parse Excel file from buffer.
 * @param {Buffer} buffer - File buffer from multer
 * @param {string} businessId - Business ID (for later account resolution, not used in validation but passed through)
 * @param {Object} columnMapping - Optional user-provided mapping
 * @returns {Promise<{validRows: Array, errors: Array}>}
 */
const parseExcelTransactions = async (buffer, businessId, columnMapping = null) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error('No worksheet found in the Excel file');
  }

  const rows = [];
  const errors = [];
  let headerRowIndex = -1;
  let dataStartRow = -1;

  // Find header row (first row that contains expected columns)
  worksheet.eachRow((row, rowNumber) => {
    if (headerRowIndex === -1) {
      let hasDate = false;
      row.eachCell(cell => {
        const val = cell.value ? cell.value.toString().toLowerCase() : '';
        if (val.includes('date')) hasDate = true;
      });
      if (hasDate) {
        headerRowIndex = rowNumber;
        dataStartRow = rowNumber + 1;
      }
    }
  });

  if (headerRowIndex === -1) {
    throw new Error('Could not locate header row with required columns');
  }

  const headerRow = worksheet.getRow(headerRowIndex);
  const colIndices = getColumnIndices(headerRow, columnMapping);

  // Check that all required columns were found
  const required = [
    'dateCol',
    'descriptionCol',
    'amountCol',
    'transactionTypeCol',
    'debitAccountCol',
    'creditAccountCol',
  ];
  const missing = required.filter((col) => colIndices[col] === -1);
  if (missing.length) {
    throw new Error(`Missing required columns: ${missing.map((m) => m.replace('Col', '')).join(', ')}`);
  }

  let rowCount = 0;
  for (let i = dataStartRow; i <= worksheet.rowCount; i++) {
    if (rowCount >= config.MAX_EXCEL_ROWS) {
      errors.push({ row: i, field: 'general', message: `Row limit exceeded (max ${config.MAX_EXCEL_ROWS})` });
      break;
    }
    const row = worksheet.getRow(i);
    const dateCell = row.getCell(colIndices.dateCol);
    const descCell = row.getCell(colIndices.descriptionCol);
    const amountCell = row.getCell(colIndices.amountCol);
    const typeCell = row.getCell(colIndices.transactionTypeCol);
    const debitCell = row.getCell(colIndices.debitAccountCol);
    const creditCell = row.getCell(colIndices.creditAccountCol);

    // Skip empty rows
    if (!dateCell.value && !descCell.value && !amountCell.value) continue;

    const rowData = {
      date: dateCell.value,
      description: descCell.value,
      amount: amountCell.value,
      transactionType: typeCell.value,
      debitAccount: debitCell.value,
      creditAccount: creditCell.value,
      rowNumber: i,
    };

    const validation = validateTransactionRow(rowData);
    if (validation.isValid) {
      rows.push({
        businessId,
        ...validation.parsedData,
        originalRow: i,
      });
    } else {
      errors.push(...validation.errors);
    }
    rowCount++;
  }

  return { validRows: rows, errors };
};

module.exports = {
  parseExcelTransactions,
};