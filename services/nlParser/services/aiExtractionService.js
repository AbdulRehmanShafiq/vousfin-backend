/**
 * @module aiExtractionService
 * @description Structured-JSON transaction extraction, powered by DeepSeek
 * (services/deepseek.service.js — the app's single LLM provider).
 *
 * DeepSeek's hosted API is text-only: there is no image/vision input. The
 * text-extraction path (callAIExtraction) works exactly as before; the
 * image path (callAIVision) throws a clear, catchable error so callers
 * (bookkeeper.service.js) degrade to their existing "couldn't read this one"
 * message instead of silently failing. Wire in a dedicated OCR step ahead of
 * this call if photo/receipt capture needs to come back.
 */
'use strict';
const { buildSystemPrompt, buildUserPrompt } = require('../utils/promptBuilder');
const { extractJSON } = require('../../../utils/aiJson.helper');
const deepseek = require('../../deepseek.service');

// A 503/429/overloaded/timeout means the AI is busy, not that the input is bad.
function isOverload(err) {
  const m = String(err?.message || '');
  return /\b(503|429)\b/.test(m) || /overloaded|unavailable|rate.?limit|timed out/i.test(m);
}

/**
 * Extract a structured transaction from natural-language text.
 * @param {string} rawInput - Raw transaction text from user.
 * @param {Array}  businessAccounts - Live accounts from MongoDB for context injection.
 * @returns {Promise<object>} Parsed JSON response.
 * @throws {Error} If the call fails or the response isn't valid JSON.
 */
async function callAIExtraction(rawInput, businessAccounts = [], inventoryItems = []) {
  const messages = [
    { role: 'system', content: buildSystemPrompt(businessAccounts, inventoryItems) },
    { role: 'user', content: buildUserPrompt(rawInput) },
  ];
  return generate(messages);
}

/**
 * Image/receipt extraction — NOT supported by DeepSeek's text-only API.
 * Always throws; callers must catch and fall back to asking the user to type
 * the transaction instead.
 */
async function callAIVision(_imageBase64, _mimeType = 'image/jpeg', _businessAccounts = []) {
  const err = new Error('Photo/receipt reading is not available with the current AI provider (DeepSeek is text-only). Please type the transaction instead.');
  err.isVisionUnsupported = true;
  throw err;
}

/** POST to DeepSeek in JSON mode, retrying on overload. */
async function generate(messages) {
  try {
    const { text } = await deepseek.callChat(messages, { temperature: 0.1, json: true, max_tokens: 1200 });
    const parsed = extractJSON(text);
    if (!parsed) throw new Error('Failed to parse JSON from AI response');
    return parsed;
  } catch (error) {
    const err = new Error(`AI extraction failed: ${error.message}`);
    err.isOverloaded = isOverload(error);
    throw err;
  }
}

module.exports = { callAIExtraction, callAIVision, extractJSON };
