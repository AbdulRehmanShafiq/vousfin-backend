const { extractJSON } = require('./nlParser/services/geminiService');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_CHAT_MODEL || process.env.GEMINI_MODEL || 'gemini-flash-latest';
const TIMEOUT_MS = parseInt(process.env.AI_MODEL_TIMEOUT_MS, 10) || 30000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function callGroq(messages, options = {}, retries = 2) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY environment variable is not set');
  }

  const body = {
    model: options.model || DEFAULT_GROQ_MODEL,
    messages,
    temperature: options.temperature ?? 0.5,
    max_tokens: options.max_tokens || options.maxTokens || 800,
    stream: false,
  };

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(GROQ_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`Groq API error (${response.status}): ${errorBody.slice(0, 300)}`);
      }

      const payload = await response.json();
      const text = payload?.choices?.[0]?.message?.content;
      if (!text) throw new Error('Groq returned an empty response');
      return text.trim();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(1200 * attempt);
    }
  }

  throw lastError;
}

function emitChunkedText(text, onToken) {
  const value = String(text || '');
  if (!value) return;
  const chunks = value.match(/\S+\s*/g) || [value];
  chunks.forEach((chunk) => onToken(chunk));
}

function parseGroqStreamLine(line) {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('data:')) return { done: false, delta: '' };
  const data = trimmed.slice(5).trim();
  if (data === '[DONE]') return { done: true, delta: '' };

  const payload = JSON.parse(data);
  return {
    done: false,
    delta: payload?.choices?.[0]?.delta?.content || '',
  };
}

async function callGroqStream(messages, options = {}, onToken = () => {}) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY environment variable is not set');
  }

  const body = {
    model: options.model || DEFAULT_GROQ_MODEL,
    messages,
    temperature: options.temperature ?? 0.5,
    max_tokens: options.max_tokens || options.maxTokens || 800,
    stream: true,
  };

  const response = await fetchWithTimeout(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Groq API error (${response.status}): ${errorBody.slice(0, 300)}`);
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    throw new Error(`Groq stream response was not readable: ${text.slice(0, 200)}`);
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
      const parsed = parseGroqStreamLine(line);
      if (parsed.done) return fullText.trim();
      if (parsed.delta) {
        fullText += parsed.delta;
        onToken(parsed.delta);
      }
    }
  }

  if (buffer.trim()) {
    const parsed = parseGroqStreamLine(buffer);
    if (parsed.delta) {
      fullText += parsed.delta;
      onToken(parsed.delta);
    }
  }

  return fullText.trim();
}

async function callGemini(messages, options = {}) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY environment variable is not set');
  }

  const system = messages.find((message) => message.role === 'system')?.content || '';
  const contents = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    }));

  const response = await fetchWithTimeout(
    `${GEMINI_API_BASE}/${DEFAULT_GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: system ? { parts: [{ text: system }] } : undefined,
        contents,
        generationConfig: {
          temperature: options.temperature ?? 0.4,
          maxOutputTokens: options.max_tokens || options.maxTokens || 800,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Gemini API error (${response.status}): ${errorBody.slice(0, 300)}`);
  }

  const payload = await response.json();
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned an empty response');
  return text.trim();
}

async function callChat(messages, options = {}) {
  const preferred = options.provider || process.env.AI_PRIMARY_PROVIDER || 'groq';

  if (preferred === 'gemini') {
    try {
      return { text: await callGemini(messages, options), provider: 'gemini' };
    } catch (error) {
      return { text: await callGroq(messages, options), provider: 'groq' };
    }
  }

  try {
    return { text: await callGroq(messages, options), provider: 'groq' };
  } catch (error) {
    return { text: await callGemini(messages, options), provider: 'gemini' };
  }
}

async function callChatStream(messages, options = {}, onToken = () => {}) {
  const preferred = options.provider || process.env.AI_PRIMARY_PROVIDER || 'groq';

  if (preferred === 'gemini') {
    try {
      const text = await callGemini(messages, options);
      emitChunkedText(text, onToken);
      return { text, provider: 'gemini' };
    } catch (error) {
      const text = await callGroqStream(messages, options, onToken);
      return { text, provider: 'groq' };
    }
  }

  try {
    const text = await callGroqStream(messages, options, onToken);
    return { text, provider: 'groq' };
  } catch (error) {
    const text = await callGemini(messages, options);
    emitChunkedText(text, onToken);
    return { text, provider: 'gemini' };
  }
}

module.exports = {
  callGroq,
  callGroqStream,
  callGemini,
  callChat,
  callChatStream,
  extractJSON,
  emitChunkedText,
};
