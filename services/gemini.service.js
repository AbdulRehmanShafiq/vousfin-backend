// services/gemini.service.js — the app's ONLY multimodal LLM provider.
//
// DeepSeek (services/deepseek.service.js) is text-only, so photo/receipt
// reading routes through Gemini instead. One env var (GEMINI_API_KEY) is the
// only credential this client needs. Mirrors deepseek.service.js's shape
// (fetchWithTimeout, retry-on-overload, {text, provider} return) so callers
// that already know that pattern read this one for free.
'use strict';

const GEMINI_API_URL = process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const TIMEOUT_MS = parseInt(process.env.AI_MODEL_TIMEOUT_MS, 10) || 30000;
const MAX_RETRIES = parseInt(process.env.AI_MODEL_MAX_RETRIES, 10) || 2;
const RETRY_DELAY_MS = 800;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Gemini API request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function requireApiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY environment variable is not set');
  return key;
}

function isOverload(err) {
  const m = String(err?.message || '');
  return /\b(503|429)\b/.test(m) || /overloaded|unavailable|rate.?limit|timed out/i.test(m);
}

/**
 * Single vision request: an image plus a system/user text prompt, in JSON mode.
 * @param {string} imageBase64 - Raw base64 image data (no data: URI prefix).
 * @param {string} mimeType - e.g. 'image/jpeg'.
 * @param {{system?: string, user: string}} prompt
 * @returns {Promise<{text: string, provider: 'gemini'}>}
 */
async function callVision(imageBase64, mimeType, prompt = {}) {
  const apiKey = requireApiKey();
  const promptText = [prompt.system, prompt.user].filter(Boolean).join('\n\n');

  const body = {
    contents: [
      {
        parts: [
          { text: promptText },
          { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
    },
  };

  const url = `${GEMINI_API_URL}/models/${GEMINI_MODEL}:generateContent`;

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`Gemini API error (${response.status}): ${errorBody.slice(0, 300)}`);
      }

      const payload = await response.json();
      const text = payload?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('');
      if (!text) throw new Error('Gemini returned an empty response (no text)');
      return { text: text.trim(), provider: 'gemini' };
    } catch (error) {
      lastError = error;
      if (isOverload(error) && attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS * attempt); continue; }
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  const err = new Error(`Gemini API failed after ${MAX_RETRIES} attempt(s): ${lastError?.message}`);
  err.isOverloaded = isOverload(lastError);
  throw err;
}

module.exports = { callVision, GEMINI_MODEL };
