// services/returnValidator.service.js — FR-04.3
//
// Pre-filing gate: run the FBR rejection-rule catalog over a prepared return,
// persist the result, and promote draft → validated when it passes. Catches the
// common rejection reasons (with a fix) before submission.
//
'use strict';
const mongoose = require('mongoose');
const { ApiError } = require('../utils/ApiError');
const { rulesFor } = require('../config/fbrRejectionRules');
const { RETURN_TRANSITIONS, TAX_RETURN_STATUS } = require('../config/constants');
const taxReturnRepo = require('../repositories/taxReturn.repository');

const Business           = () => mongoose.model('Business');
const PendingTransaction = () => mongoose.model('PendingTransaction');

function canTransition(from, to) {
  if (from === to) return true;
  const allowed = RETURN_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/** Pure: run the applicable rules over a return + context. */
function runRules(ret, ctx) {
  const errors = [];
  for (const rule of rulesFor(ret.returnType)) {
    let violated = false;
    try { violated = rule.check({ data: ret.data, returnType: ret.returnType, ...ctx }); } catch { violated = false; }
    if (violated) errors.push({ code: rule.code, field: rule.field, message: rule.message, fix: rule.fix, severity: rule.severity });
  }
  // Only error-severity violations block filing; warnings surface but pass.
  const passed = errors.every(e => e.severity !== 'error');
  return { passed, errors };
}

/**
 * Validate a return, persist the verdict, and transition draft → validated on pass.
 * @returns {Promise<object>} the updated return
 */
async function validateReturn(businessId, returnId) {
  const ret = await taxReturnRepo.findById(returnId);
  if (!ret || String(ret.businessId) !== String(businessId)) throw new ApiError(404, 'Return not found');

  const biz = await Business().findById(businessId).select('taxConfig').lean();
  const businessNtn = (biz && biz.taxConfig && biz.taxConfig.taxRegistrationNumber) || null;

  let unpostedCount = 0;
  try { unpostedCount = await PendingTransaction().countDocuments({ businessId, status: 'pending' }); } catch { unpostedCount = 0; }

  const { passed, errors } = runRules(ret, { businessNtn, unpostedCount });

  const set = { 'validation.passed': passed, 'validation.checkedAt': new Date(), 'validation.errors': errors };
  if (passed && canTransition(ret.status, TAX_RETURN_STATUS.VALIDATED)) set.status = TAX_RETURN_STATUS.VALIDATED;

  return taxReturnRepo.update(returnId, { $set: set });
}

module.exports = { validateReturn, runRules };
