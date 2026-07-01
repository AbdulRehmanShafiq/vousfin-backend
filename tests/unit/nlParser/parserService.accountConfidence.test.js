// tests/unit/nlParser/parserService.accountConfidence.test.js
//
// Locks in the Phase 2 fix: accountMapping confidence must come from actually
// resolving the journal entries' account names against the live Chart of
// Accounts (real, calibrated) — not from Gemini's own self-reported number
// (uncalibrated, decoupled from what account ultimately gets used).
'use strict';

jest.mock('../../../services/nlParser/services/geminiService', () => ({
  callGeminiAPI: jest.fn().mockResolvedValue({}),
  callGeminiVision: jest.fn(),
}));
jest.mock('../../../services/nlParser/services/validationService', () => ({
  validateResult: jest.fn().mockReturnValue({ validation: {}, errors: [], warnings: [], isValid: true }),
}));

const { normalizeExtraction } = require('../../../services/nlParser/services/normalizationService');
jest.mock('../../../services/nlParser/services/normalizationService');

const { generateJournalEntries } = require('../../../services/nlParser/services/journalGeneratorService');
jest.mock('../../../services/nlParser/services/journalGeneratorService');

const { parseTransaction } = require('../../../services/nlParser/services/parserService');

const GEMINI_SYNTHETIC_ACCOUNT_MAPPING = 0.5; // Gemini's own uncalibrated self-report

function setupMocks({ journalEntries }) {
  normalizeExtraction.mockReturnValue({
    normalized: { transactionType: 'Expense', amount: 100, sourceAccount: 'Cash at Bank', cashFlowDirection: 'outflow' },
    confidence: { intent: 0.9, amount: 0.9, date: 0.9, accountMapping: GEMINI_SYNTHETIC_ACCOUNT_MAPPING },
  });
  generateJournalEntries.mockReturnValue(journalEntries);
}

const BUSINESS_ACCOUNTS = [
  { _id: 'a1', accountName: 'Cash at Bank' },
  { _id: 'a2', accountName: 'Rent' },
];

describe('parserService — real account-resolution confidence (Phase 2)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('overrides the synthetic accountMapping score with real resolution confidence when both legs match exactly', async () => {
    setupMocks({
      journalEntries: [
        { account: 'Cash at Bank', entryType: 'credit', amount: 100 },
        { account: 'Rent', entryType: 'debit', amount: 100 },
      ],
    });
    const result = await parseTransaction('paid rent 100 cash', BUSINESS_ACCOUNTS);
    expect(result.confidence.accountMapping).toBe(1.0);
    expect(result.confidence.accountMapping).not.toBe(GEMINI_SYNTHETIC_ACCOUNT_MAPPING);
  });

  test('reflects a low real confidence when the journal account name does not resolve to anything', async () => {
    setupMocks({
      journalEntries: [
        { account: 'Cash at Bank', entryType: 'credit', amount: 100 },
        { account: 'A Completely Fabricated Account Name', entryType: 'debit', amount: 100 },
      ],
    });
    const result = await parseTransaction('paid rent 100 cash', BUSINESS_ACCOUNTS);
    expect(result.confidence.accountMapping).toBe(0);
  });

  test('falls back to the synthetic Gemini confidence when no live accounts are available (no regression)', async () => {
    setupMocks({
      journalEntries: [
        { account: 'Cash at Bank', entryType: 'credit', amount: 100 },
        { account: 'Rent', entryType: 'debit', amount: 100 },
      ],
    });
    const result = await parseTransaction('paid rent 100 cash', []); // empty businessAccounts
    expect(result.confidence.accountMapping).toBe(GEMINI_SYNTHETIC_ACCOUNT_MAPPING);
  });

  test('surfaces per-leg matchType for the auto-post gate (Phase 3)', async () => {
    setupMocks({
      journalEntries: [
        { account: 'Cash at Bank', entryType: 'credit', amount: 100 },
        { account: 'Rent', entryType: 'debit', amount: 100 },
      ],
    });
    const result = await parseTransaction('paid rent 100 cash', BUSINESS_ACCOUNTS);
    expect(result.accountResolution.debit.matchType).toBe('exact');
    expect(result.accountResolution.credit.matchType).toBe('exact');
  });
});
