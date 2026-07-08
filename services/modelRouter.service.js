// services/modelRouter.service.js — chat-completion entry point used by the AI
// assistant, how-to search, and faithfulness judge.
//
// Single provider: DeepSeek (services/deepseek.service.js). The "router" name
// and the {text, provider} return shape are kept for backward compatibility
// with every existing caller/test — there is nothing left to route between.
'use strict';
const deepseek = require('./deepseek.service');
const { extractJSON } = require('../utils/aiJson.helper');

function emitChunkedText(text, onToken) {
  const value = String(text || '');
  if (!value) return;
  const chunks = value.match(/\S+\s*/g) || [value];
  chunks.forEach((chunk) => onToken(chunk));
}

async function callChat(messages, options = {}) {
  return deepseek.callChat(messages, options);
}

async function callChatStream(messages, options = {}, onToken = () => {}) {
  return deepseek.callChatStream(messages, options, onToken);
}

module.exports = {
  callChat,
  callChatStream,
  extractJSON,
  emitChunkedText,
};
