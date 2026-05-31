"""
VousFin ML Inference Worker — FastAPI (B3: global / transfer model).

The Python side of the forecasting platform. The Node API (inferenceClient.js /
lstmForecastService) calls these endpoints; Node's circuit breaker falls back to
its in-process ensemble whenever this worker is down or slow, so the product
never hard-fails.

Stack (all pip-installable, see requirements.txt):
  • statsforecast  — AutoETS/AutoARIMA + conformal intervals (per-series)
  • mlforecast + LightGBM — ONE global model trained across many businesses,
    giving new/thin-data tenants a strong forecast on day one (transfer learning)
  • SHAP — feature attribution over the global model

Contract (stable — Node depends on it):
  GET  /api/v1/vousfin/health   -> { ready: true }
  POST /api/v1/vousfin/forecast -> { predicted[], lower[], upper[], labels[], modelType, dataSource }
  POST /api/v1/vousfin/explain  -> { drivers[], baseValue, method }
  POST /api/v1/vousfin/train    -> retrain the global model from the accumulated panel
  GET  /api/v1/vousfin/store    -> panel stats
"""
from __future__ import annotations

# IMPORTANT (Windows): lightgbm must load its OpenMP runtime BEFORE statsforecast/
# mlforecast (numba/coreforecast) load theirs, or the duplicate OpenMP runtimes
# cause a native access violation (0xC0000005) at import. Keep this first.
import lightgbm  # noqa: F401

from typing import List, Dict, Any
import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel

from adapters import to_monthly_series, horizon_labels
from forecasting import statistical_forecast
from global_model import GlobalModel
from store import TrainingStore

app = FastAPI(title="VousFin ML Worker", version="1.0.0")

GLOBAL = GlobalModel(artifact_dir="artifacts")
STORE = TrainingStore(data_dir="data")


@app.on_event("startup")
def _startup() -> None:
    GLOBAL.load()  # load a previously-trained global artifact if present


class Txn(BaseModel):
    transactionDate: str
    amount: float = 0.0
    transactionType: str = "Income"
    creditAccountType: str = "Revenue"
    debitAccountType: str = "Expense"


class ForecastRequest(BaseModel):
    businessId: str
    target: str = "Revenue"
    horizonMonths: int = 6
    returnUncertainty: bool = True
    transactions: List[Txn] = []


class ExplainRequest(BaseModel):
    businessId: str
    target: str = "Revenue"
    transactions: List[Txn] = []


@app.get("/api/v1/vousfin/health")
def health() -> Dict[str, Any]:
    # The worker is "ready" whenever it can serve a real statistical forecast.
    return {"ready": True, "globalModel": GLOBAL.ready}


@app.post("/api/v1/vousfin/forecast")
def forecast(req: ForecastRequest) -> Dict[str, Any]:
    series = to_monthly_series([t.model_dump() for t in req.transactions], req.target, req.businessId)
    h = max(1, int(req.horizonMonths))

    if series.empty or len(series) < 3:
        return {"predicted": [], "lower": [], "upper": [], "labels": [],
                "modelType": "Insufficient data", "dataSource": "none"}

    # Calibrated intervals always come from the conformal statistical model.
    stat = statistical_forecast(series, h, level=90)
    predicted = stat["predicted"]
    lower, upper = stat["lower"], stat["upper"]
    model_type, source = stat["modelType"], "statistical"

    # Prefer the global transfer model's point forecast (better cold-start), but
    # keep the conformal half-widths from the statistical model for honest bands.
    g = GLOBAL.forecast(series, h) if GLOBAL.ready else None
    if g and len(g["predicted"]) == h:
        half = [max(0.0, (upper[i] - lower[i]) / 2.0) for i in range(h)]
        predicted = g["predicted"]
        lower = [round(max(0.0, predicted[i] - half[i]), 2) for i in range(h)]
        upper = [round(predicted[i] + half[i], 2) for i in range(h)]
        model_type, source = g["modelType"] + " + conformal 90%", "global"

    # Accumulate the (de-identified) series for the next global training run.
    try:
        STORE.ingest(series)
    except Exception:
        pass

    return {
        "predicted": predicted, "lower": lower, "upper": upper,
        "labels": horizon_labels(series["ds"].iloc[-1], h),
        "modelType": model_type, "dataSource": source,
    }


@app.post("/api/v1/vousfin/explain")
def explain(req: ExplainRequest) -> Dict[str, Any]:
    series = to_monthly_series([t.model_dump() for t in req.transactions], req.target, req.businessId)
    out = GLOBAL.explain(series) if (not series.empty and GLOBAL.ready) else None
    if out:
        return out
    # Fallback: rank recent momentum/level as crude drivers.
    y = series["y"].to_numpy(dtype=float) if not series.empty else np.array([])
    drivers = []
    if len(y) >= 2:
        drivers = [
            {"name": "recent_level", "shap": round(float(y[-1]), 4)},
            {"name": "recent_change", "shap": round(float(y[-1] - y[-2]), 4)},
        ]
    return {"baseValue": 0.0, "drivers": drivers, "method": "fallback (global model not trained)"}


@app.post("/api/v1/vousfin/train")
def train() -> Dict[str, Any]:
    """Retrain the global model from the accumulated panel of all tenants."""
    return GLOBAL.train(STORE.panel())


@app.get("/api/v1/vousfin/store")
def store_stats() -> Dict[str, Any]:
    return STORE.stats()
