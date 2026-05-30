# Forecast Platform — F4: Multi-Model Ensemble + Conformal Intervals

> Kills the single-model approach. The served forecast is now a **backtest-
> weighted ensemble** of four members with **distribution-free, conformal-
> calibrated** prediction intervals — all scored through the F3 baseline gate.
> Backward-compatible and flag-gated (`FORECAST_ENSEMBLE_ENABLED`, default on);
> any failure falls back to the existing Holt-Winters path.

## Members (all share the `(train, horizon, opts) → number[]` signature)
| Member | Module | Role |
|---|---|---|
| seasonal-naive | `baselines.js` | the floor / gate reference |
| drift | `baselines.js` | linear-trend baseline |
| Holt-Winters | `classical.js` | level+trend+seasonal |
| AR regression (ridge OLS on lags) | `regression.js` | the ML member — drop-in slot for LightGBM/CatBoost once the Python worker (F8) lands |

## How it combines (never a simple average)
`ensemble.js` → **backtest-weighted**: each member is scored on the leakage-safe
walk-forward harness; weight ∝ 1/(MAE+ε), normalized. Skilful members dominate,
weak ones are damped. The ensemble is itself a `forecastFn`, so it is scored and
gated like any model. (Observed on a noisy trend: AR ≈ 0.54, drift ≈ 0.19,
HW ≈ 0.17, seasonal-naive ≈ 0.10.)

## Uncertainty (calibrated, not heuristic)
`conformal.js` (split conformal) collects the ensemble's walk-forward absolute
residuals per horizon step, takes the (1−α) empirical quantile as the half-width,
and bands the point forecast → **≈ guaranteed marginal coverage** (default 90%),
replacing the old ±% tier heuristic.

## Files
**New:** `services/forecasting/regression.js`, `ensemble.js`,
`ensembleForecast.service.js`. **Reused:** `conformal.js` (existing).
**Wired:** `lstmForecastService` (fallback path now serves the ensemble +
conformal bands behind the flag, defensively), `config` (flag),
`controllers/forecastRegistry.controller.js` + routes (`GET /forecast-registry/ensemble`).

## API
`GET /api/v1/forecast-registry/ensemble?target=&granularity=&horizon=` →
`{ predicted[], lower[], upper[], weights{}, coverageTarget, baselineGate, modelType }`.
The standard `/forecast` response is unchanged in shape — `modelType` now reads
`Ensemble (N-model, conformal 90%)` and a new optional `ensemble` field carries
`{weights, widths, coverageTarget}`.

## Safety / invariants
- **Never single-model** ✓ (≥2 members always active). **Leakage-safe** ✓ (weights
  + conformal residuals both from walk-forward folds). **Uncertainty** ✓ (conformal).
- **Defensive:** the ensemble override is wrapped in try/catch — a failure keeps
  the Holt-Winters forecast, so the served forecast can never break.
- **Gated through F3:** the ensemble is backtested vs seasonal-naive and persisted
  with its gate verdict like any model.

## Validation
9 new unit tests — AR member (trend extrapolation + short-series fallback),
ensemble weighting (sums to 1, skilful members out-weight naive, genuinely
multi-model), degenerate equal-blend, conformal intervals (valid half-widths,
brackets the point, empirical coverage), orchestrator (point+intervals,
insufficiency). Full backend suite **617 passing**, 4 pre-existing unrelated
suites unchanged. Smoke-verified end-to-end.

## Next (roadmap): F5 — incremental retraining + drift detection
The ensemble + accuracy store (F3) feed drift monitoring (PSI/KL + accuracy
decay) and scheduled/triggered retraining with champion/challenger promotion.
