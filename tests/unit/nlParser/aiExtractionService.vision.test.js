'use strict';

/**
 * callAIVision contract tests. The image path must produce the SAME
 * rawExtraction shape as callAIExtraction (text path) so _finishParse can
 * treat both identically — only the provider (Gemini vs DeepSeek) differs.
 */

jest.mock('../../../services/gemini.service');
const gemini = require('../../../services/gemini.service');
const { callAIVision } = require('../../../services/nlParser/services/aiExtractionService');

describe('callAIVision (Gemini-backed image extraction)', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV, GEMINI_API_KEY: 'test-key' };
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  test('parses the Gemini JSON reply into the rawExtraction shape', async () => {
    gemini.callVision.mockResolvedValue({
      provider: 'gemini',
      text: JSON.stringify({
        intent: 'office supplies purchase',
        transactionType: 'Cash Purchase',
        amount: 1500,
        currency: 'PKR',
        debitAccount: 'Office Supplies',
        creditAccount: 'Cash',
        confidence: { intent: 0.9, amount: 0.95, date: 0.5, accountMapping: 0.8 },
      }),
    });

    const result = await callAIVision('BASE64IMG', 'image/jpeg', [{ accountName: 'Cash', accountType: 'Asset' }]);

    expect(result.transactionType).toBe('Cash Purchase');
    expect(result.amount).toBe(1500);
    expect(result.debitAccount).toBe('Office Supplies');
    expect(gemini.callVision).toHaveBeenCalledWith(
      'BASE64IMG',
      'image/jpeg',
      expect.objectContaining({ system: expect.any(String), user: expect.any(String) })
    );
  });

  test('injects live accounts and inventory items into the vision prompt', async () => {
    gemini.callVision.mockResolvedValue({ provider: 'gemini', text: '{"transactionType":"expense"}' });
    await callAIVision(
      'BASE64IMG',
      'image/jpeg',
      [{ accountName: 'Petty Cash', accountType: 'Asset' }],
      [{ name: 'Rice Bags' }]
    );
    const promptArg = gemini.callVision.mock.calls[0][2];
    expect(promptArg.system).toContain('Petty Cash');
    expect(promptArg.system).toContain('Rice Bags');
  });

  test('throws isVisionUnsupported when GEMINI_API_KEY is missing', async () => {
    delete process.env.GEMINI_API_KEY;
    gemini.callVision.mockRejectedValue(new Error('GEMINI_API_KEY environment variable is not set'));
    await expect(callAIVision('X', 'image/jpeg', [])).rejects.toMatchObject({ isVisionUnsupported: true });
  });

  test('throws a catchable error (not isVisionUnsupported) on a bad/unparseable reply', async () => {
    gemini.callVision.mockResolvedValue({ provider: 'gemini', text: 'not json at all' });
    await expect(callAIVision('X', 'image/jpeg', [])).rejects.toThrow();
  });
});
