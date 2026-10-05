'use strict';
/**
 * LeebertyPDF — test corpus generator.
 *
 * Renders HTML to PDF with Chromium (the same engine that prints documents in
 * the reader). Large documents are split into batches so a single offscreen
 * renderer never has to hold the whole thing in memory.
 *
 * Run through the launcher:  tools\run.ps1 -Samples
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const OUT = path.join(__dirname, '..', 'samples');
fs.mkdirSync(OUT, { recursive: true });

const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.';

const STYLE = `
  @page { size: A4; margin: 0; }
  body { font-family: "Microsoft YaHei", "Segoe UI", sans-serif; margin: 0; color: #1b1f24; }
  .page { padding: 40px 52px; page-break-after: always; }
  h1 { font-size: 19px; color: #16325c; border-bottom: 2px solid #dbe4f0; padding-bottom: 8px; margin: 0 0 12px; }
  p { font-size: 12.5px; line-height: 1.85; margin: 8px 0; }
  .box { background: #fff7d6; border-left: 4px solid #f0b400; padding: 10px 14px; font-size: 12.5px; margin: 14px 0; }
  ul { font-size: 12.5px; line-height: 1.9; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin: 12px 0; }
  .cell { height: 40px; background: #f1f3f6; border: 1px solid #dfe3e9; font-size: 10px; padding: 4px; }
  table { width: 100%; font-size: 11px; border-collapse: collapse; margin-top: 10px; }
  td { border: 1px solid #dde3ea; padding: 4px 6px; }
  .cols { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
  .col { background: #f7f9fc; border: 1px solid #e2e8f0; padding: 10px; font-size: 11px; line-height: 1.7; }
`;

function pageBody(n, variant) {
  if (variant === 'landscape') {
    return `<section class="page"><h1>横向页面 ${n} — Landscape ${n}</h1>
      <div class="cols"><div class="col">${LOREM}</div><div class="col">${LOREM}</div><div class="col">${LOREM}</div></div>
      <p>${LOREM} ${LOREM}</p>
      <div class="box">关键词 ${n}：旋转 rotate · 双页 spread · 高亮 highlight</div></section>`;
  }
  return `<section class="page">
    <h1>第 ${n} 章 · The Quick Brown Fox</h1>
    <p>${LOREM}</p>
    <p>${LOREM}</p>
    <div class="box"><strong>关键术语 ${n}</strong> — LeebertyPDF 高亮测试段落。Highlight me, underline me, draw on me.</div>
    <p>${LOREM} ${LOREM}</p>
    <ul><li>Page ${n} item alpha</li><li>Page ${n} item beta</li><li>Page ${n} item gamma</li></ul>
    <div class="grid">${Array.from({ length: 8 }, (_, k) => `<div class="cell">cell ${n}.${k + 1}</div>`).join('')}</div>
    <table>${Array.from({ length: 5 }, (_, r) => `<tr><td>row ${r} a</td><td>row ${r} b</td><td>${LOREM.slice(0, 48)}</td></tr>`).join('')}</table>
  </section>`;
}

const DOCS = [
  { name: 'sample-small.pdf', pages: 12, variant: 'text' },
  { name: 'sample-large.pdf', pages: 60, variant: 'text', batch: 12 },
  { name: 'sample-landscape.pdf', pages: 8, variant: 'landscape', landscape: true },
];

function htmlFor(doc, from, to) {
  const pages = [];
  if (from === 1) {
    pages.push(`<section class="page"><h1>目录 Contents · ${doc.name}</h1>
      ${Array.from({ length: Math.min(14, doc.pages) }, (_, i) => `<p>第 ${i + 2} 页 · Section ${i + 1} — ${LOREM.slice(0, 54)}</p>`).join('')}
      </section>`);
  }
  for (let n = from; n <= to; n += 1) pages.push(pageBody(n, doc.variant));
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>${STYLE}</style></head><body>${pages.join('')}</body></html>`;
}

async function renderBatch(BrowserWindow, doc, from, to) {
  const html = htmlFor(doc, from, to);
  const url = `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`;
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true } });
  try {
    await win.loadURL(url);
    await new Promise((r) => setTimeout(r, 400));
    return await win.webContents.printToPDF({
      pageSize: 'A4',
      landscape: !!doc.landscape,
      printBackground: true,
      margins: { marginType: 'none' },
      preferCSSPageSize: true,
    });
  } finally {
    win.destroy();
    await new Promise((r) => setTimeout(r, 150));
  }
}

module.exports = function run({ app, BrowserWindow }) {
  app.whenReady().then(async () => {
    for (const doc of DOCS) {
      const batch = doc.batch || doc.pages;
      const parts = [];
      for (let from = 1; from <= doc.pages; from += batch) {
        const to = Math.min(doc.pages, from + batch - 1);
        parts.push(await renderBatch(BrowserWindow, doc, from, to));
      }
      const buf = parts.length === 1 ? parts[0] : Buffer.concat(parts);
      fs.writeFileSync(path.join(OUT, doc.name), buf);
      console.log(
        `${doc.name}: ${buf.length} bytes (${doc.pages} pages${parts.length > 1 ? `, ${parts.length} batches` : ''})`,
      );
    }
    app.quit();
    process.exit(0);
  });
};
