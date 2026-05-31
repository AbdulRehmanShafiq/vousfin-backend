% VousFin Forecasting → Smart Accountant: Detailed Implementation Plan
% VousFin Engineering
% 2026

# 1. Goal & Principles

**Goal.** Make VousFin's forecasting genuinely accurate and trustworthy, then grow
it into an intelligent accountant that can largely replace a human bookkeeper for
a small business.

**The accuracy principle (non-negotiable).** We never *claim* a fixed accuracy.
We **measure** it per business, attach a **confidence score** to every forecast,
show a number only when we're confident, and otherwise widen the range or ask for
more data. "≥80% accurate" is a *target we prove*, defined as: at a 1–3 month
horizon, the actual lands inside the predicted range ≥80% of the time (interval
coverage) and typical error (MAPE) ≤ ~20%.

**Engineering principles.** Every step is (1) shippable on its own, (2)
backward-compatible, (3) tenant-isolated (never mix businesses' data), (4)
leakage-free (never use the future to predict the past), (5) tested, and (6)
committed + pushed.

# 2. Where we are today (foundation already built)

- 10-source feature store + feature-engineering framework (lags, rolling stats, EWMA, Fourier, mutual information, PCA).
- A 6-model ensemble (seasonal-naive, drift, Holt-Winters, ETS, AR, ElasticNet) with **conformal confidence ranges**.
- Walk-forward backtesting + a **baseline gate** (never serve a model worse than naive), a stored **accuracy record** (predicted vs realized), auto-retraining, and drift detection.
- 6 domain forecasts (cash-flow/liquidity stress, debt exposure, AR payment behavior, inventory demand, profitability, macro sensitivity).
- Explainability (why a forecast says what it does) + what-if scenarios.

**The gap:** make accuracy *visible & provable* (Stage A) → *push it up* (Stage B)
→ add the *accountant experience* (Stage C) → *package & scale* (Stage D).

---

# 3. STAGE A — Make accuracy real & visible *(trust first)*

## Step A1 — Accuracy & Confidence service
**Objective.** One service that, for a business + metric, returns a measured
accuracy %, a 0–100 confidence score, the data-sufficiency state, and an honest
"insufficient data" verdict.

**Build.**
- `services/forecasting/accuracyScore.service.js`
  - `score(businessId, target)`:
    1. Read realized accuracy from `ForecastAccuracy` (MAPE, interval coverage) over the last K forecasts.
    2. Read the latest backtest from `ModelRegistry` (MASE, sMAPE).
    3. Compute **accuracyPct** = `100 − clamp(MAPE, 0, 100)` (or coverage-based), **confidence** = blend of {data sufficiency, backtest skill vs baseline, interval coverage, anomaly penalty}.
    4. Return `{ accuracyPct, confidence, label: High/Medium/Low/Insufficient, basis: "last N months", coverage, mape }`.
- API: `GET /forecast-registry/accuracy-score?target=` (controller method + route).

**Data used.** `ForecastAccuracy`, `ModelRegistry`, anomaly risk (all already exist).

**Acceptance criteria.**
- Returns a number only when ≥3 realized data points OR a valid backtest exists; else `label:"Insufficient"` with a clear message.
- Confidence drops with: little data, high volatility, poor coverage, open fraud anomalies.
- Deterministic for the same inputs.

**Tests.** Unit tests (mocked stores): high-coverage→High; thin data→Insufficient; volatile→lower confidence. **Effort:** S. **Depends on:** existing F3/F5 stores.

## Step A2 — Backfill accuracy from history
**Objective.** Make confidence real from day one by computing realized accuracy
for existing businesses.

**Build.**
- `migrations/backfill_forecast_accuracy.js` — for each business, run the
  walk-forward backtest on its live series and write the implied accuracy points
  so `accuracyScore` has data immediately. Idempotent + re-runnable. npm script
  `migrate:backfill-accuracy`.

**Acceptance criteria.** After running, every business with ≥6 months of data has
a non-empty accuracy record; the job is safe to re-run and never writes to the ledger.
**Tests.** Dry-run on mocked data. **Effort:** S. **Depends on:** A1, backtest harness.

## Step A3 — The Forecast Card (frontend)
**Objective.** One clean screen a business owner trusts: the prediction, the
range, the confidence badge, the measured accuracy, and the top reasons.

**Build.**
- `services/forecastInsights.service.js` (frontend) + `useForecastCard` hook combining: ensemble forecast (`/forecast-registry/ensemble`), accuracy score (A1), and explanation (`/forecast-registry/explain`).
- `components/forecasting/ForecastCard.jsx`:
  - Headline: "Next month revenue: **₨X** (range ₨low–₨high)".
  - Confidence badge (High/Medium/Low) + "Based on your last N months, forecasts have been **~Y% accurate**."
  - Top 2–3 drivers (plain English, from `explain`).
  - Honest empty state when Insufficient.
- Wire into the existing forecast page (additive, behind the existing route).

**Acceptance criteria.** Shows a confident card for data-rich businesses; a
clear "add more transactions to unlock forecasting" for thin ones; never shows a
fake precise number. Lint clean, build passes.
**Tests.** Component renders all states; hook integration. **Effort:** M.

**Stage A definition of done:** a business owner can open one screen and see a
forecast, its range, how confident we are, and how accurate we've been — all
measured, never asserted.

---

# 4. STAGE B — Push measured accuracy up *(the levers)*

## Step B1 — Hierarchical (by-stream) forecasting + reconciliation
**Objective.** Forecast revenue/expenses by category/stream and reconcile to the
total — more accurate and more useful.

**Build.**
- `services/forecasting/hierarchical.service.js`: forecast each stream (top accounts/categories) with the ensemble, then **reconcile** (bottom-up or MinT-style proportional) so parts sum to the total.
- API: `GET /forecast-registry/hierarchical?target=`.

**Acceptance criteria.** Stream forecasts sum to the total; backtest MASE of the
reconciled total ≤ the direct total forecast on most businesses. **Tests.**
Reconciliation sums correctly; improves or matches a synthetic series. **Effort:** M.

## Step B2 — Calendar & seasonality regressors
**Objective.** Teach the models about holidays, payroll cycles, month-end effects.
**Build.** Extend the feature framework: a holiday/region calendar + payroll-phase
flags + the existing Fourier terms, fed into the ML members. **Acceptance:** measured
accuracy improves on businesses with clear seasonality; leakage tests still pass.
**Effort:** M.

## Step B3 — Global / transfer model *(biggest accuracy lever)*
**Objective.** Train one privacy-safe model across many **de-identified, normalized**
business series so a new or thin business gets a strong forecast immediately.
**Build.**
- Python worker model (DeepAR/MFLES-style global model) trained on aggregated,
  de-identified, scaled series (no raw cross-tenant data is ever exposed).
- Node calls it via the existing inference client (timeout + circuit breaker);
  result ensembles with local models and goes through the **baseline gate**.
- Opt-in per tenant; a hard tenant guard at the serving boundary.
**Acceptance.** Cold-start businesses (1–3 months) get a materially better,
honest forecast than local-only; isolation proven (no tenant can see another's data).
**Effort:** L (needs the Python worker running).

## Step B4 — Foundation-model option (zero-shot)
**Objective.** A good forecast on **day one** with no training.
**Build.** Integrate a time-series foundation model (TimeGPT/Chronos) in the
Python worker as an additional ensemble member; gate + weight it by backtest skill
like any model. **Acceptance.** New businesses see a sensible forecast immediately;
it only wins weight when it actually beats the others. **Effort:** L (worker + API key/model).

**Stage B definition of done:** measured accuracy is higher and confident sooner,
especially for new/small businesses.

---

# 5. STAGE C — The Smart Accountant *(replace-the-accountant features)*

## Step C1 — Cash-flow & runway radar
Productize the liquidity-stress model into "you'll dip below safe cash around
**March** (confidence 78%) — driven by X; here's what to do." Push alert + screen.
**Build:** `runwayRadar.service.js` (current cash + cash-flow forecast + threshold
+ Monte-Carlo ruin probability, all already built) → alert records + digest.
**Acceptance:** flags real cash risks with a confidence and a recommendation. **Effort:** M.

## Step C2 — Proactive insights & alerts
Weekly plain-English digest + push alerts: spending spikes, late-payer risk
(survival model), margin erosion, tax to set aside, unusual transactions
(anomaly engine). **Build:** `insightsEngine.service.js` aggregating existing
signals into ranked, human-readable insights + a digest job. **Effort:** M.

## Step C3 — AI copilot (grounded)
A chat copilot that answers "can I afford to hire?" / "why did profit drop?" using
the business's **real ledger + forecasts**. The forecasting, anomaly, AR/AP and
reporting modules become **tools** the copilot calls; answers cite the actual
numbers (retrieval-augmented, never hallucinated). **Build:** `copilot.service.js`
(LLM + tool-calling over existing services) + chat UI. **Acceptance:** answers are
grounded in real data, show their working, and refuse when data is missing.
**Effort:** L.

## Step C4 — Bookkeeping assists
Auto-categorize transactions, suggest reconciliations, queue anomalies for review
(some pieces exist). **Build:** categorization model + review queue UI. **Effort:** L.

**Stage C definition of done:** VousFin proactively tells the owner what's
happening, what's coming, and what to do — like a good accountant would.

---

# 6. STAGE D — Scale to an industry *(productize)*

- **D1. Standalone onboarding & billing** — sign up, import data (CSV/bank feed),
  instant first forecast (thanks to B3/B4), usage metering + plans.
- **D2. Scale infrastructure on demand** — enable caching → worker pool →
  TimescaleDB → Kubernetes **only when metrics cross the tipping points** already
  documented (latency, data volume, tenant count).
- **D3. Trust & benchmarks** — publish measured accuracy, keep the durable audit
  trail, add SOC2-style controls.

**Stage D definition of done:** a stranger can sign up, connect data, get an
accurate forecast in minutes, and be billed — at scale, safely.

---

# 7. Accuracy measurement methodology (how we prove ≥80%)
1. Every served forecast is stored with its inputs + range.
2. As each period elapses, the actual is captured and compared (already automated daily).
3. Per business we track rolling **MAPE** and **interval coverage**; the
   accuracy % and confidence (A1) are derived from these — *measured, not claimed*.
4. A model can't be shown unless it beats the naive baseline on backtest (the gate).
5. We report the honest number and improve it with Stage B; where a business
   genuinely can't reach 80% (too little/irregular data) we say so and widen ranges.

# 8. Testing & validation strategy
- Pure math/services: unit tests (already the norm — 695 passing).
- Leakage tests: assert no feature/backtest uses future data.
- Accuracy regression: backtest MASE/coverage tracked per release.
- Frontend: component state tests + lint + build.
- Each step ships only when its acceptance criteria + tests pass and the full
  suite is green (no regressions).

# 9. Risks & mitigations
| Risk | Mitigation |
|---|---|
| Thin data → low accuracy | honest confidence + Insufficient states; global/foundation models for cold-start |
| Cross-tenant leakage (global model) | only de-identified, aggregated, scaled series; serving-boundary tenant guard; opt-in |
| Over-promising 80% | measure & display real numbers; never assert |
| Python worker not available | circuit breaker + in-process fallback (already built) |
| LLM hallucination (copilot) | retrieval-grounded, tool-calling over real data, cite numbers, refuse when unknown |

# 10. Sequencing & milestones
1. **M-A (now):** A1 + A2 + A3 — accuracy & confidence visible. *(Demoable product.)*
2. **M-B1:** B1 + B2 — accuracy up via structure + calendar.
3. **M-B2:** B3 + B4 — global + foundation models (needs Python worker). *(Biggest jump.)*
4. **M-C:** C1 + C2, then C3 + C4 — the Smart-Accountant experience.
5. **M-D:** D1–D3 — standalone SaaS + scale.

**Recommended start: Stage A (A1 → A2 → A3).** Small, high-impact, makes the 80%
goal concrete and provable, and yields a demoable product immediately.
