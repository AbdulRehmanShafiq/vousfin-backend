/**
 * tests/unit/middleware/idempotency.middleware.test.js
 *
 * The seam where a caller's retry-safety claim enters the system.
 *
 * Only the caller can distinguish a retry from a second deliberate action for
 * the operations that are repeatable on purpose (a build, a stock adjustment).
 * This middleware carries that claim; the shape rules matter because a client
 * that BELIEVES it is protected and is not is worse off than one that knows it
 * failed.
 */
'use strict';

const { idempotencyKey } = require('../../../middleware/idempotency.middleware');

const reqWith = (value) => ({ get: (h) => (h === 'Idempotency-Key' ? value : undefined) });
const run = (req) => new Promise((resolve) => idempotencyKey(req, {}, resolve));

describe('Idempotency-Key middleware', () => {
  it('carries a supplied key onto the request', async () => {
    const req = reqWith('abc-123');
    const err = await run(req);
    expect(err).toBeUndefined();
    expect(req.idempotencyKey).toBe('abc-123');
  });

  it('trims surrounding whitespace', async () => {
    const req = reqWith('  abc-123  ');
    await run(req);
    expect(req.idempotencyKey).toBe('abc-123');
  });

  it('treats an absent header as no claim, not as an error', async () => {
    // Absent key = today's behaviour, unchanged. This adds protection for
    // clients that ask for it; it never invents one.
    const req = reqWith(undefined);
    const err = await run(req);
    expect(err).toBeUndefined();
    expect(req.idempotencyKey).toBeNull();
  });

  it('rejects an empty key rather than silently ignoring it', async () => {
    // Sending the header means the client thinks it is protected. Quietly
    // dropping a blank one would leave it believing that, wrongly.
    const err = await run(reqWith('   '));
    expect(err).toBeTruthy();
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/empty/i);
  });

  it('rejects an over-long key', async () => {
    const err = await run(reqWith('x'.repeat(201)));
    expect(err).toBeTruthy();
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/200 characters/i);
  });
});
