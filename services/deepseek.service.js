// services/deepseek.service.js — the ONE LLM provider VousFin talks to.
//
// DeepSeek's API is OpenAI-compatible (chat completions, JSON mode, SSE
// streaming), so this is the single low-level HTTP client every AI feature
// in the app routes through — natural-language transaction parsing, the AI
// assistant, the how-to search, faithfulness checking. One env var
// (DEEPSEEK_API_KEY) is the only credential the whole app needs.
//
// Note: DeepSeek's hosted API is text-only (no image/vision input, no
// embeddings endpoint). Callers that need those capabilities degrade
// gracefully — see aiExtractionService.callAIVision and embeddingService
// (local deterministic embeddings).
'use strict';

const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
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
    if (error.name === 'AbortError') throw new Error(`DeepSeek API request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function requireApiKey() {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY environment variable is not set');
  return key;
}

function isOverload(err) {
  const m = String(err?.message || '');
  return /\b(503|429)\b/.test(m) || /overloaded|unavailable|rate.?limit|timed out/i.test(m);
}

function buildBody(messages, options = {}, stream = false) {
  const body = {
    model: options.model || DEEPSEEK_MODEL,
    messages,
    temperature: options.temperature ?? 0.4,
    max_tokens: options.max_tokens || options.maxTokens || 800,
    stream,
  };
  // DeepSeek supports OpenAI-style JSON mode; the prompt must itself mention
  // "json" per DeepSeek's docs, which every caller that sets this already does.
  if (options.json) body.response_format = { type: 'json_object' };
  return body;
}

/** Single non-streaming chat completion. Retries transient (429/503/timeout) failures. */
async function callChat(messages, options = {}) {
  const apiKey = requireApiKey();
  const body = buildBody(messages, options, false);

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetchWithTimeout(DEEPSEEK_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`DeepSeek API error (${response.status}): ${errorBody.slice(0, 300)}`);
      }

      const payload = await response.json();
      const text = payload?.choices?.[0]?.message?.content;
      if (!text) throw new Error('DeepSeek returned an empty response');
      return { text: text.trim(), provider: 'deepseek' };
    } catch (error) {
      lastError = error;
      if (isOverload(error) && attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS * attempt); continue; }
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  const err = new Error(`DeepSeek API failed after ${MAX_RETRIES} attempt(s): ${lastError?.message}`);
  err.isOverloaded = isOverload(lastError);
  throw err;
}

/** Parse one SSE `data: {...}` line from a DeepSeek/OpenAI-style stream. */
function parseStreamLine(line) {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('data:')) return { done: false, delta: '' };
  const data = trimmed.slice(5).trim();
  if (data === '[DONE]') return { done: true, delta: '' };
  const payload = JSON.parse(data);
  return { done: false, delta: payload?.choices?.[0]?.delta?.content || '' };
}

/** Streaming chat completion — calls onToken(delta) as text arrives. */
async function callChatStream(messages, options = {}, onToken = () => {}) {
  const apiKey = requireApiKey();
  const body = buildBody(messages, options, true);

  const response = await fetchWithTimeout(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`DeepSeek API error (${response.status}): ${errorBody.slice(0, 300)}`);
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    throw new Error(`DeepSeek stream response was not readable: ${text.slice(0, 200)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = parseStreamLine(line);
      if (parsed.done) return { text: fullText.trim(), provider: 'deepseek' };
      if (parsed.delta) { fullText += parsed.delta; onToken(parsed.delta); }
    }
  }

  if (buffer.trim()) {
    const parsed = parseStreamLine(buffer);
    if (parsed.delta) { fullText += parsed.delta; onToken(parsed.delta); }
  }

  return { text: fullText.trim(), provider: 'deepseek' };
}

module.exports = { callChat, callChatStream, DEEPSEEK_MODEL };
