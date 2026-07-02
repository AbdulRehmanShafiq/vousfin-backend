// services/bookkeeper.service.js
//
// Autonomy roadmap Phase 2 — the Bookkeeper agent (the biggest workload win).
//
// The owner hands the books a document (a typed/forwarded bill, a receipt, a
// bank-feed line). The Bookkeeper:
//   1. captures it as a SourceDocument,
//   2. reads it with the existing NL/AI engine (account-aware),
//   3. resolves the suggested accounts against this business's chart of accounts,
//   4. recalls how this counterparty was booked before (entity memory),
//   5. proposes a journal entry through the action router — which, per the
//      bookkeeping autonomy dial, either queues it for approval or auto-posts it.
//
// Nothing posts to the ledger here. The router's executor (registered below)
// calls transactionService.createTransaction — the one authoritative path — and
// every posting is audited and reversible.
//
'use strict';
const { parseTransaction, parseTransactionFromImage } = require('./nlParser');
const aiDecisionService = require('./aiDecision.service');
const actionRouter = require('./actionRouter.service');
const executors = require('./actionExecutors');
const entityMemory = require('./entityMemory.service');
const transactionService = require('./transaction.service');
const accountRepository = require('../repositories/account.repository');
const businessRepository = require('../repositories/business.repository');
const docRepo = require('../repositories/sourceDocument.repository');
const logger = require('../config/logger');
const {
  SOURCE_DOCUMENT_SOURCES, SOURCE_DOCUMENT_STATUS,
  PROPOSED_ACTION_TYPES,
} = require('../config/constants');

const MEMORY_KIND = 'counterparty_account'; // counterparty name → preferred expense/revenue account
const POST_JOURNAL = PROPOSED_ACTION_TYPES.POST_JOURNAL;

/* ── Account-name resolution ──────────────────────────────────────────────── */
// The NL engine returns account *names*; the ledger needs account *ids* scoped
// to this business. Match exact (case-insensitive) first, then a contained-name
// fallback, so "Rent" resolves to "Rent Expense".
function resolveAccount(accounts, name) {
  if (!name) return null;
  const want = String(name).trim().toLowerCase();
  return (
    accounts.find(a => a.accountName.toLowerCase() === want) ||
    accounts.find(a => a.accountName.toLowerCase().includes(want) || want.includes(a.accountName.toLowerCase())) ||
    null
  );
}

/* ── Turn a parsed reading into a proposed journal entry ──────────────────── */
async function readIntoProposal(doc, accounts, parsed) {
  const p = parsed.parsedData || {};
  const lines = Array.isArray(parsed.journalEntries) ? parsed.journalEntries : [];

  if (!lines.length || !p.amount) {
    return { ok: false, reason: "We couldn't read a clear amount and accounts from this." };
  }

  // Resolve every line's account to an id; collect any we can't match.
  const unresolved = [];
  const journalLines = lines.map((l) => {
    const acct = resolveAccount(accounts, l.account);
    if (!acct) unresolved.push(l.account);
    return { accountId: acct?._id || null, accountName: acct?.accountName || l.account, type: l.entryType, amount: l.amount };
  });

  let confidence = Math.max(0, Math.min(1, parsed.confidence?.overall ?? 0.5));
  const citations = journalLines.map(l => `${l.type === 'debit' ? 'To' : 'From'} ${l.accountName}: Rs ${Number(l.amount).toLocaleString()}`);

  // Recall how this counterparty was booked before — nudge confidence up.
  let memoryHit = null;
  if (p.counterpartyName) {
    memoryHit = await entityMemory.suggest(doc.businessId, MEMORY_KIND, p.counterpartyName).catch(() => null);
    if (memoryHit) {
      confidence = Math.min(1, confidence + 0.1);
      citations.push(`Matched how you booked ${p.counterpartyName} before.`);
    }
  }

  // An unmatched account means we can't post safely — keep it low so it never
  // auto-posts; the owner sees a clear note and can fix the account.
  if (unresolved.length) confidence = Math.min(confidence, 0.3);

  return {
    ok: unresolved.length === 0,
    confidence,
    unresolved,
    parsedData: p,
    payload: {
      businessId:      doc.businessId,
      transactionDate: p.date ? new Date(p.date) : new Date(),
      amount:          p.amount,
      description:     p.description || doc.rawText.slice(0, 200),
      // transactionType is intentionally omitted — createTransaction infers the
      // ledger's own enum from the debit/credit account types (the NL engine's
      // vocabulary differs from TRANSACTION_TYPES).
      inputMethod:     'nlp',           // read by the AI/NL engine
      counterpartyName: p.counterpartyName || null,
      journalLines:    journalLines.map(l => ({ accountId: l.accountId, type: l.type, amount: l.amount })),
      userId:          doc.submittedBy || null,
      sourceDocumentId: String(doc._id),
    },
    citations,
    summary: buildSummary(p, journalLines, unresolved),
  };
}

function plainType(t) {
  const map = {
    income: 'money in', expense: 'money out', credit_sale: 'a sale on credit',
    credit_purchase: 'a purchase on credit', payment_received: 'a payment received',
    payment_made: 'a payment made',
  };
  return map[t] || 'a transaction';
}

function buildSummary(p, lines, unresolved) {
  const amt = `Rs ${Number(p.amount).toLocaleString()}`;
  const who = p.counterpartyName ? ` ${p.transactionType === 'income' ? 'from' : 'to'} ${p.counterpartyName}` : '';
  if (unresolved.length) {
    return `We read ${amt}${who}, but couldn't match the account "${unresolved[0]}" to your books. Check it before approving.`;
  }
  return `We read this as ${plainType(p.transactionType)}: ${amt}${who}.`;
}

/* ── Public: ingest a document (text or image) and propose its journal entry ─ */
async function ingest({ businessId, rawText, source, submittedBy, image, mimeType }) {
  const text = String(rawText || '').trim();
  const hasImage = !!image;
  if (!text && !hasImage) { const e = new Error('Nothing to read — add the bill text, or attach a photo.'); e.statusCode = 400; throw e; }

  const doc = await docRepo.create({
    businessId,
    rawText: (text || '(photo of a bill/receipt)').slice(0, 5000),
    source: hasImage ? SOURCE_DOCUMENT_SOURCES.UPLOAD
      : (Object.values(SOURCE_DOCUMENT_SOURCES).includes(source) ? source : SOURCE_DOCUMENT_SOURCES.MANUAL),
    status: SOURCE_DOCUMENT_STATUS.RECEIVED,
    submittedBy: submittedBy || null,
  });

  let accounts = [];
  let countryCode = null;
  try {
    accounts = await accountRepository.findByBusiness(businessId);
    const biz = await businessRepository.findById(businessId);
    countryCode = biz?.country || null;
  } catch (e) { logger.warn(`[bookkeeper] context load failed: ${e.message}`); }

  let read;
  try {
    // Read the photo with Gemini vision, or the typed text — same pipeline after.
    const parsed = hasImage
      ? await parseTransactionFromImage(image, mimeType || 'image/jpeg', accounts, { countryCode, rawText: text })
      : await parseTransaction(text, accounts, { countryCode });
    read = await readIntoProposal(doc, accounts, parsed);
  } catch (e) {
    // Tell the owner the truth: the AI being busy is not the same as bad input.
    const busy = e.isOverloaded || /overloaded|unavailable|busy|timed out|\b(503|429)\b/i.test(e.message || '');
    const errMsg = busy
      ? 'Our reader is busy right now — please try again in a moment.'
      : 'We couldn’t read this one. Try typing the amount and what it was for.';
    logger.warn(`[bookkeeper] read failed for doc ${doc._id}: ${e.message}`);
    await docRepo.update(doc._id, { $set: { status: SOURCE_DOCUMENT_STATUS.FAILED, error: errMsg } });
    return { document: await docRepo.findById(doc._id), action: null, error: errMsg, busy };
  }

  if (!read.ok && !read.confidence) {
    await docRepo.update(doc._id, { $set: { status: SOURCE_DOCUMENT_STATUS.FAILED, error: read.reason } });
    return { document: await docRepo.findById(doc._id), action: null };
  }

  // ── AI Decision Ledger (Phase 5): document-classification lineage ─────────
  const aiDecision = await aiDecisionService.record(businessId, 'classify', {
    inputsSummary: (hasImage ? `[document image] ${text}` : text).trim().slice(0, 2000) || 'document image',
    candidates: (read.payload.journalLines || []).map((l) => l.accountName || l.description || '').filter(Boolean).slice(0, 20),
    decision: {
      description: read.payload.description,
      amount: read.payload.amount,
      transactionType: read.parsedData?.transactionType || null,
    },
    confidence: read.confidence,
    model: hasImage ? 'gemini-vision-doc' : 'gemini-nl-parser',
    promptVersion: 'doc-v1',
    linkedEntityId: doc._id,
  });

  // Propose through the router — policy decides queue vs. auto-post.
  const action = await actionRouter.propose({
    businessId,
    capability: 'bookkeeping',
    type:       POST_JOURNAL,
    title:      `Record: ${read.payload.description.slice(0, 60)}`,
    summary:    read.summary,
    rationale:  read.citations.join('  ·  '),
    citations:  read.citations,
    confidence: read.confidence,
    amount:     read.payload.amount,
    payload:    read.payload,
    reversal:   { kind: 'journal_reversal' },
    sourceType: 'source_document',
    sourceId:   String(doc._id),
  });

  // Auto-executed by policy → the classification stands accepted; queued
  // proposals stay pending until the owner acts on them.
  if (action.status === 'executed') {
    await aiDecisionService.recordOutcome(aiDecision?._id ? String(aiDecision._id) : null, businessId, 'accepted', null);
  }

  await docRepo.update(doc._id, {
    $set: {
      status: action.status === 'executed' ? SOURCE_DOCUMENT_STATUS.POSTED : SOURCE_DOCUMENT_STATUS.PROPOSED,
      extracted: { ...read.parsedData, lines: read.payload.journalLines },
      confidence: read.confidence,
      proposedActionId: action._id,
      journalEntryId: action.result?.journalEntryId || null,
      ...(aiDecision?._id ? { aiDecisionId: aiDecision._id } : {}),
    },
  });

  return { document: await docRepo.findById(doc._id), action };
}

async function listDocuments(businessId) {
  return docRepo.recent(businessId);
}

/* ── The post_journal executor — the one authoritative ledger path ────────── */
async function executePostJournal(action) {
  const payload = action.payload || {};
  if (!payload.journalLines?.some(l => l.accountId)) {
    throw new Error('This entry has an account we couldn’t match — please fix it before posting.');
  }
  const je = await transactionService.createTransaction(
    { ...payload, idempotencyKey: `bk:${action._id}` },
    payload.userId || null,
    null,
  );

  // Learn how this counterparty was booked so next time is more confident.
  if (payload.counterpartyName) {
    const debit = payload.journalLines.find(l => l.type === 'debit');
    if (debit?.accountId) {
      entityMemory.learn(action.businessId, MEMORY_KIND, payload.counterpartyName, { accountId: String(debit.accountId) });
    }
  }
  if (payload.sourceDocumentId) {
    await docRepo.update(payload.sourceDocumentId, {
      $set: { status: SOURCE_DOCUMENT_STATUS.POSTED, journalEntryId: je._id },
    }).catch(() => {});
  }
  return { journalEntryId: je._id };
}

/* ── Reverse a posted entry (one-click undo from the Command Center) ───────── */
async function reversePostJournal(action) {
  const jeId = action.result?.journalEntryId;
  if (!jeId) throw new Error('Nothing to reverse — no ledger entry was recorded.');
  const reversal = await transactionService.reverseTransaction(
    jeId, action.businessId,
    { reason: 'Reversed from the Command Center' },
    action.payload?.userId || null, null,
  );
  if (action.payload?.sourceDocumentId) {
    await docRepo.update(action.payload.sourceDocumentId, {
      $set: { status: SOURCE_DOCUMENT_STATUS.DISMISSED },
    }).catch(() => {});
  }
  return { reversalId: reversal._id };
}

/* ── Owner dismissed the proposal → mark the document so ────────────────────── */
async function onRejectPostJournal(action) {
  if (action.payload?.sourceDocumentId) {
    await docRepo.update(action.payload.sourceDocumentId, {
      $set: { status: SOURCE_DOCUMENT_STATUS.DISMISSED },
    }).catch(() => {});
  }
}

// Register this agent's handlers so the router can execute / reverse / clean up.
executors.register(POST_JOURNAL, {
  execute:  executePostJournal,
  reverse:  reversePostJournal,
  onReject: onRejectPostJournal,
});

module.exports = {
  ingest,
  listDocuments,
  // exported for tests
  resolveAccount,
  readIntoProposal,
  executePostJournal,
  reversePostJournal,
};
