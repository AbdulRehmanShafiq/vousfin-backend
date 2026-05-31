# Forecast Platform — F8: Scale-Out Infrastructure (swap-ready)

> Delivers the **in-repo, swap-ready** pieces of the target stack so flipping to
> real infra (Redis / RabbitMQ / TimescaleDB / K8s / GPU workers) is **config,
> not a rewrite**. Heavy infra is provisioned at deploy time; the code seams +
> manifests + worker contract live here, tested.

## In-repo modules (tested)
| Module | Now | Swap (env) | Interface |
|---|---|---|---|
| `infra/cache.js` | in-process LRU+TTL, tenant-namespaced | `CACHE_BACKEND=redis` | `get/set/del/wrap/clearTenant` |
| `infra/jobQueue.js` | in-process, concurrency-capped (backpressure) | `QUEUE_BACKEND=rabbitmq` | `process(type,h)/enqueue(type,p)→Promise` |
| `infra/inferenceClient.js` | HTTP + **circuit breaker** + timeout | points at `INFERENCE_URL` worker pool | `request(path,payload)/health` |

The interfaces are identical to their distributed counterparts, so the Redis/
RabbitMQ adapters drop in behind the same calls. The cache is wired into the F6
domain forecasts (cache-aside, 5-min TTL) — a real latency win today.

## Resilience
The inference client's **circuit breaker** opens after N failures and fails fast,
so a down/slow Python worker makes Node fall back to the in-process classical
ensemble immediately (the product never hard-fails on ML). The queue's
concurrency cap stops a request burst from exhausting the event loop.

## Deploy artifacts
- `deploy/Dockerfile` — backend (Node, non-root, healthcheck).
- `deploy/Dockerfile.worker` — Python ML worker (Uvicorn).
- `deploy/docker-compose.yml` — full stack: Mongo · Redis · RabbitMQ · TimescaleDB · backend ×2 · ml-worker ×2.
- `deploy/k8s/forecast-platform.yaml` — Deployments + Services + **HPAs** (backend CPU autoscale 3→20; ml-worker 2→12, GPU-ready for TFT).
- `vousfin-ml-worker/` — FastAPI worker skeleton (`app.py` health/forecast/explain matching the Node contract) + pinned `requirements.txt`.

## API
`GET /forecast-registry/infra` → live cache hit-rate, queue depth/active, and
inference-breaker state — the signals that drive the F8 tipping-point triggers.

## Tipping points → action (from the roadmap)
| Signal (`/forecast-registry/infra` + APM) | Flip |
|---|---|
| cache hitRate < 0.6 / p95 > 2s | `CACHE_BACKEND=redis` + precompute |
| queue depth/active sustained high | `QUEUE_BACKEND=rabbitmq` + scale ml-worker |
| inference breaker frequently open | scale/optimize the worker pool |
| feature rows > ~50M / Mongo aggregate > 5s | feature store → TimescaleDB |
| many tenants / multi-region | apply `k8s/` + HPAs + regional shards |

## Validation
10 new unit tests — cache (tenant namespacing/isolation, TTL via injected clock,
LRU eviction, `wrap` memoization, `clearTenant`), queue (handler routing,
concurrency cap, unknown-type reject), inference client (success resets, breaker
opens + fails fast without re-calling). Full backend suite **672 passing**, 4
pre-existing unrelated suites unchanged.

## Next (roadmap): F9 — MLOps governance + standalone SaaS
Champion dashboards, auto-rollback on accuracy regression, usage metering/billing,
API-key tenancy and standalone onboarding — the last phase, productizing the engine.
