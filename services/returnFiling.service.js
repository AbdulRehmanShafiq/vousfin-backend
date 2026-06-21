// services/returnFiling.service.js — FR-04.3
//
// Orchestrates submission + export: loads the return + filing config, calls the
// pluggable FBR adapter, persists the outcome (IRIS ack → filed + audit row; XML
// fallback → stays validated, return the file), and exports FBR XML on demand.
//
'use strict';
const mongoose = require('mongoose');
const { ApiError } = require('../utils/ApiError');
const { TAX_RETURN_STATUS, RETURN_TRANSITIONS, AUDIT_ACTIONS, ENTITY_TYPES } = require('../config/constants');
const taxReturnRepo = require('../repositories/taxReturn.repository');
const fbrClient = require('./fbr/fbrClient.service');
const { toXML } = require('./fbr/fbrXmlExporter');
const auditService = require('./audit.service');
const logger = require('../config/logger');

const Business = () => mongoose.model('Business');

function canTransition(from, to) {
  if (from === to) return true;
  const allowed = RETURN_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

async function loadConfig(businessId) {
  const biz = await Business().findById(businessId).select('taxConfig').lean();
  const cfg = (biz && biz.taxConfig) || {};
  const creds = cfg.fbrCredentials || {};
  return {
    filingMode: cfg.filingMode || 'xml',
    fbrCredentials: creds,
    ntn: creds.ntn || cfg.taxRegistrationNumber || null,
  };
}

async function loadOwned(businessId, returnId) {
  const ret = await taxReturnRepo.findById(returnId);
  if (!ret || String(ret.businessId) !== String(businessId)) throw new ApiError(404, 'Return not found');
  return ret;
}

/**
 * File a validated return. IRIS ack → filed + audit; otherwise return the XML.
 * @returns {Promise<{mode:string, ackNumber?:string, xml?:string, fallbackReason?:string, return:object}>}
 */
async function submitReturn(businessId, returnId, performedBy, opts = {}) {
  const ret = await loadOwned(businessId, returnId);
  if (![TAX_RETURN_STATUS.VALIDATED, TAX_RETURN_STATUS.SUBMITTED].includes(ret.status)) {
    throw new ApiError(400, `Return must be validated before filing (current: ${ret.status})`);
  }

  const config = await loadConfig(businessId);
  const result = await fbrClient.submit(ret, config, opts);

  if (result.mode === 'iris' && result.ackNumber) {
    const updated = await taxReturnRepo.update(returnId, { $set: {
      status: TAX_RETURN_STATUS.FILED,
      'fbr.mode': 'iris', 'fbr.ackNumber': result.ackNumber, 'fbr.submittedAt': new Date(),
    } });
    try {
      await auditService.log({
        businessId, entityType: ENTITY_TYPES.TAX_RETURN, entityId: String(returnId),
        action: AUDIT_ACTIONS.FILED, performedBy,
        afterState: { ackNumber: result.ackNumber, mode: 'iris', returnType: ret.returnType, period: ret.period },
      });
    } catch (e) { /* best-effort: audit-log write; the FBR filing result was already persisted */ logger.warn(`[filing] audit failed: ${e.message}`); }
    return { mode: 'iris', ackNumber: result.ackNumber, return: updated };
  }

  // XML fallback — record the attempt, keep status validated, hand back the file.
  const updated = await taxReturnRepo.update(returnId, { $set: { 'fbr.mode': 'xml', 'fbr.submittedAt': new Date() } });
  return { mode: 'xml', xml: result.xml, fallbackReason: result.fallbackReason, return: updated };
}

/** Export a return as FBR-compatible XML. */
async function exportReturn(businessId, returnId, format = 'xml') {
  const ret = await loadOwned(businessId, returnId);
  const config = await loadConfig(businessId);
  const xml = toXML(ret, config.ntn);
  const mm = ret.period.month ? `-${String(ret.period.month).padStart(2, '0')}` : '';
  return {
    format: 'xml',
    filename: `${ret.returnType}-${ret.period.year}${mm}.xml`,
    content: xml,
    returnType: ret.returnType,
  };
}

module.exports = { submitReturn, exportReturn, loadConfig, canTransition };
