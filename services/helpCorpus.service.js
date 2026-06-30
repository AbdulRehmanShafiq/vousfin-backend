'use strict';

/**
 * helpCorpus.service.js — generate, store and index the "how-to" help corpus.
 *
 * Seed docs are generated from the app catalog (data/app-catalog.json) so every
 * page/action has baseline guidance; the markdown files under content/help/ are
 * human-editable and are the source of truth once edited. They index into the
 * GLOBAL vector scope (dataType 'app_help') alongside the catalog, so the how-to
 * answerer retrieves them without any tenant data ever being involved.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { GLOBAL_CATALOG_BUSINESS_ID } = require('../config/constants');
const embeddingService = require('./embeddingService');
const vectorStore = require('./vectorStore.service');
const logger = require('../config/logger');

const HELP_DATA_TYPE = 'app_help';
const HELP_PERIOD = 'static';
const HELP_DIR = path.join(__dirname, '..', 'content', 'help');
const CATALOG_MANIFEST = path.join(__dirname, '..', 'data', 'app-catalog.json');

function helpTitle(entry) {
  if (entry.type === 'action') {
    const t = String(entry.title || '').toLowerCase();
    if (t.startsWith('new ')) return `How to create a ${t}`;
    return `How to ${t}`;
  }
  return `How to use ${entry.title}`;
}

function helpBody(entry) {
  const lead = (entry.desc && entry.desc.trim()) ? entry.desc.trim().replace(/\.$/, '') : entry.title;
  const crumb = (entry.path || []).join(' → ');
  return `${lead}.\n\nTo get there: open ${crumb}.`;
}

/** Build structured help docs from catalog entries (excludes top-level modules). */
function buildHelpDocs(entries) {
  return entries
    .filter((e) => e.type === 'page' || e.type === 'action')
    .map((e) => ({
      id: `help.${e.id}`,
      title: helpTitle(e),
      href: e.href,
      module: e.moduleKey,
      type: e.type,
      body: helpBody(e),
    }));
}

function serializeHelpDoc(doc) {
  return [
    '---',
    `id: ${doc.id}`,
    `title: ${doc.title}`,
    `href: ${doc.href}`,
    `module: ${doc.module}`,
    `type: ${doc.type}`,
    '---',
    doc.body,
    '',
  ].join('\n');
}

function parseHelpDoc(md) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(md);
  if (!m) return { body: md.trim() };
  const front = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) front[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { ...front, body: m[2].trim() };
}

function loadCatalogEntries() {
  const raw = JSON.parse(fs.readFileSync(CATALOG_MANIFEST, 'utf8'));
  return Array.isArray(raw.entries) ? raw.entries : [];
}

/** Write the seed corpus to disk. Existing files are overwritten (regen is idempotent). */
function generateHelpFiles({ entries, dir = HELP_DIR } = {}) {
  const docs = buildHelpDocs(entries || loadCatalogEntries());
  fs.mkdirSync(dir, { recursive: true });
  for (const doc of docs) {
    fs.writeFileSync(path.join(dir, `${doc.id}.md`), serializeHelpDoc(doc));
  }
  return { written: docs.length, dir };
}

function loadHelpDocs(dir = HELP_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => parseHelpDoc(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter((d) => d.id);
}

function buildHelpVectorDocs(docs) {
  return docs.map((d) => {
    const summary = `${d.title}\n${d.body}`;
    return {
      businessId: GLOBAL_CATALOG_BUSINESS_ID,
      scope: 'global',
      dataType: HELP_DATA_TYPE,
      recordId: d.id,
      period: HELP_PERIOD,
      summary,
      summaryHash: crypto.createHash('sha256').update(summary).digest('hex'),
      metadata: { title: d.title, href: d.href, module: d.module, type: d.type },
    };
  });
}

/** Embed + upsert help docs into the global scope. Inject {docs} for tests. */
async function reindexHelp({ docs } = {}) {
  const list = docs || loadHelpDocs();
  const vdocs = buildHelpVectorDocs(list);
  const embeddings = await embeddingService.embedDocuments(vdocs.map((d) => d.summary));

  const stats = { total: vdocs.length, indexed: 0, skipped: 0 };
  for (let i = 0; i < vdocs.length; i += 1) {
    const res = await vectorStore.upsertEmbedding({ ...vdocs[i], embedding: embeddings[i] });
    if (res.skipped) stats.skipped += 1; else stats.indexed += 1;
  }
  logger.info(`[helpCorpus] reindex complete: ${JSON.stringify(stats)}`);
  return stats;
}

module.exports = {
  helpTitle,
  helpBody,
  buildHelpDocs,
  serializeHelpDoc,
  parseHelpDoc,
  generateHelpFiles,
  loadHelpDocs,
  loadCatalogEntries,
  buildHelpVectorDocs,
  reindexHelp,
  HELP_DATA_TYPE,
  HELP_DIR,
};
