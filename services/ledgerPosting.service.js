/**
 * ledgerPosting.service.js — ERP Integration Refactor, Step 4
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  SHARED BALANCED-JOURNAL POSTER                                            │
 * │                                                                            │
 * │  One place that creates a two-account JournalEntry AND keeps the          │
 * │  Chart-of-Accounts running balances in lock-step. Before this, only       │
 * │  transaction.service updated running balances (via _updateAccountBalance) │
 * │  — bill.service / vendorCredit.service created JournalEntries directly and │
 * │  silently left the trial balance stale.                                   │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * WHY (mandatory rules):
 *   • Rule 4 (GAAP) / Rule 5 (double-entry integrity): a posted journal must
 *     move BOTH account running balances, or the trial balance drifts.
 *   • Rule 8 (no duplicate logic) / Rule 9 (centralized): the debit/credit
 *     sign rule lived only inside transaction.service; now any service that
 *     posts a system journal reuses the exact same rule here.
 *
 * The journal itself is always balanced by construction: a single debit account
 * and a single credit account for the SAME amount.
 *
 * ATOMICITY (R-01 / R-02 fix):
 *   The JournalEntry insert AND both running-balance updates now run inside ONE
 *   MongoDB transaction (via utils/withTransaction). Either the journal AND both
 *   balances commit together, or they ALL roll back — so a crash mid-post can no
 *   longer leave the trial balance drifted from the ledger.
 *     • On a replica set (Atlas / prod): real all-or-nothing. If a balance update
 *       fails, the whole post — including the JournalEntry — rolls back, and the
 *       error propagates so the caller knows the post did not happen. Better to
 *       fail loudly and retry than to silently drift.
 *     • On a standalone dev server (no transactions): withTransaction runs the
 *       work without a session, and the balance updates stay best-effort (a
 *       cache hiccup is logged, the JE survives) — exactly the old behaviour, so
 *       local dev never breaks.
 *   Callers already inside their own transaction can pass `{ session }`; the post
 *   then joins that transaction instead of opening a nested one.
 */

'use strict';

const JournalEntry = require('../models/JournalEntry.model');
const accountRepository = require('../repositories/account.repository');
const { withTransaction } = require('../utils/withTransaction');
const { ApiError } = require('../utils/ApiError');
const { INPUT_METHODS } = require('../config/constants');
const logger = require('../config/logger');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * Apply a posted amount to one account's cached running balance, respecting the
 * account's normal balance. Mirrors transaction.service._updateAccountBalance.
 *
 * @param {string} accountId
 * @param {number} amount   always positive — the journal line amount
 * @param {'debit'|'credit'} side
 * @param {Object}  [opts]
 * @param {import('mongoose').ClientSession|null} [opts.session]  txn session to join
 * @param {boolean} [opts.strict]  when true (inside a real txn), a failure THROWS
 *                                 so the transaction rolls back; when false it is
 *                                 logged and swallowed (legacy best-effort).
 */
async function applyRunningBalance(accountId, amount, side, { session = null, strict = false } = {}) {
  if (!accountId) return;
  try {
    // Read inside the session. This used to be a session-less read, justified by
    // "normalBalance is immutable, so it is consistent anyway" — true, but it
    // assumed the account already existed. It can now be created earlier in this
    // same transaction (the resolver healing a missing default), and a
    // session-less read cannot see its own transaction's writes: the account
    // looked absent and, under strict, blew up the whole posting.
    const account = await accountRepository.findByIdInSession(accountId, session);
    if (!account) {
      const msg = `[ledgerPosting] account ${accountId} not found — running balance not updated`;
      if (strict) throw new Error(msg);
      logger.warn(msg);
      return;
    }
    let delta;
    if (side === 'debit') {
      // Debit increases debit-normal accounts, decreases credit-normal ones.
      delta = account.normalBalance === 'Debit' ? amount : -amount;
    } else {
      // Credit increases credit-normal accounts, decreases debit-normal ones.
      delta = account.normalBalance === 'Credit' ? amount : -amount;
    }
    await accountRepository.updateRunningBalance(accountId, r2(delta), session);
  } catch (e) {
    if (strict) throw e; // inside a transaction → propagate so the JE rolls back
    logger.error(`[ledgerPosting] running-balance update failed for ${accountId}: ${e.message}`);
  }
}

/**
 * Create a balanced two-account JournalEntry and sync both running balances —
 * atomically (see the ATOMICITY note in the file header).
 *
 * @param {Object} entry   a JournalEntry payload with debitAccountId,
 *                         creditAccountId and amount (plus the usual metadata)
 * @param {Object} [opts]
 * @param {boolean} [opts.updateBalances=true]  set false to skip the cache sync
 * @param {import('mongoose').ClientSession|null} [opts.session]  join an existing txn
 * @returns {Promise<Object>}  the created JournalEntry document
 */
/**
 * CANONICAL COMPOUND POSTER (Phase 1).
 * Post ONE balanced journal with 1..N lines, atomically, updating the running
 * balance for EVERY line. This is the system lane: it does NO enrichment (no
 * tax, FX, type inference, double-submit guard) — the caller supplies exact,
 * already-validated lines. The top-level (debitAccountId, creditAccountId,
 * amount) triple is written as a DERIVED projection of the lines (first debit,
 * first credit, Σ debits) for back-compat and indexes.
 *
 * @param {Object} payload
 *   { businessId, transactionDate, description, transactionType, inputMethod,
 *     createdBy, transactionSource?, entryType?, costCenterId?, periodId?, …,
 *     lines: [ { accountId, type:'debit'|'credit', amount, costCenterId?, description? } ],
 *     idempotencyKey?, metadata? }
 * @param {Object} [opts] { updateBalances=true, session=null }
 * @returns {Promise<Object>} the created (or pre-existing idempotent) JournalEntry
 */
async function postCompoundJournal(payload, { updateBalances = true, session = null } = {}) {
  const { lines, idempotencyKey, metadata, ...rest } = payload;

  // `inputMethod` is REQUIRED by the schema, and seven system posting sites in
  // invoice/bill omitted it — every one of them would have thrown a
  // ValidationError. It stayed invisible because those paths were unreachable
  // (the below-threshold early return) and because the unit tests mock this
  // poster, so no schema ever ran.
  //
  // Defaulting it here rather than at seven call sites is the same reasoning as
  // the balance rule: enforce in the chokepoint and the next caller cannot get
  // it wrong either. A system-generated posting is never a user input method —
  // the human paths (transaction.service: excel/nlp/batch) pass their own and
  // are untouched.
  if (!rest.inputMethod) rest.inputMethod = INPUT_METHODS.FORM;

  if (!Array.isArray(lines) || lines.length < 2) {
    throw new ApiError(400, 'A journal needs at least two lines.');
  }
  let sumDebit = 0, sumCredit = 0;
  for (const l of lines) {
    if (!(Number(l.amount) > 0)) throw new ApiError(400, 'Every journal line needs a positive amount.');
    if (l.type === 'debit') sumDebit = r2(sumDebit + l.amount);
    else if (l.type === 'credit') sumCredit = r2(sumCredit + l.amount);
    else throw new ApiError(400, `Invalid journal line type: ${l.type}`);
  }
  if (r2(sumDebit) !== r2(sumCredit)) {
    throw new ApiError(400, `Journal is not balanced (debits ${r2(sumDebit)} ≠ credits ${r2(sumCredit)}).`);
  }

  // F16 — tenant defense-in-depth: every line's account must belong to the
  // posting business. createTransaction validates human input; the poster now
  // guards its (system) callers too, because a wrong-tenant accountId here
  // would both reference AND re-balance another business's account.
  const lineAccountIds = [...new Set(lines.map((l) => l.accountId && String(l.accountId._id || l.accountId)))];
  if (lineAccountIds.some((id) => !id)) {
    throw new ApiError(400, 'Every journal line must reference an account.');
  }
  // Read inside the caller's session: an account the caller legitimately created
  // earlier in this same transaction (the resolver healing a missing default,
  // say) is invisible to a session-less read, and this guard would reject the
  // business's own account as foreign.
  const ownedAccounts = await accountRepository.findAllByBusinessAndIds(
    rest.businessId, lineAccountIds, { session }
  );
  const ownedSet = new Set((ownedAccounts || []).map((a) => String(a._id)));
  const foreignIds = lineAccountIds.filter((id) => !ownedSet.has(id));
  if (foreignIds.length > 0) {
    throw new ApiError(400, `Journal line account(s) do not belong to this business: ${foreignIds.join(', ')}`);
  }

  // Unified idempotency — keyed on metadata.idempotencyKey (one batch = one entry).
  if (idempotencyKey) {
    const existing = await JournalEntry.findOne(
      { businessId: rest.businessId, 'metadata.idempotencyKey': idempotencyKey }, { _id: 1 }
    ).lean();
    if (existing) {
      logger.info(`[postCompoundJournal] idempotent skip — key ${idempotencyKey} already posted as ${existing._id}`);
      return existing;
    }
  }

  const firstDebit = lines.find((l) => l.type === 'debit');
  const firstCredit = lines.find((l) => l.type === 'credit');
  const entry = {
    ...rest,
    amount: r2(sumDebit),
    debitAccountId: firstDebit.accountId,
    creditAccountId: firstCredit.accountId,
    journalLines: lines.map((l) => ({
      accountId: l.accountId, type: l.type, amount: r2(l.amount),
      description: l.description || '', costCenterId: l.costCenterId || null,
    })),
    metadata: { ...(metadata || {}), ...(idempotencyKey ? { idempotencyKey } : {}) },
  };

  const run = async (s) => {
    const created = await JournalEntry.create([entry], { session: s });
    const je = Array.isArray(created) ? created[0] : created;
    if (updateBalances) {
      // Sequential so two lines on the same account can't race; strict inside a txn.
      for (const l of entry.journalLines) {
        await applyRunningBalance(l.accountId, l.amount, l.type, { session: s, strict: !!s });
      }
    }
    return je;
  };

  // F7 — the unique index {businessId, metadata.idempotencyKey} is the real
  // idempotency arbiter: when a concurrent twin wins the insert race, our
  // create gets E11000. Translate that into "already posted" by returning the
  // committed twin — the losing attempt's transaction rolled back, so no
  // balance was double-applied. An E11000 without a key (or with no committed
  // twin, e.g. an invoice-number collision) is a genuine error and rethrows.
  const runIdempotent = async (exec) => {
    try {
      return await exec();
    } catch (err) {
      if (err && err.code === 11000 && idempotencyKey) {
        const twin = await JournalEntry.findOne(
          { businessId: rest.businessId, 'metadata.idempotencyKey': idempotencyKey }
        ).lean();
        if (twin) {
          logger.info(`[postCompoundJournal] lost idempotency race — key ${idempotencyKey} already posted as ${twin._id}`);
          return twin;
        }
      }
      throw err;
    }
  };

  if (session) return runIdempotent(() => run(session));
  if (!updateBalances) return runIdempotent(() => run(null));
  return runIdempotent(() => withTransaction(run));
}

/**
 * Two-account balanced poster — now a thin shim over postCompoundJournal so the
 * whole codebase shares ONE posting engine and every entry carries journalLines.
 * Honours a caller-supplied compound `journalLines` if present (previously such
 * extra legs moved the report but NOT the running balance — this fixes that).
 */
async function postBalancedJournal(entry, opts = {}) {
  const { debitAccountId, creditAccountId, amount, journalLines, ...rest } = entry;
  const lines = (journalLines && journalLines.length > 0)
    ? journalLines.map((l) => ({ accountId: l.accountId, type: l.type, amount: l.amount, description: l.description, costCenterId: l.costCenterId }))
    : [
        { accountId: debitAccountId, type: 'debit', amount },
        { accountId: creditAccountId, type: 'credit', amount },
      ];
  return postCompoundJournal({ ...rest, lines }, opts);
}

module.exports = { postBalancedJournal, postCompoundJournal, applyRunningBalance };
