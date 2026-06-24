// utils/totp.util.js
// Zero-dependency RFC-6238 (TOTP) + RFC-4226 (HOTP) using Node's crypto.
// Chosen over otplib because otplib@13 is ESM-first and fails to require() in the
// Vercel serverless (CommonJS) runtime — which broke MFA in production.
'use strict';
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648 base32

function base32Decode(input) {
  const clean = String(input).replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// RFC 4226 HOTP with dynamic truncation.
function hotp(key, counter, digits) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, '0');
}

function generateToken(secret, { time = Date.now(), step = 30, digits = 6 } = {}) {
  const counter = Math.floor(time / 1000 / step);
  return hotp(base32Decode(secret), counter, digits);
}

// Accepts the code for the current step and `window` steps either side (clock skew).
function verifyToken(secret, token, { window = 1, time = Date.now(), step = 30, digits = 6 } = {}) {
  if (!token) return false;
  const key = base32Decode(secret);
  const counter = Math.floor(time / 1000 / step);
  const t = String(token).trim();
  for (let i = -window; i <= window; i++) {
    if (hotp(key, counter + i, digits) === t) return true;
  }
  return false;
}

function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

// otpauth:// URI for authenticator-app QR/setup-key import.
function keyuri(label, issuer, secret) {
  const i = encodeURIComponent(issuer);
  return `otpauth://totp/${i}:${encodeURIComponent(label)}?secret=${secret}&issuer=${i}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { generateSecret, generateToken, verifyToken, keyuri, base32Encode, base32Decode };
