# VousFin Feature Engineering Framework

> A world-class, leakage-safe financial feature framework. Built on the F1/F2
> feature store; every transform is causal and every feature is declared once in
> a catalog. **Shipped + tested** (transforms, selection, catalog, pipeline).

## 1. Feature families (catalog-driven)
One declarative registry (`featureEngineering/catalog.js`) — `count() = 30` features:

| Family | Features |
|---|---|
| **financial_health** | revenue_growth · expense_growth · profit_margin · liquidity_ratio · debt_ratio · working_capital_trend · cash_burn_rate · operating_leverage |
| **behavioral** | customer_payment_delay · collection_velocity · vendor_payment_cycle · churn_signal · recurring_revenue_stability |
| **seasonality** | fourier_weekly · monthly · quarterly · yearly · holiday_effect · payroll_cycle |
| **risk** | volatility · spending_spike · fraud_influence · anomaly_adjusted_trend · regime_shift |
| **macro** | inflation · interest_rate · oil · gold · fx_rate · regional_indicator |

Each catalog row carries `{family, name, formula, source, leakageSafe}` — the pipeline and the registry/UI document forecasts against it.

## 2. Transforms (causal, `featureEngineering/transforms.js`)
`lag` · `rollingMean/Std/Min/Max/Sum` · `rollingZScore` · **`ewma`** (span→α) ·
`diff` · `pctChange` · **Fourier** seasonality terms (`sin/cos(2π·h·t/P)`, multi-period, multi-harmonic).
**Every transform is CAUSAL**: value at *t* uses only indices ≤ *t*; insufficient history → `null` (never forward-filled). A feature matrix built from these is leakage-free *by construction*.

## 3. Selection & dimensionality reduction (`featureEngineering/selection.js`)
- **Mutual information** (binned joint histogram) — non-linear dependence.
- **Pearson** — linear dependence.
- **PCA** — covariance + power-iteration eigenvectors with deflation → top-k components + explained variance (decorrelation / dimensionality reduction).
- **`selectFeatures`** — rank by MI or |corr|, top-K.
- **SHAP-based selection** — delegated to the Python worker (model-specific Shapley values; F8 contract); `selectFeatures` is the in-process fallback until it lands.

## 4. Leakage prevention (defense in depth)
1. **Causal transforms** (no look-ahead, no forward-fill).
2. **`knowledgeDate`** stamped on every engineered row (= period close).
3. **Stock/snapshot features** (assets/liabilities) attached only where genuinely known — never back-filled into history.
4. **Walk-forward only** in backtests (F3) + a validation rule that rejects future-dated rows (F1 `dataValidation`).
5. Target is never an input to its own features.

## 5. Feature store architecture
```
F1/F2 datasetBuilder (10 sources, tenant-scoped, ccy+tz normalized)
        │  rows[]  (revenue, expenses, AR/AP, cash, payroll, party-activity, balance snapshots)
        ▼
featureEngineering.pipeline.engineer(rows)   ← causal transforms + 5 families
        │  { features[], columns{}, leakageSafe:true }
        ▼
ForecastFeatureSnapshot (point-in-time, knowledgeDate, idempotent)  ← materialized nightly (F2 cron)
        ▼
selection (MI / PCA / SHAP) → model feature set → ensemble / domain models (F4/F6)
```
At scale the snapshot collection graduates to a TimescaleDB hypertable / Feast (F8) with the same schema.

## 6. Code structure
```
services/forecasting/featureEngineering/
  transforms.js   # causal lag/rolling/EWMA/Fourier/diff
  selection.js    # MI · Pearson · PCA · selectFeatures (+ SHAP via worker)
  catalog.js      # the 5 families, declarative
  pipeline.js     # engineer(rows) → full leakage-safe family matrix
  index.js
```
APIs: `GET /forecast-platform/feature-catalog` · `POST /forecast-platform/features/engineer`
(build → engineer → MI-rank against the revenue target).

## 7. Implementation plan / status
1. ✅ Transforms + selection (pure, 10 tests).
2. ✅ Families catalog + engineering pipeline (6 tests).
3. ✅ API + integration with the F1/F2 store.
4. ▶ Next: persist the engineered matrix into `ForecastFeatureSnapshot.features`
   (extend the F2 materialization), wire SHAP selection through the Python worker,
   and add external macro connectors (inflation/rates/oil/gold) behind `macro_indicators`.

## 8. Validation
16 unit tests — causal transforms (lag/rolling/EWMA/Fourier leakage-safety), selection
(MI dependent vs independent, PCA explained variance, ranking), catalog (5 families,
all leakage-safe), pipeline (per-period family features, causal lags, correct ratios).
Full backend suite **688 passing**, 4 pre-existing unrelated suites unchanged.
