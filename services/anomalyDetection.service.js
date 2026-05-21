// services/anomalyDetection.service.js
// Isolation Forest + heuristic hybrid anomaly detection for vousFin.

const { IsolationForest } = require('./isolationForest.service');
const anomalyRepository = require('../repositories/anomaly.repository');
const JournalEntry = require('../models/JournalEntry.model');
const mongoose = require('mongoose');
const logger = require('../config/logger');

// ─── Encoding maps ─────────────────────────────────────────────────────────────

const TX_TYPE_IDX = {
  'Income': 0, 'Expense': 1, 'Transfer': 2, 'Credit Sale': 3,
  'Credit Purchase': 4, 'Payment Received': 5, 'Payment Made': 6,
  'Installment Payment': 7, 'Loan Disbursement': 8, 'Loan Repayment': 9,
  'Owner Investment': 10, 'Owner Withdrawal': 11, 'Asset Purchase': 12,
};

const TX_MODE_IDX = { cash: 0, credit: 1, installment: 2, partial_settlement: 3 };

// ─── Math helpers ──────────────────────────────────────────────────────────────

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function std(arr, mu) {
  if (arr.length < 2) return 1;
  const v = arr.reduce((s, x) => s + (x - mu) ** 2, 0) / arr.length;
  return Math.sqrt(v) || 1;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function safeNum(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

// ─── Multi-tier transaction fetching ──────────────────────────────────────────
// Tries progressively looser queries so small / new businesses always get scanned.

async function fetchTransactions(businessId) {
  // Safely coerce businessId to ObjectId — handles ObjectId instances, hex strings
  let bId;
  try {
    const hex = businessId instanceof mongoose.Types.ObjectId
      ? businessId.toHexString()
      : String(businessId);
    bId = new mongoose.Types.ObjectId(hex);
  } catch (e) {
    logger.error(`[AnomalyDetection] Could not convert businessId "${businessId}": ${e.message}`);
    return [];
  }

  const since90 = new Date();
  since90.setDate(since90.getDate() - 90);

  // Tier 1: last 90 days + posted/settled status
  let txns = await JournalEntry.find({
    businessId: bId,
    transactionDate: { $gte: since90 },
    status: { $in: ['posted', 'partially_settled', 'settled'] },
    isArchived: { $ne: true },
  }).sort({ transactionDate: 1 }).lean();

  logger.info(`[AnomalyDetection] Tier1 (90d + status filter): ${txns.length} txns`);

  // Tier 2: last 90 days, any status (catches 'draft' and others)
  if (txns.length < 2) {
    txns = await JournalEntry.find({
      businessId: bId,
      transactionDate: { $gte: since90 },
    }).sort({ transactionDate: 1 }).lean();
    logger.info(`[AnomalyDetection] Tier2 (90d, no status): ${txns.length} txns`);
  }

  // Tier 3: all time, any status — catches businesses whose transactions predate the window
  if (txns.length < 2) {
    txns = await JournalEntry.find({ businessId: bId })
      .sort({ transactionDate: 1 }).lean();
    logger.info(`[AnomalyDetection] Tier3 (all-time): ${txns.length} txns`);
  }

  return txns;
}

// ─── Feature engineering ───────────────────────────────────────────────────────
// 10-dimensional feature vector per transaction.

function buildFeatureMatrix(txns) {
  const amounts = txns.map(t => t.amount);
  const mu = mean(amounts);
  const sigma = std(amounts, mu);

  const minTs = Math.min(...txns.map(t => new Date(t.transactionDate).getTime()));
  const maxTs = Math.max(...txns.map(t => new Date(t.transactionDate).getTime()));
  const tsRange = maxTs - minTs || 1;

  const pairCount = {};
  for (const tx of txns) {
    const k = `${tx.debitAccountId}_${tx.creditAccountId}`;
    pairCount[k] = (pairCount[k] || 0) + 1;
  }

  const dailyCount = {};
  for (const tx of txns) {
    const day = new Date(tx.transactionDate).toISOString().slice(0, 10);
    dailyCount[day] = (dailyCount[day] || 0) + 1;
  }
  const avgDaily = mean(Object.values(dailyCount)) || 1;

  return txns.map(tx => {
    const date = new Date(tx.transactionDate);
    const created = new Date(tx.createdAt || tx.transactionDate);

    const logAmt = safeNum(Math.log(tx.amount + 1));
    const zScore = safeNum(clamp((tx.amount - mu) / sigma, -5, 5));
    const dow = date.getDay() / 6;
    const hr = created.getHours() / 23;
    const mo = date.getMonth() / 11;
    const relDate = safeNum((date.getTime() - minTs) / tsRange);
    const typeIdx = (TX_TYPE_IDX[tx.transactionType] ?? 1) / 12;
    const modeIdx = (TX_MODE_IDX[tx.transactionMode] ?? 0) / 3;
    const pairKey = `${tx.debitAccountId}_${tx.creditAccountId}`;
    const pairRarity = safeNum(1 - (pairCount[pairKey] || 1) / txns.length);
    const velocity = safeNum(clamp((dailyCount[new Date(tx.transactionDate).toISOString().slice(0, 10)] || 1) / avgDaily, 0, 3) / 3);

    return [logAmt, zScore, dow, hr, mo, relDate, typeIdx, modeIdx, pairRarity, velocity];
  });
}

// ─── Heuristic scoring ─────────────────────────────────────────────────────────
// Rule-based anomaly detection for small datasets (<20 txns) as a supplement.

function heuristicScore(tx, mu, sigma) {
  let score = 0;
  const flags = [];

  // Extreme amount
  const z = Math.abs((tx.amount - mu) / (sigma || 1));
  if (z > 3.5) { score += 0.45; flags.push('extreme_amount_spike'); }
  else if (z > 2.5) { score += 0.30; flags.push('high_amount_deviation'); }
  else if (z > 1.8) { score += 0.15; flags.push('elevated_amount'); }

  // Off-hours entry (before 6 AM or after 11 PM)
  const hr = new Date(tx.createdAt || tx.transactionDate).getHours();
  if (hr < 6 || hr >= 23) { score += 0.15; flags.push('off_hours_entry'); }

  // Weekend transaction
  const dow = new Date(tx.transactionDate).getDay();
  if (dow === 0 || dow === 6) { score += 0.08; flags.push('weekend_transaction'); }

  // Suspiciously round large amount (common in money laundering patterns)
  if (tx.amount >= 500000 && tx.amount % 100000 === 0) { score += 0.15; flags.push('round_large_amount'); }
  else if (tx.amount >= 100000 && tx.amount % 50000 === 0) { score += 0.08; flags.push('round_medium_amount'); }

  // Very small amount (possible test or structuring transaction)
  if (tx.amount < 50) { score += 0.28; flags.push('micro_transaction'); }

  return { score: clamp(score, 0, 1), flags };
}

// ─── Score → label converters ──────────────────────────────────────────────────

function toSeverity(score) {
  if (score >= 0.82) return 'critical';
  if (score >= 0.68) return 'high';
  if (score >= 0.54) return 'medium';
  return 'low';
}

function toFraudRisk(score) {
  if (score >= 0.82) return 'critical';
  if (score >= 0.68) return 'high';
  if (score >= 0.54) return 'medium';
  return 'low';
}

function toAnomalyStatus(score) {
  if (score >= 0.78) return 'potentially_fraudulent';
  if (score >= 0.62) return 'highly_suspicious';
  return 'suspicious';
}

// ─── Reason builder ────────────────────────────────────────────────────────────

function buildReason(tx, score, mu, sigma, hFlags = []) {
  const parts = [];
  const z = (tx.amount - mu) / (sigma || 1);

  if (Math.abs(z) > 1.8) {
    const dir = tx.amount > mu ? 'above' : 'below';
    parts.push(`amount PKR ${tx.amount.toLocaleString()} is ${Math.abs(z).toFixed(1)}σ ${dir} average (PKR ${Math.round(mu).toLocaleString()})`);
  }

  for (const flag of hFlags) {
    if (flag === 'off_hours_entry') {
      const hr = new Date(tx.createdAt || tx.transactionDate).getHours();
      parts.push(`entered at unusual hour (${String(hr).padStart(2, '0')}:00)`);
    }
    if (flag === 'weekend_transaction') parts.push('recorded on a weekend');
    if (flag === 'round_large_amount') parts.push('suspiciously round large amount — common in structuring patterns');
    if (flag === 'micro_transaction') parts.push('unusually small amount flagged as potential test transaction');
  }

  if (score >= 0.82) {
    parts.push('Isolation Forest detected highly isolated pattern consistent with fraud');
  } else if (score >= 0.68) {
    parts.push('ML model detected concurrent irregular patterns');
  } else {
    parts.push('Isolation Forest flagged unusual combination of transaction attributes');
  }

  return (parts.length ? parts.join('; ') : 'Anomalous pattern detected by ML model') + '.';
}

// ─── Main service class ────────────────────────────────────────────────────────

class AnomalyDetectionService {
  /**
   * Run anomaly scan for a business.
   * Uses Isolation Forest for >= 5 txns, hybrid heuristic for smaller sets.
   * Multi-tier fallback query ensures transactions are always found.
   */
  async runScan(businessId) {
    const scanId = `if_${Date.now()}_${String(businessId).slice(-6)}`;
    logger.info(`[AnomalyDetection] Starting scan ${scanId} for business ${businessId}`);

    const txns = await fetchTransactions(businessId);

    logger.info(`[AnomalyDetection] Total transactions fetched: ${txns.length}`);

    if (!txns || txns.length === 0) {
      return {
        scanId, anomaliesFound: 0, alertsCreated: 0, anomalies: [],
        totalScanned: 0,
        message: 'No transactions found for this business. Add transactions first.',
      };
    }

    if (txns.length < 2) {
      return {
        scanId, anomaliesFound: 0, alertsCreated: 0, anomalies: [],
        totalScanned: txns.length,
        message: 'Need at least 2 transactions to run anomaly detection.',
      };
    }

    const amounts = txns.map(t => t.amount);
    const mu = mean(amounts);
    const sigma = std(amounts, mu);

    // Build daily counts for velocity feature
    const dailyCount = {};
    for (const tx of txns) {
      const day = new Date(tx.transactionDate).toISOString().slice(0, 10);
      dailyCount[day] = (dailyCount[day] || 0) + 1;
    }

    let finalScores;
    const heuristicResults = txns.map(tx => heuristicScore(tx, mu, sigma));

    if (txns.length >= 5) {
      // Build feature matrix and train Isolation Forest
      const features = buildFeatureMatrix(txns);
      const forest = new IsolationForest({
        numTrees: txns.length < 30 ? 50 : 100,
        sampleSize: Math.min(256, txns.length),
      });
      forest.fit(features);
      const ifScores = forest.predict(features);

      if (txns.length < 20) {
        // Hybrid: blend IF + heuristics, weighted toward heuristics for tiny sets
        const wIF = txns.length < 10 ? 0.35 : 0.55;
        finalScores = txns.map((_, i) => {
          const hNorm = heuristicResults[i].score * 0.7 + 0.3; // map [0,1]→[0.3,1]
          return clamp(wIF * ifScores[i] + (1 - wIF) * hNorm, 0, 1);
        });
        logger.info(`[AnomalyDetection] Hybrid mode (${txns.length} txns, wIF=${wIF})`);
      } else {
        finalScores = ifScores;
        logger.info(`[AnomalyDetection] Pure IF mode (${txns.length} txns)`);
      }
    } else {
      // Pure heuristics for very small datasets
      finalScores = txns.map((_, i) => {
        const h = heuristicResults[i].score;
        // Map heuristic [0,1] → [0.3, 0.95] to avoid flat distributions
        return clamp(0.3 + h * 0.65, 0.3, 0.95);
      });
      logger.info(`[AnomalyDetection] Heuristic-only mode (${txns.length} txns)`);
    }

    // Adaptive threshold — lower for small datasets where score spread is tighter
    const THRESHOLD = txns.length < 10 ? 0.44 : txns.length < 20 ? 0.50 : 0.54;
    const flagged = finalScores
      .map((score, i) => ({ tx: txns[i], score, hFlags: heuristicResults[i].flags }))
      .filter(x => x.score >= THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    logger.info(`[AnomalyDetection] Flagged ${flagged.length} anomalies (threshold=${THRESHOLD})`);

    // Build alert docs for DB storage
    const alertDocs = flagged.map(({ tx, score, hFlags }) => ({
      businessId: new mongoose.Types.ObjectId(String(businessId instanceof mongoose.Types.ObjectId ? businessId.toHexString() : businessId)),
      journalEntryId: tx._id,
      anomalyScore: score,
      reason: buildReason(tx, score, mu, sigma, hFlags),
      featureVector: {
        amount: tx.amount,
        amountZScore: safeNum((tx.amount - mu) / (sigma || 1)),
        dayOfWeek: new Date(tx.transactionDate).getDay(),
        transactionType: tx.transactionType,
        transactionMode: tx.transactionMode,
        heuristicFlags: hFlags,
      },
      scanId,
    }));

    if (alertDocs.length > 0) {
      await anomalyRepository.bulkCreateAlerts(alertDocs);
      logger.info(`[AnomalyDetection] Saved ${alertDocs.length} alerts to DB`);
    }

    // Format for frontend display
    const anomalies = flagged.map(({ tx, score, hFlags }) => ({
      id: tx._id,
      title: tx.description,
      severity: toSeverity(score),
      reason: buildReason(tx, score, mu, sigma, hFlags),
      date: tx.transactionDate,
      amount: tx.amount,
      anomalyScore: Math.round(score * 100),
      fraudRiskLevel: toFraudRisk(score),
      anomalyStatus: toAnomalyStatus(score),
      transactionType: tx.transactionType,
      transactionMode: tx.transactionMode,
    }));

    return {
      scanId,
      anomaliesFound: flagged.length,
      alertsCreated: alertDocs.length,
      anomalies,
      totalScanned: txns.length,
      message: flagged.length > 0
        ? `Found ${flagged.length} suspicious transaction${flagged.length > 1 ? 's' : ''} out of ${txns.length} scanned.`
        : `All ${txns.length} transactions appear normal.`,
    };
  }

  /**
   * Retrieve stored anomaly alerts for a business.
   */
  async getAlerts(businessId, status = null, pagination = {}) {
    const result = await anomalyRepository.getByBusiness(businessId, status, pagination);
    return {
      anomalies: result.data.map(alert => {
        const tx = alert.journalEntryId;
        const score = alert.anomalyScore;
        return {
          id: alert._id,
          alertId: alert._id,
          title: tx?.description || 'Unknown Transaction',
          severity: toSeverity(score),
          reason: alert.reason,
          date: tx?.transactionDate || alert.detectedAt,
          amount: tx?.amount ?? null,
          anomalyScore: Math.round(score * 100),
          fraudRiskLevel: toFraudRisk(score),
          anomalyStatus: toAnomalyStatus(score),
          transactionType: tx?.transactionType || null,
          status: alert.status,
          detectedAt: alert.detectedAt,
          reviewedAt: alert.reviewedAt || null,
          scanId: alert.scanId,
        };
      }),
      total: result.total,
      page: result.page,
      limit: result.limit,
    };
  }

  /**
   * Review / classify an alert.
   */
  async reviewAlert(alertId, action, userId) {
    const statusMap = { legitimate: 'valid', fraud: 'confirmed_issue' };
    const status = statusMap[action];
    if (!status) throw new Error(`Invalid action "${action}". Use "legitimate" or "fraud".`);
    return anomalyRepository.updateAlertStatus(alertId, status, userId);
  }

  /**
   * Get alert counts by status.
   */
  async getStats(businessId) {
    return anomalyRepository.countByBusinessAndStatus(businessId);
  }
}

module.exports = new AnomalyDetectionService();
