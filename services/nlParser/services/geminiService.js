/**
 * @module geminiService
 * @description Handles communication with the Google Gemini API.
 * Implements retry logic, timeout handling, and strict JSON enforcement.
 */

const { buildSystemPrompt, buildUserPrompt } = require('../utils/promptBuilder');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
// When the primary model is overloaded (503), fail over to another. Google's
// "-latest" aliases point at busy preview models; the dated/stable ones are
// usually free. De-duplicated, primary first.
const MODELS = [...new Set([GEMINI_MODEL, 'gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-1.5-flash'])];
const MAX_RETRIES = 2;          // per model (we also fail over across models)
const TIMEOUT_MS = 30000;
const RETRY_DELAY_MS = 800;

// A 503/429/UNAVAILABLE/timeout means the AI is busy, not that the input is bad.
function isOverload(err) {
  const m = String(err?.message || '');
  return /\b(503|429)\b/.test(m) || /overloaded|unavailable|rate.?limit|timed out/i.test(m);
}

/**
 * Call the Gemini API with natural language transaction input.
 * @param {string} rawInput - Raw transaction text from user.
 * @param {Array}  businessAccounts - Live accounts from MongoDB for context injection.
 * @returns {Promise<object>} Parsed JSON response from Gemini.
 * @throws {Error} If all retries fail or response is invalid.
 */
async function callGeminiAPI(rawInput, businessAccounts = []) {
  const requestBody = {
    system_instruction: { parts: [{ text: buildSystemPrompt(businessAccounts) }] },
    contents: [{ role: 'user', parts: [{ text: buildUserPrompt(rawInput) }] }],
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
  };
  return generate(requestBody);
}

/**
 * Read a bill/receipt IMAGE and return the same structured JSON as the text
 * path. Gemini's flash models are multimodal, so we send the image inline with
 * the same accounting prompt.
 * @param {string} imageBase64 - base64 (no data: prefix)
 * @param {string} mimeType    - e.g. image/jpeg, image/png
 */
async function callGeminiVision(imageBase64, mimeType = 'image/jpeg', businessAccounts = []) {
  const requestBody = {
    system_instruction: { parts: [{ text: buildSystemPrompt(businessAccounts) }] },
    contents: [{
      role: 'user',
      parts: [
        { text: buildUserPrompt('Read this bill/receipt image and extract the transaction. Use the amount, who it was paid to/received from, what it was for, and the date shown.') },
        { inline_data: { mime_type: mimeType, data: imageBase64 } },
      ],
    }],
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
  };
  return generate(requestBody);
}

/**
 * POST a request body to Gemini, retrying per model and failing over across
 * models when one is overloaded. Throws a tagged error (`.isOverloaded`) when
 * the failure is the AI being busy rather than bad input.
 */
async function generate(requestBody) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY environment variable is not set');

  let lastError = null;
  for (const model of MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        }, TIMEOUT_MS);

        if (!response.ok) {
          const errorBody = await response.text().catch(() => 'Unknown error');
          throw new Error(`Gemini API error (${response.status}): ${errorBody}`);
        }
        const data = await response.json();
        const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!content) throw new Error('Empty response content from Gemini API');
        const parsed = extractJSON(content);
        if (!parsed) throw new Error('Failed to parse JSON from Gemini response');
        return parsed;
      } catch (error) {
        lastError = error;
        console.error(`Gemini [${model}] attempt ${attempt}/${MAX_RETRIES} failed:`, error.message);
        // Overloaded → stop retrying this model, fail over to the next one.
        if (isOverload(error)) break;
        if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  const err = new Error(`Gemini API failed across ${MODELS.length} model(s): ${lastError?.message}`);
  err.isOverloaded = isOverload(lastError);
  throw err;
}

/**
 * Fetch with timeout support using AbortController.
 */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Gemini API request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Extract valid JSON from a string that may contain markdown or extra text.
 * @param {string} content - Raw response content.
 * @returns {object|null} Parsed JSON or null.
 */
function extractJSON(content) {
  if (!content || typeof content !== 'string') return null;

  // Try direct parse first
  try {
    return JSON.parse(content);
  } catch (_) {
    // Continue to fallback extraction
  }

  // Try to extract JSON from markdown code blocks
  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch (_) {
      // Continue
    }
  }

  // Try to find JSON object in the string
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (_) {
      // Failed
    }
  }

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { callGeminiAPI, callGeminiVision, extractJSON };
