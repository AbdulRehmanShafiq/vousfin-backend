/**
 * @module geminiService
 * @description Handles communication with the Google Gemini API.
 * Implements retry logic, timeout handling, and strict JSON enforcement.
 */

const { buildSystemPrompt, buildUserPrompt } = require('../utils/promptBuilder');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const MAX_RETRIES = 3;
const TIMEOUT_MS = 30000;
const RETRY_DELAY_MS = 1000;

/**
 * Call the Gemini API with natural language transaction input.
 * @param {string} rawInput - Raw transaction text from user.
 * @returns {Promise<object>} Parsed JSON response from Gemini.
 * @throws {Error} If all retries fail or response is invalid.
 */
async function callGeminiAPI(rawInput) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not set');
  }

  const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(rawInput);

  const requestBody = {
    system_instruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: userPrompt }],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
    },
  };

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetchWithTimeout(GEMINI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      }, TIMEOUT_MS);

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'Unknown error');
        throw new Error(`Gemini API error (${response.status}): ${errorBody}`);
      }

      const data = await response.json();

      const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!content) {
        throw new Error('Empty response content from Gemini API');
      }

      // Parse and validate JSON response
      const parsed = extractJSON(content);
      if (!parsed) {
        throw new Error('Failed to parse JSON from Gemini response');
      }

      return parsed;
    } catch (error) {
      lastError = error;
      console.error(`Gemini API attempt ${attempt}/${MAX_RETRIES} failed:`, error.message);

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw new Error(`Gemini API failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
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

module.exports = { callGeminiAPI, extractJSON };
