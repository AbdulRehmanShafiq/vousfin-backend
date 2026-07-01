// controllers/transaction.controller.js
const transactionService = require('../services/transaction.service');
const installmentService = require('../services/installment.service');
const parserService = require('../services/nlParser/services/parserService');
const accountRepository = require('../repositories/account.repository');
const businessRepository = require('../repositories/business.repository');
const { mapParserToPreview } = require('../utils/nlParserPreview.helper');
const { matchAccountByName } = require('../utils/accountMatcher');
const { AUTO_POST_THRESHOLD } = require('../services/nlParser/utils/confidenceCalculator');
const { TRANSACTION_SOURCES } = require('../config/constants');
const ApiResponse = require('../utils/ApiResponse');
const { ApiError } = require('../utils/ApiError');
const { parseExcelTransactions } = require('../utils/excelParser.utils');
const aiDecisionService = require('../services/aiDecision.service');
const logger = require('../config/logger');

/**
 * Eligible for zero-click auto-post only when ALL of:
 *  - the business has explicitly opted in (default false)
 *  - overall confidence clears the auto-post bar
 *  - BOTH legs resolved to an EXACT account-name match (never on a fuzzy guess,
 *    regardless of how high the overall score is)
 * The amount-threshold approval gate in approvalService is a SEPARATE, still-
 * enforced check — this only decides whether to attempt immediate posting.
 */
function isAutoPostEligible(confidence, accountResolution, autoPostEnabled) {
  if (!autoPostEnabled) return false;
  if (!confidence || confidence.overall < AUTO_POST_THRESHOLD) return false;
  if (accountResolution?.debit?.matchType !== 'exact') return false;
  if (accountResolution?.credit?.matchType !== 'exact') return false;
  return true;
}

const resolveAccountIds = async (businessId, row) => {
  let debitAccountId = row.debitAccountId;
  let creditAccountId = row.creditAccountId;
  const debitName = row.debitAccountName || row.debitAccount;
  const creditName = row.creditAccountName || row.creditAccount;
  if (!debitAccountId && debitName) {
    const debit = await accountRepository.findByBusinessAndName(businessId, debitName);
    if (!debit) throw new ApiError(400, `Debit account not found: "${debitName}". Please check your Chart of Accounts.`);
    debitAccountId = debit._id;
  }
  if (!creditAccountId && creditName) {
    const credit = await accountRepository.findByBusinessAndName(businessId, creditName);
    if (!credit) throw new ApiError(400, `Credit account not found: "${creditName}". Please check your Chart of Accounts.`);
    creditAccountId = credit._id;
  }
  return { debitAccountId, creditAccountId };
};

/**
 * Build an in-memory account resolver from a pre-loaded accounts array, so
 * bulk imports need only ONE database query instead of N×2-3. Delegates to the
 * shared matchAccountByName so every account-name resolution path in the app
 * (Excel, NL, manual) uses the identical, tested, confidence-scored algorithm —
 * critical for the auto-post gate, which trusts a SEPARATE matchAccountByName
 * call (in parserService) to judge "exact match"; if this resolver disagreed
 * with that judgement, the gate would be meaningless.
 */
const buildAccountResolver = (accounts) => (name) => matchAccountByName(accounts, name).account;

/**
 * Create a transaction from structured form.
 *
 * #6 — routed through the approval gate. When the business has approvals enabled
 * and the amount exceeds the threshold, the transaction is parked in the review
 * queue (nothing posts) instead of hitting the ledger. Otherwise it posts
 * immediately — identical to the legacy behaviour (approvals are off by default).
 */
const createFormTransaction = async (req, res, next) => {
  try {
    const approvalService = require('../services/approval.service');
    const transactionData = {
      ...req.body,
      businessId: req.user.businessId,
      inputMethod: 'form',
      doubleSubmitGuard: true, // reject exact duplicates posted within 10s (double-click protection)
    };
    const result = await approvalService.submitOrPost(
      transactionData,
      req.user,
      req.ip,
      { source: 'form' }
    );
    if (result.pendingApproval) {
      return ApiResponse.created(
        res,
        result.pendingTransaction,
        `Submitted for approval — amount exceeds the ${result.threshold} approval limit`
      );
    }
    ApiResponse.created(res, result.transaction, 'Transaction recorded successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Record a partial or full payment against a parent transaction.
 * POST /api/v1/transactions/payment
 */
const recordPayment = async (req, res, next) => {
  try {
    const { parentTransactionId, ...paymentData } = req.body;
    if (!parentTransactionId) throw new ApiError(400, 'parentTransactionId is required');

    // AR/AP M2 — delegate to the first-class Payment service. This records a
    // Payment (single allocation) and returns the underlying child settlement
    // transaction, preserving the legacy response contract byte-for-byte.
    const paymentService = require('../services/payment.service');
    const paymentTx = await paymentService.recordLegacyPayment(
      parentTransactionId,
      req.user.businessId,
      paymentData,
      req.user.id,
      req.ip
    );
    ApiResponse.created(res, paymentTx, 'Payment recorded successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Get outstanding balances (Receivables or Payables).
 * GET /api/v1/transactions/outstanding
 */
const getOutstandingBalances = async (req, res, next) => {
  try {
    const { type, withAging } = req.query; // 'receivable' or 'payable'
    if (!type) throw new ApiError(400, 'type query parameter is required (receivable or payable)');

    const rows = await transactionService.getOutstandingBalances(req.user.businessId, type);

    /* Backward-compat: without withAging the response stays a plain array.
       With ?withAging=true we wrap it as { rows, aging, totals }. */
    if (withAging === 'true' || withAging === '1') {
      const aging = transactionService.computeAgingBuckets(rows);
      return ApiResponse.success(res, { rows, aging }, 'Outstanding balances retrieved');
    }
    ApiResponse.success(res, rows, 'Outstanding balances retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Get settlement history for a parent transaction.
 * GET /api/v1/transactions/:id/settlements
 */
const getSettlementHistory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const history = await transactionService.getSettlementHistory(id, req.user.businessId);
    ApiResponse.success(res, history, 'Settlement history retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Create an installment transaction (creates entry + plan).
 * POST /api/v1/transactions/installment
 */
const createInstallmentTransaction = async (req, res, next) => {
  try {
    const {
      transactionDate, description, amount, debitAccountId, creditAccountId,
      customerId, vendorId,
      downPayment, installmentCount, installmentFrequency, interestRate,
      firstPaymentDate, interestMethod,
      // Optional extras passed from the form
      transactionType, invoiceNumber, customerName, vendorName,
      notes, paymentMethod, dueDate,
    } = req.body;

    const transactionData = {
      businessId: req.user.businessId,
      transactionDate,
      description,
      amount,
      debitAccountId,
      creditAccountId,
      inputMethod: 'form',
      // Pass optional party refs / metadata so they are persisted on the journal entry
      ...(customerId      ? { customerId }      : {}),
      ...(vendorId        ? { vendorId }        : {}),
      ...(transactionType ? { transactionType } : {}),
      ...(invoiceNumber?.trim() ? { invoiceNumber: invoiceNumber.trim() } : {}),
      ...(customerName?.trim()  ? { customerName:  customerName.trim()  } : {}),
      ...(vendorName?.trim()    ? { vendorName:    vendorName.trim()    } : {}),
      ...(notes?.trim()         ? { notes:         notes.trim()         } : {}),
      ...(paymentMethod         ? { paymentMethod }                       : {}),
      ...(dueDate               ? { dueDate }                             : {}),
    };

    const installmentConfig = {
      downPayment:          downPayment || 0,
      installmentCount,
      installmentFrequency,
      interestRate:         Number(interestRate || 0),
      interestMethod:       interestMethod || 'reducing_balance',
      firstPaymentDate:     firstPaymentDate || null,
    };

    const result = await installmentService.createInstallmentPlan(
      transactionData,
      installmentConfig,
      req.user.id,
      req.ip
    );

    ApiResponse.created(res, result, 'Installment transaction created successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Record a payment against an installment plan.
 * POST /api/v1/transactions/installment/:planId/pay
 */
const recordInstallmentPayment = async (req, res, next) => {
  try {
    const { planId } = req.params;
    const paymentData = req.body;
    
    const result = await installmentService.recordInstallmentPayment(
      planId,
      req.user.businessId,
      paymentData,
      req.user.id,
      req.ip
    );

    ApiResponse.success(res, result, 'Installment payment recorded successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Process natural language input and return a preview.
 */
const processNaturalLanguage = async (req, res, next) => {
  try {
    const { text, attempt } = req.body;
    if (!text || text.trim().length < 5) {
      throw new ApiError(400, 'Please provide a longer transaction description');
    }

    // Phase 3: Load live business accounts so Gemini uses real CoA names.
    // Non-fatal — parsing still proceeds with empty accounts on failure.
    let businessAccounts = [];
    try {
      // Defensive `|| []`: never let a nullish repo result crash the parser path.
      businessAccounts = (await accountRepository.findByBusiness(req.user.businessId)) || [];
    } catch (acctErr) {
      logger.warn('NL parse: could not load business accounts (non-fatal):', acctErr.message);
    }

    const parsed = await parserService.parseTransaction(text, businessAccounts, {
      attempt: Number(attempt) || 0,
    });
    const preview = mapParserToPreview(parsed, text);

    if (req.user.businessId && (preview.debitAccount || preview.creditAccount)) {
      // Build an in-memory resolver from the accounts we already loaded (no extra DB round-trips).
      const resolve = businessAccounts.length ? buildAccountResolver(businessAccounts) : null;

      // Gracefully resolve primary accounts — fuzzy match, don't throw if not found
      try {
        if (preview.debitAccount) {
          const debit = resolve
            ? resolve(preview.debitAccount)
            : await accountRepository.findByBusinessAndName(req.user.businessId, preview.debitAccount);
          preview.debitAccountId = debit?._id || null;
          if (debit) preview.debitAccount = debit.accountName; // normalize to canonical name
        }
        if (preview.creditAccount) {
          const credit = resolve
            ? resolve(preview.creditAccount)
            : await accountRepository.findByBusinessAndName(req.user.businessId, preview.creditAccount);
          preview.creditAccountId = credit?._id || null;
          if (credit) preview.creditAccount = credit.accountName;
        }
      } catch (resolveErr) {
        logger.warn('NL account resolution partial failure (non-fatal):', resolveErr.message);
        // Continue — user will pick accounts manually in preview step
      }

      // ── Phase 4: Resolve multi-line journal entries (names → IDs) ────────────
      // journalEntries are already in the preview (from mapParserToPreview).
      // Resolve each line's account name to a MongoDB ID so the confirm step can
      // forward the full journal line set without another round-trip.
      if (Array.isArray(preview.journalEntries) && preview.journalEntries.length > 0) {
        const resolvedLines = [];
        for (const entry of preview.journalEntries) {
          try {
            const acc = resolve
              ? resolve(entry.account)
              : await accountRepository.findByBusinessAndName(req.user.businessId, entry.account);
            resolvedLines.push({
              accountId:   acc?._id    || null,
              accountName: acc?.accountName || entry.account,
              type:        entry.entryType,   // 'debit' | 'credit'
              amount:      entry.amount,
              resolved:    !!acc,
            });
          } catch (_) {
            resolvedLines.push({
              accountId:   null,
              accountName: entry.account,
              type:        entry.entryType,
              amount:      entry.amount,
              resolved:    false,
            });
          }
        }
        preview.resolvedJournalLines = resolvedLines;
      }
    }

    // ── AI Decision Ledger (Phase 0): record the parse lineage ──────────────
    const aiDecision = await aiDecisionService.record(req.user.businessId, 'parse', {
      inputsSummary: text.slice(0, 2000),
      candidates: [preview.debitAccount, preview.creditAccount].filter(Boolean),
      decision: {
        transactionType: preview.transactionType,
        debitAccount: preview.debitAccount, creditAccount: preview.creditAccount,
        amount: preview.amount,
      },
      confidence: parsed.confidence?.overall ?? null,
      model: 'gemini-nl-parser',
      promptVersion: 'nl-v1',
    });
    if (aiDecision?._id) preview.aiDecisionId = String(aiDecision._id);

    // ── Opt-in zero-click auto-post (Phase 3) ──────────────────────────────────
    // Installments have their own multi-step config (down payment, frequency,
    // interest) — out of scope for auto-post; always fall through to preview.
    if (
      preview.debitAccountId && preview.creditAccountId &&
      !parsed.parsedData?.isInstallment
    ) {
      try {
        const business = await businessRepository.findById(req.user.businessId);
        if (isAutoPostEligible(parsed.confidence, parsed.accountResolution, business?.aiSettings?.autoPostEnabled)) {
          const approvalService = require('../services/approval.service');
          const transactionData = {
            transactionDate: preview.transactionDate,
            description:     preview.description,
            transactionType: preview.transactionType,
            amount:          preview.amount,
            debitAccountId:  preview.debitAccountId,
            creditAccountId: preview.creditAccountId,
            businessId:      req.user.businessId,
            inputMethod:     'nlp',
            transactionSource: TRANSACTION_SOURCES.AI_AUTO_POSTED,
            metadata: { aiConfidence: parsed.confidence.overall, autoPosted: true },
          };
          const result = await approvalService.submitOrPost(transactionData, req.user, req.ip, { source: 'nl-autopost' });
          // The amount-threshold gate is independent of confidence — a large
          // amount still parks for approval even at 100% AI confidence, so the
          // response must not claim an auto-post happened.
          if (!result.pendingApproval) {
            await aiDecisionService.recordOutcome(preview.aiDecisionId, req.user.businessId, 'accepted', null);
            const pct = Math.round(parsed.confidence.overall * 100);
            return ApiResponse.created(
              res,
              { ...preview, autoPosted: true, transaction: result.transaction },
              `Recorded automatically by AI (${pct}% confidence)`
            );
          }
        }
      } catch (autoPostErr) {
        // Never let an auto-post attempt block the user from reviewing/confirming
        // manually — fall through to the normal preview response.
        logger.warn('NL auto-post attempt failed (non-fatal, falling back to preview):', autoPostErr.message);
      }
    }

    ApiResponse.success(res, preview, 'Preview generated. Confirm to save.');
  } catch (error) {
    next(error);
  }
};

/**
 * Confirm and save a natural language transaction (after preview).
 *
 * Phase 3: when `isInstallment: true` is present in the body (set by the NL
 * preview step), route through InstallmentService instead of plain createTransaction.
 * The installment engine now supports asset-only plans (no customerId/vendorId required).
 */
const confirmNaturalLanguage = async (req, res, next) => {
  try {
    const {
      transactionDate,
      description,
      transactionType,
      amount,
      // Installment fields forwarded from the NL preview
      isInstallment,
      installmentCount,
      installmentFrequency,
      downPayment,
      installmentPeriodMonths,
      interestRate,
    } = req.body;

    const { debitAccountId, creditAccountId } = await resolveAccountIds(req.user.businessId, req.body);
    if (!debitAccountId || !creditAccountId) {
      throw new ApiError(400, 'Debit and credit accounts are required. Resolve account names or pass account IDs.');
    }

    // ── Phase 4: Accept multi-line journal lines forwarded from the preview ──
    // The preview step resolves account names → IDs and stores them as
    // resolvedJournalLines. The frontend forwards them back here as journalLines.
    // Only include fully-resolved lines (accountId present) to avoid partial saves.
    let journalLines;
    const rawJournalLines = req.body.journalLines || req.body.resolvedJournalLines;
    if (Array.isArray(rawJournalLines) && rawJournalLines.length > 2) {
      const validLines = rawJournalLines.filter((l) => l.accountId);
      if (validLines.length >= 2) {
        journalLines = validLines.map((l) => ({
          accountId: l.accountId,
          type:      l.type,
          amount:    Number(l.amount),
          description: l.accountName || '',
        }));
      }
    }

    const transactionData = {
      transactionDate,
      description,
      transactionType,
      amount,
      debitAccountId,
      creditAccountId,
      businessId: req.user.businessId,
      inputMethod: 'nlp',
      // Include journal lines for multi-entry accounting (Phase 4).
      // When present, the service uses these for balance updates and storage.
      ...(journalLines ? { journalLines } : {}),
    };

    // ── Phase 3: Installment routing ─────────────────────────────────────────
    const effectiveCount = installmentCount || installmentPeriodMonths;
    if (isInstallment && effectiveCount) {
      const installmentConfig = {
        downPayment:          Number(downPayment   || 0),
        installmentCount:     Number(effectiveCount),
        installmentFrequency: installmentFrequency || 'monthly',
        interestRate:         Number(interestRate  || 0),
        interestMethod:       req.body.interestMethod || 'reducing_balance',
        firstPaymentDate:     req.body.firstPaymentDate || null,
      };

      const plan = await installmentService.createInstallmentPlan(
        transactionData,
        installmentConfig,
        req.user.id,
        req.ip
      );
      return ApiResponse.created(res, plan, 'Installment plan created from natural language');
    }

    // ── Standard (non-installment) transaction ────────────────────────────────
    // #6 — route through the approval gate, same as the structured form, so a
    // typed/NL entry above the limit waits for review instead of posting.
    const approvalService = require('../services/approval.service');
    const result = await approvalService.submitOrPost(
      transactionData,
      req.user,
      req.ip,
      { source: 'nl' }
    );
    if (result.pendingApproval) {
      return ApiResponse.created(
        res,
        result.pendingTransaction,
        `Submitted for approval — amount exceeds the ${result.threshold} approval limit`
      );
    }
    await aiDecisionService.recordOutcome(req.body._aiDecisionId, req.user.businessId, 'accepted', null);
    ApiResponse.created(res, result.transaction, 'Transaction recorded from natural language');
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/transactions/excel/template
 * Download a sample .xlsx import template.
 */
const downloadExcelTemplate = async (req, res, next) => {
  try {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'vousFin';

    // ── Instructions sheet ──────────────────────────────────────────────────
    const info = wb.addWorksheet('Instructions');
    info.getColumn(1).width = 20;
    info.getColumn(2).width = 60;
    const addInfo = (label, value) => {
      const row = info.addRow([label, value]);
      row.getCell(1).font = { bold: true };
    };
    info.addRow(['vousFin Bulk Import Template']);
    info.getRow(1).font = { bold: true, size: 14 };
    info.addRow([]);
    addInfo('Required columns:', 'Date, Description, Amount, Debit Account, Credit Account');
    addInfo('Optional columns:', 'Type, Customer, Vendor, Reference, Notes');
    addInfo('Date format:', 'YYYY-MM-DD or DD/MM/YYYY');
    addInfo('Amount format:', 'Positive numbers only (e.g. 25000 or 25,000.00)');
    addInfo('Debit Account:', 'Exact account name from your Chart of Accounts');
    addInfo('Credit Account:', 'Exact account name from your Chart of Accounts');
    addInfo('Type (optional):', 'Income, Expense, Credit Sale, Credit Purchase, Transfer, Owner Investment, Owner Withdrawal, Loan Disbursement, Loan Repayment, Asset Purchase');
    addInfo('Customer:', 'Required for Credit Sale / Payment Received rows');
    addInfo('Vendor:', 'Required for Credit Purchase / Payment Made rows');

    // ── Transactions sheet ───────────────────────────────────────────────────
    const ws = wb.addWorksheet('Transactions');

    const headers = ['Date', 'Description', 'Amount', 'Debit Account', 'Credit Account', 'Type', 'Customer', 'Vendor', 'Reference', 'Notes'];
    const widths  = [14,     40,             14,       28,              28,               22,     20,         20,       16,          35];
    headers.forEach((h, i) => { ws.getColumn(i + 1).width = widths[i]; });

    const headerRow = ws.addRow(headers);
    headerRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFF8FAFC' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      cell.alignment = { vertical: 'middle' };
    });
    ws.getRow(1).height = 22;

    // Example rows
    const examples = [
      ['2024-01-15', 'Monthly office rent',                  25000, 'Rent Expense',         'Cash',              'Expense',    '',         '',         'RENT-001', 'Office rent January'],
      ['2024-01-16', 'Service revenue from client',          50000, 'Cash',                  'Service Revenue',   'Income',     '',         '',         '',         ''],
      ['2024-01-17', 'Credit sale to Ahmed Khan',            35000, 'Accounts Receivable',   'Sales Revenue',     'Credit Sale','Ahmed Khan','',         'INV-002',  ''],
      ['2024-01-18', 'Salary payment',                       60000, 'Salaries Expense',      'Bank',              'Expense',    '',         '',         '',         'Staff salaries'],
      ['2024-01-19', 'Purchase inventory from supplier',     40000, 'Inventory',             'Accounts Payable',  'Credit Purchase','',    'Ali Traders','PO-005',  ''],
      ['2024-01-20', 'Loan from bank',                      200000, 'Bank',                  'Loan Payable',      'Loan Disbursement','','',            '',         'MCB Business Loan'],
      ['2024-01-21', 'Owner puts in capital',               100000, 'Cash at Bank',          'Capital / Investment','Owner Investment','','',          '',         ''],
    ];
    examples.forEach((row, idx) => {
      const r = ws.addRow(row);
      r.eachCell(cell => {
        cell.fill = {
          type: 'pattern', pattern: 'solid',
          fgColor: { argb: idx % 2 === 0 ? 'FFFAFAFA' : 'FFFFFFFF' },
        };
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="vousFin_import_template.xlsx"');
    res.setHeader('Cache-Control', 'no-cache');
    await wb.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
};

// ── Allowed MIME types and extensions for Excel/CSV uploads ─────────────────
const ALLOWED_EXCEL_MIMETYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel',                                           // .xls
  'text/csv',
  'application/csv',
  'text/plain',   // some browsers send .csv as text/plain
  'application/octet-stream', // generic binary — rely on extension
]);
const ALLOWED_EXCEL_EXTENSIONS = new Set(['xlsx', 'xls', 'csv']);

/**
 * POST /api/v1/transactions/excel
 * Parse & validate an uploaded Excel file; return a preview without saving.
 */
const uploadExcelPreview = async (req, res, next) => {
  try {
    if (!req.file) {
      throw new ApiError(400, 'Excel file is required. Attach the file as form-data field "file".');
    }

    // ── Security: validate file type ──────────────────────────────────────
    const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
    if (!ALLOWED_EXCEL_EXTENSIONS.has(ext)) {
      throw new ApiError(400, `Unsupported file extension ".${ext}". Please upload .xlsx, .xls, or .csv.`);
    }
    if (req.file.mimetype && !ALLOWED_EXCEL_MIMETYPES.has(req.file.mimetype)) {
      logger.warn(`Excel upload: unexpected MIME type "${req.file.mimetype}" for ${req.file.originalname} — proceeding`);
    }

    const businessId = req.user.businessId;
    logger.info(`Excel upload: "${req.file.originalname}" (${req.file.size} B) by business ${businessId}`);

    // ── Parse file (multi-format: xlsx / xls / csv) ───────────────────────
    const {
      validRows,
      errors,
      duplicatesFound,
      fileInfo,
      confidenceStats,
    } = await parseExcelTransactions(req.file.buffer, businessId, req.file.originalname);

    // ── Resolve account names → IDs (single DB query) ─────────────────────
    const allAccounts = await accountRepository.findByBusiness(businessId);
    const resolve = buildAccountResolver(allAccounts);

    const resolvedRows = [];
    for (const row of validRows) {
      const debit  = resolve(row.debitAccountName);
      const credit = resolve(row.creditAccountName);

      if (!debit) {
        errors.push({
          row:     row.originalRow,
          field:   'debitAccount',
          message: `Debit account not found: "${row.debitAccountName}". Check your Chart of Accounts.`,
        });
        continue;
      }
      if (!credit) {
        errors.push({
          row:     row.originalRow,
          field:   'creditAccount',
          message: `Credit account not found: "${row.creditAccountName}". Check your Chart of Accounts.`,
        });
        continue;
      }
      if (debit._id.toString() === credit._id.toString()) {
        errors.push({
          row:     row.originalRow,
          field:   'general',
          message: `Debit and credit resolved to the same account: "${debit.accountName}"`,
        });
        continue;
      }

      // Downgrade confidence if account was fuzzy-matched
      let rowConf = row.confidenceScore;
      const rowFlags = [...(row.confidenceFlags || [])];
      if (debit.accountName.toLowerCase()  !== row.debitAccountName.toLowerCase())  {
        rowConf  -= 15; rowFlags.push('debit_fuzzy');
      }
      if (credit.accountName.toLowerCase() !== row.creditAccountName.toLowerCase()) {
        rowConf  -= 15; rowFlags.push('credit_fuzzy');
      }
      rowConf = Math.max(0, rowConf);
      const rowConfLabel = rowConf >= 80 ? 'High' : rowConf >= 50 ? 'Medium' : 'Low';

      resolvedRows.push({
        ...row,
        debitAccountId:    debit._id,
        creditAccountId:   credit._id,
        debitAccountName:  debit.accountName,   // normalise to canonical name
        creditAccountName: credit.accountName,
        confidenceScore:   rowConf,
        confidenceLabel:   rowConfLabel,
        confidenceFlags:   rowFlags,
      });
    }

    // ── Re-compute confidence stats after account resolution ─────────────
    const resolvedStats = resolvedRows.reduce(
      (acc, r) => {
        if      (r.confidenceScore >= 80) acc.high++;
        else if (r.confidenceScore >= 50) acc.medium++;
        else                              acc.low++;
        return acc;
      },
      { high: 0, medium: 0, low: 0 }
    );

    logger.info(`Excel preview: ${resolvedRows.length} resolved, ${errors.length} error(s)`);

    ApiResponse.success(res, {
      // Backward-compat fields
      validCount:   resolvedRows.length,
      invalidCount: errors.length,
      validRows:    resolvedRows,
      errors,
      // New fields
      duplicatesFound,
      fileInfo,
      confidenceStats: resolvedStats,
    }, 'Excel preview generated');

  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/transactions/excel/confirm
 * Bulk-save the validated rows that were returned by the preview step.
 */
const confirmExcelImport = async (req, res, next) => {
  try {
    const { rows } = req.body;
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      throw new ApiError(400, 'No valid rows to import');
    }

    const businessId = req.user.businessId;
    logger.info(`Excel confirm: importing ${rows.length} rows for business ${businessId}`);

    // Pre-load all accounts once for re-validation (accounts may have changed since preview)
    const allAccounts = await accountRepository.findByBusiness(businessId);
    const resolve = buildAccountResolver(allAccounts);

    const transactionsToCreate = [];
    const accountErrors = [];
    let flagged = 0;

    for (const row of rows) {
      // Phase 4 — per-row confidence enforcement, mirroring the NL 98/95/<95
      // tiers: High (>=~98%-equivalent) imports as-is; Medium (95-98%-equivalent)
      // still imports but is flagged for a spot-check; Low (<95%-equivalent) is
      // held back entirely — never silently posted on a weak guess.
      if (row.confidenceLabel === 'Low') {
        accountErrors.push({
          row: row.originalRow,
          error: 'Confidence too low for auto-import — please review and correct this row before importing.',
        });
        continue;
      }

      // Re-resolve by name (authoritative); fall back to the ID from preview if name is missing
      let debitAccountId  = row.debitAccountId;
      let creditAccountId = row.creditAccountId;

      if (row.debitAccountName) {
        const acc = resolve(row.debitAccountName);
        if (!acc) {
          accountErrors.push({ row: row.originalRow, error: `Debit account not found: "${row.debitAccountName}"` });
          continue;
        }
        debitAccountId = acc._id;
      }
      if (row.creditAccountName) {
        const acc = resolve(row.creditAccountName);
        if (!acc) {
          accountErrors.push({ row: row.originalRow, error: `Credit account not found: "${row.creditAccountName}"` });
          continue;
        }
        creditAccountId = acc._id;
      }

      if (!debitAccountId || !creditAccountId) {
        accountErrors.push({ row: row.originalRow, error: 'Could not resolve account IDs' });
        continue;
      }

      if (row.confidenceLabel === 'Medium') flagged++;

      transactionsToCreate.push({
        transactionDate:      row.transactionDate,
        description:          row.description,
        transactionType:      row.transactionType      || undefined,
        transactionMode:      row.transactionMode      || undefined,
        amount:               row.amount,
        debitAccountId,
        creditAccountId,
        customerName:         row.customerName         || undefined,
        vendorName:           row.vendorName           || undefined,
        transactionReference: row.transactionReference || undefined,
        notes:                row.notes                || undefined,
        businessId,
        inputMethod:          'excel',
        originalRow:          row.originalRow,
        // Medium-confidence rows still import (not blocked) but are marked so
        // the user knows to spot-check them — not treated identically to High.
        ...(row.confidenceLabel === 'Medium' ? { metadata: { needsSpotCheck: true } } : {}),
      });
    }

    // #9 — route through the gated batch service so over-threshold rows are
    // parked for approval (consistent with the form/NL/AI paths) and we get a
    // structured summary in a single server-side pass.
    const batchPostingService = require('../services/batchPosting.service');
    const batch = await batchPostingService.postBatch(
      businessId,
      transactionsToCreate,
      req.user,
      req.ip,
      { source: 'excel' }
    );

    // Map to the legacy Excel result shape (+ pending) and merge resolution errors.
    const results = {
      successful: batch.posted,
      pending:    batch.pending,
      failed:     [...batch.failed, ...accountErrors],
      flagged,   // imported but medium-confidence — worth a spot-check
      batchId:    batch.batchId,
    };

    logger.info(`Excel import complete: ${results.successful} posted, ${results.pending} pending approval, ${results.flagged} flagged, ${results.failed.length} failed`);
    const msg = results.pending > 0
      ? `${results.successful} imported, ${results.pending} sent for approval`
      : `${results.successful} transactions imported successfully`;
    ApiResponse.success(res, results, msg);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/transactions/batch
 * Post many transactions in one call. Each item goes through the approval gate;
 * over-threshold items are parked. Optional per-item idempotencyKey makes a
 * retry safe (already-posted keys are skipped).
 *
 * Body: { items: [ { transactionDate, description, amount, debitAccountId, creditAccountId, ...optional, idempotencyKey? } ] }
 */
const postBatchTransactions = async (req, res, next) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      throw new ApiError(400, 'Provide a non-empty "items" array');
    }
    const batchPostingService = require('../services/batchPosting.service');
    const result = await batchPostingService.postBatch(
      req.user.businessId,
      items,
      req.user,
      req.ip,
      { source: 'batch' }
    );
    const msg = `Batch complete: ${result.posted} posted`
      + (result.pending ? `, ${result.pending} sent for approval` : '')
      + (result.skipped ? `, ${result.skipped} already posted` : '')
      + (result.failed.length ? `, ${result.failed.length} failed` : '');
    ApiResponse.success(res, result, msg);
  } catch (error) {
    next(error);
  }
};

/**
 * Get list of transactions with filtering and pagination.
 */
const getTransactions = async (req, res, next) => {
  try {
    const filters = {
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      transactionType: req.query.transactionType,
      minAmount: req.query.minAmount,
      maxAmount: req.query.maxAmount,
      accountId: req.query.accountId,
      customerId: req.query.customerId,
      vendorId: req.query.vendorId,
      status: req.query.status,
      paymentStatus: req.query.paymentStatus,
      hasOutstandingBalance: req.query.hasOutstandingBalance,
      search: req.query.search,
    };
    const pagination = {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 25,
      sortBy: req.query.sortBy || 'transactionDate',
      sortOrder: req.query.sortOrder === 'asc' ? 1 : -1,
    };
    const result = await transactionService.getTransactionHistory(
      req.user.businessId,
      filters,
      pagination
    );
    ApiResponse.success(res, result, 'Transactions retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Get a single transaction by ID (with details and audit trail).
 */
const getTransactionById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const transaction = await transactionService.getTransactionById(id, req.user.businessId);
    ApiResponse.success(res, transaction, 'Transaction details retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Update an existing transaction.
 */
const updateTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    const updated = await transactionService.editTransaction(
      id,
      req.user.businessId,
      updateData,
      req.user.id,
      req.ip
    );
    ApiResponse.success(res, updated, 'Transaction updated successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Delete (reverse) a transaction — legacy endpoint kept for backward compat.
 * Prefer POST /:id/reverse for new code.
 */
const deleteTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const reversal = await transactionService.deleteTransaction(
      id,
      req.user.businessId,
      req.user.id,
      req.ip
    );
    ApiResponse.success(res, reversal, 'Transaction reversed successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Reverse a posted transaction — GAAP-compliant dedicated reversal.
 * POST /api/v1/transactions/:id/reverse
 *
 * Body: { reversalDate?: ISO date, reason?: string }
 */
const reverseTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reversalDate, reason } = req.body;
    const reversal = await transactionService.reverseTransaction(
      id,
      req.user.businessId,
      { reversalDate, reason },
      req.user.id,
      req.ip
    );
    ApiResponse.created(res, reversal, 'Transaction reversed successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * Get full audit/reversal history for a transaction.
 * GET /api/v1/transactions/:id/history
 */
const getTransactionAuditHistory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const history = await transactionService.getTransactionAuditHistory(id, req.user.businessId);
    ApiResponse.success(res, history, 'Transaction history retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * Repair orphaned AR/AP transactions for this business.
 *
 * POST /api/v1/transactions/repair-ar-ap
 *
 * Finds transactions where the account pair indicates AR/AP (debit = Accounts
 * Receivable + credit = Revenue, or credit = Accounts Payable + debit = Expense)
 * but paymentStatus was never set (wrong preset used at entry time).
 *
 * Idempotent — safe to call multiple times. Only processes transactions where
 * paymentStatus is currently null.
 *
 * Returns: { arFixed, apFixed, message }
 */
const repairARAPTransactions = async (req, res, next) => {
  try {
    const result = await transactionService.repairOrphanedARAPTransactions(req.user.businessId);
    const msg = result.arFixed === 0 && result.apFixed === 0
      ? 'No orphaned AR/AP entries found — books are consistent.'
      : `Repaired ${result.arFixed} receivable${result.arFixed !== 1 ? 's' : ''} and ${result.apFixed} payable${result.apFixed !== 1 ? 's' : ''}.`;
    ApiResponse.success(res, result, msg);
  } catch (error) {
    next(error);
  }
};

/* ─────────────────────────────────────────────────────────────────────────── */
/* Advanced Installment Lifecycle Controllers                                  */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * GET /api/v1/transactions/installments
 * List all installment plans for the current business.
 */
const getInstallmentPlans = async (req, res, next) => {
  try {
    const filters = req.query; // status, customerId, vendorId, etc.
    const plans = await installmentService.getInstallmentsByBusiness(req.user.businessId, filters);
    ApiResponse.success(res, plans, 'Installment plans retrieved successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/transactions/installment/:planId
 * Get a single installment plan with full schedule.
 */
const getInstallmentPlan = async (req, res, next) => {
  try {
    const plan = await installmentService.getInstallmentPlan(req.params.planId, req.user.businessId);
    ApiResponse.success(res, plan, 'Installment plan retrieved');
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/transactions/installments/reminders?daysAhead=7
 * Upcoming due installments within the look-ahead window.
 */
const getInstallmentReminders = async (req, res, next) => {
  try {
    const daysAhead = Number(req.query.daysAhead) || 7;
    const reminders = await installmentService.getUpcomingReminders(req.user.businessId, daysAhead);
    ApiResponse.success(res, reminders, `${reminders.length} upcoming installment(s) within ${daysAhead} days`);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/transactions/installments/overdue-alerts
 * All overdue plans with per-row detail and severity.
 */
const getOverdueAlerts = async (req, res, next) => {
  try {
    const result = await installmentService.getOverdueAlerts(req.user.businessId);
    ApiResponse.success(res, result, `${result.planCount} overdue installment plan(s)`);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/transactions/installment/:planId/penalty
 * Accrue late-payment penalty on a single plan.
 *
 * Body: { flatPenaltyPerRow?, annualPenaltyRate? }
 */
const accrueInstallmentPenalty = async (req, res, next) => {
  try {
    const { planId } = req.params;
    const opts = {
      flatPenaltyPerRow: req.body.flatPenaltyPerRow != null ? Number(req.body.flatPenaltyPerRow) : undefined,
      annualPenaltyRate: req.body.annualPenaltyRate != null ? Number(req.body.annualPenaltyRate) : undefined,
    };
    const result = await installmentService.accrueInstallmentPenalty(
      planId,
      req.user.businessId,
      opts,
      req.user.id,
      req.ip
    );
    const msg = result.penaltiesApplied.length > 0
      ? `Penalty of ${result.totalPenalty} accrued across ${result.penaltiesApplied.length} overdue row(s)`
      : 'No overdue rows found — no penalty accrued';
    ApiResponse.success(res, result, msg);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/transactions/installments/accrue-all-penalties
 * Batch penalty accrual for ALL overdue plans of the business.
 * Designed for cron-job use.
 *
 * Body: { flatPenaltyPerRow?, annualPenaltyRate? }
 */
const accrueAllPenalties = async (req, res, next) => {
  try {
    const opts = {
      flatPenaltyPerRow: req.body.flatPenaltyPerRow != null ? Number(req.body.flatPenaltyPerRow) : undefined,
      annualPenaltyRate: req.body.annualPenaltyRate != null ? Number(req.body.annualPenaltyRate) : undefined,
    };
    const result = await installmentService.accrueAllPenalties(
      req.user.businessId,
      opts,
      req.user.id,
      req.ip
    );
    ApiResponse.success(
      res,
      result,
      `Penalty run complete: ${result.plansProcessed} plan(s) processed, total ${result.totalPenalty} accrued`
    );
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/transactions/installment/:planId/restructure
 * Restructure (modify terms of) an installment plan.
 *
 * Body: {
 *   installmentCount,
 *   installmentFrequency?,
 *   interestRate?,
 *   interestMethod?,
 *   firstPaymentDate?,
 *   reason?
 * }
 */
const restructureInstallmentPlan = async (req, res, next) => {
  try {
    const { planId } = req.params;
    if (!req.body.installmentCount) {
      throw new ApiError(400, 'installmentCount is required for restructuring');
    }
    const plan = await installmentService.restructurePlan(
      planId,
      req.user.businessId,
      req.body,
      req.user.id,
      req.ip
    );
    ApiResponse.success(res, plan, 'Installment plan restructured successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/transactions/installment/:planId/settle-early
 * Early settlement of an installment plan.
 *
 * Body: {
 *   amount,           – actual cash paid
 *   discountAmount?,  – waived/forgiven amount (optional)
 *   paymentAccountId, – cash/bank account
 *   transactionDate?, description?
 * }
 */
const settleInstallmentEarly = async (req, res, next) => {
  try {
    const { planId } = req.params;
    const result = await installmentService.settleEarly(
      planId,
      req.user.businessId,
      req.body,
      req.user.id,
      req.ip
    );
    ApiResponse.success(res, result, 'Installment plan settled early successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/transactions/installments/refresh-overdue
 * Manually trigger overdue status refresh for all active plans.
 * Normally called by a daily cron.
 */
const refreshOverdueStatuses = async (req, res, next) => {
  try {
    const result = await installmentService.refreshOverdueStatuses(req.user.businessId);
    ApiResponse.success(res, result, `Refreshed ${result.scanned} plans (${result.updated} updated)`);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/transactions/refresh-overdue-ar
 * Mark AR entries (Credit Sale) as OVERDUE where dueDate has passed.
 * Idempotent — safe to call multiple times.
 */
const refreshOverdueAR = async (req, res, next) => {
  try {
    const result = await transactionService.refreshOverdueAR(req.user.businessId);
    ApiResponse.success(res, result,
      result.updated > 0
        ? `${result.updated} receivable(s) marked as overdue`
        : 'No new overdue receivables found'
    );
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/transactions/refresh-overdue-ap
 * Mark AP entries (Credit Purchase) as OVERDUE where dueDate has passed.
 * Idempotent — safe to call multiple times.
 */
const refreshOverdueAP = async (req, res, next) => {
  try {
    const result = await transactionService.refreshOverdueAP(req.user.businessId);
    ApiResponse.success(res, result,
      result.updated > 0
        ? `${result.updated} payable(s) marked as overdue`
        : 'No new overdue payables found'
    );
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createFormTransaction,
  recordPayment,
  getOutstandingBalances,
  getSettlementHistory,
  createInstallmentTransaction,
  recordInstallmentPayment,
  processNaturalLanguage,
  confirmNaturalLanguage,
  downloadExcelTemplate,
  uploadExcelPreview,
  confirmExcelImport,
  postBatchTransactions,
  getTransactions,
  getTransactionById,
  updateTransaction,
  deleteTransaction,
  reverseTransaction,
  getTransactionAuditHistory,
  repairARAPTransactions,
  refreshOverdueAR,
  refreshOverdueAP,
  // ── Advanced installment lifecycle ─────────────────────────────────────
  getInstallmentPlans,
  getInstallmentPlan,
  getInstallmentReminders,
  getOverdueAlerts,
  accrueInstallmentPenalty,
  accrueAllPenalties,
  restructureInstallmentPlan,
  settleInstallmentEarly,
  refreshOverdueStatuses,
};