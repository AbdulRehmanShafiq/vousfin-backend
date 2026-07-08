'use strict';

/**
 * embeddingService unit tests.
 *
 * DeepSeek has no embeddings endpoint, so this service always returns a
 * deterministic local embedding — no network calls at all. These tests lock
 * in the invariants that matter for RAG: every vector is exactly DIMENSIONS
 * long (must match the Atlas Vector Search index), the same text always
 * produces the same vector, and no fetch is ever made.
 */

const realFetch = global.fetch;

describe('embeddingService (local deterministic embeddings)', () => {
  let embeddingService;
  let DIMENSIONS;
  let fetchSpy;

  beforeEach(() => {
    jest.resetModules();
    fetchSpy = jest.fn();
    global.fetch = fetchSpy;
    embeddingService = require('../../../services/embeddingService');
    DIMENSIONS = embeddingService.DIMENSIONS;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  test('embedQuery returns a vector of exactly DIMENSIONS length', async () => {
    const vec = await embeddingService.embedQuery('cash flow');
    expect(vec).toHaveLength(DIMENSIONS);
  });

  test('embedQuery is deterministic — same text yields the same vector', async () => {
    const a = await embeddingService.embedQuery('monthly cash flow');
    const b = await embeddingService.embedQuery('monthly cash flow');
    expect(a).toEqual(b);
  });

  test('embedDocuments returns one DIMENSIONS-length vector per input, in order', async () => {
    const vecs = await embeddingService.embedDocuments(['rent', 'salary']);
    expect(vecs).toHaveLength(2);
    expect(vecs[0]).toHaveLength(DIMENSIONS);
    expect(vecs[1]).toHaveLength(DIMENSIONS);
    expect(vecs[0]).not.toEqual(vecs[1]);
  });

  test('never makes a network call', async () => {
    await embeddingService.embedQuery('cash flow');
    await embeddingService.embedDocuments(['rent', 'salary']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('rejects empty or non-string input', async () => {
    await expect(embeddingService.embedQuery('')).rejects.toThrow(/non-empty string/);
    await expect(embeddingService.embedQuery(null)).rejects.toThrow(/non-empty string/);
  });
});
