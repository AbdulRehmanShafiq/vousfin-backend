/**
 * @module aiExtractionService
 * @description Structured-JSON transaction extraction. Text goes through
 * DeepSeek (services/deepseek.service.js); photos/receipts go through Gemini
 * (services/gemini.service.js) — DeepSeek's hosted API is text-only. Both
 * paths share the same prompt schema (buildSystemPrompt) and produce the
 * identical rawExtraction shape, so the rest of the pipeline
 * (_finishParse onward) never needs to know which provider ran.
 */
'use strict';
const { buildSystemPrompt, buildUserPrompt } = require('../utils/promptBuilder');
const { extractJSON } = require('../../../utils/aiJson.helper');
const deepseek = require('../../deepseek.service');
const gemini = require('../../gemini.service');

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
 * Extract a structured transaction from a photo of a bill/receipt.
 * Uses Gemini (the app's only multimodal provider) with the SAME system
 * prompt schema as the text path, so the result merges into the pipeline
 * identically to callAIExtraction's output.
 * @param {string} imageBase64 - Raw base64 image data (no data: URI prefix).
 * @param {string} mimeType - e.g. 'image/jpeg'.
 * @param {Array}  businessAccounts - Live accounts from MongoDB for context injection.
 * @param {Array}  inventoryItems - Live inventory items for goods-name matching.
 * @returns {Promise<object>} Parsed JSON response.
 * @throws {Error} isVisionUnsupported=true if GEMINI_API_KEY is not configured;
 *   a plain Error for any other failure (bad reply, network, overload).
 */
async function callAIVision(imageBase64, mimeType = 'image/jpeg', businessAccounts = [], inventoryItems = []) {
  const system = buildSystemPrompt(businessAccounts, inventoryItems);
  const user = 'This image is a photo of a bill, receipt, or invoice. Read every visible detail — vendor/customer name, line items, amounts, tax, date — and extract the transaction as JSON per the schema above. If a field is not visible in the image, set it to null.';

  let response;
  try {
    response = await gemini.callVision(imageBase64, mimeType, { system, user });
  } catch (error) {
    if (/GEMINI_API_KEY/.test(error.message || '')) {
      const err = new Error('Photo/receipt reading is not available right now (AI vision is not configured). Please type the transaction instead.');
      err.isVisionUnsupported = true;
      throw err;
    }
    const err = new Error(`AI vision extraction failed: ${error.message}`);
    err.isOverloaded = !!error.isOverloaded;
    throw err;
  }

  const parsed = extractJSON(response.text);
  if (!parsed) throw new Error('Failed to parse JSON from AI vision response');
  return parsed;
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
