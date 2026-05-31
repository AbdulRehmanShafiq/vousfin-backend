const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env'), quiet: true });

const requiredEnv = ['MONGO_URI', 'JWT_SECRET', 'CLIENT_URL'];
const missing = requiredEnv.filter(env => !process.env[env]);
if (missing.length) {
  console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

module.exports = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT, 10) || 5000,
  MONGO_URI: process.env.MONGO_URI,
  LOG_DIR: process.env.LOG_DIR || 'logs',
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRY: process.env.JWT_EXPIRY || '24h',
  CLIENT_URL: process.env.CLIENT_URL,
  /** Comma-separated origins; dev defaults include Vite (5173) and CRA (3000). */
  CLIENT_ORIGINS: (() => {
    const fromEnv = (process.env.CLIENT_URL || '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    const devDefaults = ['http://localhost:5173', 'http://localhost:3000'];
    if ((process.env.NODE_ENV || 'development') !== 'production') {
      devDefaults.forEach((o) => {
        if (!fromEnv.includes(o)) fromEnv.push(o);
      });
    }
    return fromEnv.length ? fromEnv : devDefaults;
  })(),
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  GOOGLE_CALLBACK_URL: process.env.GOOGLE_CALLBACK_URL,
  GOOGLE_OAUTH_ENABLED: Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,

  ),
  EMAIL_ENABLED: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
  SMTP: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  },
  EMAIL_FROM: process.env.EMAIL_FROM || 'noreply@vousfin.com',
  /** When true, new users are active immediately and can log in without email verification. */
  SKIP_EMAIL_VERIFICATION:
    process.env.SKIP_EMAIL_VERIFICATION === 'true' ||
    (process.env.NODE_ENV || 'development') !== 'production',

  // ── AR/AP Refactor M9 — event sourcing / dual-write retirement ──────────────
  /** Persist every domain event to the durable EventLog collection (system of
   *  record for replay/rebuild). Default on; set 'false' to disable the writer. */
  EVENT_LOG_ENABLED: process.env.EVENT_LOG_ENABLED !== 'false',
  /** Treat Invoice/Bill as the authoritative AR/AP source of truth and the
   *  JournalEntry as its immutable projection. Default on (post M1–M8). */
  AR_AP_AUTHORITATIVE: process.env.AR_AP_AUTHORITATIVE !== 'false',

  // ── Forecast Platform F3 — registry / persistence / baseline gate ───────────
  /** Persist every forecast to ForecastRun, register model versions, and apply
   *  the seasonal-naive baseline gate. Default on; set 'false' to disable. */
  FORECAST_REGISTRY_ENABLED: process.env.FORECAST_REGISTRY_ENABLED !== 'false',
  /** F4 — serve the multi-model ensemble + conformal-calibrated intervals from
   *  the classical fallback path (replaces single Holt-Winters). Default on. */
  FORECAST_ENSEMBLE_ENABLED: process.env.FORECAST_ENSEMBLE_ENABLED !== 'false',
  /** F5 — weekly + drift-triggered incremental retraining with champion/
   *  challenger promotion. Default on. */
  FORECAST_RETRAIN_ENABLED: process.env.FORECAST_RETRAIN_ENABLED !== 'false',
  /** F2 — nightly pre-warm of multi-source feature snapshots. Default on. */
  FORECAST_MATERIALIZE_ENABLED: process.env.FORECAST_MATERIALIZE_ENABLED !== 'false',

  // ── Forecast Platform F8 — scale-out backends (swap via env, no code change) ─
  /** 'memory' (default) | 'redis' — forecast cache backend. */
  FORECAST_CACHE_BACKEND: process.env.CACHE_BACKEND || 'memory',
  /** 'inprocess' (default) | 'rabbitmq' — inference job-queue backend. */
  FORECAST_QUEUE_BACKEND: process.env.QUEUE_BACKEND || 'inprocess',
  /** Python ML inference worker base URL (LSTM/GBM/SHAP). */
  INFERENCE_URL: process.env.INFERENCE_URL || process.env.LSTM_API_URL || 'http://localhost:8000',
};