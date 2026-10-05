'use strict';
/**
 * LeebertyPDF — page editor test rig (plain Node, no Electron).
 *
 *   node tools/pdfeng-test.js
 *
 * Exercises the object-level PDF engine against the sample corpus and prints a
 * pass/fail table. Every produced file is written to artifacts/pdfeng/ so it can
 * also be eyeballed in the reader.
 */
const fs = require('fs');
const path = require('path');
const { PdfDocument } = require('../src/main/pdf/document');
const { PageEditor } = require('../src/main/pdf/editor');

const ROOT = path.join(__dirname, '..');
const SAMPLES = path.join(ROOT, 'samples');
const OUT = path.join(ROOT, 'artifacts', 'pdfeng');
fs.mkdirSync(OUT, { recursive: true });

const results = [];

/** Registers a test; async functions are awaited before the next one runs. */
async function check(name, fn) {
  try {
    const info = await fn();
    results.push({ name, ok: true, info: info || '' });
  } catch (err) {
    results.push({ name, ok: false, info: `${err.message}` });
  }
}

const files = [
  path.join(SAMPLES, 'sample-small.pdf'),
  path.join(SAMPLES, 'sample-large.pdf'),
  path.join(SAMPLES, 'sample-landscape.pdf'),
  path.join(SAMPLES, 'sample-tiny.pdf'),
  path.join(SAMPLES, 'real', 'dummy.pdf'),
  path.join(SAMPLES, 'real', 'compressed.tracemonkey-pldi-09.pdf'),
  path.join(SAMPLES, 'real', 'real-1706.03762v7.pdf'),
].filter((f) => fs.existsSync(f));

function reopen(file) {
  const doc = new PdfDocument(fs.readFileSync(file), file);
  return {
    doc,
    pages: doc.pageCount,
    labels: doc.getPageLabels().slice(0, 6),
    outline: (() => {
      try {
        const cat = doc.catalog;
        const ol = doc.resolve(cat && cat.get('Outlines'));
        if (!ol || typeof ol.get !== 'function') return 0;
        let n = 0;
        const walk = (ref, depth) => {
          if (depth > 8) return;
          let cur = ref;
          let guard = 0;
          while (cur && guard < 500) {
            guard += 1;
            const d = doc.resolve(cur);
            if (!d || typeof d.get !== 'function') break;
            n += 1;
            const first = d.get('First');
            if (first) walk(first, depth + 1);
            cur = d.get('Next');
          }
        };
        walk(ol.get('First'), 0);
        return n;
      } catch {
        return -1;
      }
    })(),
  };
}

async function main() {
/* ---------------------------------------------------------------- parsing */
for (const f of files) {
  const name = path.relative(ROOT, f);
  await check(`parse ${name}`, async () => {
    const info = reopen(f);
    return `${info.pages} pages, labels=${JSON.stringify(info.labels)}, outline=${info.outline}`;
  });
}

/* -------------------------------------------------------------- operators */
const small = path.join(SAMPLES, 'sample-small.pdf');
const large = path.join(SAMPLES, 'sample-large.pdf');
const landscape = path.join(SAMPLES, 'sample-landscape.pdf');

await check('extract 1-4 of sample-small', async () => {
  const ed = new PageEditor();
  await ed.addFile(small, { pages: [{ from: 0, to: 3 }] });
  const out = path.join(OUT, 'extract-1-4.pdf');
  const res = await await ed.save(out);
  const back = reopen(out);
  if (back.pages !== 4) throw new Error(`expected 4 pages, got ${back.pages}`);
  return `${res.buffer.length} bytes, ${back.pages} pages, outline=${back.outline}`;
});

await check('delete pages 2,3,5 of sample-small', async () => {
  const ed = new PageEditor();
  await ed.addFile(small);
  ed.removePages([1, 2, 4]);
  const out = path.join(OUT, 'deleted.pdf');
  await ed.save(out);
  const back = reopen(out);
  if (back.pages !== 9) throw new Error(`expected 9 pages, got ${back.pages}`);
  return `${back.pages} pages`;
});

await check('rotate page 1 by 90 and 6 by -90', async () => {
  const ed = new PageEditor();
  await ed.addFile(small);
  ed.rotatePages([0], 90);
  ed.rotatePages([5], 270);
  const out = path.join(OUT, 'rotated.pdf');
  await ed.save(out);
  const back = reopen(out);
  const dict = back.doc.getPages()[0].dict;
  const rot = Number(back.doc.resolve(dict.get('Rotate')));
  if (rot !== 90) throw new Error(`page 1 rotation is ${rot}`);
  const rot6 = back.doc.getPages()[5].rotate;
  if (rot6 !== 270) throw new Error(`page 6 rotation is ${rot6}`);
  return `page1=${rot} page6=${rot6}`;
});

await check('reverse page order', async () => {
  const ed = new PageEditor();
  await ed.addFile(small);
  ed.reverse();
  const out = path.join(OUT, 'reversed.pdf');
  await ed.save(out);
  const back = reopen(out);
  if (back.pages !== 12) throw new Error(`expected 12 pages, got ${back.pages}`);
  return `${back.pages} pages`;
});

await check('merge small + landscape + large(1-3)', async () => {
  const ed = new PageEditor();
  await ed.addFile(small);
  await ed.addFile(landscape);
  await ed.addFile(large, { pages: [{ from: 0, to: 2 }] });
  const out = path.join(OUT, 'merged.pdf');
  const res = await await ed.save(out);
  const back = reopen(out);
  if (back.pages !== 12 + 8 + 3) throw new Error(`expected 23 pages, got ${back.pages}`);
  return `${res.buffer.length} bytes, ${back.pages} pages`;
});

await check('insert landscape page 1 after small page 2', async () => {
  const ed = new PageEditor();
  await ed.addFile(small);
  await ed.addFile(landscape, { pages: [{ from: 0, to: 0 }], at: 2 });
  const out = path.join(OUT, 'inserted.pdf');
  await ed.save(out);
  const back = reopen(out);
  if (back.pages !== 13) throw new Error(`expected 13 pages, got ${back.pages}`);
  return `${back.pages} pages`;
});

await check('move page 1 to the end', async () => {
  const ed = new PageEditor();
  await ed.addFile(small);
  ed.movePage(0, 11);
  const out = path.join(OUT, 'moved.pdf');
  await ed.save(out);
  const back = reopen(out);
  const mediaBoxOf = (i) => {
    const p = back.doc.getPages()[i];
    const box = back.doc.resolve(p.dict.get('MediaBox')) || p.mediaBox;
    return box && box.__array ? box.__array.map(Number).join(',') : 'n/a';
  };
  return `${back.pages} pages, first box ${mediaBoxOf(0)}`;
});

await check('split sample-small every 5 pages', async () => {
  const ed = new PageEditor();
  await ed.addFile(small);
  const chunks = ed.splitEvery(5);
  const sizes = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const out = path.join(OUT, `split-${i + 1}.pdf`);
    await chunks[i].save(out);
    sizes.push(reopen(out).pages);
  }
  const expected = [5, 5, 2].join(',');
  if (sizes.join(',') !== expected) throw new Error(`got ${sizes.join(',')}`);
  return `chunks: ${sizes.join(' + ')}`;
});

await check('duplicate page 1 three times', async () => {
  const ed = new PageEditor();
  await ed.addFile(small, { pages: [{ from: 0, to: 0 }] });
  ed.duplicatePage(0);
  ed.duplicatePage(0);
  const out = path.join(OUT, 'duplicated.pdf');
  await ed.save(out);
  const back = reopen(out);
  if (back.pages !== 3) throw new Error(`expected 3 pages, got ${back.pages}`);
  return `${back.pages} pages`;
});

await check('240-page document: delete 60, keep outline sane', async () => {
  const ed = new PageEditor();
  await ed.addFile(large);
  const drop = [];
  for (let i = 0; i < 240; i += 4) drop.push(i);
  ed.removePages(drop);
  const out = path.join(OUT, 'large-trimmed.pdf');
  const res = await await ed.save(out);
  const back = reopen(out);
  if (back.pages !== 180) throw new Error(`expected 180 pages, got ${back.pages}`);
  return `${res.buffer.length} bytes, ${back.pages} pages, outline items=${back.outline}`;
});

await check('real paper: extract 5 pages (object streams)', async () => {
  const src = path.join(SAMPLES, 'real', 'real-1706.03762v7.pdf');
  if (!fs.existsSync(src)) return 'skipped';
  const ed = new PageEditor();
  await ed.addFile(src, { pages: [{ from: 0, to: 4 }] });
  const out = path.join(OUT, 'attention-1-5.pdf');
  const res = await await ed.save(out);
  const back = reopen(out);
  if (back.pages !== 5) throw new Error(`expected 5 pages, got ${back.pages}`);
  return `${res.buffer.length} bytes, ${back.pages} pages, outline=${back.outline}`;
});

await check('real paper: full copy round trip (15 pages)', async () => {
  const src = path.join(SAMPLES, 'real', 'real-1706.03762v7.pdf');
  const ed = new PageEditor();
  await ed.addFile(src);
  const out = path.join(OUT, 'attention-full.pdf');
  const res = await await ed.save(out);
  const back = reopen(out);
  if (back.pages !== 15) throw new Error(`expected 15 pages, got ${back.pages}`);
  return `${res.buffer.length} bytes, ${back.pages} pages`;
});

await check('tracemonkey: rotate all + reorder odd/even', async () => {
  const src = path.join(SAMPLES, 'real', 'compressed.tracemonkey-pldi-09.pdf');
  const ed = new PageEditor();
  await ed.addFile(src);
  const n = ed.pages.length;
  const order = [];
  for (let i = 0; i < n; i += 2) order.push(i);
  for (let i = 1; i < n; i += 2) order.push(i);
  ed.reorder(order);
  const out = path.join(OUT, 'tracemonkey-reordered.pdf');
  const res = await await ed.save(out);
  const back = reopen(out);
  if (back.pages !== n) throw new Error(`expected ${n} pages, got ${back.pages}`);
  return `${res.buffer.length} bytes, ${back.pages} pages`;
});

/* ------------------------------------------------------------------ report */
let failed = 0;
const width = Math.max(...results.map((r) => r.name.length));
console.log('');
for (const r of results) {
  const mark = r.ok ? '\u2713' : '\u2717';
  if (!r.ok) failed += 1;
  console.log(`${mark} ${r.name.padEnd(width)}  ${r.info}`);
}
console.log('');
console.log(`${results.length - failed}/${results.length} passed`);
console.log(`output: ${OUT}`);
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2), 'utf8');
return failed;
}

module.exports = { main };

if (require.main === module) {
  main().then((failed) => process.exit(failed ? 1 : 0));
}
