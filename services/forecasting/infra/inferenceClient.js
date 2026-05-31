// services/forecasting/infra/inferenceClient.js
//
// Forecast Platform — F8. Client for the Python ML inference worker (FastAPI).
//
// Generalizes the existing _callPythonLSTM pattern into one resilient client for
// every heavy task (LSTM / GBM / SHAP), with a timeout and a CIRCUIT BREAKER so a
// down/slow worker fails fast (and the classical in-process fallback takes over)
// instead of piling up requests. Stateless + horizontally scalable behind the
// worker pool; the Node side never blocks on ML.
//
'use strict';
const logger = require('../../../config/logger');

class InferenceClient {
  constructor({ baseUrl, timeoutMs = 15000, failureThreshold = 3, cooldownMs = 30000, fetchImpl } = {}) {
    this.baseUrl = baseUrl || process.env.INFERENCE_URL || process.env.LSTM_API_URL || 'http://localhost:8000';
    this.timeoutMs = timeoutMs;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.fetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    this.failures = 0;
    this.openUntil = 0;
  }

  /** Is the breaker currently open (failing fast)? */
  isOpen() { return Date.now() < this.openUntil; }

  _onSuccess() { this.failures = 0; this.openUntil = 0; }
  _onFailure() {
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.openUntil = Date.now() + this.cooldownMs;
      logger.warn(`[inferenceClient] circuit OPEN for ${this.cooldownMs}ms after ${this.failures} failures`);
    }
  }

  async _fetchJson(path, options) {
    if (!this.fetch) throw new Error('no_fetch_available');
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(`${this.baseUrl}${path}`, { ...options, signal: ctrl.signal });
      if (!res.ok) throw new Error(`inference_http_${res.status}`);
      return await res.json();
    } finally { clearTimeout(tid); }
  }

  /** Health probe (never throws). */
  async health() {
    try { const b = await this._fetchJson('/api/v1/vousfin/health', { method: 'GET' }); return b?.ready === true; }
    catch { return false; }
  }

  /**
   * Run an inference task. Fails fast when the breaker is open so the caller can
   * fall back to the in-process classical/ensemble path immediately.
   */
  async request(path, payload) {
    if (this.isOpen()) throw new Error('circuit_open');
    try {
      const result = await this._fetchJson(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      this._onSuccess();
      return result;
    } catch (e) {
      this._onFailure();
      throw e;
    }
  }

  getState() { return { baseUrl: this.baseUrl, open: this.isOpen(), failures: this.failures }; }
}

module.exports = { InferenceClient, inferenceClient: new InferenceClient() };
