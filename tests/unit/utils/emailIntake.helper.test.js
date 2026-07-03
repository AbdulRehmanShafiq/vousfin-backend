'use strict';
const { buildIngestFromEmail } = require('../../../utils/emailIntake.helper');

describe('buildIngestFromEmail', () => {
  it('combines subject + body into ingest text and tags the source as email', () => {
    const r = buildIngestFromEmail({ subject: 'Invoice from AWS', text: 'Amount due: Rs 12,000 for cloud hosting', from: 'billing@aws.com' });
    expect(r.rawText).toContain('Invoice from AWS');
    expect(r.rawText).toContain('12,000');
    expect(r.source).toBe('email');
    expect(r.image).toBeNull();
  });

  it('picks the first image/pdf attachment as the document image', () => {
    const r = buildIngestFromEmail({
      subject: 'Receipt', text: 'see attached',
      attachments: [
        { filename: 'note.txt', contentType: 'text/plain', content: 'aaa' },
        { filename: 'receipt.jpg', contentType: 'image/jpeg', content: 'BASE64DATA' },
      ],
    });
    expect(r.image).toBe('BASE64DATA');
    expect(r.mimeType).toBe('image/jpeg');
  });

  it('strips a data: URI prefix from attachment content', () => {
    const r = buildIngestFromEmail({
      subject: 'R', text: 'x',
      attachments: [{ filename: 'r.png', contentType: 'image/png', content: 'data:image/png;base64,ZZZ' }],
    });
    expect(r.image).toBe('ZZZ');
    expect(r.mimeType).toBe('image/png');
  });

  it('returns null (invalid) when there is neither meaningful text nor an attachment', () => {
    expect(buildIngestFromEmail({ subject: '', text: '' })).toBeNull();
    expect(buildIngestFromEmail(null)).toBeNull();
  });

  it('accepts an image-only email even with empty body', () => {
    const r = buildIngestFromEmail({ subject: '', text: '', attachments: [{ filename: 'b.jpg', contentType: 'image/jpeg', content: 'IMG' }] });
    expect(r).not.toBeNull();
    expect(r.image).toBe('IMG');
  });
});
