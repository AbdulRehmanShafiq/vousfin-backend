/**
 * businessEventEngine.service.js — ERP Integration Refactor, Step 2
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  THE CENTRAL BUSINESS EVENT ENGINE                                         │
 * │                                                                            │
 * │  Every meaningful business action publishes an event here; subscribers    │
 * │  (handlers) react to keep the rest of the system consistent — inventory,  │
 * │  AR/AP, dashboard cache, audit trail, forecasting feed, etc.              │
 * │                                                                            │
 * │  This replaces the scattered, imperative "call service A then B then C"   │
 * │  pattern with a single publish/subscribe hub. See systemDependencyMap.md  │
 * │  §6 for the taxonomy and the subscriber list this engine routes to.       │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * DESIGN PRINCIPLES (aligned with the refactor's mandatory rules):
 *
 *  1. NEVER break the emitter.  `emit()` is fire-and-forget: handler errors are
 *     caught and logged, never propagated back to the code that published the
 *     event.  Publishing a TRANSACTION_CREATED event can therefore never break
 *     journal balancing or roll back a ledger write.  (Rule 3)
 *
 *  2. Business- & user-isolation.  Every event MUST carry a `businessId`.  The
 *     engine refuses to dispatch an event without one and tags every history
 *     record with it, so one tenant's events never leak into another's.  (Rule 10)
 *
 *  3. Centralized, not duplicated.  Adding a new cross-module effect means
 *     registering one handler here — not editing N services.  (Rule 9 / Rule 8)
 *
 *  4. Deterministic ordering.  Handlers for an event run in registration order,
 *     sequentially, so a handler that depends on an earlier handler's write
 *     observes it.
 *
 *  5. Observable.  A bounded in-memory ring buffer records recent events for
 *     diagnostics and feeds the unified cross-module audit trail (Step 9).
 *
 * USAGE
 * ─────
 *   const { businessEvents, EVENTS } = require('./businessEventEngine.service');
 *
 *   // Subscribe (typically in a bootstrap module wired in Steps 3–9):
 *   businessEvents.on(EVENTS.TRANSACTION_CREATED, async (evt) => {
 *     // evt = { eventId, eventName, businessId, occurredAt, ...payload }
 *   }, { name: 'warm-dashboard-cache' });
 *
 *   // Publish (fire-and-forget — safe inside a service after the DB write):
 *   businessEvents.emit(EVENTS.TRANSACTION_CREATED, {
 *     businessId, userId, entityType: 'journal_entry', entityId, after,
 *   });
 *
 *   // Publish and await all handlers (used by integration tests / sync flows):
 *   const result = await businessEvents.emitAndWait(EVENTS.TRANSACTION_CREATED, payload);
 */

'use strict';

const crypto = require('crypto');
const logger = require('../config/logger');
const Redis = require('ioredis');

// ─────────────────────────────────────────────────────────────────────────────
//  Event taxonomy  (systemDependencyMap.md §6)
//  Frozen so a typo in an event name fails fast instead of silently no-op'ing.
// ─────────────────────────────────────────────────────────────────────────────
const EVENTS = Object.freeze({
  // ── Ledger / transactions ────────────────────────────────────────────────
  TRANSACTION_CREATED:          'transaction.created',
  TRANSACTION_REVERSED:         'transaction.reversed',
  TRANSACTION_EDITED:           'transaction.edited',
  TRANSACTION_DELETED:          'transaction.deleted',
  PAYMENT_RECORDED:             'payment.recorded',
  PAYMENT_APPLIED:              'payment.applied',   // AR/AP M2 — first-class Payment posted

  // ── Accounts payable / bills ──────────────────────────────────────────────
  BILL_CREATED:                 'bill.created',
  BILL_APPROVED:                'bill.approved',
  BILL_PAID:                    'bill.paid',
  BILL_CANCELLED:               'bill.cancelled',

  // ── Accounts receivable / invoices ────────────────────────────────────────
  INVOICE_CREATED:              'invoice.created',
  INVOICE_APPROVED:             'invoice.approved',
  INVOICE_PAID:                 'invoice.paid',
  INVOICE_CANCELLED:            'invoice.cancelled',
  INVOICE_VOIDED:               'invoice.voided',     // AR/AP M5 — GL-correct void
  BILL_VOIDED:                  'bill.voided',
  CREDIT_MEMO_APPLIED:          'credit_memo.applied',
  // ── AR/AP M8 — enterprise extras ──────────────────────────────────────────
  RECURRING_INVOICE_GENERATED:  'invoice.recurring_generated',
  DUNNING_ESCALATED:            'dunning.escalated',
  EARLY_PAYMENT_DISCOUNT_APPLIED: 'ar_ap.early_payment_discount',
  CUSTOMER_STATEMENT_GENERATED: 'customer.statement_generated',

  // ── Parties ───────────────────────────────────────────────────────────────
  VENDOR_BALANCE_CHANGED:       'vendor.balance_changed',
  CUSTOMER_BALANCE_CHANGED:     'customer.balance_changed',

  // ── Inventory ─────────────────────────────────────────────────────────────
  INVENTORY_RECEIVED:           'inventory.received',
  INVENTORY_REDUCED:            'inventory.reduced',
  INVENTORY_ADJUSTED:           'inventory.adjusted',
  INVENTORY_RETURNED:           'inventory.returned',
  LOW_STOCK_REACHED:            'inventory.low_stock',
  INVENTORY_VALUATION_CHANGED:  'inventory.valuation_changed',

  // ── Procurement (PO → GRN → Bill) ─────────────────────────────────────────
  PURCHASE_ORDER_APPROVED:      'purchase_order.approved',
  GOODS_RECEIVED:               'goods.received',
  THREE_WAY_MATCH_DONE:         'three_way_match.done',

  // ── Installments / loans ──────────────────────────────────────────────────
  INSTALLMENT_PAID:             'installment.paid',
  INSTALLMENT_PENALTY_ACCRUED:  'installment.penalty_accrued',

  // ── Tax ───────────────────────────────────────────────────────────────────
  TAX_CALCULATED:               'tax.calculated',
  TAX_FILED:                    'tax.filed',

  // ── FX / periods ──────────────────────────────────────────────────────────
  FX_RATE_UPDATED:              'fx.rate_updated',
  PERIOD_CLOSED:                'period.closed',

  // ── Intelligence ──────────────────────────────────────────────────────────
  ANOMALY_DETECTED:             'anomaly.detected',
});

// Reverse lookup used for validation / diagnostics.
const VALID_EVENT_NAMES = new Set(Object.values(EVENTS));

// Wildcard channel — handlers registered here observe EVERY event.
// Used by the diagnostic logger and (Step 9) the unified audit writer.
const WILDCARD = '*';

// ─────────────────────────────────────────────────────────────────────────────
//  Engine
// ─────────────────────────────────────────────────────────────────────────────

class BusinessEventEngine {
  constructor() {
    /** @type {Map<string, Array<{ handler: Function, name: string, once: boolean }>>} */
    this._handlers = new Map();

    /** Bounded ring buffer of recent events (diagnostics + audit feed). */
    this._history = [];
    this._historyLimit = 250;

    /** Counters for observability. */
    this._stats = { emitted: 0, handled: 0, errors: 0 };

    this.pub = null;
    this.sub = null;

    if (process.env.REDIS_URL) {
      try {
        const redisConfig = {
          maxRetriesPerRequest: 1,
          enableReadyCheck: false,
          connectTimeout: 2000,
          commandTimeout: 2000,
          retryStrategy: (times) => Math.min(times * 50, 2000)
        };
        this.pub = new Redis(process.env.REDIS_URL, redisConfig);
        this.sub = new Redis(process.env.REDIS_URL, redisConfig);
        
        this.sub.subscribe('business_events', (err) => {
          if (err) logger.error(`[EventEngine] Redis subscribe error: ${err.message}`);
          else logger.info('[EventEngine] Subscribed to Redis distributed event channel');
        });

        this.sub.on('message', (channel, message) => {
          if (channel === 'business_events') {
            try {
              const envelope = JSON.parse(message);
              // Ensure we don't process it locally if it was already processed, wait actually
              // emit() will just publish and NOT run locally, so we only run here.
              this._executeHandlersLocally(envelope);
            } catch (err) {
              logger.error(`[EventEngine] Redis message parse error: ${err.message}`);
            }
          }
        });
      } catch (err) {
        logger.warn(`[EventEngine] Failed to init Redis PubSub, falling back to local events: ${err.message}`);
      }
    }
  }

  // ─── Subscription ──────────────────────────────────────────────────────────

  /**
   * Register a handler for an event.
   *
   * @param {string}   eventName  One of EVENTS.* (or '*' for all events)
   * @param {Function} handler    (event) => void | Promise<void>
   * @param {Object}   [opts]
   * @param {string}   [opts.name='anonymous']  Label for logs/diagnostics
   * @param {boolean}  [opts.once=false]        Auto-unsubscribe after first run
   * @returns {Function} unsubscribe function
   */
  on(eventName, handler, opts = {}) {
    if (typeof handler !== 'function') {
      throw new TypeError('businessEvents.on: handler must be a function');
    }
    if (eventName !== WILDCARD && !VALID_EVENT_NAMES.has(eventName)) {
      // Fail fast on typos — but only warn (don't crash a bootstrap) for forward compat.
      logger.warn(`[eventEngine] Subscribing to unknown event "${eventName}" — check EVENTS taxonomy`);
    }

    const entry = { handler, name: opts.name || 'anonymous', once: !!opts.once };
    if (!this._handlers.has(eventName)) this._handlers.set(eventName, []);
    this._handlers.get(eventName).push(entry);

    // Return an unsubscribe closure.
    return () => this._remove(eventName, entry);
  }

  /** Convenience: register a one-shot handler. */
  once(eventName, handler, opts = {}) {
    return this.on(eventName, handler, { ...opts, once: true });
  }

  /** Remove a specific handler entry. @private */
  _remove(eventName, entry) {
    const list = this._handlers.get(eventName);
    if (!list) return;
    const idx = list.indexOf(entry);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) this._handlers.delete(eventName);
  }

  /** Remove all handlers for an event (or all handlers entirely when omitted). */
  off(eventName) {
    if (eventName === undefined) this._handlers.clear();
    else this._handlers.delete(eventName);
  }

  // --- Publishing ---

  /**
   * Build a normalized event envelope.
   * Validates that businessId is present (tenant isolation is non-negotiable).
   * @private
   */
  _envelope(eventName, payload = {}) {
    if (!payload || typeof payload !== 'object') {
      throw new TypeError('businessEvents: event payload must be an object');
    }
    const businessId = payload.businessId != null ? String(payload.businessId) : null;
    if (!businessId) {
      throw new Error(`businessEvents.${eventName}: payload.businessId is required`);
    }
    return {
      eventId:    crypto.randomUUID(),
      eventName,
      occurredAt: new Date(),
      ...payload,
      businessId, // normalized to string, always last so it can't be overwritten
    };
  }

  /**
   * Collect the ordered handler list for an event (specific handlers first,
   * then wildcard observers).
   * @private
   */
  _resolveHandlers(eventName) {
    const specific = this._handlers.get(eventName) || [];
    const wildcard = this._handlers.get(WILDCARD) || [];
    return [...specific, ...wildcard];
  }

  /**
   * Run all handlers for an envelope locally.
   * @private
   */
  _executeHandlersLocally(envelope) {
    const handlers = this._resolveHandlers(envelope.eventName);
    if (handlers.length === 0) {
      this._record(envelope);
      return;
    }

    // Detached: run sequentially, swallow all errors. Never returns to caller.
    Promise.resolve().then(async () => {
      const errors = [];
      for (const entry of handlers) {
        const res = await this._runHandler(entry, envelope);
        if (!res.ok) errors.push(res);
      }
      this._record(envelope, { errors });
    }).catch((err) => {
      logger.error(`[eventEngine] dispatch loop crashed for ${envelope.eventName}: ${err.message}`);
    });
  }

  /**
   * Publish an event — FIRE-AND-FORGET.
   *
   * @param {string} eventName  EVENTS.*
   * @param {Object} payload    must include businessId
   * @returns {string} eventId  (for correlation in logs)
   */
  emit(eventName, payload = {}) {
    const envelope = this._envelope(eventName, payload);
    this._stats.emitted++;

    if (this.pub) {
      this.pub.publish('business_events', JSON.stringify(envelope)).catch(err => {
        logger.error(`[EventEngine] Redis publish error: ${err.message}`);
      });
    } else {
      this._executeHandlersLocally(envelope);
    }
    return envelope.eventId;
  }

  /**
   * Internal diagnostic history.
   * @private
   */
  _record(envelope, { errors = [] } = {}) {
    this._history.push({
      eventId:    envelope.eventId,
      eventName:  envelope.eventName,
      businessId: envelope.businessId,
      occurredAt: envelope.occurredAt,
      entityType: envelope.entityType || null,
      entityId:   envelope.entityId != null ? String(envelope.entityId) : null,
      handlerErrors: errors.length,
    });
    if (this._history.length > this._historyLimit) {
      this._history.splice(0, this._history.length - this._historyLimit);
    }
  }

  /**
   * Run a single handler with full error isolation.
   * @private
   * @returns {Promise<{ ok: boolean, error?: Error, name: string }>}
   */
  async _runHandler(entry, envelope) {
    try {
      await entry.handler(envelope);
      this._stats.handled++;
      if (entry.once) this._remove(envelope.eventName, entry);
      return { ok: true, name: entry.name };
    } catch (err) {
      this._stats.errors++;
      logger.error(
        `[eventEngine] handler "${entry.name}" failed for ${envelope.eventName} ` +
        `(business ${envelope.businessId}): ${err.message}`
      );
      if (entry.once) this._remove(envelope.eventName, entry);
      return { ok: false, error: err, name: entry.name };
    }
  }

  /**
   * Publish an event and AWAIT all handlers.
   *
   * Use when the caller genuinely needs the side effects to complete before
   * proceeding (synchronous workflows, integration tests).  Per-handler errors
   * are still isolated and collected — this method itself never throws on a
   * handler failure; it reports them in the result.
   *
   * @param {string} eventName
   * @param {Object} payload
   * @returns {Promise<{ eventId: string, handled: number, failed: number, errors: Array }>}
   */
  async emitAndWait(eventName, payload = {}) {
    const envelope = this._envelope(eventName, payload);
    this._stats.emitted++;

    const handlers = this._resolveHandlers(eventName);
    const errors = [];
    for (const entry of handlers) {
      const res = await this._runHandler(entry, envelope);
      if (!res.ok) errors.push({ name: res.name, message: res.error.message });
    }
    this._record(envelope, { errors });

    return {
      eventId: envelope.eventId,
      handled: handlers.length - errors.length,
      failed:  errors.length,
      errors,
    };
  }

  // ─── Introspection / diagnostics ───────────────────────────────────────────

  /** List registered handler names keyed by event. */
  listHandlers() {
    const out = {};
    for (const [event, list] of this._handlers.entries()) {
      out[event] = list.map((e) => e.name);
    }
    return out;
  }

  /** Number of handlers registered for an event (incl. wildcard). */
  handlerCount(eventName) {
    return this._resolveHandlers(eventName).length;
  }

  /**
   * Recent event history (optionally filtered to one business — enforces the
   * same tenant isolation as everything else).
   * @param {string} [businessId]
   * @param {number} [limit=50]
   */
  getHistory(businessId, limit = 50) {
    let rows = this._history;
    if (businessId != null) {
      const id = String(businessId);
      rows = rows.filter((r) => r.businessId === id);
    }
    return rows.slice(-limit);
  }

  /** Engine counters for monitoring. */
  getStats() {
    return { ...this._stats, historySize: this._history.length };
  }

  /** Reset everything — for tests only. */
  reset() {
    this._handlers.clear();
    this._history = [];
    this._stats = { emitted: 0, handled: 0, errors: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Singleton
// ─────────────────────────────────────────────────────────────────────────────
const businessEvents = new BusinessEventEngine();

// A built-in, always-on diagnostic observer (DEBUG-level so it's silent in prod
// unless log level is turned up). Gives a single trace of the whole event flow.
businessEvents.on(WILDCARD, (evt) => {
  logger.debug(
    `[event] ${evt.eventName} · business=${evt.businessId} · ` +
    `${evt.entityType || '-'}:${evt.entityId || '-'} · ${evt.eventId}`
  );
}, { name: 'diagnostic-tracer' });

module.exports = { businessEvents, EVENTS, WILDCARD };
