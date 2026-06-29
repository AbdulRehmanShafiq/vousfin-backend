const crypto = require('crypto');
const AIInteractionLog = require('../models/AIInteractionLog.model');
const modelRouter = require('./modelRouter.service');
const logger = require('../config/logger');

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

async function check(responseText, context, businessId) {
  if (process.env.AI_FAITHFULNESS_ENABLED !== 'true') {
    return { faithful: true, unsupportedClaims: [] };
  }

  const prompt = `You are a financial fact-checker.

Retrieved context:
${context}

AI response:
${responseText}

Check whether every factual claim in the AI response is supported by the retrieved context.
Return only JSON in this shape:
{ "faithful": boolean, "unsupportedClaims": string[] }`;

  const messages = [
    { role: 'system', content: 'You are a strict JSON-only financial fact checker.' },
    { role: 'user', content: prompt },
  ];

  const result = await modelRouter.callChat(messages, { temperature: 0, max_tokens: 500 });
  const parsed = modelRouter.extractJSON(result.text);
  if (!parsed || typeof parsed.faithful !== 'boolean') {
    throw new Error('Faithfulness judge returned invalid JSON');
  }

  if (!parsed.faithful) {
    await AIInteractionLog.create({
      businessId,
      eventType: 'AI_FAITHFULNESS_ISSUE',
      questionHash: hashText(responseText),
      details: {
        unsupportedClaims: parsed.unsupportedClaims || [],
        provider: result.provider,
      },
    });
  }

  return parsed;
}

function checkAsync(responseText, context, businessId) {
  setImmediate(() => {
    check(responseText, context, businessId).catch((error) => {
      logger.warn(`[faithfulnessJudge] check skipped/failed: ${error.message}`);
    });
  });
}

module.exports = {
  check,
  checkAsync,
};
