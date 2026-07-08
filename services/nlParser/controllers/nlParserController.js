/**
 * @module nlParserController
 * @description Express controller for the NL Parser endpoint.
 * Handles request validation, service invocation, and error responses.
 */

const { parseTransaction } = require('../services/parserService');

/**
 * POST /api/nl-parser/parse
 * Parse a natural language transaction description.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function parseNaturalLanguage(req, res) {
  try {
    // ── Input Validation ──
    const { text } = req.body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid "text" field. Please provide a transaction description string.',
      });
    }

    const trimmed = text.trim();

    if (trimmed.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Transaction description cannot be empty.',
      });
    }

    if (trimmed.length > 1000) {
      return res.status(400).json({
        success: false,
        error: 'Transaction description exceeds maximum length of 1000 characters.',
      });
    }

    // ── Parse Transaction ──
    const result = await parseTransaction(trimmed);

    return res.status(200).json(result);
  } catch (error) {
    console.error('[NL Parser] Controller error:', error);

    // Determine if it's a known error type
    if (error.message?.includes('DEEPSEEK_API_KEY')) {
      return res.status(500).json({
        success: false,
        error: 'AI service configuration error. Please contact support.',
      });
    }

    if (error.message?.includes('AI extraction failed') || error.message?.includes('DeepSeek API')) {
      return res.status(502).json({
        success: false,
        error: 'AI service is temporarily unavailable. Please try again later.',
      });
    }

    if (error.message?.includes('timed out')) {
      return res.status(504).json({
        success: false,
        error: 'AI service request timed out. Please try again.',
      });
    }

    return res.status(500).json({
      success: false,
      error: 'An unexpected error occurred while parsing the transaction.',
    });
  }
}

module.exports = { parseNaturalLanguage };
