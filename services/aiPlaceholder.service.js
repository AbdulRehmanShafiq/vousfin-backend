// services/aiPlaceholder.service.js
const { TRANSACTION_TYPES, INPUT_METHODS } = require('../config/constants');
const transactionRepository = require('../repositories/transaction.repository');
const anomalyRepository = require('../repositories/anomaly.repository');
const accountRepository = require('../repositories/account.repository');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');

class AIPlaceholderService {
  /**
   * Mock natural language parser.
   * Extracts amount, date, transaction type, and account pair from plain text.
   * @param {string} text - User's natural language input (e.g., "Paid Rs. 8,000 electricity bill yesterday")
   * @param {string} businessId - To validate account names (optional)
   * @returns {Promise<Object>} Parsed fields with confidence score
   */
  async parseNaturalLanguage(text, businessId) {
    if (!text || text.trim().length < 5) {
      throw new ApiError(400, 'Input text is too short. Please provide a complete description.');
    }

    // Mock extraction using regex patterns
    const amountMatch = text.match(/(\d+(?:,\d+)*(?:\.\d+)?)/);
    const amount = amountMatch ? parseFloat(amountMatch[0].replace(/,/g, '')) : 1000;

    // Detect date (today, yesterday, or a specific date)
    let date = new Date();
    if (text.toLowerCase().includes('yesterday')) {
      date.setDate(date.getDate() - 1);
    } else if (text.toLowerCase().includes('tomorrow')) {
      date.setDate(date.getDate() + 1);
    } else {
      // Try to find a date pattern like "2025-05-18" or "May 18, 2025"
      const dateMatch = text.match(/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}/);
      if (dateMatch) date = new Date(dateMatch[0]);
    }

    // Determine transaction type
    const lowerText = text.toLowerCase();
    let transactionType = TRANSACTION_TYPES.EXPENSE;
    let debitAccount = 'Utilities Expense';
    let creditAccount = 'Cash';
    let confidence = 0.85;

    if (lowerText.includes('received') || lowerText.includes('income') || lowerText.includes('sale') || lowerText.includes('client')) {
      transactionType = TRANSACTION_TYPES.INCOME;
      debitAccount = 'Cash';
      creditAccount = 'Service Revenue';
      confidence = 0.9;
    } else if (lowerText.includes('transfer')) {
      transactionType = TRANSACTION_TYPES.TRANSFER;
      debitAccount = 'Bank';
      creditAccount = 'Cash';
      confidence = 0.7;
    } else if (lowerText.includes('rent')) {
      debitAccount = 'Rent Expense';
      confidence = 0.95;
    } else if (lowerText.includes('salary') || lowerText.includes('wage')) {
      debitAccount = 'Salaries Expense';
      confidence = 0.95;
    } else if (lowerText.includes('electricity') || lowerText.includes('utility')) {
      debitAccount = 'Utilities Expense';
      confidence = 0.9;
    }

    // Try to resolve account names to actual account IDs if businessId provided
    let debitAccountId = null;
    let creditAccountId = null;
    if (businessId) {
      const accounts = await accountRepository.findByBusiness(businessId);
      const debitAcc = accounts.find(a => a.accountName.toLowerCase() === debitAccount.toLowerCase());
      const creditAcc = accounts.find(a => a.accountName.toLowerCase() === creditAccount.toLowerCase());
      if (debitAcc) debitAccountId = debitAcc._id;
      if (creditAcc) creditAccountId = creditAcc._id;
    }

    return {
      amount,
      transactionDate: date.toISOString().split('T')[0],
      transactionType,
      debitAccount,
      creditAccount,
      debitAccountId,
      creditAccountId,
      confidence,
      rawText: text,
    };
  }

  /**
   * Mock RAG assistant. Returns an answer based on keyword matching.
   * @param {string} question - User's financial question
   * @param {string} businessId
   * @param {Array} chatHistory - Previous messages (optional)
   * @returns {Promise<Object>} { answer, sources }
   */
  async ragQuery(question, businessId, chatHistory = []) {
    // Fetch some basic data to make answer seem real (e.g., revenue, expenses)
    let revenue = 0, expenses = 0;
    try {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const { getIncomeStatementData } = require('../repositories/transaction.repository');
      const { revenue: revData, expenses: expData } = await getIncomeStatementData(businessId, startOfMonth, now);
      revenue = revData.reduce((s, i) => s + i.amount, 0);
      expenses = expData.reduce((s, i) => s + i.amount, 0);
    } catch (err) {
      logger.warn('Failed to fetch real data for RAG mock, using defaults');
    }

    const lowerQ = question.toLowerCase();
    let answer = '';
    let sources = [];

    if (lowerQ.includes('highest expense') || lowerQ.includes('largest expense')) {
      answer = `Based on your transactions this month, your highest expense category is Salaries Expense totaling PKR 45,000.`;
      sources = ['Transaction #INV-001', 'Transaction #INV-002'];
    } else if (lowerQ.includes('total revenue') || lowerQ.includes('total income')) {
      answer = `Your total revenue for this month is PKR ${revenue.toLocaleString()}.`;
      sources = ['Income Statement (current period)'];
    } else if (lowerQ.includes('total expense') || lowerQ.includes('total expenses')) {
      answer = `Your total expenses for this month are PKR ${expenses.toLocaleString()}.`;
      sources = ['Income Statement (current period)'];
    } else if (lowerQ.includes('net profit') || lowerQ.includes('net income')) {
      const net = revenue - expenses;
      answer = `Your net profit for this month is PKR ${net.toLocaleString()}. ${net >= 0 ? 'Congratulations!' : 'Consider reducing expenses.'}`;
      sources = ['Income Statement (current period)'];
    } else if (lowerQ.includes('cash flow')) {
      answer = `Your net cash flow from operations this month is positive PKR 12,500. Investing activities show an outflow of PKR 5,000 for equipment purchase.`;
      sources = ['Cash Flow Statement (current period)'];
    } else {
      answer = `I'm still learning. Based on your data, you have recorded ${revenue + expenses > 0 ? 'several' : 'no'} transactions. Try asking about total revenue, highest expense, or cash flow.`;
      sources = [];
    }

    return { answer, sources };
  }

  /**
   * Mock cash flow recommendations.
   * @param {string} businessId
   * @returns {Promise<Array>} Prioritised list of recommendations
   */
  async cashflowRecommendations(businessId) {
    // Simulate analysis: fetch latest expenses
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const { getIncomeStatementData } = require('../repositories/transaction.repository');
    let expensesData = [];
    try {
      const { expenses } = await getIncomeStatementData(businessId, startOfMonth, now);
      expensesData = expenses;
    } catch (err) {
      logger.warn('Failed to fetch expenses for recommendations');
    }

    const recommendations = [
      {
        priority: 'High',
        text: 'Reduce office rent by renegotiating lease or moving to a smaller space',
        reason: 'Rent expense accounts for 40% of your monthly expenses.',
        reportLink: '/reports/expenses?category=Rent',
      },
      {
        priority: 'Medium',
        text: 'Delay non-essential equipment purchases',
        reason: 'Cash flow forecast shows a possible dip next month.',
        reportLink: '/forecast',
      },
    ];

    if (expensesData.some(e => e.name.toLowerCase().includes('marketing'))) {
      recommendations.push({
        priority: 'Low',
        text: 'Review marketing ROI; consider shifting budget to higher-performing channels',
        reason: 'Marketing expenses have increased 15% month-over-month.',
        reportLink: '/reports/expenses?category=Marketing',
      });
    }

    return recommendations;
  }

  /**
   * Mock LSTM forecast.
   * @param {string} metric - 'revenue', 'expenses', 'netCashFlow'
   * @param {number} horizon - 1, 3, or 6 months
   * @param {string} businessId
   * @returns {Promise<Object>} { historical, forecast, confidenceIntervals, metric }
   */
  async forecast(metric, horizon, businessId) {
    // Validate inputs
    const validMetrics = ['revenue', 'expenses', 'netCashFlow'];
    if (!validMetrics.includes(metric)) {
      throw new ApiError(400, `Invalid metric. Must be one of: ${validMetrics.join(', ')}`);
    }
    if (![1, 3, 6].includes(horizon)) {
      throw new ApiError(400, 'Horizon must be 1, 3, or 6 months');
    }

    // Dummy data: last 6 months historical + future predictions
    const historicalValues = [50000, 55000, 60000, 58000, 62000, 65000];
    const forecastValues = [67000, 69000, 70000, 72000, 74000, 76000].slice(0, horizon);
    const confidenceIntervals = forecastValues.map(v => [v * 0.9, v * 1.1]);

    return {
      metric,
      horizon: `${horizon} months`,
      historical: historicalValues,
      forecast: forecastValues,
      confidenceIntervals,
      unit: 'PKR',
    };
  }

  /**
   * Mock anomaly detection scan.
   * Runs a simple check: flags any transaction above 500,000 or below 1.
   * Creates alerts in the anomalyAlerts collection.
   * @param {string} businessId
   * @returns {Promise<Object>} { scanId, anomaliesFound, alertsCreated }
   */
  async anomalyScan(businessId) {
    const scanId = `mock_scan_${Date.now()}`;
    // Fetch recent transactions (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const transactions = await transactionRepository.getByDateRange(businessId, thirtyDaysAgo, new Date());
    
    const flagged = [];
    for (const tx of transactions) {
      // Mock condition: amount > 500,000 or amount < 10
      if (tx.amount > 500000 || tx.amount < 10) {
        flagged.push(tx);
      }
    }

    // Create alerts
    const alerts = [];
    for (const tx of flagged) {
      const alertData = {
        businessId,
        journalEntryId: tx._id,
        anomalyScore: -0.2 - Math.random() * 0.3, // between -0.2 and -0.5
        reason: `Transaction amount ${tx.amount} is unusually ${tx.amount > 500000 ? 'high' : 'low'} compared to typical transactions.`,
        featureVector: {
          amount: tx.amount,
          dayOfWeek: new Date(tx.transactionDate).getDay(),
          transactionType: tx.transactionType,
          accountPairFreq: 0.05,
          interval: 2,
        },
        scanId,
      };
      alerts.push(alertData);
    }

    if (alerts.length > 0) {
      await anomalyRepository.bulkCreateAlerts(alerts);
      logger.info(`Mock anomaly scan created ${alerts.length} alerts for business ${businessId}`);
    }

    return {
      scanId,
      anomaliesFound: flagged.length,
      alertsCreated: alerts.length,
      message: flagged.length ? `Found ${flagged.length} unusual transactions. Please review them.` : 'No anomalies detected.',
    };
  }

  /**
   * Mock semantic search (falls back to keyword search on description).
   * @param {string} query - Natural language query
   * @param {string} businessId
   * @returns {Promise<Array>} List of matching transactions
   */
  async semanticSearch(query, businessId) {
    if (!query || !businessId) return [];
    // Simple keyword search: split query into words, search in description
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (keywords.length === 0) return [];

    // Fetch last 500 transactions (enough for demo)
    const allTransactions = await transactionRepository.findAll({ businessId }, { limit: 500, sort: { transactionDate: -1 } });
    const results = allTransactions.data.filter(tx => {
      const desc = tx.description.toLowerCase();
      return keywords.some(kw => desc.includes(kw));
    });

    // Add a mock similarity score
    return results.map(tx => ({
      ...tx,
      similarity: 0.75 + Math.random() * 0.2,
    })).slice(0, 20);
  }
}

module.exports = new AIPlaceholderService();