// tests/unit/utils/totp.util.test.js
// Zero-dependency RFC-6238 TOTP — verified against RFC-6238 Appendix B known-answer vectors.
// RFC secret is the ASCII string "12345678901234567890" = base32 "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".
'use strict';
const totp = require('../../../utils/totp.util');

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('totp.util (RFC-6238)', () => {
  test('generateToken matches the RFC vector at T=59s (6 digits = 287082)', () => {
    expect(totp.generateToken(RFC_SECRET, { time: 59 * 1000 })).toBe('287082');
  });

  test('generateToken matches the RFC vector at T=1111111109 (081804)', () => {
    expect(totp.generateToken(RFC_SECRET, { time: 1111111109 * 1000 })).toBe('081804');
  });

  test('verifyToken accepts the code generated for the same time', () => {
    const t = totp.generateToken(RFC_SECRET, { time: 1234567890 * 1000 });
    expect(totp.verifyToken(RFC_SECRET, t, { time: 1234567890 * 1000 })).toBe(true);
  });

  test('verifyToken rejects a wrong code', () => {
    expect(totp.verifyToken(RFC_SECRET, '000000', { time: 1234567890 * 1000 })).toBe(false);
  });

  test('verifyToken honours the time window (accepts the previous 30s step)', () => {
    const prev = totp.generateToken(RFC_SECRET, { time: (1234567890 - 30) * 1000 });
    expect(totp.verifyToken(RFC_SECRET, prev, { time: 1234567890 * 1000, window: 1 })).toBe(true);
  });

  test('verifyToken outside the window is rejected', () => {
    const old = totp.generateToken(RFC_SECRET, { time: (1234567890 - 120) * 1000 });
    expect(totp.verifyToken(RFC_SECRET, old, { time: 1234567890 * 1000, window: 1 })).toBe(false);
  });

  test('generateSecret returns a base32 string', () => {
    const s = totp.generateSecret();
    expect(s).toMatch(/^[A-Z2-7]+$/);
    expect(s.length).toBeGreaterThanOrEqual(16);
  });

  test('round-trips a freshly generated secret at the current time', () => {
    const s = totp.generateSecret();
    const t = totp.generateToken(s);
    expect(totp.verifyToken(s, t)).toBe(true);
  });
});
