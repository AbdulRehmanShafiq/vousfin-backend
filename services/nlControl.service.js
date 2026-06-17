// services/nlControl.service.js
//
// Autonomy roadmap Phase 7 — the natural-language control line.
//
// The owner types plain English ("raise tax to autopilot", "don't pay ACME until
// I say so") and it becomes a structured policy change. Deliberately rules-based,
// not an LLM: these commands change how much VousFin is trusted to act (and can
// hold payments), so interpretation must be deterministic, explainable and
// testable. Anything it doesn't clearly understand, it asks about rather than
// guessing.
//
'use strict';
const policy = require('./autonomyPolicy.service');
const paymentsAgent = require('./paymentsAgent.service');
const Vendor = require('../models/Vendor.model');
const { AUTONOMY_CAPABILITIES, AUTONOMY_LEVELS } = require('../config/constants');

// Plain-language → capability / level.
const CAP_SYNONYMS = {
  bookkeeping:    ['bookkeeping', 'book-keeping', 'books', 'bookkeeper'],
  reconciliation: ['reconciliation', 'reconcile', 'reconciling', 'bank matching', 'bank rec'],
  collections:    ['collections', 'collecting', 'chasing', 'chase', 'dunning', 'reminders'],
  payments:       ['payments', 'paying', 'pay bills', 'bill payments'],
  tax:            ['tax', 'taxes', 'gst', 'fbr'],
  close:          ['month-end', 'month end', 'closing', 'close the books', 'close'],
  advisory:       ['advisory', 'advice', 'insights', 'advisor'],
};
const LEVEL_SYNONYMS = {
  observe:   ['observe', 'observing', 'watch only', 'just watch', 'off'],
  suggest:   ['suggest', 'suggestions', 'suggesting', 'manual', 'ask me', 'ask first'],
  copilot:   ['co-pilot', 'copilot', 'co pilot', 'with approval', 'with my approval'],
  autopilot: ['autopilot', 'auto-pilot', 'automatic', 'automatically', 'full auto', 'auto'],
};
const LEVEL_LABEL = { observe: 'Observe', suggest: 'Suggest', copilot: 'Co-pilot', autopilot: 'Autopilot' };
const CAP_LABEL = {
  bookkeeping: 'Bookkeeping', reconciliation: 'Reconciliation', collections: 'Collections',
  payments: 'Payments', tax: 'Tax', close: 'Month-end close', advisory: 'Advisory',
};

const firstMatch = (text, table) => {
  for (const [key, words] of Object.entries(table)) {
    if (words.some(w => text.includes(w)) || text.includes(key)) return key;
  }
  return null;
};

const notUnderstood = (extra = '') => ({
  understood: false,
  message: `I didn't quite catch that.${extra} Try things like "set tax to autopilot", "raise collections to co-pilot", or "don't pay ACME for now".`,
});

/** Interpret one control-line command and apply it. */
async function interpret(businessId, rawText, actor) {
  const text = String(rawText || '').toLowerCase().trim();
  if (!text) return notUnderstood();

  // 1) Payment hold / release — check before dials so "don't pay {vendor}" isn't
  //    read as a Payments dial change. Requires a clear payment-hold phrase so a
  //    bare "hold" doesn't trigger a vendor lookup.
  const holdVendor =
    text.match(/(?:do ?n'?t pay|stop paying|hold payments? (?:to|for))\s+(.+?)(?:\s+(?:until.*|for now|please))?\s*$/)?.[1]
    || text.match(/put\s+(.+?)\s+on hold/)?.[1];
  if (holdVendor) return applyHold(businessId, holdVendor, true);

  const releaseVendor =
    text.match(/(?:resume paying|start paying|release|unhold|you can pay)\s+(.+?)(?:\s+again|\s+now)?\s*$/)?.[1];
  if (releaseVendor) return applyHold(businessId, releaseVendor, false);

  // 2) Dial change — needs both a capability and a level.
  const capability = firstMatch(text, CAP_SYNONYMS);
  const level = firstMatch(text, LEVEL_SYNONYMS);
  if (capability && level) {
    await policy.setCapability(businessId, capability, { level }, actor?.id || null);
    return {
      understood: true, kind: 'dial', data: { capability, level },
      message: `Done — ${CAP_LABEL[capability]} is now on ${LEVEL_LABEL[level]}.`,
    };
  }
  if (level && !capability) return notUnderstood(' Which area? (bookkeeping, payments, collections, tax…)');
  if (capability && !level) return notUnderstood(` How much should ${CAP_LABEL[capability]} act? (observe, suggest, co-pilot, autopilot)`);

  return notUnderstood();
}

/** Resolve a vendor by (fuzzy) name and set / clear its payment hold. */
async function applyHold(businessId, vendorPhrase, hold) {
  const name = String(vendorPhrase || '').replace(/\b(the|a|an|please|for now|until i say|vendor)\b/g, '').trim();
  if (!name) return notUnderstood(' Which vendor?');
  let vendor;
  try {
    vendor = await Vendor.findOne({ businessId, vendorName: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).lean();
  } catch { /* ignore */ }
  if (!vendor) return { understood: false, message: `I couldn't find a vendor matching "${name}". Check the name and try again.` };

  await paymentsAgent.setVendorHold(businessId, vendor._id, hold);
  return {
    understood: true, kind: hold ? 'payment_hold' : 'payment_release',
    data: { vendorId: String(vendor._id), vendorName: vendor.vendorName, hold },
    message: hold
      ? `Okay — I won't propose paying ${vendor.vendorName} until you lift the hold.`
      : `Done — ${vendor.vendorName} is back in the payment runs.`,
  };
}

module.exports = { interpret, CAP_SYNONYMS, LEVEL_SYNONYMS };
