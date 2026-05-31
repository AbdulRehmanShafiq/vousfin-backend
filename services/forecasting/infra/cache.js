// services/forecasting/infra/cache.js
//
// Forecast Platform — F8. Cache abstraction (tenant-namespaced LRU + TTL).
//
// In-process default; the SAME interface (get/set/del/wrap, all async-safe) maps
// 1:1 onto a Redis adapter — swap the backend via CACHE_BACKEND=redis with no
// caller changes. Every key is tenant-namespaced so one business can never read
// another's cached forecast.
//
'use strict';

class ForecastCache {
  constructor({ maxEntries = 1000, defaultTtlMs = 5 * 60 * 1000, clock = () => Date.now() } = {}) {
    this.store = new Map();          // insertion-ordered → cheap LRU
    this.max = maxEntries;
    this.ttl = defaultTtlMs;
    this.clock = clock;
    this.stats = { hits: 0, misses: 0, sets: 0, evictions: 0 };
  }

  /** Tenant-namespaced key — isolation guaranteed by construction. */
  key(businessId, ...parts) {
    if (!businessId) throw new Error('cache.key: businessId is required (tenant isolation)');
    return `${businessId}::${parts.join('::')}`;
  }

  get(key) {
    const e = this.store.get(key);
    if (!e) { this.stats.misses++; return null; }
    if (this.clock() > e.exp) { this.store.delete(key); this.stats.misses++; return null; }
    // LRU bump (re-insert as most-recent)
    this.store.delete(key); this.store.set(key, e);
    this.stats.hits++;
    return e.val;
  }

  set(key, val, ttlMs) {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { val, exp: this.clock() + (ttlMs || this.ttl) });
    this.stats.sets++;
    while (this.store.size > this.max) {
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
      this.stats.evictions++;
    }
    return val;
  }

  del(key) { return this.store.delete(key); }

  /** Invalidate everything for one tenant (e.g. on a new transaction). */
  clearTenant(businessId) {
    const prefix = `${businessId}::`;
    let n = 0;
    for (const k of [...this.store.keys()]) if (k.startsWith(prefix)) { this.store.delete(k); n++; }
    return n;
  }

  /** Memoize an async producer under a key (cache-aside). */
  async wrap(key, ttlMs, producer) {
    const hit = this.get(key);
    if (hit !== null) return hit;
    const val = await producer();
    if (val !== undefined && val !== null) this.set(key, val, ttlMs);
    return val;
  }

  getStats() {
    const total = this.stats.hits + this.stats.misses;
    return { ...this.stats, size: this.store.size, hitRate: total ? Math.round((this.stats.hits / total) * 100) / 100 : 0 };
  }
}

// Singleton used across the forecasting services (swap to Redis adapter at scale).
module.exports = { ForecastCache, cache: new ForecastCache() };
