# Forecast Platform — F2: Source Coverage + Nightly Materialization

> Expands the dataset builder from 3 to 10 live input sources and pre-warms the
> feature store nightly. Additive + backward-compatible: the default source set
> (`journal_entries, invoices, bills`) and all F1 behavior are unchanged; new
> sources are opt-in via the `sources` parameter.

## Sources now live (was: declared)
| Source | Type | Signal |
|---|---|---|
| journal_entries · invoices · bills | flow | revenue/expenses/cashflow · AR · AP *(F1)* |
| **payments** | flow | `cashInflow` (inbound), `cashOutflow` (outbound) from the Payment entity |
| **payroll** | flow | `payrollExpense` — JE postings debiting a salary/wage/payroll account |
| **customer_behavior** | flow | `activeCustomers` (distinct/period), `newInvoices` |
| **vendor_behavior** | flow | `activeVendors`, `newBills` |
| **assets** · **liabilities** | snapshot | `totalAssets`, `totalLiabilities`, `equity` from Chart-of-Account running balances |
| **inventory** | snapshot | `inventoryValue`, `lowStockCount`, `inventoryItems` from InventoryItem |
| macro_indicators | declared | external connector — deferred to F8 (surfaced via `GET /forecast-platform/sources`) |

**Flow** sources contribute per-period to the contiguous time series (currency- &
tz-normalized, gap-filled, leakage-validated like F1). **Snapshot** sources attach
current-state context to the latest period.

## Feature engineering (F2 additions, leakage-safe period features)
`featureStore.computeFeatures` now emits `cash_inflow`, `cash_outflow`,
`net_cash_movement`, `payroll_expense`, `active_customers`, `active_vendors`,
`new_invoices`, `new_bills` per period — feeding the F4 ensemble and F6 domains.

## Nightly materialization
`jobs/forecastMaterialize.job.js` — nightly 02:00, for every active business,
build → engineer → persist the **full** multi-source dataset at monthly + weekly
grain (`featureStore.materialize`). Forecasts/backtests then read ready-made
point-in-time snapshots with no request-time ETL. Flag `FORECAST_MATERIALIZE_ENABLED`
(default on); one tenant's failure never aborts the sweep.

## Files
**Modified:** `services/forecasting/platform/datasetBuilder.service.js` (5 new
extractors + merge/snapshot logic + source registry), `featureStore.service.js`
(new features), `config` (flag), `server.js` (cron). **New:**
`jobs/forecastMaterialize.job.js`.

## Safety / invariants
- **Tenant isolation:** every new extractor goes through `assertTenant`/`businessId`-scoped aggregates.
- **Currency + timezone normalized:** flow amounts converted as-of date to base currency, bucketed on the F1 tz calendar.
- **No leakage:** new features are period-level (period *t* only); validation still rejects future-dated rows.
- **Backward compatible:** default sources + all F1 tests unchanged; macro stays declared.

## Validation
4 new unit tests (source registry advertises live/declared; payments → cash
in/out; customer behavior → distinct active customers + new invoices; snapshot →
assets/liabilities/equity/inventory on the latest period) + F1 builder/featureStore
suites still green. Full backend suite **636 passing**, 4 pre-existing unrelated
suites unchanged.

## Next (roadmap): F6 — forecast domains
With cash-flow, payroll, AR/AP, party-activity and balance-sheet features now in
the store, F6 builds the domain forecasts (liquidity stress, debt exposure, AR
payment behavior, inventory demand, profitability, macro sensitivity) on the same
ensemble + gate spine.
