# Forecast Platform — Foundation Data Layer (F1)

> Implements the foundation of `docs/ai-forecasting-platform.md` inside the live
> Node/Express + MongoDB stack, behind clean interfaces that map 1:1 onto the
> target SaaS stack (NestJS/FastAPI · TimescaleDB · RabbitMQ · MinIO · Prefect/
> Airflow · MLflow · Evidently/Great-Expectations · Docker/K8s).

## 1. The 9 foundation components (all delivered)
| # | Component | Implementation | Target-stack mapping |
|---|---|---|---|
| 1 | Forecasting Data Lake | read-side over the Mongo ledger (`datasetBuilder`) | → object storage (MinIO/S3) + Parquet |
| 2 | Feature Store | `ForecastFeatureSnapshot` + `featureStore.service` | → Feast / TimescaleDB hypertable |
| 3 | Dataset Builder | `datasetBuilder.service` (pluggable source extractors) | → Prefect/Airflow ETL DAG |
| 4 | Tenant Isolation Layer | `tenantScope` (mandatory businessId choke-point) | → row-level security + tenant claims |
| 5 | Currency Normalization | `currencyNormalizer` (fx.service, as-of, cached) | → shared FX service |
| 6 | Timezone Normalization | `timezone` (offset-aware bucketing, ISO week) | → luxon/date-fns-tz (IANA zones) |
| 7 | Data Validation Framework | `dataValidation` (GE-style expectations) | → Great Expectations suite |
| 8 | Historical Snapshot System | `ForecastFeatureSnapshot.knowledgeDate` (append-only, idempotent) | → time-travel queries |
| 9 | Forecasting Metadata Registry | `ForecastDatasetRegistry` (lineage + content hash + validation) | → MLflow / data catalog |

Granularities supported end-to-end: **daily · weekly (ISO) · monthly · quarterly**.

## 2. Folder structure
```
services/forecasting/platform/
  tenantScope.js           # isolation guard (assertTenant / scopeFilter / assertSameTenant)
  timezone.js              # periodKey / periodBounds / enumeratePeriods (offset-aware)
  currencyNormalizer.js    # toBase / normalizeRows (as-of FX, monthly rate cache)
  dataValidation.js        # validateDataset + expectation primitives
  datasetBuilder.service.js# multi-source ETL → normalized period rows + validation + hash
  featureStore.service.js  # computeFeatures (leakage-safe) + materialize + getSnapshots
  index.js                 # public surface
models/ForecastFeatureSnapshot.model.js
models/ForecastDatasetRegistry.model.js
controllers/forecastPlatform.controller.js
routes/v1/forecastPlatform.routes.js          # mounted at /api/v1/forecast-platform
tests/unit/services/forecastPlatform.*.test.js
```

## 3. Database schema (Mongo today → Timescale-ready)
**ForecastFeatureSnapshot** — `{ businessId, datasetKey, granularity, periodKey, periodStart, periodEnd, knowledgeDate, baseCurrency, sourceVersion, features{}, target{} }`
unique `{businessId,datasetKey,granularity,periodKey}` · idx `{businessId,granularity,periodStart}`, `{businessId,knowledgeDate}`.
**ForecastDatasetRegistry** — `{ businessId, datasetKey, granularity, version, sources[], rangeStart, rangeEnd, rowCount, baseCurrency, tzOffsetMinutes, contentHash, validation{passed,errors,warnings,summary}, status, builtBy, builtAt }`.

## 4. ETL pipeline (per request, leakage-safe)
```
tenantScope.assertTenant
  → source extractors (Mongo aggregate, DAILY×currency)   [journal_entries · invoices · bills]
  → currencyNormalizer.toBase (as-of each day, cached)
  → timezone.periodKey re-bucket to {daily|weekly|monthly|quarterly}
  → enumeratePeriods gap-fill (contiguous axis, imputed flag)
  → dataValidation.validateDataset (future-date / monotonic / nulls / currency)
  → contentHash (sha256 of normalized rows)
```
Input sources: **live** = journal_entries, invoices, bills. **declared (contracted, filled in later phases)** = payments, payroll, assets, liabilities, inventory, customer_behavior, vendor_behavior, macro_indicators — surfaced via `GET /forecast-platform/sources`.

## 5. Feature-engineering pipeline (leakage-guaranteed)
`computeFeatures(rows)` — for period *t* uses **only** rows ≤ *t*; stamps `knowledgeDate = periodEnd`. Features: revenue/expenses/netCashFlow lags (1,3), trailing rolling mean/std(3), MoM %, AR/AP exposure (`ar_new`, `ap_new`, `ar_minus_ap`), activity (`entries`), calendar (`month`, `quarter`, `period_index`). Unit-tested so `features[t]` is identical whether or not future rows exist (no look-ahead).

## 6. APIs (`/api/v1/forecast-platform`, auth + business scoped)
`GET /sources` · `POST /datasets/build` (build+validate, preview — no persist) · `GET /datasets` (registry/lineage) · `POST /features/materialize` (build→engineer→persist→register) · `GET /features?datasetKey=&granularity=&asOf=` (point-in-time snapshots).

## 7. Production deployment strategy (phased to the target stack)
- **Now (in-repo):** runs inside the Express app; snapshots in Mongo; FX cached in-request; DB-readyState guard makes persistence a no-op when disconnected.
- **Scale-out:** move `datasetBuilder` extraction to **Prefect/Airflow** DAGs writing **Parquet→MinIO**; promote the feature store to **TimescaleDB** (the schema is hypertable-ready on `periodStart`); register datasets/models in **MLflow**; wrap validation in **Great Expectations** + **Evidently** drift checks; serve heavy ML via **FastAPI** workers behind **RabbitMQ**; containerize (Docker) and orchestrate on **Kubernetes** with **Prometheus/Grafana**.
- **Isolation at scale:** the `tenantScope` choke-point becomes RLS + per-tenant partitions; global models (opt-in) consume only aggregated, de-identified snapshots.

## 8. Validation
22 unit tests: tz bucketing (incl. offset late-night day) · gap-fill · tenant isolation (reject/scope/cross-tenant) · validation suite (future-date leakage, monotonic, currency) · currency normalization (passthrough/convert/cache/fallback) · leakage-safe feature math (lags/MoM/rolling, no look-ahead) · dataset builder ETL (daily→monthly aggregation, AR/AP, gap-fill). Full backend suite **588 passing**, zero regressions.

## 9. Edge cases & future
New tenant / empty ledger (validated empty series) · missing periods (imputed) · multi-currency history (as-of FX) · late-night local transactions (tz offset) · FX outage (1:1 fallback) · DB disconnected (persist no-op). **Future:** IANA zones, the 8 declared sources, Parquet/Timescale migration, Prefect DAGs, GE/Evidently, MLflow registry — all without changing the F1 interfaces.
