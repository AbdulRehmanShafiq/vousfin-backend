// utils/emailIntake.helper.js — pure transform of a forwarded email into a
// bookkeeper.ingest payload (Intelligence Roadmap Phase 5 follow-on).
//
// An email-forwarding webhook delivers { subject, text, from, attachments[] }.
// We fold subject + body into the ingest text and, if a bill/receipt image or
// PDF is attached, carry the first one through as the document image. Deterministic
// and DB-free so it can be exhaustively unit-tested.
'use strict';

const IMAGE_DOC_TYPES = /^(image\/|application\/pdf)/i;

function stripDataUri(content) {
  const m = String(content || '').match(/^data:[^;]+;base64,(.*)$/s);
  return m ? m[1] : String(content || '');
}

/**
 * @param {{subject?:string, text?:string, from?:string, attachments?:Array<{filename?:string, contentType?:string, content?:string}>}} email
 * @returns {{rawText:string, image:string|null, mimeType:string|null, source:'email'}|null}
 */
function buildIngestFromEmail(email) {
  if (!email) return null;
  const subject = String(email.subject || '').trim();
  const body = String(email.text || '').trim();
  const from = String(email.from || '').trim();

  const doc = (email.attachments || []).find(
    (a) => a && IMAGE_DOC_TYPES.test(a.contentType || '') && a.content,
  );

  const rawText = [subject, body, from ? `From: ${from}` : ''].filter(Boolean).join('\n').trim();

  // Need SOMETHING to read — meaningful text or a document image.
  if (rawText.length < 3 && !doc) return null;

  return {
    rawText: rawText || '(forwarded bill/receipt)',
    image: doc ? stripDataUri(doc.content) : null,
    mimeType: doc ? (doc.contentType || 'image/jpeg') : null,
    source: 'email',
  };
}

module.exports = { buildIngestFromEmail };
