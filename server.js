const mongoose = require('mongoose');
const app = require('./app');
const connectDB = require('./config/database');
const config = require('./config');
const logger = require('./config/logger');
const { scheduleAnomalyScan } = require('./jobs/anomalyScan.job');
const { scheduleFxRateSync }  = require('./jobs/fxRateSync.job');
const { initialize: initForecastingData } = require('./services/forecasting/dataLoader');
const { ensureLSTMRunning, stopLSTM } = require('./utils/lstmService');

// Global unhandled rejection/exception handlers (must be set early)
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Optionally exit: process.exit(1)
});
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

const startServer = async () => {
  try {
    logger.info('🔁 Starting server bootstrap...');
    
    // Step 1: Validate environment
    if (!config.MONGO_URI) throw new Error('MONGO_URI is missing in environment');
    if (!config.JWT_SECRET) throw new Error('JWT_SECRET is missing');
    
    // Step 2: Connect to database
    logger.info('📡 Connecting to MongoDB...');
    await connectDB();
    logger.info('✅ Database connection established');
    
    // Step 3: Schedule background jobs (if any)
    if (scheduleAnomalyScan) {
      scheduleAnomalyScan();
      logger.info('⏰ Anomaly scan job scheduled');
    }

    // Step 3a: Schedule daily FX rate sync (live rates from open.er-api.com)
    try {
      scheduleFxRateSync();
    } catch (err) {
      logger.warn(`⚠️ FX rate sync job failed to schedule (non-fatal): ${err.message}`);
    }

    try {
      initForecastingData();
      logger.info('✅ ML forecasting data loaded');
    } catch (err) {
      logger.warn(`⚠️ Failed to load ML forecasting data. Forecasts may fail: ${err.message}`);
    }

    // Step 3b: Auto-start Python LSTM microservice (non-blocking — errors are warnings only)
    ensureLSTMRunning().catch(err => {
      logger.warn(`⚠️ LSTM auto-start error (non-fatal): ${err.message}`);
    });

    // Step 4: Start Express server
    const server = app.listen(config.PORT, () => {
      logger.info(`🚀 Server listening on port ${config.PORT}`);
      logger.info(`📄 Health check: http://localhost:${config.PORT}/health`);
      logger.info(`📄 API base: http://localhost:${config.PORT}/api/v1`);
    });
    
    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.warn(`⚠️ ${signal} received. Shutting down gracefully...`);
      stopLSTM();   // terminate Python LSTM microservice if we spawned it
      server.close(async () => {
        logger.info('HTTP server closed');
        await mongoose.connection.close();
        logger.info('Database connection closed');
        process.exit(0);
      });
      // Force exit after 10 seconds if something hangs
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    
  } catch (error) {
    logger.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();