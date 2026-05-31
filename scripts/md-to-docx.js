// scripts/md-to-docx.js — lightweight Markdown → Word(.docx) converter (docx-js).
// Handles: title (% lines), #/##/### headings, paragraphs, **bold**, - bullets,
// and | pipe | tables. Usage: node scripts/md-to-docx.js in.md out.docx
'use strict';
const fs = require('fs');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, BorderStyle, AlignmentType, ShadingType,
} = require('docx');

const [, , inPath, outPath] = process.argv;
const md = fs.readFileSync(inPath, 'utf8').split(/\r?\n/);

// Inline **bold** → runs
function runs(text) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((p) => p.startsWith('**') && p.endsWith('**')
    ? new TextRun({ text: p.slice(2, -2), bold: true, font: 'Arial', size: 22 })
    : new TextRun({ text: p, font: 'Arial', size: 22 }));
}

const border = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
const borders = { top: border, bottom: border, left: border, right: border };

function tableFrom(rows) {
  const cells = rows.map((r) => r.split('|').slice(1, -1).map((c) => c.trim()));
  const cols = cells[0].length;
  const width = Math.floor(9360 / cols);
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: Array(cols).fill(width),
    rows: cells.map((row, ri) => new TableRow({
      children: row.map((c) => new TableCell({
        borders,
        width: { size: width, type: WidthType.DXA },
        shading: ri === 0 ? { fill: 'D5E8F0', type: ShadingType.CLEAR, color: 'auto' } : undefined,
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        children: [new Paragraph({ children: runs(c) })],
      })),
    })),
  });
}

const children = [];
let title = 'Document';
let i = 0;
while (i < md.length) {
  let line = md[i];
  if (line.startsWith('% ')) { if (title === 'Document') title = line.slice(2).trim(); i++; continue; }
  if (line.trim() === '' || line.trim() === '---') { i++; continue; }

  // table block
  if (line.trim().startsWith('|')) {
    const block = [];
    while (i < md.length && md[i].trim().startsWith('|')) { block.push(md[i]); i++; }
    const body = block.filter((r) => !/^\|[\s:|-]+\|$/.test(r.trim()));
    children.push(tableFrom(body));
    children.push(new Paragraph({ text: '' }));
    continue;
  }
  if (line.startsWith('### ')) children.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: runs(line.slice(4)) }));
  else if (line.startsWith('## ')) children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: runs(line.slice(3)) }));
  else if (line.startsWith('# ')) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: runs(line.slice(2)) }));
  else if (line.startsWith('- ')) children.push(new Paragraph({ bullet: { level: 0 }, children: runs(line.slice(2)) }));
  else if (/^\d+\.\s/.test(line)) children.push(new Paragraph({ numbering: undefined, children: runs(line) }));
  else children.push(new Paragraph({ children: runs(line) }));
  i++;
}

const doc = new Document({
  styles: {
    default: { document: { run: { font: 'Arial', size: 22 } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 30, bold: true, font: 'Arial', color: '1F3864' }, paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 26, bold: true, font: 'Arial', color: '2E5496' }, paragraph: { spacing: { before: 180, after: 80 }, outlineLevel: 1 } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 23, bold: true, font: 'Arial', color: '2E5496' }, paragraph: { spacing: { before: 120, after: 60 }, outlineLevel: 2 } },
    ],
  },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
    children: [
      new Paragraph({ children: [new TextRun({ text: title, bold: true, font: 'Arial', size: 40, color: '1F3864' })], spacing: { after: 240 }, alignment: AlignmentType.LEFT }),
      ...children,
    ],
  }],
});

Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(outPath, buf); console.log('wrote', outPath, buf.length, 'bytes'); });
