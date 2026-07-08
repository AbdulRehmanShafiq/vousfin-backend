// utils/aiJson.helper.js — pure, provider-agnostic JSON extraction from an LLM
// text response (direct parse → ```json code fence → first {...} object).
'use strict';

function extractJSON(content) {
  if (!content || typeof content !== 'string') return null;

  try {
    return JSON.parse(content);
  } catch (_) {
    // fall through to extraction strategies below
  }

  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch (_) {
      // continue
    }
  }

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (_) {
      // give up
    }
  }

  return null;
}

module.exports = { extractJSON };
