// services/forecasting/infra/jobQueue.js
//
// Forecast Platform — F8. Job-queue abstraction (in-process, concurrency-limited).
//
// Decouples request handling from heavy ML work. The interface
// (process(type, handler) + enqueue(type, payload) → Promise) is identical to a
// RabbitMQ-backed implementation, so scaling out to real workers is a backend
// swap (QUEUE_BACKEND=rabbitmq) with no caller changes. A concurrency cap gives
// backpressure so a burst can't exhaust the event loop.
//
'use strict';

class JobQueue {
  constructor({ concurrency = 4 } = {}) {
    this.handlers = new Map();
    this.queue = [];
    this.active = 0;
    this.concurrency = concurrency;
    this.stats = { enqueued: 0, processed: 0, failed: 0, maxActive: 0 };
  }

  /** Register a handler for a job type. */
  process(jobType, handler) { this.handlers.set(jobType, handler); return this; }

  /** Submit a job; resolves with the handler's result (or rejects). */
  enqueue(jobType, payload) {
    this.stats.enqueued++;
    return new Promise((resolve, reject) => {
      this.queue.push({ jobType, payload, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      if (this.active > this.stats.maxActive) this.stats.maxActive = this.active;
      const handler = this.handlers.get(job.jobType);
      Promise.resolve()
        .then(() => (handler ? handler(job.payload) : Promise.reject(new Error(`No handler for job type "${job.jobType}"`))))
        .then((r) => { this.stats.processed++; job.resolve(r); })
        .catch((e) => { this.stats.failed++; job.reject(e); })
        .finally(() => { this.active--; this._drain(); });
    }
  }

  depth() { return this.queue.length; }
  getStats() { return { ...this.stats, active: this.active, depth: this.queue.length, concurrency: this.concurrency }; }
}

module.exports = { JobQueue, queue: new JobQueue({ concurrency: Number(process.env.FORECAST_QUEUE_CONCURRENCY) || 4 }) };
