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
};