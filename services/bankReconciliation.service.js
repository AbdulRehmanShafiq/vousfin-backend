// services/bankReconciliation.service.js
//
// Feature #7 — Real bank-statement reconciliation feed.
//
// Import a bank statement for a bank/cash account, then match each statement
// line to an existing journal entry that touches that account. The matching
// engine auto-links high-confidence pairs and suggests the rest for one-click
// confirmation. Reconciliation state lives only on the statement line — journal
// entries are never mutated (they stay immutable), and a new ledger entry can be
// posted directly from an unmatched line through the normal transaction engine.
//
'use strict';
const mongoose = require('mongoose');
const bankStatementRepository = require('../repositories/bankStatement.repository');
const accountRepository = require('../repositories/account.repository');
const transactionRepository = require('../repositories/transaction.repository');
const transactionService = require('./transaction.service');
const auditService = require('./audit.service');
const { ApiError } = require('../utils/ApiError');
const logger = require('../config/logger');
const { parseBankStatement } = require('../utils/bankStatementParser.utils');
const {
  BANK_LINE_STATUS, BANK_STATEMENT_STATUS, BANK_LINE_DIRECTION,
  RECONCILIATION_MATCH, ENTITY_TYPES, AUDIT_ACTIONS, TRANSACTION_ENTRY_SOURCES,
} = require('../config/constants');

const DAY = 86_400_000;
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const tokens = (s) => String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
// Account refs may be raw ObjectIds (lean getByAccount) or populated objects
// (findByIdWithDetails). Normalise either to its id string.
const idOf = (v) => String(v && v._id ? v._id : v);

class BankReconciliationService {
  _validateId(id, label = 'id') {
    if (!id || !mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, `Invalid ${label}`);
  }

  /** The bank-side effect of a journal entry: 'in' (bank debited) | 'out' (credited) | null. */
  _entryDirection(je, bankAccountId) {
    const b = String(bankAccountId);
    if (idOf(je.debitAccountId) === b)  return BANK_LINE_DIRECTION.IN;
    if (idOf(je.creditAccountId) === b) return BANK_LINE_DIRECTION.OUT;
    return null;
  }

  _entryAmount(je) {
    return Number(je.baseCurrencyAmount || je.amount) || 0;
  }

  /**
   * Score a (statement line, journal entry) pair 0–100 with a breakdown.
   * Direction + amount must agree or the pair is disqualified (returns null).
   */
  scoreCandidate(line, je, bankAccountId) {
    if (this._entryDirection(je, bankAccountId) !== line.direction) return null;

    const amt = this._entryAmount(je);
    const diff = Math.abs(amt - line.amount);
    const rel = line.amount ? diff / line.amount : 1;
    let amountPts;
    if (diff <= 0.01)      amountPts = 60;
    else if (rel <= 0.01)  amountPts = 42;
    else if (rel <= 0.02)  amountPts = 25;
    else return null; // amount too far off — not the same transaction
    const amountExact = diff <= 0.01;

    const days = Math.abs(new Date(je.transactionDate) - new Date(line.date)) / DAY;
    let datePts;
    if (days < 1)       datePts = 25;
    else if (days <= 2) datePts = 20;
    else if (days <= 5) datePts = 14;
    else if (days <= 10) datePts = 8;
    else if (days <= 20) datePts = 3;
    else datePts = 0;

    const lt = new Set(tokens(`${line.description} ${line.reference}`));
    const jt = tokens(`${je.description} ${je.transactionReference || ''} ${je.invoiceNumber || ''}`);
    let overlap = 0;
    for (const t of jt) if (lt.has(t)) overlap++;
    const denom = Math.max(1, Math.min(lt.size, jt.length) || 1);
    let textPts = Math.round(Math.min(1, overlap / denom) * 15);
    // Strong signal: the statement reference appears verbatim in the entry.
    if (line.reference && jt.includes(String(line.reference).toLowerCase())) textPts = 15;

    return {
      score: amountPts + datePts + textPts,
      amountExact,
      breakdown: { amount: amountPts, date: datePts, text: textPts },
    };
  }

  /** Best candidates for a line among a pool of entries, excluding used ids. */
  _rankCandidates(line, entries, usedIds) {
    const out = [];
    for (const je of entries) {
      if (usedIds.has(String(je._id))) continue;
      const s = this.scoreCandidate(line, je, line._bankAccountId);
      if (s && s.score >= RECONCILIATION_MATCH.SUGGEST_MIN_SCORE) {
        out.push({
          journalEntryId: je._id,
          description: je.description,
          date: je.transactionDate,
          amount: this._entryAmount(je),
          score: s.score,
          amountExact: s.amountExact,
          breakdown: s.breakdown,
        });
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /** Load ledger entries touching the bank account across the statement window. */
  async _loadLedgerWindow(businessId, bankAccountId, lines) {
    const dates = lines.map((l) => new Date(l.date).getTime());
    const start = new Date(Math.min(...dates) - 20 * DAY);
    const end   = new Date(Math.max(...dates) + 20 * DAY);
    const entries = await transactionRepository.getByAccount(businessId, bankAccountId, start, end);
    // tag the bank account on each line so scoreCandidate can read it
    lines.forEach((l) => { l._bankAccountId = bankAccountId; });
    return entries;
  }

  // ── Parse (preview) ──────────────────────────────────────────────────────────
  parse(buffer, fileName) {
    return parseBankStatement(buffer, fileName);
  }

  // ── Import + auto-match ──────────────────────────────────────────────────────
  async importStatement(businessId, data, actor) {
    this._validateId(businessId, 'businessId');
    this._validateId(data.bankAccountId, 'bankAccountId');
    const bankAcct = await accountRepository.findOneByBusinessAndId(businessId, data.bankAccountId);
    if (!bankAcct) throw new ApiError(400, 'Bank account not found for this business');

    let lines = Array.isArray(data.lines) ? data.lines : [];
    if (!lines.length) throw new ApiError(400, 'No statement lines to import');

    // Normalise + assign refs if missing.
    const crypto = require('crypto');
    lines = lines.map((l) => ({
      lineRef: l.lineRef || crypto.randomUUID(),
      date: new Date(l.date),
      description: String(l.description || '').slice(0, 500),
      reference: String(l.reference || '').slice(0, 100),
      amount: Math.abs(Number(l.amount) || 0),
      direction: l.direction === BANK_LINE_DIRECTION.OUT ? BANK_LINE_DIRECTION.OUT : BANK_LINE_DIRECTION.IN,
      runningBalance: l.runningBalance != null ? Number(l.runningBalance) : null,
      status: BANK_LINE_STATUS.UNMATCHED,
    })).filter((l) => l.amount > 0 && !isNaN(l.date));
    if (!lines.length) throw new ApiError(400, 'No valid statement lines after parsing');

    const dates = lines.map((l) => l.date);
    const periodStart = data.periodStart ? new Date(data.periodStart) : new Date(Math.min(...dates));
    const periodEnd   = data.periodEnd   ? new Date(data.periodEnd)   : new Date(Math.max(...dates));

    // Auto-match against the ledger.
    const entries = await this._loadLedgerWindow(businessId, data.bankAccountId, lines);
    const used = await bankStatementRepository.matchedJournalEntryIds(businessId, data.bankAccountId);
    let autoCount = 0;
    for (const line of lines) {
      const ranked = this._rankCandidates(line, entries, used);
      const best = ranked[0], second = ranked[1];
      const confident = best && best.amountExact &&
        best.score >= RECONCILIATION_MATCH.AUTO_MIN_SCORE &&
        (!second || best.score - second.score >= RECONCILIATION_MATCH.AUTO_MIN_GAP);
      if (confident) {
        line.status = BANK_LINE_STATUS.MATCHED;
        line.matchedJournalEntryId = best.journalEntryId;
        line.matchScore = best.score;
        line.autoMatched = true;
        line.matchedAt = new Date();
        used.add(String(best.journalEntryId));
        autoCount++;
      }
      delete line._bankAccountId;
    }

    const statement = await bankStatementRepository.create({
      businessId,
      bankAccountId: data.bankAccountId,
      bankAccountName: bankAcct.accountName,
      name: data.name || `${bankAcct.accountName} — ${periodEnd.toISOString().slice(0, 10)}`,
      fileName: data.fileName || null,
      periodStart, periodEnd,
      openingBalance: data.openingBalance != null ? Number(data.openingBalance) : null,
      closingBalance: data.closingBalance != null ? Number(data.closingBalance) : null,
      lines,
      status: BANK_STATEMENT_STATUS.IN_PROGRESS,
      importedBy: actor.id,
    });

    try {
      await auditService.log({
        businessId, entityType: ENTITY_TYPES.BANK_STATEMENT, entityId: statement._id,
        action: AUDIT_ACTIONS.CREATED, performedBy: actor.id, performedByName: actor.fullName,
        afterState: { name: statement.name, lines: lines.length, autoMatched: autoCount },
      });
    } catch (e) { /* best-effort: audit-log write; the bank statement import was already persisted */ logger.warn(`[reconcile] import audit failed: ${e.message}`); }

    logger.info(`[reconcile] imported statement ${statement._id}: ${lines.length} lines, ${autoCount} auto-matched`);
    return this.getStatement(statement._id, businessId);
  }

  // ── Read: statement + live candidates for unmatched lines + summary ───────────
  async getStatement(id, businessId) {
    this._validateId(id, 'statementId');
    const stmt = await bankStatementRepository.findOneByBusinessAndId(businessId, id);
    if (!stmt) throw new ApiError(404, 'Statement not found');

    const lines = stmt.lines;
    const matchedIds = new Set(
      lines.filter((l) => l.matchedJournalEntryId).map((l) => String(l.matchedJournalEntryId))
    );
    // exclude ids already used by OTHER statements too
    const otherUsed = await bankStatementRepository.matchedJournalEntryIds(businessId, stmt.bankAccountId, stmt._id);
    const used = new Set([...matchedIds, ...otherUsed]);

    const plainLines = lines.map((l) => l.toObject());
    const entries = await this._loadLedgerWindow(businessId, String(stmt.bankAccountId), plainLines);

    // Attach candidates to unmatched lines + resolve matched-entry display.
    const entryById = new Map(entries.map((e) => [String(e._id), e]));
    const out = plainLines.map((l) => {
      delete l._bankAccountId;
      if (l.status === BANK_LINE_STATUS.UNMATCHED) {
        l._bankAccountId = String(stmt.bankAccountId);
        l.candidates = this._rankCandidates(l, entries, used).slice(0, 4);
        delete l._bankAccountId;
      } else if (l.matchedJournalEntryId) {
        const je = entryById.get(String(l.matchedJournalEntryId));
        l.matchedEntry = je ? {
          _id: je._id, description: je.description, date: je.transactionDate, amount: this._entryAmount(je),
        } : null;
      }
      return l;
    });

    const summary = this._summary(stmt, out, entries, used);
    const unmatchedBook = entries
      .filter((e) => !used.has(String(e._id)))
      .map((e) => ({
        _id: e._id, description: e.description, date: e.transactionDate,
        amount: this._entryAmount(e), direction: this._entryDirection(e, String(stmt.bankAccountId)),
      }))
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    const obj = stmt.toObject();
    obj.lines = out;
    obj.summary = summary;
    obj.unmatchedBookEntries = unmatchedBook;
    return obj;
  }

  _summary(stmt, lines, entries, used) {
    const isMatched = (s) => s === BANK_LINE_STATUS.MATCHED || s === BANK_LINE_STATUS.CREATED;
    let inflow = 0, outflow = 0, matched = 0, cleared = 0, unmatched = 0;
    for (const l of lines) {
      if (l.direction === BANK_LINE_DIRECTION.IN) inflow += l.amount; else outflow += l.amount;
      if (isMatched(l.status)) matched++;
      else if (l.status === BANK_LINE_STATUS.CLEARED) cleared++;
      else unmatched++;
    }
    const net = r2(inflow - outflow);
    const opening = stmt.openingBalance;
    const closing = stmt.closingBalance;
    const expectedClosing = opening != null ? r2(opening + net) : null;
    const closingMatches = (closing != null && expectedClosing != null)
      ? Math.abs(closing - expectedClosing) < 0.01 : null;
    const unmatchedBookCount = entries.filter((e) => !used.has(String(e._id))).length;
    return {
      totalLines: lines.length, matched, cleared, unmatched,
      inflow: r2(inflow), outflow: r2(outflow), net,
      opening, closing, expectedClosing, closingMatches,
      unmatchedBookCount,
      fullyReconciled: unmatched === 0,
    };
  }

  _findLine(stmt, lineRef) {
    const line = stmt.lines.find((l) => l.lineRef === lineRef);
    if (!line) throw new ApiError(404, 'Statement line not found');
    return line;
  }

  // ── Actions ───────────────────────────────────────────────────────────────────
  async confirmMatch(statementId, lineRef, journalEntryId, businessId, actor) {
    this._validateId(journalEntryId, 'journalEntryId');
    const stmt = await bankStatementRepository.findOneByBusinessAndId(businessId, statementId);
    if (!stmt) throw new ApiError(404, 'Statement not found');
    const line = this._findLine(stmt, lineRef);

    const je = await transactionRepository.findByIdWithDetails(journalEntryId, businessId);
    if (!je) throw new ApiError(400, 'Journal entry not found');
    if (this._entryDirection(je, String(stmt.bankAccountId)) !== line.direction) {
      throw new ApiError(400, 'That entry does not move this bank account in the same direction as the statement line');
    }
    // Guard against double-claiming a ledger entry.
    const used = await bankStatementRepository.matchedJournalEntryIds(businessId, stmt.bankAccountId);
    const inThis = stmt.lines.some((l) => l.lineRef !== lineRef && String(l.matchedJournalEntryId) === String(journalEntryId));
    if (used.has(String(journalEntryId)) || inThis) {
      throw new ApiError(409, 'That ledger entry is already reconciled to another line');
    }

    const sc = this.scoreCandidate(line, je, String(stmt.bankAccountId));
    line.status = BANK_LINE_STATUS.MATCHED;
    line.matchedJournalEntryId = je._id;
    line.matchScore = sc?.score ?? null;
    line.autoMatched = false;
    line.matchedAt = new Date();
    line.matchedBy = actor.id;
    line.note = null;
    await stmt.save();
    return this.getStatement(statementId, businessId);
  }

  async unmatch(statementId, lineRef, businessId) {
    const stmt = await bankStatementRepository.findOneByBusinessAndId(businessId, statementId);
    if (!stmt) throw new ApiError(404, 'Statement not found');
    const line = this._findLine(stmt, lineRef);
    line.status = BANK_LINE_STATUS.UNMATCHED;
    line.matchedJournalEntryId = null;
    line.matchScore = null;
    line.autoMatched = false;
    line.matchedAt = null;
    line.matchedBy = null;
    line.note = null;
    await stmt.save();
    return this.getStatement(statementId, businessId);
  }

  async markCleared(statementId, lineRef, businessId, actor, note = null) {
    const stmt = await bankStatementRepository.findOneByBusinessAndId(businessId, statementId);
    if (!stmt) throw new ApiError(404, 'Statement not found');
    const line = this._findLine(stmt, lineRef);
    line.status = BANK_LINE_STATUS.CLEARED;
    line.matchedJournalEntryId = null;
    line.matchedAt = new Date();
    line.matchedBy = actor.id;
    line.note = note || 'Manually cleared';
    await stmt.save();
    return this.getStatement(statementId, businessId);
  }

  /**
   * Post a new journal entry from an unmatched line, then link it. The line is
   * hard evidence the money moved, so this posts directly through the normal
   * transaction engine (the bank side is fixed; the user picks the other side).
   */
  async createFromLine(statementId, lineRef, businessId, body, actor, ipAddress) {
    const stmt = await bankStatementRepository.findOneByBusinessAndId(businessId, statementId);
    if (!stmt) throw new ApiError(404, 'Statement not found');
    const line = this._findLine(stmt, lineRef);
    if (line.status === BANK_LINE_STATUS.MATCHED || line.status === BANK_LINE_STATUS.CREATED) {
      throw new ApiError(409, 'This line is already matched');
    }
    const categoryAccountId = body.categoryAccountId || body.accountId;
    this._validateId(categoryAccountId, 'categoryAccountId');
    if (String(categoryAccountId) === String(stmt.bankAccountId)) {
      throw new ApiError(400, 'Pick a category account different from the bank account');
    }
    const cat = await accountRepository.findOneByBusinessAndId(businessId, categoryAccountId);
    if (!cat) throw new ApiError(400, 'Category account not found');

    // Bank side is fixed by the line direction.
    const txData = {
      businessId,
      transactionDate: line.date,
      description: (body.description || line.description || 'Bank reconciliation entry').slice(0, 200),
      amount: line.amount,
      debitAccountId:  line.direction === BANK_LINE_DIRECTION.IN ? stmt.bankAccountId : categoryAccountId,
      creditAccountId: line.direction === BANK_LINE_DIRECTION.IN ? categoryAccountId : stmt.bankAccountId,
      inputMethod: 'form',
      transactionSource: TRANSACTION_ENTRY_SOURCES.BANK_RECONCILIATION,
      ...(line.reference ? { transactionReference: line.reference } : {}),
      ...(body.vendorName ? { vendorName: body.vendorName } : {}),
      ...(body.customerName ? { customerName: body.customerName } : {}),
    };
    const je = await transactionService.createTransaction(txData, actor.id, ipAddress);

    line.status = BANK_LINE_STATUS.CREATED;
    line.matchedJournalEntryId = je._id;
    line.matchScore = 100;
    line.autoMatched = false;
    line.matchedAt = new Date();
    line.matchedBy = actor.id;
    await stmt.save();

    try {
      await auditService.log({
        businessId, entityType: ENTITY_TYPES.BANK_STATEMENT, entityId: stmt._id,
        action: AUDIT_ACTIONS.CREATED, performedBy: actor.id, performedByName: actor.fullName,
        afterState: { createdJournalEntry: je._id, fromLine: lineRef, amount: line.amount },
      });
    } catch (_) { /* best-effort */ }

    return this.getStatement(statementId, businessId);
  }

  async finish(statementId, businessId, actor) {
    const stmt = await bankStatementRepository.findOneByBusinessAndId(businessId, statementId);
    if (!stmt) throw new ApiError(404, 'Statement not found');
    stmt.status = BANK_STATEMENT_STATUS.COMPLETED;
    stmt.completedAt = new Date();
    await stmt.save();
    try {
      await auditService.log({
        businessId, entityType: ENTITY_TYPES.BANK_STATEMENT, entityId: stmt._id,
        action: AUDIT_ACTIONS.STATE_CHANGED, performedBy: actor.id, performedByName: actor.fullName,
        afterState: { status: 'completed' },
      });
    } catch (_) { /* best-effort */ }
    return this.getStatement(statementId, businessId);
  }

  async list(businessId, { bankAccountId } = {}) {
    return bankStatementRepository.listByBusiness(businessId, { bankAccountId });
  }

  async remove(statementId, businessId) {
    this._validateId(statementId, 'statementId');
    const stmt = await bankStatementRepository.findOneByBusinessAndId(businessId, statementId);
    if (!stmt) throw new ApiError(404, 'Statement not found');
    // Deleting a reconciliation session does NOT touch journal entries — it only
    // removes the matching metadata. The ledger is unaffected.
    await stmt.deleteOne();
    return { _id: statementId, deleted: true };
  }
}

module.exports = new BankReconciliationService();
