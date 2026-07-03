// utils/moduleShortcuts.helper.js — pure ranking for the dashboard's
// "your most-used" module shortcuts.
//
// Blends frequency (how often a module is opened/searched) with recency, so the
// shortcuts reflect what the owner actually works in. A module holds its slot
// until another out-ranks it. Returns only display fields — never the counters.
'use strict';

const DEFAULT_LIMIT = 5;

/**
 * @param {Array<{moduleKey, label, path, count, lastUsedAt}>} usages
 * @param {{limit?:number}} opts
 * @returns {Array<{moduleKey, label, path}>}
 */
function rankShortcuts(usages = [], { limit = DEFAULT_LIMIT } = {}) {
  if (!Array.isArray(usages) || usages.length === 0) return [];
  return [...usages]
    .sort((a, b) => {
      const c = (b.count || 0) - (a.count || 0);
      if (c !== 0) return c; // frequency first
      return new Date(b.lastUsedAt || 0) - new Date(a.lastUsedAt || 0); // recency breaks ties
    })
    .slice(0, Math.max(1, limit))
    .map(({ moduleKey, label, path }) => ({ moduleKey, label, path }));
}

module.exports = { rankShortcuts, DEFAULT_LIMIT };
