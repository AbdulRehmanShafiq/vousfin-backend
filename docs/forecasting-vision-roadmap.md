# VousFin Forecasting → Intelligent Smart Accountant — Vision, Research & Roadmap

> Plain-English plan to make VousFin's forecasting **genuinely accurate and
> trustworthy**, and grow it into a tool that can **replace an accountant** for a
> small business — built in small, shippable steps on what already exists.

---

## 1. The honest truth about "80% accuracy"
No forecaster is 80% accurate for *every* business — it depends on data. So the
world-class approach (Amazon Forecast, Nixtla, Pilot, Digits all do this) is:
1. **Measure** accuracy continuously (we already store predicted-vs-actual).
2. Show a **confidence score** on every forecast.
3. Only present a confident number; otherwise widen the range or say
   "add more data." **Never fake a precise number.**
4. Use proven levers to push the *measured* number up over time.

**Definition we'll commit to:** for a metric (e.g. revenue) at a 1–3 month
horizon, "accurate" = the actual lands inside the predicted range ≥ 80% of the
time (interval coverage) AND typical error (MAPE) ≤ ~20%. We already compute
coverage + MAPE per business, so we can *prove* this number, not claim it.

---

## 2. Best-of-world ideas (researched) and what we pick
| Idea (who) | What it gives | Verdict for VousFin |
|---|---|---|
| **Ensemble of simple models + good cross-validation** (M5/M4 winners) | beats fancy AI on most business series | ✅ already our core (6-model ensemble + walk-forward) |
| **Global / transfer model** (Amazon DeepAR) — one model trained across *many* businesses | huge accuracy lift for businesses with **little history** (cold start) | ✅ **adopt** — the single biggest lever for SMBs |
| **Time-series foundation models** (TimeGPT/Nixtla, Chronos/Amazon, TimesFM/Google) | good zero-shot forecast on **day one**, no training | ✅ **adopt as an option** via the Python worker |
| **Conformal prediction** | honest, guaranteed confidence ranges | ✅ already shipped |
| **Hierarchical reconciliation** (forecast parts + total, make them agree) | more coherent, more accurate | ✅ adopt (forecast revenue by stream, reconcile to total) |
| **LightGBM + rich features** (M5 winner) | strong tabular accuracy | ✅ feature framework shipped; tree model via worker |
| **AI bookkeeping + copilot** (Pilot, Puzzle, Digits, Truewind) | the "replace the accountant" experience | ✅ adopt for the Smart-Accountant layer |

**Chosen architecture (best fit):** keep the **measured, gated ensemble + conformal
confidence** core; add a **global/transfer model + a foundation-model option** for
accuracy and cold-start; reconcile hierarchically; then wrap it in a **proactive
Smart-Accountant layer** (cash-flow alerts + plain-English copilot grounded in the
business's own ledger).

---

## 3. What already exists (so we build, not rebuild)
- 10-source feature store + full feature-engineering framework (lags, EWMA, Fourier, etc.).
- 6-model ensemble (statistical + ML) with **conformal confidence ranges**.
- Backtesting + **baseline gate** (won't show a model worse than naive) + a stored
  **accuracy record** (predicted vs realized) + auto-retraining + drift detection.
- 6 domain forecasts (cash-flow/liquidity stress, debt, payment behavior, inventory, etc.).
- Explainability (why the forecast says what it says) + what-if scenarios.

**The gap to the goal:** (a) make accuracy & confidence *visible and provable*,
(b) push the measured number up (global model, more data granularity, reconciliation),
(c) add the *accountant* experience (alerts + copilot), (d) package it to sell.

---

## 4. Roadmap — small, doable steps (each shippable on its own)

### STAGE A — Make accuracy real & visible *(trust first)*
- **A1. Accuracy & Confidence score** — compute per-business, per-metric measured
  accuracy (MAPE + interval coverage) and a 0–100 confidence; honest
  "insufficient data" state. *(Uses the data we already store.)*
- **A2. Backfill accuracy** — run backtests for every business, populate the
  accuracy record, so confidence is real from day one.
- **A3. Forecast card UI** — one clean screen: the prediction, the range, the
  confidence badge, "based on your last N months this is X% accurate," and the
  top reasons (we already generate these).

### STAGE B — Push measured accuracy up *(the levers)*
- **B1. Finer + categorized data** — forecast revenue/expense by stream and
  reconcile to the total (hierarchical) → more accuracy + more useful detail.
- **B2. Seasonality + calendar regressors** — holidays, payroll cycles, month-end
  effects (feature framework already has the Fourier pieces).
- **B3. Global / transfer model** — train one privacy-safe model across many
  de-identified businesses so a new business gets a strong forecast immediately.
- **B4. Foundation-model option** — plug TimeGPT/Chronos via the Python worker for
  instant zero-shot forecasts; ensemble it with our models, keep the best (gated).

### STAGE C — The Smart Accountant *(replace-the-accountant features)*
- **C1. Cash-flow & runway radar** — "you'll dip below safe cash in March
  (confidence 78%) — here's why and what to do." *(Builds on liquidity stress.)*
- **C2. Proactive insights & alerts** — spending spikes, late-payer risk, margin
  erosion, tax to set aside; weekly plain-English digest + push alerts.
- **C3. AI copilot** — ask "can I afford to hire?" / "why did profit drop?" and get
  a grounded answer using the business's real ledger + forecasts (the forecasting,
  anomaly, AR/AP modules become tools the copilot calls).
- **C4. Bookkeeping assists** — auto-categorize transactions, suggest
  reconciliations, queue anomalies for review.

### STAGE D — Scale to an industry *(productize)*
- **D1. Standalone onboarding** — sign up, import data (CSV/bank feed), instant
  first forecast (thanks to B3/B4). Usage metering + billing.
- **D2. Scale infra as load grows** — turn on caching, worker pool, Timescale, K8s
  *only when metrics demand it* (the tipping-point plan already exists).
- **D3. Trust & benchmarks** — publish measured accuracy, keep the audit trail,
  SOC2-style controls (the durable event log/audit already exists).

---

## 5. Recommended first step
**Start with A1 + A3** — turn the accuracy/confidence the engine already measures
into something a business owner can *see and trust* on one clean screen. It's
small, high-impact, makes the "80%" goal concrete and provable, and gives us a
demoable product immediately. Then B3 (global model) is the biggest accuracy jump.

*Each step: shippable on its own · backward-compatible · tested · the accuracy
number is always measured and honest, never asserted.*
