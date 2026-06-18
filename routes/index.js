// routes/index.js
const express = require('express');
const router = express.Router();

// Import v1 route modules
const authRoutes = require('./v1/auth.routes');
const businessRoutes = require('./v1/business.routes');
const transactionRoutes = require('./v1/transaction.routes');
const reportRoutes = require('./v1/report.routes');
const dashboardRoutes = require('./v1/dashboard.routes');
const aiRoutes = require('./v1/ai.routes');
const adminRoutes = require('./v1/admin.routes');
const customerRoutes = require('./v1/customer.routes');
const vendorRoutes = require('./v1/vendor.routes');
const forecastRoutes = require('./v1/forecast.routes');
const inventoryRoutes  = require('./v1/inventory.routes');
const fiscalYearRoutes = require('./v1/fiscalYear.routes');
const fxRateRoutes     = require('./v1/fxRate.routes');
const taxRoutes        = require('./v1/tax.routes');        // Phase 5.4
const invoiceRoutes    = require('./v1/invoice.routes');    // Phase 1 — AR domain
const billRoutes       = require('./v1/bill.routes');       // Phase 1 — AP domain
const creditNoteRoutes    = require('./v1/creditNote.routes');    // Phase 2 — Credit/Debit Notes
const purchaseOrderRoutes = require('./v1/purchaseOrder.routes'); // Phase 3.1 — Procurement
const goodsReceiptRoutes  = require('./v1/goodsReceipt.routes');  // Phase 3.1 — Procurement
const vendorCreditRoutes  = require('./v1/vendorCredit.routes');  // Phase 3.1 — Procurement
const billDocumentRoutes  = require('./v1/billDocument.routes');  // Phase 3.3 — Document Management
const billScheduleRoutes  = require('./v1/billSchedule.routes');  // Phase 3.3 — Scheduling
const vendorRiskRoutes    = require('./v1/vendorRisk.routes');    // Phase 3.3 — Risk Engine
const expenseAllocationRoutes = require('./v1/expenseAllocation.routes'); // Phase 3.3 — Allocation
const procurementAnalyticsRoutes = require('./v1/procurementAnalytics.routes'); // Phase 3.4 — Analytics
const auditRoutes = require('./v1/audit.routes'); // ERP Step 9 — unified audit trail
const paymentRoutes = require('./v1/payment.routes'); // AR/AP M2 — first-class Payment entity
const arApReportRoutes = require('./v1/arApReport.routes'); // AR/AP M7 — unified aging read model
const invoiceScheduleRoutes = require('./v1/invoiceSchedule.routes'); // AR/AP M8 — recurring invoices
const dunningRoutes = require('./v1/dunning.routes'); // AR/AP M8 — dunning / collections
const arApIntegrityRoutes = require('./v1/arApIntegrity.routes'); // AR/AP M9 — event log / replay / rebuild / verify
const forecastPlatformRoutes = require('./v1/forecastPlatform.routes'); // Forecast Platform F1 — foundation data layer
const forecastRegistryRoutes = require('./v1/forecastRegistry.routes'); // Forecast Platform F3 — registry/persistence/baseline gate
const forecastDomainRoutes = require('./v1/forecastDomain.routes'); // Forecast Platform F6 — domain forecasts
const recognitionScheduleRoutes = require('./v1/recognitionSchedule.routes'); // Phase 4 — accrual: deferred revenue / prepaid expense
const transactionTemplateRoutes = require('./v1/transactionTemplate.routes'); // #5 — recurring / template transactions
const approvalRoutes = require('./v1/approval.routes'); // #6 — approval workflow
const bankReconciliationRoutes = require('./v1/bankReconciliation.routes'); // #7 — bank-statement reconciliation
const alertRoutes = require('./v1/alert.routes'); // FR-02.1/02.3 — financial alerts + trend monitor
const healthIndicatorRoutes = require('./v1/healthIndicators.routes'); // FR-03.2 — 40+ health indicators

// Mount v1 routes under /api/v1
router.use('/auth', authRoutes);
router.use('/business', businessRoutes);
router.use('/transactions', transactionRoutes);
router.use('/reports', reportRoutes);
router.use('/alerts', alertRoutes); // FR-02.1/02.3 — financial alerts
router.use('/health-indicators', healthIndicatorRoutes); // FR-03.2
router.use('/scenarios', require('./v1/scenario.routes')); // FR-03.3 — decision impact modeler
router.use('/cfo-reports', require('./v1/cfoReport.routes')); // FR-03.4 — autonomous monthly CFO report
router.use('/dashboard', dashboardRoutes);
router.use('/ai', aiRoutes);
router.use('/admin', adminRoutes);
router.use('/customers', customerRoutes);
router.use('/vendors', vendorRoutes);
router.use('/forecast', forecastRoutes);
router.use('/inventory',   inventoryRoutes);
router.use('/fiscal-years', fiscalYearRoutes);
router.use('/fx-rates',    fxRateRoutes);
router.use('/tax',         taxRoutes);            // Phase 5.4
router.use('/invoices',     invoiceRoutes);        // Phase 1 — AR domain
router.use('/bills',        billRoutes);           // Phase 1 — AP domain
router.use('/credit-notes',    creditNoteRoutes);    // Phase 2 — Credit/Debit Notes
router.use('/purchase-orders', purchaseOrderRoutes); // Phase 3.1 — Procurement
router.use('/goods-receipts',  goodsReceiptRoutes);  // Phase 3.1 — Procurement
router.use('/vendor-credits',  vendorCreditRoutes);  // Phase 3.1 — Procurement
router.use('/bill-documents',   billDocumentRoutes);       // Phase 3.3 — Document Management
router.use('/bill-schedules',   billScheduleRoutes);       // Phase 3.3 — Scheduling
router.use('/vendor-risk',      vendorRiskRoutes);         // Phase 3.3 — Risk Engine
router.use('/expense-allocation',    expenseAllocationRoutes);    // Phase 3.3 — Allocation
router.use('/procurement-analytics', procurementAnalyticsRoutes); // Phase 3.4 — Analytics
router.use('/audit',                 auditRoutes);                // ERP Step 9 — unified audit trail
router.use('/payments',              paymentRoutes);              // AR/AP M2 — first-class Payment entity
router.use('/ar-ap',                 arApReportRoutes);           // AR/AP M7 — unified aging read model
router.use('/invoice-schedules',     invoiceScheduleRoutes);      // AR/AP M8 — recurring invoices
router.use('/dunning',               dunningRoutes);              // AR/AP M8 — dunning / collections
router.use('/ar-ap-integrity',       arApIntegrityRoutes);        // AR/AP M9 — event log / replay / rebuild / verify
router.use('/forecast-platform',     forecastPlatformRoutes);     // Forecast Platform F1 — foundation data layer
router.use('/forecast-registry',     forecastRegistryRoutes);     // Forecast Platform F3 — registry/persistence/baseline gate
router.use('/forecast-domains',      forecastDomainRoutes);       // Forecast Platform F6 — domain forecasts
router.use('/recognition-schedules', recognitionScheduleRoutes);  // Phase 4 — accrual: deferred revenue / prepaid expense
router.use('/transaction-templates', transactionTemplateRoutes);  // #5 — recurring / template transactions
router.use('/approvals',             approvalRoutes);             // #6 — approval workflow
router.use('/bank-reconciliation',   bankReconciliationRoutes);   // #7 — bank-statement reconciliation
router.use('/autonomy',              require('./v1/autonomy.routes')); // Autonomy roadmap Phase 0 — control plane + inbox
router.use('/bookkeeping',           require('./v1/bookkeeping.routes')); // Autonomy roadmap Phase 2 — Bookkeeper agent
router.use('/cost-centers',          require('./v1/costCenter.routes'));  // SRS FR-07.1 — cost / profit centres
router.use('/payroll',               require('./v1/payroll.routes'));     // SRS FR-08 — payroll
router.use('/budgets',               require('./v1/budget.routes'));      // SRS FR-04.1/.2 — budgeting & variance

// Health check endpoint (versioned)
router.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'API is healthy',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;