"""selftest.py — exercise the real library APIs end-to-end (no FastAPI needed)."""
from __future__ import annotations
import lightgbm  # noqa: F401 — must load OpenMP runtime before statsforecast/mlforecast (Windows)
import pandas as pd
import numpy as np

from forecasting import statistical_forecast, _HAVE_SF
from global_model import GlobalModel, _HAVE_ML, _HAVE_SHAP
from adapters import to_monthly_series, horizon_labels

print("flags:", {"statsforecast": _HAVE_SF, "mlforecast": _HAVE_ML, "shap": _HAVE_SHAP})


def mk(uid: str, base: float, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    ds = pd.date_range("2024-01-01", periods=24, freq="MS")
    season = np.array([1.0, 1.1, 0.9, 1.2, 1.0, 0.95, 1.15, 1.05, 0.9, 1.1, 1.2, 1.0])
    y = base * (1 + 0.02 * np.arange(24)) * np.tile(season, 2) + rng.normal(0, base * 0.03, 24)
    return pd.DataFrame({"unique_id": uid, "ds": ds, "y": np.clip(y, 0, None)})


one = mk("biz1", 1000, 1)

stat = statistical_forecast(one, 6)
print("statistical modelType:", stat["modelType"])
print("statistical predicted:", stat["predicted"])
assert len(stat["predicted"]) == 6 and len(stat["lower"]) == 6 and len(stat["upper"]) == 6

panel = pd.concat([mk(f"biz{i}", 800 + 100 * i, i) for i in range(8)], ignore_index=True)
gm = GlobalModel(artifact_dir="artifacts")
print("train:", gm.train(panel))
gm.load()
g = gm.forecast(one, 6)
print("global forecast:", g)
assert g is not None and len(g["predicted"]) == 6, "global forecast failed"
ex = gm.explain(one)
print("explain method:", (ex or {}).get("method"), "drivers:", len((ex or {}).get("drivers", [])))

txns = [{"transactionDate": "2026-01-15", "amount": 500, "transactionType": "Income"},
        {"transactionDate": "2026-01-20", "amount": 200, "transactionType": "Expense"},
        {"transactionDate": "2026-02-10", "amount": 700, "transactionType": "Income"}]
ser = to_monthly_series(txns, "Revenue", "b")
print("adapter rows:", ser.to_dict("records"))
print("labels:", horizon_labels(ser["ds"].iloc[-1], 3) if len(ser) else [])

print("SELFTEST DONE — OK")
