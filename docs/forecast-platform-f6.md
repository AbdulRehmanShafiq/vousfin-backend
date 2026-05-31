# Forecast Platform — F6: Forecast Domains

> Six institutional forecast domains on the shared ensemble + feature spine. Each
> uses the *right* model for its problem (not one-size-fits-all), reads only
> tenant-scoped live data, and is additive/backward-compatible.

## Domains & models
| Domain | Model | Output |
|---|---|---|
| **Profitability** | F4 ensemble + conformal | net-profit forecast + intervals (runs through the F3 gate) |
| **Liquidity stress** | Monte-Carlo VaR (seeded, 2000 sims) | VaR, **ruin probability**, ending-cash percentiles, expected cash trajectory |
| **Debt exposure** | balance-sheet + ensemble | current/projected liabilities, debt-to-asset, coverage ratio |
| **AR payment behavior** | Kaplan-Meier survival | median/mean days-to-pay, survival curve, **collection schedule** for open AR |
| **Inventory demand** | Croston (intermittent) / ensemble | demand forecast + current stock value + low-stock count |
| **Macro sensitivity** | OLS regression | revenue↔FX **beta, R², elasticity** + ±10% FX scenarios |

## Files
**New (pure science):** `services/forecasting/domains/liquidityStress.js`
(Monte-Carlo VaR), `survival.js` (Kaplan-Meier), `croston.js`, `sensitivity.js`
(OLS). **New (orchestrator):** `domainForecast.service.js`. **New (API):**
`controllers/forecastDomain.controller.js` + `routes/v1/forecastDomain.routes.js`
(mounted `/api/v1/forecast-domains`). **Frontend:** `forecastDomain.service.js` +
`useForecastDomain` hook.

## API
`GET /forecast-domains` (list) ·
`GET /forecast-domains/:domain?horizon=` where domain ∈
`profitability | liquidity-stress | debt-exposure | ar-payment-behavior | inventory-demand | macro-sensitivity`.

## Safety / invariants
- **Right model per problem:** Monte-Carlo for tail risk, survival for time-to-event,
  Croston for intermittent demand, OLS for sensitivity — not a single model forced everywhere.
- **Deterministic:** the Monte-Carlo simulation uses a seeded PRNG (reproducible/testable).
- **Tenant-isolated + read-only:** every query is `businessId`-scoped; no ledger writes.
- **Graceful degradation:** each domain returns `insufficient`/`available:false` with a note
  when data is too thin (e.g., no aligned FX history for macro sensitivity).
- **Honest proxies labelled:** inventory demand uses an aggregate revenue demand-value proxy
  (per-SKU is a later pass) — stated in the response `note`.

## Validation
17 new unit tests — domain science (MC-VaR determinism + healthy/stressed ruin
probability; Kaplan-Meier monotonicity + censoring + schedule; Croston intermittent
vs zero; OLS slope/R²/projection) + orchestrator wiring for all six domains
(mocked sources). Full backend suite **653 passing**, 4 pre-existing unrelated
suites unchanged.

## Next (roadmap): F7 — explainability (SHAP/quantile attribution) + scenario engine
Attaches feature attributions + plain-English drivers to the gated champion and
each domain forecast.
