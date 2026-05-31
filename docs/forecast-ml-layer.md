# Machine-Learning Forecasting Layer — Design

> Tree/boosting + regularized-linear regressors as ensemble members, consuming
> the Feature Engineering Framework matrix. AR ridge-OLS is **shipped** (JS,
> ensemble member + the exact-attribution model for F7). The tree models run in
> the **Python worker** (F8); ElasticNet is JS-feasible next. All share the F3
> registry, baseline gate, walk-forward backtester, and feature-importance engine.

## Where each model runs
| Model | Runtime | Status |
|---|---|---|
| AR ridge-OLS (linear ML member) | Node (`regression.js`) | ✅ shipped |
| ElasticNet | Node (planned) | ▶ next |
| XGBoost · LightGBM · CatBoost · RandomForest · ExtraTrees · GradientBoosting | Python worker | F8 contract ready |

## Per-model specification (use case · strengths · weaknesses · hyperparameters)
| Model | Use case | Strengths | Weaknesses | Key hyperparameters |
|---|---|---|---|---|
| **XGBoost** | tabular lag/calendar features, non-linear interactions | accuracy, regularization (L1/L2), handles missing, monotonic constraints | tuning surface large, can overfit small series | n_estimators, max_depth, eta, subsample, colsample, lambda, alpha, min_child_weight |
| **LightGBM** | large feature sets, fast retrains | leaf-wise growth (fast/accurate), categorical native, low memory | leaf-wise overfits tiny data; needs min_data tuning | num_leaves, max_depth, learning_rate, feature/bagging_fraction, min_data_in_leaf, lambda_l1/l2 |
| **CatBoost** | many categorical drivers (vendor/customer/segment) | best-in-class categoricals, ordered boosting (less leakage), strong defaults | slower training, larger models | iterations, depth, learning_rate, l2_leaf_reg, border_count |
| **Random Forest** | robust baseline, low tuning | low variance via bagging, parallel, robust to outliers | weaker extrapolation/trend, large models | n_estimators, max_depth, max_features, min_samples_leaf, bootstrap |
| **Extra Trees** | high-variance data, speed | extra randomization → lower variance, very fast | slightly higher bias, no extrapolation | n_estimators, max_features, min_samples_leaf |
| **ElasticNet** | many correlated features, want sparsity + stability | L1+L2 (feature selection + grouping), convex, fast, interpretable | linear only; needs scaling | alpha, l1_ratio, max_iter, tol |
| **Gradient Boosting** | reference boosting baseline | flexible loss, strong accuracy | sequential (slow), tuning-sensitive | n_estimators, learning_rate, max_depth, subsample |

> **Time-series caveat for all:** trees can't extrapolate trend, so we feed
> differenced/detrended targets + lag/EWMA/Fourier features, and combine them in
> the ensemble with trend-aware members (Holt-Winters, AR, drift). Cross-validation
> is **walk-forward only** (never k-fold shuffled) to prevent leakage.

## Architecture
```
Feature Engineering matrix (causal, leakage-safe)
        │
        ▼  feature set (MI/PCA/SHAP selection)
  ┌─────────────── ML LAYER ───────────────┐
  │ Node:   ElasticNet · AR-OLS            │
  │ Python: XGBoost·LightGBM·CatBoost·RF·ET·GBM (inference worker, GPU-ready)
  └──────────────────┬─────────────────────┘
                     ▼  member forecasts
        backtest-weighted stacking (F4 ensemble) → conformal intervals
                     ▼
        F3 baseline gate + registry · F5 champion/challenger · F7 explainability
```

## Pipelines
- **Feature pipeline** — `featureEngineering.pipeline.engineer(rows)` → matrix; `selection` picks the feature set per model; persisted to `ForecastFeatureSnapshot`.
- **Training pipeline** — per tenant×target: load point-in-time snapshots ≤ knowledgeDate → walk-forward fit (Optuna HPO in the worker) → register `ModelRegistry` version with backtest metrics → gate.
- **Inference pipeline** — `inferenceClient.request()` to the worker (timeout + circuit breaker); on breaker-open, fall back to the in-process AR/ensemble. Cache via `infra/cache`. Queue heavy batches via `infra/jobQueue`.
- **Online retraining** — F5 weekly + drift-triggered (`driftMonitor` PSI/accuracy-decay) → challenger fit → promote only if it beats the champion (F5).
- **Feature importance engine** — tree `feature_importances_`/gain + **SHAP** (Python worker) for instance-level attribution; the AR member uses exact `coef×feature` (F7). Unified into `drivers[]` on every forecast.

## Model comparison framework
All members + baselines run through the *same* walk-forward harness; the registry
stores MAE/RMSE/sMAPE/**MASE**/pinball/coverage per model version. A comparison
report ranks them, the ensemble weights ∝ inverse backtest error, and the
**champion/challenger** router (F5) promotes the winner with auto-rollback on
realized-accuracy regression (F9).

## Production deployment strategy
- Models trained/served in the **Python worker pool** (Docker `Dockerfile.worker`,
  K8s `ml-worker` Deployment + HPA, GPU node-pool for heavy boosting/TFT).
- Model artifacts in object storage (MinIO/S3) + registered in MLflow (F9);
  `ModelRegistry` (Mongo) holds the lineage/gate verdict the app reads.
- Node stays the stateless orchestrator (auth, tenancy, gate, cache, queue,
  fallback). Scale-out + tipping points per `forecast-platform-roadmap.md` / F8.

## Implementation plan
1. ✅ AR ridge-OLS member + exact attribution (F4/F7).
2. ▶ ElasticNet (coordinate descent) as a JS member + registry/gate.
3. ▶ Python worker: XGBoost/LightGBM/CatBoost/RF/ExtraTrees/GBM training + Optuna HPO + SHAP, behind the F8 `/forecast` + `/explain` contract.
4. Comparison dashboard (registry-backed) + champion/challenger auto-rollback (F9).
