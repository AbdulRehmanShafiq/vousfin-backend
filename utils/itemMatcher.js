// utils/itemMatcher.js
//
// Inventory-item name matching for the NL parser — the SAME 3-tier algorithm
// (exact → substring → word overlap) as account matching, so "rice" resolves
// to "Rice (bag)" exactly the way "Rent" resolves to "Rent Expense".
// Items must be plain objects (lean docs) — mongoose documents would lose
// their prototype under the spread below.
'use strict';
const { matchAccountByName } = require('./accountMatcher');

const NONE = { item: null, confidence: 0, matchType: 'none' };

/**
 * @param {Array<{_id, name}>} items  the business's live inventory items (lean)
 * @param {string} name               free-text goods name from the parse
 * @returns {{ item: object|null, confidence: number, matchType: string }}
 */
function matchItemByName(items, name) {
  if (!Array.isArray(items) || items.length === 0 || !name) return { ...NONE };
  const shaped = items.map((i) => ({ ...i, accountName: i.name }));
  const res = matchAccountByName(shaped, name);
  if (!res.account) return { ...NONE };
  const { accountName, ...item } = res.account;
  return { item, confidence: res.confidence, matchType: res.matchType };
}

module.exports = { matchItemByName };
