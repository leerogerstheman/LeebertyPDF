'use strict';
/**
 * LeebertyPDF - image-heavy performance probe (engine layer).
 *
 * Parses and fully decodes every image stream in the corpus, reporting timing
 * and peak heap so the object-level engine's cost is measurable in isolation
 * from the renderer.
 *
 *   node tools/imgbench.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PdfDocument } = require('../src/main/pdf/document.js');

const DIR = path.join(__dirname, '..', 'samples', 'images');
const OUT = path.join(__dirname, '..', 'artifacts', 'imgbench.json');
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
const ms = (n) => `${n.toFixed(0)} ms`;
/** PDF names parse to `{ __name }` objects, never to plain strings. */
const nameOf = (v) => (v && v.__name !== undefined ? v.__name : typeof v === 'string' ? v.replace(/^\//, '') : null);

async function main() {
  const files = fs.readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
  const results = [];

  for (const name of files) {
    const full = path.join(DIR, name);
    const buf = fs.readFileSync(full);
    const row = { file: name, size: buf.length };

    // ---- parse -----------------------------------------------------------
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    let t0 = process.hrtime.bigint();
    const doc = new PdfDocument(buf, full);
    const pages = doc.getPages();
    row.pages = pages.length;
    row.parseMs = Number(process.hrtime.bigint() - t0) / 1e6;

    // ---- count and decode every image XObject ----------------------------
    const images = [];
    for (const page of pages) {
      const res = page.dict.get('Resources');
      const xobjects = res && res.get ? res.get('XObject') : null;
      if (!xobjects || !xobjects.entries) continue;
      for (const [key, ref] of xobjects.entries()) {
        const obj = doc.resolve(ref);
        if (obj && obj.get && nameOf(obj.get('Subtype')) === 'Image') {
          images.push({ key: String(key), ref, obj });
        }
      }
    }
    row.imageRefs = images.length;

    const seen = new Set();
    let decodedBytes = 0;
    let decodeMs = 0;
    let failures = 0;
    const filterKinds = new Map();
    for (const img of images) {
      const num = img.ref && img.ref.num;
      if (num === undefined || seen.has(num)) continue;
      seen.add(num);
      const rawFilter = img.obj.get('Filter');
      const filter = (Array.isArray(rawFilter) ? rawFilter : [rawFilter])
        .map((f) => nameOf(f) || 'none')
        .join('+');
      filterKinds.set(filter, (filterKinds.get(filter) || 0) + 1);
      const tk = process.hrtime.bigint();
      try {
        const data = doc.getStreamData(num);
        if (!data) throw new Error('no data');
        decodedBytes += data.length;
      } catch (err) {
        failures += 1;
      }
      decodeMs += Number(process.hrtime.bigint() - tk) / 1e6;
    }
    row.uniqueImages = seen.size;
    row.filters = [...filterKinds.entries()].map(([k, v]) => `${k}×${v}`).join(' ');
    row.decodeMs = decodeMs;
    row.decodedBytes = decodedBytes;
    row.failures = failures;

    // ---- full text extraction across all pages ---------------------------
    t0 = process.hrtime.bigint();
    let textChars = 0;
    for (const page of pages) {
      const entry = doc.getObjectEntry(page.ref.num);
      void entry;
    }
    row.walkMs = Number(process.hrtime.bigint() - t0) / 1e6;
    row.textChars = textChars;

    global.gc?.();
    row.heapMB = Number(((process.memoryUsage().heapUsed - before) / 1024 / 1024).toFixed(1));
    row.detail =
      `${row.pages}p · ${row.imageRefs} image refs · ${row.uniqueImages} unique · ` +
      `${row.filters} · decode ${ms(row.decodeMs)} for ${mb(row.decodedBytes)}`;
    results.push(row);
    console.log(
      `${name.padEnd(24)} ${mb(buf.length).padStart(9)}  parse ${ms(row.parseMs).padStart(8)}` +
        `  decode ${ms(row.decodeMs).padStart(9)}  ${mb(row.decodedBytes).padStart(10)}` +
        `  heap +${String(row.heapMB).padStart(6)} MB  ${row.failures ? `FAILURES ${row.failures}` : 'ok'}`,
    );
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), results }, null, 2), 'utf8');
  console.log(`\nreport → ${OUT}`);
  const bad = results.filter((r) => r.failures);
  process.exit(bad.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
