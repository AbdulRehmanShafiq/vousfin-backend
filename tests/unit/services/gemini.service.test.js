'use strict';

/**
 * gemini.service unit tests.
 *
 * Gemini is the app's ONLY multimodal provider — used for reading receipt/bill
 * photos (DeepSeek is text-only). These tests lock in the invariants that matter:
 * the request carries the image as inline_data + asks for JSON, a missing key
 * fails loudly (so callers can degrade), transient 429/503 is retried, and the
 * model's text reply is returned unwrapped.
 */

const realFetch = global.fetch;

function okResponse(text) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
    text: async () => text,
  };
}

function errResponse(status, body = '') {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  };
}

describe('gemini.service (vision client)', () => {
  let gemini;
  let fetchSpy;
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV, GEMINI_API_KEY: 'test-key', AI_MODEL_MAX_RETRIES: '2' };
    fetchSpy = jest.fn();
    global.fetch = fetchSpy;
    gemini = require('../../../services/gemini.service');
  });

  afterEach(() => {
    global.fetch = realFetch;
    process.env = OLD_ENV;
  });

  test('callVision returns the model text + provider tag', async () => {
    fetchSpy.mockResolvedValueOnce(okResponse('{"amount":500}'));
    const out = await gemini.callVision('BASE64DATA', 'image/jpeg', { system: 'sys', user: 'usr' });
    expect(out).toEqual({ text: '{"amount":500}', provider: 'gemini' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('sends the image as inline_data and requests JSON output', async () => {
    fetchSpy.mockResolvedValueOnce(okResponse('{}'));
    await gemini.callVision('BASE64DATA', 'image/png', { system: 'S', user: 'U' });

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toMatch(/:generateContent/);
    expect(url).not.toContain('test-key'); // key must NOT be in the query string (privacy)
    expect(opts.headers['x-goog-api-key']).toBe('test-key');
    const body = JSON.parse(opts.body);
    const parts = body.contents[0].parts;
    const inline = parts.find((p) => p.inline_data);
    expect(inline.inline_data).toEqual({ mime_type: 'image/png', data: 'BASE64DATA' });
    expect(parts.some((p) => p.text)).toBe(true);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });

  test('throws a clear error when GEMINI_API_KEY is missing', async () => {
    delete process.env.GEMINI_API_KEY;
    jest.resetModules();
    gemini = require('../../../services/gemini.service');
    await expect(gemini.callVision('X', 'image/jpeg', { user: 'u' })).rejects.toThrow(/GEMINI_API_KEY/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('retries once on a 503 then succeeds', async () => {
    fetchSpy
      .mockResolvedValueOnce(errResponse(503, 'overloaded'))
      .mockResolvedValueOnce(okResponse('{"ok":true}'));
    const out = await gemini.callVision('X', 'image/jpeg', { user: 'u' });
    expect(out.text).toBe('{"ok":true}');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test('surfaces an overloaded flag after exhausting retries', async () => {
    fetchSpy.mockResolvedValue(errResponse(429, 'rate limited'));
    await expect(gemini.callVision('X', 'image/jpeg', { user: 'u' })).rejects.toMatchObject({
      isOverloaded: true,
    });
  });

  test('throws when the model returns no text', async () => {
    fetchSpy.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ candidates: [] }),
      text: async () => '',
    });
    await expect(gemini.callVision('X', 'image/jpeg', { user: 'u' })).rejects.toThrow(/empty|no text/i);
  });
});
