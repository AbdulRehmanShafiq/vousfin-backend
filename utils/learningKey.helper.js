// utils/learningKey.helper.js — pure normalization for the closed learning loop
// (Intelligence Roadmap Phase 1).
//
// Turns a free-text transaction description into a stable per-tenant key so that
// recurring entries ("Paid electricity bill 5000", "Paid electricity bill 6200
// on 2025-01-15") collapse to the SAME key and can share a learned account
// mapping. Volatile parts — amounts, currency symbols, dates, reference numbers,
// punctuation — are stripped; only meaningful word-stems survive.
'use strict';

const MAX_KEY_LEN = 200;
const MIN_TOKEN_LEN = 3; // drops filler/prepositions/currency codes ("on", "rs", "of")

/**
 * @param {string} description
 * @returns {string|null} a stable lowercase key, or null if nothing meaningful survives
 */
function deriveLearningKey(description) {
  if (!description) return null;
  const tokens = String(description)
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z]/g, '')) // keep letters only → strips digits, dates, currency, punctuation
    .filter((t) => t.length >= MIN_TOKEN_LEN);
  if (tokens.length === 0) return null;
  return tokens.join(' ').slice(0, MAX_KEY_LEN).trim();
}

module.exports = { deriveLearningKey };
