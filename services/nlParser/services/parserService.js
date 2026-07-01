/**
 * @module parserService
 * @description Main orchestrator service for the NL Parser pipeline.
 * Coordinates the full flow: AI extraction → normalization → accounting rules
 * → journal generation → validation → structured response.
 */

const { callGeminiAPI, callGeminiVision } = require('./geminiService');
const { normalizeExtraction } = require('./normalizationService');
const { generateJournalEntries } = require('./journalGeneratorService');
const { validateResult } = require('./validationService');
const { calculateConfidence, evaluateReviewNeed } = require('../utils/confidenceCalculator');
const { buildClarification } = require('../utils/clarificationBuilder');
const { matchAccountByName } = require('../../../utils/accountMatcher');

/**
 * Parse a natural language transaction description into a structured
 * accounting journal entry object.
 *
 * Pipeline:
 *   1. AI Extraction (Gemini API — with live business accounts injected)
 *   2. Normalization
 *   3. Accounting Rules Engine
 *   4. Journal Entry Generation
 *   5. Validation
 *   6. Confidence & Review Assessment
 *
 * @param {string} rawInput         - Natural language transaction description.
 * @param {Array}  businessAccounts - Live ChartOfAccount docs for CoA-aware parsing.
 * @param {object} [opts]           - Optional context
 * @param {string} [opts.countryCode] - Business country code for tax intelligence (Phase 5.4.7)
 * @returns {Promise<object>} Structured journal entry response.
 */
async function parseTransaction(rawInput, businessAccounts = [], opts = {}) {
  // ── Step 1: AI Extraction — inject live accounts so Gemini uses real names ──
  const rawExtraction = await callGeminiAPI(rawInput, businessAccounts);
  return _finishParse(rawExtraction, rawInput, businessAccounts, opts);
}

/** Read a bill/receipt IMAGE into the same structured result as the text path. */
async function parseTransactionFromImage(imageBase64, mimeType = 'image/jpeg', businessAccounts = [], opts = {}) {
  const rawExtraction = await callGeminiVision(imageBase64, mimeType, businessAccounts);
  return _finishParse(rawExtraction, opts.rawText || '', businessAccounts, opts);
}

/** Steps 2–6 of the pipeline (shared by the text + image paths). */
async function _finishParse(rawExtraction, rawInput, businessAccounts = [], opts = {}) {
  // ── Step 2: Normalization (Phase 5.4.7: pass rawText + countryCode for tax intelligence) ──
  const { normalized, confidence: rawConfidence } = normalizeExtraction(rawExtraction, {
    rawText:     rawInput,
    countryCode: opts.countryCode || null,
  });

  // ── Step 3 & 4: Journal Entry Generation (includes accounting rules) ──
  const journalEntries = generateJournalEntries(normalized);

  // ── Step 5: Validation — pass live accounts so custom names resolve correctly ──
  const { validation, errors, warnings, isValid } = validateResult(normalized, journalEntries, businessAccounts);

  // ── Step 5.5: Real account-mapping confidence ─────────────────────────────
  // Resolve the journal's debit/credit account NAMES against the already-loaded
  // live CoA (in-memory — no extra DB round-trip). This replaces Gemini's own
  // self-reported accountMapping score (uncalibrated, decoupled from what
  // account name actually gets used) with a real, deterministic confidence —
  // the foundation the tiered auto-post policy is built on. Falls back to the
  // synthetic score when no live accounts were supplied (e.g. no CoA yet).
  const debitEntry  = journalEntries.find((e) => e.entryType === 'debit');
  const creditEntry = journalEntries.find((e) => e.entryType === 'credit');
  const debitMatch  = matchAccountByName(businessAccounts, debitEntry?.account);
  const creditMatch = matchAccountByName(businessAccounts, creditEntry?.account);
  const accountResolution = { debit: debitMatch, credit: creditMatch };

  const accountMapping = businessAccounts.length > 0
    ? Math.min(debitMatch.confidence, creditMatch.confidence)
    : rawConfidence.accountMapping;

  // ── Step 6: Confidence & Review ──
  const confidence = calculateConfidence({ ...rawConfidence, accountMapping });

  // Adjust account mapping confidence based on validation
  if (!isValid) {
    confidence.accountMapping = Math.min(confidence.accountMapping, 0.5);
    confidence.overall = calculateConfidence({
      ...confidence,
      accountMapping: confidence.accountMapping,
    }).overall;
  }

  const { requiresReview, reviewReasons } = evaluateReviewNeed(confidence, normalized);

  // If a critical field is still missing/ambiguous, prepare ONE plain-English
  // follow-up question. The frontend collects the answer and re-parses (with a
  // higher `attempt`) so the form is filled with greater confidence. Stateless +
  // round-capped, so it always terminates.
  const clarification = buildClarification(confidence, normalized, { attempt: opts.attempt || 0 });

  // Add validation warnings to review reasons
  if (warnings.length > 0) {
    reviewReasons.push(...warnings);
  }
  if (errors.length > 0) {
    reviewReasons.push(...errors.map((e) => `VALIDATION ERROR: ${e}`));
  }

  // Build final response — include all fields the frontend needs
  const parsedData = {
    intent: normalized.intent,
    transactionType: normalized.transactionType,
    subcategory: normalized.subcategory,
    amount: normalized.amount,
    currency: normalized.currency,
    date: normalized.date,
    description: normalized.description,
    counterpartyName: normalized.counterpartyName,
    paymentMethod: normalized.paymentMethod,
    sourceAccount: normalized.sourceAccount,
    // Explicit debit/credit suggestions from Gemini (new Phase 1 fields)
    debitAccount: normalized.debitAccount,
    creditAccount: normalized.creditAccount,
    cashFlowDirection: normalized.cashFlowDirection,
    // Installment / financing metadata — must NOT be dropped
    isInstallment: normalized.isInstallment,
    totalInstallmentAmount: normalized.totalInstallmentAmount,
    installmentPeriodMonths: normalized.installmentPeriodMonths,
    downPayment:      normalized.downPayment,
    interestRate:     normalized.interestRate,
    firstPaymentDate: normalized.firstPaymentDate,
    interestMethod:   normalized.interestMethod,
    // Tax fields — preserved for journal generation (payroll, GST sale)
    taxAmount:        normalized.taxAmount,
    taxRate:          normalized.taxRate,
    // Phase 3 Step 4 — Tax + Liability + Inventory
    taxType:          normalized.taxType,
    isTaxExclusive:   normalized.isTaxExclusive,
    isTaxInclusive:   normalized.isTaxInclusive,
    costAmount:       normalized.costAmount,
    grossAmount:      normalized.grossAmount,
    netAmount:        normalized.netAmount,
    adjustmentType:   normalized.adjustmentType,
    eobi:             normalized.eobi,
  };

  return {
    success: isValid,
    rawInput,
    parsedData,
    journalEntries,
    validation,
    confidence,
    requiresReview: requiresReview || !isValid || errors.length > 0,
    reviewReasons: [...new Set(reviewReasons)], // deduplicate
    clarification,                    // null, or { field, question, options? }
    needsClarification: !!clarification,
    accountResolution,                 // { debit: {account,confidence,matchType}, credit: {...} }
  };
}

module.exports = { parseTransaction, parseTransactionFromImage };
