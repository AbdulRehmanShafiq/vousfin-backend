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

// Email verification is REQUIRED. Brevo SMTP is configured (same path as team
// invites / password resets), so verification emails actually send. Verification
// is ON by default; only an explicit SKIP_EMAIL_VERIFICATION=true disables it
// (e.g. local/dev). New signups land as PENDING until they click the email link.
process.env.SKIP_EMAIL_VERIFICATION = process.env.SKIP_EMAIL_VERIFICATION || 'false';

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

// Vercel requires a synchronous wrapper when handling Express inside a Serverless Function.
// We must NOT use an `async` function because it would resolve immediately (since `app(req, res)`
// is not a Promise), causing Vercel to terminate the function prematurely with 
// FUNCTION_INVOCATION_FAILED before Express finishes its asynchronous response handling.
module.exports = (req, res) => {
  ensureDB()
    .then(() => {
      app(req, res);
    })
    .catch((err) => {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: false, message: 'Database connection failed' }));
    });
};
