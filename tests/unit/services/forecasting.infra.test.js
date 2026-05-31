/**
 * tests/unit/services/forecasting.infra.test.js
 *
 * Forecast Platform — F8. Scale-out infra: cache (TTL/LRU/tenant), job queue
 * (concurrency + handler routing), inference client (timeout + circuit breaker).
 */
'use strict';

const { ForecastCache } = require('../../../services/forecasting/infra/cache');
const { JobQueue } = require('../../../services/forecasting/infra/jobQueue');
const { InferenceClient } = require('../../../services/forecasting/infra/inferenceClient');

describe('ForecastCache', () => {
  it('hits, namespaces by tenant, and refuses a keyless tenant', () => {
    const c = new ForecastCache();
    const k = c.key('biz1', 'Revenue', 6);
    expect(k.startsWith('biz1::')).toBe(true);
    c.set(k, [1, 2, 3]);
    expect(c.get(k)).toEqual([1, 2, 3]);
    expect(c.get(c.key('biz2', 'Revenue', 6))).toBeNull();   // tenant isolation
    expect(() => c.key(null, 'x')).toThrow();
  });

  it('expires entries past their TTL (injected clock)', () => {
    let t = 1000;
    const c = new ForecastCache({ clock: () => t });
    c.set('k', 'v', 100);
    expect(c.get('k')).toBe('v');
    t = 1200; // past exp (1000+100)
    expect(c.get('k')).toBeNull();
  });

  it('evicts the least-recently-used beyond maxEntries', () => {
    const c = new ForecastCache({ maxEntries: 2 });
    c.set('a', 1); c.set('b', 2);
    c.get('a');             // 'a' now most-recent → 'b' is LRU
    c.set('c', 3);          // evicts 'b'
    expect(c.get('b')).toBeNull();
    expect(c.get('a')).toBe(1);
    expect(c.get('c')).toBe(3);
  });

  it('wrap() memoizes — producer runs once', async () => {
    const c = new ForecastCache();
    const producer = jest.fn().mockResolvedValue(42);
    expect(await c.wrap('k', 1000, producer)).toBe(42);
    expect(await c.wrap('k', 1000, producer)).toBe(42);
    expect(producer).toHaveBeenCalledTimes(1);
  });

  it('clearTenant invalidates only that tenant', () => {
    const c = new ForecastCache();
    c.set(c.key('biz1', 'a'), 1); c.set(c.key('biz2', 'a'), 2);
    expect(c.clearTenant('biz1')).toBe(1);
    expect(c.get(c.key('biz2', 'a'))).toBe(2);
  });
});

describe('JobQueue', () => {
  it('routes jobs to handlers and resolves with the result', async () => {
    const q = new JobQueue({ concurrency: 2 });
    q.process('forecast', async (p) => p.x * 2);
    expect(await q.enqueue('forecast', { x: 21 })).toBe(42);
  });

  it('respects the concurrency cap (backpressure)', async () => {
    const q = new JobQueue({ concurrency: 2 });
    let active = 0; let peak = 0;
    q.process('slow', async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--; return true;
    });
    await Promise.all(Array.from({ length: 6 }, () => q.enqueue('slow', {})));
    expect(peak).toBeLessThanOrEqual(2);
    expect(q.getStats().processed).toBe(6);
  });

  it('rejects an unknown job type', async () => {
    const q = new JobQueue();
    await expect(q.enqueue('nope', {})).rejects.toThrow(/No handler/);
  });
});

describe('InferenceClient circuit breaker', () => {
  const okFetch = async () => ({ ok: true, json: async () => ({ predicted: [1, 2, 3] }) });
  const badFetch = async () => { throw new Error('conn refused'); };

  it('returns results and resets failures on success', async () => {
    const c = new InferenceClient({ fetchImpl: okFetch, baseUrl: 'http://x' });
    const r = await c.request('/forecast', {});
    expect(r.predicted).toEqual([1, 2, 3]);
    expect(c.isOpen()).toBe(false);
  });

  it('opens the breaker after the failure threshold, then fails fast', async () => {
    const calls = { n: 0 };
    const countingBad = async () => { calls.n++; throw new Error('down'); };
    const c = new InferenceClient({ fetchImpl: countingBad, baseUrl: 'http://x', failureThreshold: 3, cooldownMs: 60000 });
    for (let i = 0; i < 3; i++) await expect(c.request('/forecast', {})).rejects.toThrow();
    expect(c.isOpen()).toBe(true);
    // breaker open → fails fast WITHOUT calling fetch again
    await expect(c.request('/forecast', {})).rejects.toThrow(/circuit_open/);
    expect(calls.n).toBe(3);
  });
});
