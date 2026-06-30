'use strict';

/**
 * embeddingService unit tests.
 *
 * The Gemini `gemini-embedding-001` model returns 3072-dimensional vectors by
 * default, but our Atlas Vector Search index and the local deterministic
 * fallback are both 768-dimensional. A mismatch makes every retrieval fall back
 * to local cosine over incompatible vector lengths (garbage scores → refusals).
 *
 * These tests lock in the invariant: every embedding the service returns —
 * whether from the API or the local fallback — must be exactly DIMENSIONS long,
 * and the API request must explicitly pin outputDimensionality to DIMENSIONS.
 */

const realFetch = global.fetch;

function mockGeminiResponse(values) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ embedding: { values } }),
    text: async () => '',
  };
}

function mockGeminiBatchResponse(valuesList) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ embeddings: valuesList.map((values) => ({ values })) }),
    text: async () => '',
  };
}

describe('embeddingService dimension pinning', () => {
  let embeddingService;
  let DIMENSIONS;

  beforeEach(() => {
    jest.resetModules();
    process.env.GEMINI_API_KEY = 'test-key';
    delete process.env.AI_EMBEDDINGS_LOCAL;
    process.env.NODE_ENV = 'production'; // force the API path, not the test-mode local fallback
    embeddingService = require('../../../services/embeddingService');
    DIMENSIONS = embeddingService.DIMENSIONS;
  });

  afterEach(() => {
    global.fetch = realFetch;
    process.env.NODE_ENV = 'test';
  });

  test('embedQuery requests outputDimensionality = DIMENSIONS', async () => {
    let capturedBody;
    global.fetch = jest.fn(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return mockGeminiResponse(new Array(DIMENSIONS).fill(0.5));
    });

    await embeddingService.embedQuery('cash flow');

    expect(capturedBody.outputDimensionality).toBe(DIMENSIONS);
  });

  test('embedQuery returns a vector of exactly DIMENSIONS length even if API returns more', async () => {
    // Simulate an API that ignored outputDimensionality and returned 3072 dims.
    global.fetch = jest.fn(async () => mockGeminiResponse(new Array(3072).fill(0.1)));

    const vec = await embeddingService.embedQuery('cash flow');

    expect(vec).toHaveLength(DIMENSIONS);
  });

  test('embedDocuments returns DIMENSIONS-length vectors and pins outputDimensionality', async () => {
    let capturedBody;
    global.fetch = jest.fn(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return mockGeminiBatchResponse([new Array(3072).fill(0.2), new Array(3072).fill(0.3)]);
    });

    const vecs = await embeddingService.embedDocuments(['rent', 'salary']);

    expect(vecs).toHaveLength(2);
    expect(vecs[0]).toHaveLength(DIMENSIONS);
    expect(vecs[1]).toHaveLength(DIMENSIONS);
    // outputDimensionality must be set on each request in the batch
    expect(capturedBody.requests[0].outputDimensionality).toBe(DIMENSIONS);
  });

  test('local fallback (on API error) also yields DIMENSIONS-length vectors', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: 'denied' } }),
      text: async () => '{"error":"denied"}',
    }));

    const q = await embeddingService.embedQuery('cash flow');
    const d = await embeddingService.embedDocuments(['rent']);

    expect(q).toHaveLength(DIMENSIONS);
    expect(d[0]).toHaveLength(DIMENSIONS);
  });
});
