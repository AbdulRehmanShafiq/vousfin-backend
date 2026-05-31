# Statistical Forecasting Subsystem — Design

> Classical/statistical models as first-class ensemble members. Holt-Winters &
> Holt's ES are **shipped** (in-process, JS); ARIMA/SARIMA/VAR/ETS/Prophet/BSTS
> run in the **Python worker** (F8) behind the inference client + circuit breaker.
> All share the F3 registry, baseline gate, and walk-forward backtester.

## Where each model runs
| Model | Runtime | Status |
|---|---|---|
| Holt-Winters, Holt's Double ES | Node (`classical.js`) | ✅ shipped (ensemble member) |
| ETS, ARIMA, differenced-AR | Node (planned, JS-feasible) | ▶ next |
| SARIMA, VAR, Prophet, BSTS | Python worker (FastAPI) | contract ready (F8) |

## Per-model specification

### ARIMA(p,d,q)
1. **Use cases** non-seasonal series with trend; short-/medium-horizon revenue/expense.
2. **Strengths** principled, parsimonious, interpretable (AR+MA), good with autocorrelation.
3. **Weaknesses** no seasonality, assumes (after differencing) stationarity & linearity; manual order selection.
4. **Data** ≥30–50 points; single series; stationary after d differences.
5. **Hyperparameters** p (AR), d (differencing), q (MA); selection by AIC/BIC grid or auto-arima.
6. **Training** difference d times → fit AR/MA by MLE/CSS → check residual whiteness (Ljung-Box).
7. **Validation** rolling-origin one/multi-step; residual ACF; AIC/BIC; MASE vs seasonal-naive (gate).

### SARIMA(p,d,q)(P,D,Q)ₘ
1. **Use cases** seasonal business cycles (monthly m=12, quarterly m=4).
2. **Strengths** explicit seasonal + non-seasonal structure; strong on stable seasonality.
3. **Weaknesses** many params, needs ≥2 full seasons, sensitive to misspecified m.
4. **Data** ≥2–3× seasonal period (24–36 monthly points).
5. **Hyperparameters** (p,d,q)(P,D,Q,m); grid/auto search by AICc.
6. **Training** seasonal+regular differencing → MLE → residual diagnostics.
7. **Validation** seasonal walk-forward; coverage of seasonal peaks; MASE gate.

### VAR(p)
1. **Use cases** *interdependent* series — revenue⇄expenses⇄cash; cross-series shocks.
2. **Strengths** captures lead/lag between variables; impulse-response / Granger causality.
3. **Weaknesses** parameter blow-up (k²p), needs more data, assumes linearity/stationarity.
4. **Data** multivariate, aligned; ≥10×(k·p) points.
5. **Hyperparameters** lag order p (AIC/BIC), variable set.
6. **Training** OLS per equation on stacked lags; stability (eigenvalues < 1).
7. **Validation** multivariate rolling-origin; per-series MASE; forecast-error-variance decomposition.

### Prophet
1. **Use cases** strong multiple seasonalities + holidays + changepoints; analyst-friendly.
2. **Strengths** robust to missing data/outliers, holiday regressors, automatic changepoints, fast.
3. **Weaknesses** additive/structural assumptions; can over-smooth; less sharp than ARIMA on pure AR.
4. **Data** ≥several months; daily/weekly ideal; holiday calendar.
5. **Hyperparameters** changepoint_prior_scale, seasonality_prior_scale, seasonality_mode, holidays.
6. **Training** Stan MAP/MCMC fit of trend+seasonality+holidays.
7. **Validation** Prophet cross_validation (rolling) + coverage; MASE gate.

### Holt-Winters (Triple ES) — ✅ shipped
1. **Use cases** level+trend+seasonal, limited history (our default classical member).
2. **Strengths** cheap, robust, no stationarity assumption, good with 6+ months.
3. **Weaknesses** point seasonality only; weaker with irregular seasonality/long horizons.
4. **Data** ≥2× period for seasonal; falls back to Holt's Double ES when shorter.
5. **Hyperparameters** α (level), β (trend), γ (seasonal), period m.
6. **Training** recursive smoothing (`classical.js`).
7. **Validation** walk-forward MASE/coverage (F3) — already gated.

### ETS (Error/Trend/Seasonal state space)
1. **Use cases** automatic model class selection (additive/multiplicative, damped trend).
2. **Strengths** unifies the ES family; AICc auto-selection; prediction intervals from the state-space form.
3. **Weaknesses** still univariate; multiplicative forms unstable near zero.
4. **Data** similar to Holt-Winters.
5. **Hyperparameters** error{A,M}, trend{N,A,Ad}, season{N,A,M}, m.
6. **Training** MLE over the chosen ETS form; AICc selection across forms.
7. **Validation** rolling-origin; interval coverage; MASE gate.

### Bayesian Structural Time Series (BSTS)
1. **Use cases** trend+seasonal+regression with *uncertainty* + causal-impact analysis.
2. **Strengths** full posterior (native intervals), handles regressors/spike-and-slab selection, missing data.
3. **Weaknesses** compute-heavy (MCMC), needs priors, slower.
4. **Data** flexible; benefits from regressors (macro features).
5. **Hyperparameters** state components (local level/trend, seasonal), prior scales, MCMC iters.
6. **Training** Kalman filter + Gibbs sampling of state + coefficients.
7. **Validation** posterior predictive checks; one-step-ahead log-likelihood; MASE gate.

## Registry integration
Each model registers a `ModelRegistry` version (`type`, hyperparameters in `backtest`/metadata,
`modelMase`, `baselineMase`, `gatePassed`) and **must beat seasonal-naive** to be promoted
(F3 gate + F5 champion/challenger). Forecasts persist to `ForecastRun` with the model version.

## Forecasting APIs (existing surface)
`GET /forecast-registry/ensemble` (combined) · `POST /forecast-registry/backtest`
(score a model) · `GET /forecast-registry/champion` · `GET /forecast-registry/explain`.
Python-worker models are invoked via `inferenceClient.request('/api/v1/vousfin/forecast', …)`
with classical fallback on breaker-open.

## Backtesting framework (shipped — `backtest.js`)
Rolling-origin (walk-forward) splitter, identical folds for every model; metrics
MAE/RMSE/MAPE/sMAPE/**MASE**/pinball/coverage; the **baseline gate** (MASE < seasonal-naive)
governs promotion. Same harness scores classical, ML, ensemble, and worker models.

## Implementation plan
1. ✅ Holt-Winters/Holt's in the ensemble + gate + backtest.
2. ▶ Add ETS (AICc selection) + differenced-AR (ARIMA-lite) as JS members.
3. ▶ Python worker: statsmodels SARIMA/VAR, Prophet, `bsts`/`orbit` BSTS behind the F8 contract.
4. Auto-order search (AICc) + per-tenant model selection logged to the registry.
