// utils/accountMatcher.js
//
// Pure, DB-free account-name matching shared by:
//   - repositories/account.repository.js (Excel/manual name resolution)
//   - services/nlParser/services/parserService.js (resolves Gemini's suggested
//     account names against the already-loaded live CoA, in-memory — no extra
//     DB round-trip, and gives the NL confidence score a REAL number instead
//     of an LLM self-reported one).
//
// Same 3-tier strategy the resolver has always used, but now returns a
// confidence score + matchType instead of a bare account, and picks the best
// candidate by word-overlap when multiple accounts share a substring (the old
// silent-ambiguity bug — it used to just take the first document-order hit).

const NONE = { account: null, confidence: 0, matchType: 'none' };

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Two words "overlap" only if they're an exact match, or both are long enough
// (>=4 chars) that a substring containment is meaningful. Without the length
// floor, short common words falsely collide — e.g. "totally" contains "at" as
// a substring, which would wrongly count as an overlap with "Cash at Bank".
function wordsOverlap(a, b) {
  if (a === b) return true;
  return a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a));
}

function wordOverlapScore(nameWords, accountName) {
  // >2 filter matches the query-word filter below, so short filler words
  // ("at", "of", "&") never participate in either side of the comparison.
  const accWords = accountName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  return nameWords.filter(w => accWords.some(aw => wordsOverlap(aw, w))).length;
}

/**
 * @param {Array<{_id, accountName}>} accounts  the business's live Chart of Accounts
 * @param {string} name  the account name to resolve (e.g. Gemini's suggestion, an Excel cell)
 * @returns {{ account: object|null, confidence: number, matchType: 'exact'|'fuzzy'|'ambiguous'|'none' }}
 */
function matchAccountByName(accounts, name) {
  if (!name || !Array.isArray(accounts) || accounts.length === 0) return NONE;
  const cleanName = String(name).trim();
  if (!cleanName) return NONE;

  // 1. Exact case-insensitive match
  const exactRe = new RegExp(`^${escapeRegExp(cleanName)}$`, 'i');
  const exact = accounts.find(a => exactRe.test(a.accountName));
  if (exact) return { account: exact, confidence: 1.0, matchType: 'exact' };

  // 2. Substring match — one hit is a confident fuzzy match; multiple hits are
  // ambiguous, resolved by picking the best whole-word overlap (not doc order).
  const substrRe = new RegExp(escapeRegExp(cleanName), 'i');
  const partials = accounts.filter(a => substrRe.test(a.accountName));
  if (partials.length === 1) {
    return { account: partials[0], confidence: 0.75, matchType: 'fuzzy' };
  }
  if (partials.length > 1) {
    // Every candidate already contains the query as a substring — the
    // differentiator is which one is the *tightest* fit. Prefer the account
    // name closest in length to the query (e.g. "Rent" over "Rent — Equipment
    // & Machinery"), not document order.
    let best = partials[0], bestDiff = Infinity;
    for (const a of partials) {
      const diff = Math.abs(a.accountName.length - cleanName.length);
      if (diff < bestDiff) { bestDiff = diff; best = a; }
    }
    return { account: best, confidence: 0.5, matchType: 'ambiguous' };
  }

  // 3. Word-overlap fuzzy match — find the account with the most shared words.
  const words = cleanName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (words.length) {
    let best = null, bestScore = 0;
    for (const a of accounts) {
      const score = wordOverlapScore(words, a.accountName);
      if (score > bestScore) { bestScore = score; best = a; }
    }
    if (bestScore > 0) {
      const confidence = Math.round((0.4 + 0.1 * Math.min(bestScore, 3)) * 100) / 100;
      return { account: best, confidence, matchType: 'fuzzy' };
    }
  }

  return NONE;
}

module.exports = { matchAccountByName };
