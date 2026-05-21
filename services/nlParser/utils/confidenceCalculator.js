/**
 * @module confidenceCalculator
 * @description Calculates confidence scores for parsed transaction fields
 * and determines if human review is required.
 */

const REVIEW_THRESHOLD = 0.75;

/**
 * Calculate overall confidence from individual field scores.
 * Uses weighted average with field importance weights.
 * @param {{ intent: number, amount: number, date: number, accountMapping: number }} scores
 * @returns {{ overall: number, intent: number, amount: number, date: number, accountMapping: number }}
 */
function calculateConfidence(scores) {
  const weights = {
    intent: 0.25,
    amount: 0.30,
    date: 0.20,
    accountMapping: 0.25,
  };

  const intent = clamp(scores.intent ?? 0);
  const amount = clamp(scores.amount ?? 0);
  const date = clamp(scores.date ?? 0);
  const accountMapping = clamp(scores.accountMapping ?? 0);

  const overall = clamp(
    intent * weights.intent +
    amount * weights.amount +
    date * weights.date +
    accountMapping * weights.accountMapping
  );

  return { overall, intent, amount, date, accountMapping };
}

/**
 * Determine if the parsed transaction requires human review.
 * @param {{ overall: number, intent: number, amount: number, date: number, accountMapping: number }} confidence
 * @param {object} parsedData - The parsed transaction data.
 * @returns {{ requiresReview: boolean, reviewReasons: string[] }}
 */
function evaluateReviewNeed(confidence, parsedData) {
  const reasons = [];

  if (confidence.overall < REVIEW_THRESHOLD) {
    reasons.push('Overall confidence below threshold');
  }
  if (confidence.intent < 0.7) {
    reasons.push('Conflicting or ambiguous transaction intent');
  }
  if (confidence.amount < 0.7) {
    reasons.push('Uncertain or missing amount');
  }
  if (confidence.date < 0.6) {
    reasons.push('Unclear or missing date');
  }
  if (confidence.accountMapping < 0.7) {
    reasons.push('Uncertain account mapping');
  }

  // Additional data-level checks
  if (!parsedData.amount || parsedData.amount <= 0) {
    reasons.push('Invalid or missing amount');
  }
  if (!parsedData.transactionType) {
    reasons.push('Missing transaction type');
  }
  if (!parsedData.sourceAccount && !parsedData.paymentMethod) {
    reasons.push('Ambiguous payment source');
  }
  if (parsedData.counterpartyName === null && parsedData.transactionType === 'income') {
    reasons.push('Unclear counterparty for income transaction');
  }

  return {
    requiresReview: reasons.length > 0,
    reviewReasons: reasons,
  };
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

module.exports = {
  calculateConfidence,
  evaluateReviewNeed,
  REVIEW_THRESHOLD,
};
