// services/fbr/fbrClient.service.js — FR-04.3
//
// Pluggable FBR submission adapter. XML-FIRST: always produces FBR-compatible
// XML; attempts live IRIS submission only when filingMode==='iris' AND
// credentials are present, and falls back to XML on ANY failure so filing is
// never blocked by FBR being unavailable. The network call lives behind a single
// injectable transport (mockable/swappable).
//
'use strict';
const { toXML } = require('./fbrXmlExporter');

/** The real IRIS transport. Wired when credentials + an endpoint are configured. */
async function defaultIrisTransport(/* xml, creds */) {
  // No live IRIS integration in this environment — the XML path is guaranteed.
  throw new Error('IRIS transport not configured');
}

/**
 * @param {object} returnDoc
 * @param {object} config  { filingMode, fbrCredentials:{irisToken,ntn,endpoint}, ntn }
 * @param {object} [opts]  { irisTransport }
 * @returns {Promise<{mode:'iris'|'xml', xml:string, ackNumber?:string, fallbackReason?:string}>}
 */
async function submit(returnDoc, config = {}, opts = {}) {
  const creds = config.fbrCredentials || {};
  const ntn   = config.ntn || creds.ntn || null;
  const xml   = toXML(returnDoc, ntn);

  const wantsIris = config.filingMode === 'iris' && !!creds.irisToken;
  if (!wantsIris) return { mode: 'xml', xml };

  const transport = opts.irisTransport || defaultIrisTransport;
  try {
    const res = await transport(xml, creds);
    if (res && res.ackNumber) return { mode: 'iris', xml, ackNumber: String(res.ackNumber) };
    return { mode: 'xml', xml, fallbackReason: 'IRIS returned no acknowledgment' };
  } catch (e) {
    return { mode: 'xml', xml, fallbackReason: e.message };
  }
}

module.exports = { submit, defaultIrisTransport };
