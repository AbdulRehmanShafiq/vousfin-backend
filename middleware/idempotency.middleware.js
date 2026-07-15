// middleware/idempotency.middleware.js
//
// Retry-safety for the postings that are REPEATABLE ON PURPOSE.
//
// The poster demands every caller declare its idempotency (a stable key, or an
// explicit null). Most postings have a natural once-ever key derived from the
// document — `invoice-ar:<id>` — and the database enforces it.
//
// But some operations are legitimately repeatable: the same BOM is built again
// tomorrow, and two identical write-offs on one day are a real thing an owner
// does. A key derived from the entity would block the second VALID one, so those
// pass null — which leaves a genuine gap: a double-tap or a network retry posts
// twice, and both are indistinguishable from two deliberate actions.
//
// Only the CALLER knows which it is. So the caller supplies the key, and this is
// the seam where it enters: standard `Idempotency-Key` header → req.idempotencyKey
// → the service namespaces it → the same unique index does the rest.
//
// Absent header = absent key = today's behaviour, unchanged. This adds
// protection for clients that ask for it; it never invents one, because a key we
// invented (a body hash, say) could not tell a retry from a deliberate repeat.
'use strict';

const { ApiError } = require('../utils/ApiError');

const MAX_LEN = 200;

/**
 * Reads the `Idempotency-Key` request header onto `req.idempotencyKey`.
 *
 * Validates shape only — meaning is the service's business. A malformed key is
 * rejected rather than ignored: a client that thinks it is protected and is not
 * is worse off than one that knows it failed.
 */
function idempotencyKey(req, _res, next) {
  const raw = req.get('Idempotency-Key');
  if (raw === undefined) {
    req.idempotencyKey = null; // no claim made
    return next();
  }
  const key = String(raw).trim();
  if (!key) {
    return next(new ApiError(400, 'Idempotency-Key was sent but is empty. Omit the header, or send a stable unique value.'));
  }
  if (key.length > MAX_LEN) {
    return next(new ApiError(400, `Idempotency-Key must be ${MAX_LEN} characters or fewer.`));
  }
  req.idempotencyKey = key;
  return next();
}

module.exports = { idempotencyKey };
