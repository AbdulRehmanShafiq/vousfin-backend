/**
 * @module clarificationBuilder
 * @description Decides whether the NL parser should ask the user ONE plain-English
 * follow-up question before autofilling the form.
 *
 * The parser is stateless: when a critical field is missing or ambiguous, we
 * surface a single, prioritised question. The frontend collects the answer,
 * appends it to the original text, and re-parses — so the next pass fills the
 * form with greater confidence. A round cap guarantees the loop always ends.
 *
 * Plain language only — the person typing may not be an accountant.
 */

const DEFAULT_MAX_ROUNDS = 2;

/**
 * @param {{overall:number, intent:number, amount:number, date:number, accountMapping:number}} confidence
 * @param {object} parsedData  normalized parser output (amount, paymentMethod, sourceAccount, cashFlowDirection, ...)
 * @param {{attempt?:number, maxRounds?:number}} [opts]
 * @returns {null | {field:string, question:string, options?:string[]}}
 */
function buildClarification(confidence = {}, parsedData = {}, opts = {}) {
  const attempt = Number(opts.attempt) || 0;
  const maxRounds = Number(opts.maxRounds) || DEFAULT_MAX_ROUNDS;

  // Never loop forever — after the cap, fill the form with what we have.
  if (attempt >= maxRounds) return null;

  // 1) Amount is the single most important field — ask for it first.
  const amount = Number(parsedData.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      field: 'amount',
      question: 'How much was this for? Please enter the amount.',
    };
  }

  // 2) Ambiguous payment source — but ONLY for money-moving transactions.
  // Non-cash entries (depreciation, financed asset purchases, transfers) have no
  // payment source by design, so asking would be a false prompt.
  const isCashFlow = parsedData.cashFlowDirection !== 'non_cash';
  if (isCashFlow && !parsedData.paymentMethod && !parsedData.sourceAccount) {
    return {
      field: 'paymentMethod',
      question: 'How was this paid?',
      options: ['Cash', 'Bank transfer', 'Credit/Debit card', 'On credit (pay later)'],
    };
  }

  // 3) We could not confidently tell which accounts this belongs to.
  if ((confidence.accountMapping ?? 1) < 0.7) {
    return {
      field: 'purpose',
      question: 'What was this for? For example: office rent, a sale to a customer, or buying stock.',
    };
  }

  return null;
}

module.exports = { buildClarification, DEFAULT_MAX_ROUNDS };
