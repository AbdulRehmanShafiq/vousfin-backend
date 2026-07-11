// services/nlParser/constants/clarificationAnswers.js
//
// The clarification loop is stateless: option-button answers are appended to
// the re-parse text verbatim. These literals are therefore a CONTRACT between
// clarificationBuilder (which offers them), the frontend (which echoes them),
// and intentResolver (which detects them). Change them only together.
'use strict';

const ANSWER_OPTIONS = Object.freeze({
  RESALE:       "Sell it again (it's stock)",
  BUSINESS_USE: 'Use it in the business',
  ASSET:        "It's equipment we'll keep",
  ADD_ITEM_YES: 'Yes, add it',
  ADD_ITEM_NO:  'No — record without stock tracking',
});

/**
 * @param {string} rawText  the full (re-)parse input including appended answers
 * @returns {{ intentAnswer: 'resale'|'business_use'|'long_term_asset'|null, itemConsent: boolean|null }}
 */
function detectAnswers(rawText) {
  const t = String(rawText || '').toLowerCase();
  let intentAnswer = null;
  if (t.includes('sell it again')) intentAnswer = 'resale';
  else if (t.includes('use it in the business')) intentAnswer = 'business_use';
  else if (t.includes("equipment we'll keep") || t.includes('equipment we will keep')) intentAnswer = 'long_term_asset';

  let itemConsent = null;
  if (t.includes('yes, add it')) itemConsent = true;
  else if (t.includes('record without stock tracking')) itemConsent = false;

  return { intentAnswer, itemConsent };
}

module.exports = { ANSWER_OPTIONS, detectAnswers };
