/**
 * eventSubscribers.service.js — ERP Integration Refactor, Step 7
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  THE EVENT ENGINE'S SUBSCRIBERS                                            │
 * │                                                                            │
 * │  Steps 2–6 made every meaningful business action PUBLISH an event, but    │
 * │  nothing was LISTENING — the engine was "a tree falling in an empty       │
 * │  forest." This module registers the first real subscribers, closing the   │
 * │  loop so analytics stay consistent with the ledger automatically.         │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * WHAT IT DOES (Step 7 — Dashboard / Forecast / Report sync):
 *   Dashboards, financial reports and cash-flow forecasts are served from a
 *   per-business in-memory TTL cache (utils/reportCache). Before this, only
 *   transaction.service invalidated that cache on its own writes — so approving
 *   a bill/invoice, receiving goods, applying a vendor credit or moving a party
 *   balance left the dashboard stale for up to the TTL window. Now a single
 *   centralized subscriber invalidates the per-business analytics cache the
 *   instant ANY material business event fires, so the next dashboard/report/
 *   forecast view recomputes from fresh data. (Rules 7, 9)
 *
 * DESIGN:
 *   • Idempotent registration — safe to call from app bootstrap and tests.
 *   • Handlers are fire-and-forget through the engine: a subscriber error is
 *     isolated and never propagates back to the emitting service (Rule 3).
 *   • Tenant-safe — every event carries businessId; we only ever invalidate
 *     that one business's cache (Rule 10).
 */

'use strict';

const { businessEvents, EVENTS } = require('./businessEventEngine.service');
const reportCache = require('../utils/reportCache');
const logger = require('../config/logger');

let _registered = false;

/**
 * Events after which cached analytics (dashboard, income statement, balance
 * sheet, trial balance, AR/AP aging, cash-flow forecast) may be stale and must
 * be recomputed on next view. Curated rather than wildcard so purely
 * informational signals (e.g. anomaly.detected) don't needlessly churn caches.
 */
const CACHE_INVALIDATING_EVENTS = [
  // Ledger / transactions
  EVENTS.TRANSACTION_CREATED,
  EVENTS.TRANSACTION_REVERSED,
  EVENTS.TRANSACTION_EDITED,
  EVENTS.TRANSACTION_DELETED,
  EVENTS.PAYMENT_RECORDED,
  // Accounts payable / receivable documents
  EVENTS.BILL_APPROVED,
  EVENTS.BILL_PAID,
  EVENTS.BILL_CANCELLED,
  EVENTS.INVOICE_APPROVED,
  EVENTS.INVOICE_PAID,
  EVENTS.INVOICE_CANCELLED,
  // Party balances
  EVENTS.VENDOR_BALANCE_CHANGED,
  EVENTS.CUSTOMER_BALANCE_CHANGED,
  // Inventory & procurement
  EVENTS.INVENTORY_RECEIVED,
  EVENTS.INVENTORY_REDUCED,
  EVENTS.INVENTORY_ADJUSTED,
  EVENTS.INVENTORY_RETURNED,
  EVENTS.INVENTORY_VALUATION_CHANGED,
  EVENTS.GOODS_RECEIVED,
  // Installments / loans
  EVENTS.INSTALLMENT_PAID,
  // Tax
  EVENTS.TAX_CALCULATED,
  EVENTS.TAX_FILED,
  // Periods / FX
  EVENTS.PERIOD_CLOSED,
  EVENTS.FX_RATE_UPDATED,
];

/**
 * Register all Step-7 subscribers on the singleton event engine.
 * Idempotent — repeated calls (app bootstrap + tests) are no-ops after the first.
 * @returns {boolean} true if it registered this call, false if already registered
 */
function registerAll() {
  if (_registered) return false;
  _registered = true;

  // One handler, reused across every cache-invalidating event. Clearing the
  // per-business cache is cheap and idempotent, so a single sale firing several
  // events (transaction.created + inventory.reduced + customer.balance_changed)
  // collapses to harmless repeat invalidations.
  const invalidateAnalyticsCache = (evt) => {
    if (!evt || !evt.businessId) return;
    reportCache.invalidate(String(evt.businessId));
  };

  for (const eventName of CACHE_INVALIDATING_EVENTS) {
    businessEvents.on(eventName, invalidateAnalyticsCache, {
      name: `analytics-cache-sync:${eventName}`,
    });
  }

  // ── AR/AP refactor M1 — ledger → document payment reconciliation ──────────
  // When a payment settles a JournalEntry, project its authoritative
  // paidAmount / remainingBalance / state onto the linked Invoice / Bill so the
  // document never goes stale (closes the split-brain, finding P1). Idempotent
  // and fire-and-forget: a failure here can never block or unwind the payment.
  // lazy-require avoids pulling the document models into this lightweight module
  // at load time and sidesteps any require-cycle.
  businessEvents.on(EVENTS.PAYMENT_RECORDED, async (evt) => {
    if (!evt || !evt.businessId || !evt.parentJournalEntryId) return;
    const arApReconciliation = require('./arApReconciliation.service');
    await arApReconciliation.reconcileByJournalEntryId(
      evt.businessId, evt.parentJournalEntryId, { userId: evt.userId }
    );
  }, { name: 'ar-ap-document-reconcile' });

  logger.info(
    `[eventSubscribers] analytics cache-sync on ${CACHE_INVALIDATING_EVENTS.length} event types ` +
    `+ AR/AP document reconciliation on payment.recorded`
  );
  return true;
}

/** @returns {boolean} whether subscribers are currently registered. */
function isRegistered() {
  return _registered;
}

/** Test-only: clear the registered flag (does not detach handlers). */
function _resetForTest() {
  _registered = false;
}

module.exports = {
  registerAll,
  isRegistered,
  CACHE_INVALIDATING_EVENTS,
  _resetForTest,
};
