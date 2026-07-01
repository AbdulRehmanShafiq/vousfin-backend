// services/learnedResolution.service.js — closed learning loop (Intelligence
// Roadmap Phase 1): learn description → account mappings from confirmed
// transactions, and recall them to beat a fuzzy guess next time.
//
// Built on the existing per-tenant EntityMemory store. Best-effort throughout:
// learning/recall never breaks or blocks the transaction path.
'use strict';
const entityMemory = require('./entityMemory.service');
const { deriveLearningKey } = require('../utils/learningKey.helper');
const logger = require('../config/logger');

const KIND = 'nl_description_accounts';

/**
 * Reinforce that this description resolves to these accounts (captures both a
 * plain confirmation and a user correction — we always learn the FINAL choice).
 * No-op if the description yields no stable key or an account name is missing.
 */
async function learnAccountsFromConfirmation(businessId, description, { debitAccountName, creditAccountName } = {}) {
  const key = deriveLearningKey(description);
  if (!key || !debitAccountName || !creditAccountName) return;
  try {
    await entityMemory.learn(businessId, KIND, key, { debitAccountName, creditAccountName });
  } catch (err) {
    logger.warn(`[learnedResolution] learn failed (non-fatal): ${err.message}`);
  }
}

/**
 * Recall a learned account mapping for a description.
 * @returns {Promise<{debitAccountName, creditAccountName, hits}|null>}
 */
async function recallAccounts(businessId, description) {
  const key = deriveLearningKey(description);
  if (!key) return null;
  try {
    const hit = await entityMemory.suggest(businessId, KIND, key);
    if (!hit || !hit.value) return null;
    const { debitAccountName, creditAccountName } = hit.value;
    if (!debitAccountName || !creditAccountName) return null;
    return { debitAccountName, creditAccountName, hits: hit.hits };
  } catch (err) {
    logger.warn(`[learnedResolution] recall failed (non-fatal): ${err.message}`);
    return null;
  }
}

module.exports = { learnAccountsFromConfirmation, recallAccounts, KIND };
