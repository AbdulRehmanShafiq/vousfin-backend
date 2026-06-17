// services/actionExecutors.js
//
// Autonomy roadmap Phase 2 — the executor registry.
//
// The action router (Phase 0) is deliberately generic: it decides whether an
// action is observed / queued / executed, but it does not know HOW to carry any
// particular action out. Each agent registers a handler for the action types it
// owns:
//
//   register('post_journal', { execute, reverse })
//
// The router looks the handler up by action.type when it needs to auto-execute,
// when a human approves a queued action, or when one is reversed. This keeps the
// router free of agent-specific imports (and free of circular dependencies).
//
'use strict';
const logger = require('../config/logger');

/** @type {Map<string, { execute?: Function, reverse?: Function }>} */
const registry = new Map();

/** An agent registers how to execute (and undo) one action type. */
function register(type, handlers) {
  if (!type || typeof handlers !== 'object') return;
  registry.set(type, { ...(registry.get(type) || {}), ...handlers });
  logger.info(`[actionExecutors] registered handler for "${type}"`);
}

/** The execute() for an action type, or undefined. */
function executor(type) {
  return registry.get(type)?.execute;
}

/** The reverse() for an action type, or undefined. */
function reverser(type) {
  return registry.get(type)?.reverse;
}

/** An optional onReject() side-effect for an action type, or undefined. */
function rejecter(type) {
  return registry.get(type)?.onReject;
}

module.exports = { register, executor, reverser, rejecter };
