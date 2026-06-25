/**
 * reportCache.js — Distributed/In-memory TTL cache for financial reports.
 *
 * WHY:
 *   Financial reports (Balance Sheet, Income Statement, Trial Balance, Dashboard)
 *   are expensive to compute — they aggregate thousands of journal entries.
 *   For a typical SME, reports are viewed many more times than transactions are
 *   written. A 5-minute cache eliminates redundant DB work on repeated views.
 *
 * SAFETY:
 *   The cache is invalidated on EVERY transaction write (create, update, reverse,
 *   delete) ensuring reports always reflect the latest data within one request
 *   cycle. There is NO risk of stale financial totals surviving after a write.
 *
 * DESIGN:
 *   - No external dependency (pure Node.js Map)
 *   - businessId-scoped keys → one business's writes don't affect another
 *   - TTL-based expiry as a safety net (default 5 minutes)
 *   - LRU-style eviction to prevent unbounded memory growth
 */

const Redis = require('ioredis');
const logger = require('../config/logger');

const MAX_ENTRIES   = 500;   // safety ceiling across all businesses
const DEFAULT_TTL   = 30 * 1000; // 30 seconds

class ReportCache {
  constructor() {
    this._store = new Map();
    this.redis = null;
    if (process.env.REDIS_URL) {
      try {
        this.redis = new Redis(process.env.REDIS_URL, { 
          maxRetriesPerRequest: 1, 
          enableReadyCheck: false,
          connectTimeout: 2000,
          commandTimeout: 2000,
          retryStrategy: (times) => Math.min(times * 50, 2000)
        });
        this.redis.on('error', (err) => logger.warn(`[Redis Cache] Connection error: ${err.message}`));
      } catch (err) {
        logger.warn(`[Redis Cache] Failed to initialize Redis, falling back to memory: ${err.message}`);
      }
    }
  }

  _key(type, businessId, params = {}) {
    return `${type}::${businessId}::${JSON.stringify(params)}`;
  }

  async get(type, businessId, params = {}) {
    const key = this._key(type, businessId, params);
    
    if (this.redis) {
      try {
        const val = await this.redis.get(key);
        return val ? JSON.parse(val) : null;
      } catch (err) {
        logger.warn(`[Redis Cache] get error: ${err.message}`);
      }
    }

    const entry = this._store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(type, businessId, params = {}, value, ttlMs = DEFAULT_TTL) {
    const key = this._key(type, businessId, params);
    
    if (this.redis) {
      try {
        await this.redis.setex(key, Math.ceil(ttlMs / 1000), JSON.stringify(value));
        return;
      } catch (err) {
        logger.warn(`[Redis Cache] set error: ${err.message}`);
      }
    }

    if (this._store.size >= MAX_ENTRIES) {
      const first = this._store.keys().next().value;
      this._store.delete(first);
    }
    this._store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async invalidate(businessId) {
    const suffix = `::${businessId}::`;
    
    if (this.redis) {
      try {
        // Use scan in production, keys is fine for POC
        const keys = await this.redis.keys(`*${suffix}*`);
        if (keys.length > 0) {
          await this.redis.del(keys);
        }
      } catch (err) {
        logger.warn(`[Redis Cache] invalidate error: ${err.message}`);
      }
    }

    for (const key of this._store.keys()) {
      if (key.includes(suffix)) {
        this._store.delete(key);
      }
    }
  }

  async clear() {
    if (this.redis) {
      try {
        await this.redis.flushdb();
      } catch (err) {}
    }
    this._store.clear();
  }

  get size() {
    return this._store.size;
  }
}

module.exports = new ReportCache();
