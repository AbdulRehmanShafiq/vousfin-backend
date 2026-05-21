/**
 * @module parserService
 * @description Main orchestrator service for the NL Parser pipeline.
 * Coordinates the full flow: AI extraction → normalization → accounting rules
 * → journal generation → validation → structured response.
 */

const { callGeminiAPI } = require('./geminiService');
const { normalizeExtraction } = require('./normalizationService');
const { generateJournalEntries } = require('./journalGeneratorService');
const { validateResult } = require('./validationService');
const { calculateConfidence, evaluateReviewNeed } = require('../utils/confidenceCalculator');

/**
 * Parse a natural language transaction description into a structured
 * accounting journal entry object.
 *
 * Pipeline:
 *   1. AI Extraction (GROK API)
 *   2. Normalization
 *   3. Accounting Rules Engine
 *   4. Journal Entry Generation
 *   5. Validation
 *   6. Confidence & Review Assessment
 *
 * @param {string} rawInput - Natural language transaction description.
 * @returns {Promise<object>} Structured journal entry response.
 */
async function parseTransaction(rawInput) {
  // ── Step 1: AI Extraction ──
  const rawExtraction = await callGeminiAPI(rawInput);

  // ── Step 2: Normalization ──
  const { normalized, confidence: rawConfidence } = normalizeExtraction(rawExtraction);

  // ── Step 3 & 4: Journal Entry Generation (includes accounting rules) ──
  const journalEntries = generateJournalEntries(normalized);

  // ── Step 5: Validation ──
  const { validation, errors, warnings, isValid } = validateResult(normalized, journalEntries);

  // ── Step 6: Confidence & Review ──
  const confidence = calculateConfidence(rawConfidence);

  // Adjust account mapping confidence based on validation
  if (!isValid) {
    confidence.accountMapping = Math.min(confidence.accountMapping, 0.5);
    confidence.overall = calculateConfidence({
      ...confidence,
      accountMapping: confidence.accountMapping,
    }).overall;
  }

  const { requiresReview, reviewReasons } = evaluateReviewNeed(confidence, normalized);

  // Add validation warnings to review reasons
  if (warnings.length > 0) {
    reviewReasons.push(...warnings);
  }
  if (errors.length > 0) {
    reviewReasons.push(...errors.map((e) => `VALIDATION ERROR: ${e}`));
  }

  // Build final response
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
    cashFlowDirection: normalized.cashFlowDirection,
    isInstallment: normalized.isInstallment,
    totalInstallmentAmount: normalized.totalInstallmentAmount,
    installmentPeriodMonths: normalized.installmentPeriodMonths,
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
  };
}

module.exports = { parseTransaction };
