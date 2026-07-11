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

const { ANSWER_OPTIONS } = require('../constants/clarificationAnswers');

const DEFAULT_MAX_ROUNDS = 3;

/**
 * @param {{overall:number, intent:number, amount:number, date:number, accountMapping:number}} confidence
 * @param {object} parsedData  normalized parser output (amount, paymentMethod, sourceAccount, cashFlowDirection, ...)
 * @param {{attempt?:number, maxRounds?:number, intentResolution?:object}} [opts]
 * @returns {null | {field:string, question:string, options?:string[]}}
 */
function buildClarification(confidence = {}, parsedData = {}, opts = {}) {
  const attempt = Number(opts.attempt) || 0;
  const maxRounds = Number(opts.maxRounds) || DEFAULT_MAX_ROUNDS;
  const ir = opts.intentResolution || null;

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

  // 3) Stock or expense? Only when the intent resolver was genuinely torn.
  if (ir?.needsClassificationQuestion) {
    return {
      field: 'purchaseIntent',
      question: 'Will you sell this again, or use it in the business?',
      options: [ANSWER_OPTIONS.RESALE, ANSWER_OPTIONS.BUSINESS_USE, ANSWER_OPTIONS.ASSET],
    };
  }

  // 4) Ask-first before creating a new inventory item (never silent).
  if (ir?.needsItemConsent) {
    const itemName = parsedData.lineItems?.[0]?.name || 'This item';
    return {
      field: 'newItemConsent',
      question: `"${itemName}" isn't in your inventory yet. Add it as a new item?`,
      options: [ANSWER_OPTIONS.ADD_ITEM_YES, ANSWER_OPTIONS.ADD_ITEM_NO],
    };
  }

  // 5) Stock will move but we don't know by how much.
  if (ir?.needsQuantity) {
    const verb = parsedData.cashFlowDirection === 'inflow' ? 'sell' : 'buy';
    return {
      field: 'inventoryQuantity',
      question: `How many did you ${verb}, and in what unit? (for example: 10 bags)`,
    };
  }

  // 6) A credit purchase needs to know who is owed.
  if (/accounts payable/i.test(parsedData.creditAccount || '') && !parsedData.counterpartyName) {
    return {
      field: 'vendorName',
      question: "Who did you buy this from? (the supplier's name)",
    };
  }

  // 7) We could not confidently tell which accounts this belongs to.
  if ((confidence.accountMapping ?? 1) < 0.7) {
    return {
      field: 'purpose',
      question: 'What was this for? For example: office rent, a sale to a customer, or buying stock.',
    };
  }

  return null;
}

module.exports = { buildClarification, DEFAULT_MAX_ROUNDS };
