// Vercel serverless entry for the VousFin backend.
//
// Reuses the Express app from app.js and opens ONE cached MongoDB connection
// that is reused across warm invocations (so we don't exhaust Atlas connections).
// Logs are redirected to Vercel's writable /tmp — the rest of the serverless
// filesystem is read-only, and the winston file transport would otherwise crash
// on startup trying to mkdir ./logs.
//
// NOTE: the node-cron background jobs wired up in server.js (FX rate sync,
// payment reminders, tax snapshots, scheduled report delivery, anomaly scan) do
// NOT run in this serverless model — there is no always-on process. The core API
// (auth, accounting, AR/AP, procurement, reports-on-request) works fully. If you
// later need the scheduled jobs, run the backend on a container host using the
// Dockerfile in this repo instead.

process.env.LOG_DIR = process.env.LOG_DIR || '/tmp/logs';

const app = require('../app');
const connectDB = require('../config/database');

let dbPromise = null;
function ensureDB() {
  if (!dbPromise) {
    dbPromise = connectDB().catch((err) => {
      dbPromise = null; // reset so the next request can retry the connection
      throw err;
    });
  }
  return dbPromise;
}

module.exports = async (req, res) => {
  try {
    await ensureDB();
  } catch (err) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, message: 'Database connection failed' }));
    return;
  }
  return app(req, res);
};
