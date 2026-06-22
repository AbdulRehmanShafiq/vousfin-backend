const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const config = require('./config');
const logger = require('./config/logger');
const { defaultLimiter } = require('./middleware/rateLimiter.middleware');
const { sanitizeRequest } = require('./middleware/sanitize.middleware');
const errorMiddleware = require('./middleware/error.middleware');
const passport = require('./config/passport');
const apiRoutes = require('./routes');
const eventSubscribers = require('./services/eventSubscribers.service'); // ERP Step 7

const app = express();

// ERP Step 7 — wire the business-event subscribers (analytics cache-sync, …).
// Idempotent: safe whether the app is started by server.js or imported by tests.
eventSubscribers.registerAll();

// Security & standard middleware
app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser clients (no Origin header) and whitelisted frontends.
      // Normalize trailing slashes + case so a CLIENT_URL set as
      // "https://app.example.com/" still matches the browser origin
      // "https://app.example.com" (a very common deploy-config slip).
      const norm = (o) => String(o || '').replace(/\/+$/, '').toLowerCase();
      if (!origin) return callback(null, true);
      const allowed = config.CLIENT_ORIGINS.map(norm);
      if (allowed.includes(norm(origin))) {
        return callback(null, true);
      }
      logger.warn(`CORS blocked origin: ${origin}. Allowed: ${config.CLIENT_ORIGINS.join(', ')}`);
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  })
);
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use(passport.initialize());

// Logging (Morgan + Winston)
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));

// Sanitization
app.use(sanitizeRequest());

// Rate limiting
app.use('/api', defaultLimiter);

// API routes
app.use('/api/v1', apiRoutes);

// Health check (no auth)
app.get('/health', (req, res) => {
  res.status(200).json({ success: true, message: 'Server is running' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Cannot ${req.method} ${req.originalUrl}` });
});

// Global error handler
app.use(errorMiddleware);

// CRITICAL: export the app directly, not as an object
module.exports = app;