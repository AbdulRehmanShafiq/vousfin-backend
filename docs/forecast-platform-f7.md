# Forecast Platform — F7: Explainability + Scenario Engine

> Makes every forecast transparent: which model drove it, which inputs moved it,
> a plain-English narrative, and a what-if engine. Exact attribution where the
> math allows it (no black-box approximation); the Python SHAP worker (F8) drops
> into the same interface later for non-linear members.

## Attribution (`explainability/attribution.js`, pure — exact)
- **Ensemble decomposition** — splits the ensemble point forecast into each
  member's weighted contribution (`weight × member_forecast`): *which model drove the number*.
- **Linear (AR) contributions** — `coef_i × feature_i` is the **exact Shapley value
  of a linear model**, so the autoregressive member's drivers (most-recent values,
  trend) are attributed precisely, ranked by magnitude with direction (up/down).

## Scenario engine (`explainability/scenario.js`, pure)
What-if by **refitting** the ensemble on a shocked series (captures changed
dynamics, not a flat rescale): `applyShock`, `whatIf`, `compare` (per-step deltas),
`sweep` (multiplier grid → sensitivity curve).

## Orchestrator (`explainability.service.js`)
- `explain(businessId, target, horizon)` → `memberContributions[]` + `drivers[]` +
  a **plain-English narrative** ("The revenue forecast is led by the Holt-Winters
  seasonal model (52%); its strongest signal is the most recent revenue (t-1),
  pushing the forecast up; recent revenue is rising +6.2% MoM…").
- `scenario(businessId, target, horizon, {revenueMultiplier|expenseMultiplier})` →
  base vs scenario path + comparison.

## API / Frontend
`GET /forecast-registry/explain?target=&horizon=` ·
`POST /forecast-registry/scenario {target,horizon,revenueMultiplier,expenseMultiplier}`.
Frontend: `forecastRegistryService.explain/scenario` + `useForecastExplanation`/`useForecastScenario`.

## Safety / invariants
- **Exact, not approximate** for linear/ensemble decompositions (sums reconcile to the forecast).
- **Tenant-isolated + read-only.** **Graceful degradation** on thin history (`insufficient`).
- **Backward compatible** — additive endpoints; existing forecast responses unchanged.

## Validation
9 new unit tests — ensemble attribution (contributions sum to total, ranked),
exact linear attribution (base + coef·feature, direction), scenario engine
(applyShock, refit what-if lifts a +20% path, compare deltas, sweep), and the
orchestrator (member+driver+narrative, insufficient guard, scenario vs base).
Full backend suite **662 passing**, 4 pre-existing unrelated suites unchanged.

## Next (roadmap): F8 — scale-out infra (metric-triggered) · F9 — MLOps governance + SaaS
F8 introduces Redis/RabbitMQ/Timescale/K8s only as tipping points fire; the
Python SHAP worker for non-linear attribution lands there. F9 adds champion
dashboards, auto-rollback, usage metering and standalone SaaS onboarding.
