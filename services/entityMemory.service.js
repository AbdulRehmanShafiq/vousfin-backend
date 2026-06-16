// services/entityMemory.service.js
//
// Autonomy roadmap Phase 1 — learn + recall per-entity associations. Agents call
// learn() when a human confirms a mapping, and suggest() to pre-fill the next
// proposal with higher confidence. Best-effort: learning never breaks the flow.
//
'use strict';
const mongoose = require('mongoose');
const logger = require('../config/logger');

const EntityMemory = () => mongoose.model('EntityMemory');

/** Reinforce (businessId, kind, key) → value. Returns the stored doc or null. */
async function learn(businessId, kind, key, value) {
  try {
    return await EntityMemory().findOneAndUpdate(
      { businessId, kind, key: String(key) },
      { $set: { value, lastSeen: new Date() }, $inc: { hits: 1 }, $setOnInsert: { businessId, kind, key: String(key) } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
  } catch (e) {
    logger.warn(`[entityMemory] learn failed: ${e.message}`);
    return null;
  }
}

/** Recall a learned value. @returns {Promise<{value:any, hits:number}|null>} */
async function suggest(businessId, kind, key) {
  const doc = await EntityMemory().findOne({ businessId, kind, key: String(key) }).lean();
  return doc ? { value: doc.value, hits: doc.hits } : null;
}

module.exports = { learn, suggest };
