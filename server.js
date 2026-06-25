// Force Google DNS so Atlas SRV/TXT/A lookups work on any local network
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

const mongoose = require('mongoose');
const app = require('./app');
const connectDB = require('./config/database');
const config = require('./config');
const logger = require('./config/logger');
const { scheduleAnomalyScan } = require('./jobs/anomalyScan.job');
const { scheduleFxRateSync }  = require('./jobs/fxRateSync.job');
const { schedulePaymentReminders } = require('./jobs/paymentReminder.job');
const { scheduleTaxSnapshots } = require('./jobs/taxSnapshot.job');
const { scheduleAutoPrepare } = require('./jobs/taxReturnAutoPrepare.job');
const { scheduleReportDelivery } = require('./jobs/scheduledReport.job');
const { scheduleIntegrityScan } = require('./jobs/ledgerIntegrity.job');
const { scheduleBankReconciliation } = require('./jobs/bankReconciliation.job');
const { scheduleDunningEscalation } = require('./jobs/dunningEscalation.job');
const { startWorker: startBookkeeperWorker, stopWorker: stopBookkeeperWorker } = require('./workers/bookkeeper.worker');
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

    try {
      scheduleIntegrityScan();
    } catch (err) {
      logger.warn(`⚠️ Ledger integrity job failed to schedule (non-fatal): ${err.message}`);
    }

    // Step 3a: Schedule daily FX rate sync (live rates from open.er-api.com)
    try {
      scheduleFxRateSync();
    } catch (err) {
      logger.warn(`⚠️ FX rate sync job failed to schedule (non-fatal): ${err.message}`);
    }

    // Step 3b: Schedule daily customer payment reminders (08:00 server time)
    try {
      schedulePaymentReminders();
    } catch (err) {
      logger.warn(`⚠️ Payment reminder job failed to schedule (non-fatal): ${err.message}`);
    }

    // Step 3b2: Schedule daily tax-position snapshots (00:30) for the 6-month trend (FR-04.1)
    try {
      scheduleTaxSnapshots();
    } catch (err) {
      logger.warn(`⚠️ Tax-snapshot job failed to schedule (non-fatal): ${err.message}`);
    }

    // Step 3b3: Schedule daily auto-prepare of returns N days before deadline (FR-04.3)
    try {
      scheduleAutoPrepare();
    } catch (err) {
      logger.warn(`⚠️ Tax-return auto-prepare job failed to schedule (non-fatal): ${err.message}`);
    }

    // Step 3b4: Schedule hourly scheduled-report email delivery (FR-02.5)
    try {
      scheduleReportDelivery();
    } catch (err) {
      logger.warn(`⚠️ Scheduled report delivery job failed to schedule (non-fatal): ${err.message}`);
    }

    // Forecast Platform F3: capture realized forecast accuracy daily (09:00)
    try {
      require('./jobs/forecastAccuracy.job').scheduleForecastAccuracy();
    } catch (err) {
      logger.warn(`⚠️ Forecast accuracy job failed to schedule (non-fatal): ${err.message}`);
    }

    // Forecast Platform F5: weekly + drift-triggered retraining (Mon 03:00)
    try {
      if (config.FORECAST_RETRAIN_ENABLED) require('./jobs/forecastRetrain.job').scheduleForecastRetrain();
    } catch (err) {
      logger.warn(`⚠️ Forecast retrain job failed to schedule (non-fatal): ${err.message}`);
    }

    // Forecast Platform F2: nightly multi-source feature materialization (02:00)
    try {
      if (config.FORECAST_MATERIALIZE_ENABLED) require('./jobs/forecastMaterialize.job').scheduleForecastMaterialize();
    } catch (err) {
      logger.warn(`⚠️ Forecast materialization job failed to schedule (non-fatal): ${err.message}`);
    }

    // Step 3c: Schedule AP automation jobs (Phase 3.3)
    try {
      const cron = require('node-cron');
      const billSchedulerService = require('./services/billScheduler.service');

      // Daily at 06:00 — generate bills from recurring schedules
      cron.schedule('0 6 * * *', async () => {
        try {
          const ids = await billSchedulerService.generateDueBills();
          if (ids.length) logger.info(`[cron] Generated ${ids.length} recurring bills`);
        } catch (err) {
          logger.error(`[cron] generateDueBills error: ${err.message}`);
        }
      });

      // Daily at 07:00 — update bill reminder states
      cron.schedule('0 7 * * *', async () => {
        try {
          const r = await billSchedulerService.updateReminderStates();
          logger.info(`[cron] Reminder states updated: ${r.updated}/${r.total}`);
        } catch (err) {
          logger.error(`[cron] updateReminderStates error: ${err.message}`);
        }
      });

      // ── AR/AP M8 — recurring invoices + dunning ──────────────────────────
      const invoiceSchedulerService = require('./services/invoiceScheduler.service');
      const dunningService = require('./services/dunning.service');

      // Daily at 06:00 — generate invoices from recurring schedules
      cron.schedule('0 6 * * *', async () => {
        try {
          const ids = await invoiceSchedulerService.generateDueInvoices();
          if (ids.length) logger.info(`[cron] Generated ${ids.length} recurring invoices`);
        } catch (err) {
          logger.error(`[cron] generateDueInvoices error: ${err.message}`);
        }
      });

      // Daily dunning escalation — now uses distributed-lock job (Phase 3)
      // (replaced inline cron — see jobs/dunningEscalation.job.js)

      // Phase 4 — Accrual: post due deferred-revenue / prepaid-expense recognitions
      const recognitionService = require('./services/recognitionSchedule.service');
      // Daily at 05:30 — recognize any schedule slices whose date has arrived
      cron.schedule('30 5 * * *', async () => {
        try {
          const r = await recognitionService.postDueRecognitions(null, new Date());
          if (r.linesPosted) logger.info(`[cron] Recognition: posted ${r.linesPosted} due entries (${r.errors} errors)`);
        } catch (err) {
          logger.error(`[cron] postDueRecognitions error: ${err.message}`);
        }
      });

      // ── #5 — recurring transactions (templates) ──────────────────────────
      const transactionTemplateService = require('./services/transactionTemplate.service');
      // Daily at 06:30 — post transactions for every due recurring template
      cron.schedule('30 6 * * *', async () => {
        try {
          const r = await transactionTemplateService.generateDueRecurring(new Date());
          if (r.generated || r.pending) {
            logger.info(`[cron] Recurring transactions: ${r.generated} posted, ${r.pending} pending approval (${r.scanned} due)`);
          }
        } catch (err) {
          logger.error(`[cron] generateDueRecurring error: ${err.message}`);
        }
      });

      // ── FR-03.4 — autonomous monthly CFO report ───────────────────────────
      const cfoReportService = require('./services/cfoReport.service');
      // Daily at 08:30 — runs only on the first business day; delivered by 9 AM.
      cron.schedule('30 8 * * *', async () => {
        try {
          await cfoReportService.runMonthly(new Date());
        } catch (err) {
          logger.error(`[cron] cfoReport error: ${err.message}`);
        }
      });

      // ── FR-02.1 / FR-02.3 — trend monitor + balance-equation invariant ────
      const trendMonitor = require('./services/trendMonitor.service');
      // Every 30 minutes — rolling-window drift rules + runtime invariant.
      // Alerts dedup at the DB layer, so frequent runs never spam.
      cron.schedule('*/30 * * * *', async () => {
        try {
          await trendMonitor.runAllBusinesses();
        } catch (err) {
          logger.error(`[cron] trendMonitor error: ${err.message}`);
        }
      });

      logger.info('⏰ AR/AP automation jobs scheduled (recurring bills + invoices + transactions + reminders + dunning + accrual recognition + trend monitor)');
    } catch (err) {
      logger.warn(`⚠️ AR/AP automation jobs failed to schedule (non-fatal): ${err.message}`);
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

    // Phase 3 — Automated Accounting Modules
    try {
      scheduleBankReconciliation();
    } catch (err) {
      logger.warn(`⚠️ Bank reconciliation job failed to schedule (non-fatal): ${err.message}`);
    }

    try {
      scheduleDunningEscalation();
    } catch (err) {
      logger.warn(`⚠️ Dunning escalation job failed to schedule (non-fatal): ${err.message}`);
    }

    try {
      startBookkeeperWorker();
    } catch (err) {
      logger.warn(`⚠️ Bookkeeper worker failed to start (non-fatal): ${err.message}`);
    }

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
      stopBookkeeperWorker(); // terminate BullMQ bookkeeper worker
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