# VousFin ML Inference Worker (B3 — global / transfer model)

Python/FastAPI service that gives the platform real ML forecasting:
- **statsforecast** — AutoETS/AutoARIMA with **conformal** prediction intervals (per-series; a real upgrade over the in-process Holt-Winters fallback).
- **mlforecast + LightGBM** — **one global model trained across many businesses**, so a new or thin-data tenant gets a strong forecast on **day one** (transfer learning / cold-start). This is the B3 win.
- **SHAP** — feature attribution over the global model for the `/explain` path.

The Node backend (`services/forecasting/infra/inferenceClient.js` + `lstmForecastService.js`) calls it; a **circuit breaker** on the Node side falls back to the in-process ensemble whenever this worker is unavailable — so the product never hard-fails, with or without the worker.

## Files
| File | Role |
|---|---|
| `app.py` | FastAPI app + the 5 endpoints |
| `adapters.py` | Node transaction payload → monthly series panel `[unique_id, ds, y]` |
| `forecasting.py` | statsforecast AutoETS/AutoARIMA + conformal intervals (per-series) |
| `global_model.py` | the global LightGBM model: train · forecast (incl. unseen series) · SHAP explain |
| `store.py` | accumulates de-identified series into a parquet panel for training |
| `train.py` | offline training CLI |

## Run locally
```bash
cd ml-worker
pip install -r requirements.txt
python selftest.py                 # optional: verifies libs + global model end-to-end
uvicorn app:app --host 0.0.0.0 --port 8000
```
Point the backend at it: set `LSTM_API_URL=http://localhost:8000` (or `INFERENCE_URL`). The Node side auto-detects it via the health probe and starts using it.

> **Windows note:** `app.py` imports `lightgbm` first on purpose — loading its
> OpenMP runtime before statsforecast/mlforecast avoids a native access-violation
> crash (0xC0000005) from duplicate OpenMP runtimes. Keep that import first.

## Train the global model
1. The running worker **accumulates** every forecasted series (de-identified) into `data/panel.parquet`.
2. Train across all of them:
   ```bash
   curl -X POST http://localhost:8000/api/v1/vousfin/train      # from the accumulated panel
   #  or offline from your own export:
   python train.py --csv my_panel.csv                            # columns: unique_id,ds,y
   ```
3. The artifact `artifacts/global_mlforecast.joblib` is saved and auto-loaded; subsequent `/forecast` calls use the global model for the point forecast (with conformal bands), labelled `dataSource: "global"`.

> Until the global model is trained, `/forecast` serves the conformal statistical
> model (`dataSource: "statistical"`) — still a real, calibrated forecast.

## Contract (stable — Node depends on it)
| Method | Path | Response |
|---|---|---|
| GET | `/api/v1/vousfin/health` | `{ ready, globalModel }` |
| POST | `/api/v1/vousfin/forecast` | `{ predicted[], lower[], upper[], labels[], modelType, dataSource }` |
| POST | `/api/v1/vousfin/explain` | `{ baseValue, drivers[], method }` |
| POST | `/api/v1/vousfin/train` | retrain the global model from the panel |
| GET | `/api/v1/vousfin/store` | panel stats |

## Privacy / isolation
The global model trains only on **aggregated monthly series** keyed by an opaque
`unique_id` — never transaction-level or identifying data — and inference for one
business never reads another's data. The cross-business benefit is in the *learned
parameters*, not shared data.

## Container
```bash
docker build -t vousfin-ml-worker ./ml-worker
docker run -p 8000:8000 vousfin-ml-worker
```
(or via `deploy/docker-compose.yml` / `deploy/k8s/…` for the worker pool — scale
horizontally behind the F8 queue.)
