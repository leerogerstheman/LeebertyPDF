'use strict';
/**
 * LeebertyPDF - image-heavy UI probe.
 *
 * Opens each image-heavy sample in the real reader and measures the things a
 * user feels: time to first painted page, time to paint every page of the
 * document, backing-store memory, thumbnail throughput and editor round trips.
 * Screenshots are captured so the rendering can be judged by eye as well.
 *
 *   powershell -ExecutionPolicy Bypass -File tools\imgtest.ps1
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'artifacts', 'img');
const CORPUS = path.join(__dirname, '..', 'samples', 'images');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function run({ win, app }) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows = [];
  const errors = [];
  const shots = [];

  win.webContents.on('console-message', (event) => {
    const level = String(event.level ?? event.severity ?? '');
    if (level !== 'error' && level !== '3') return;
    const message = String(event.message ?? '');
    if (/offsetParent is not set|open failed:/.test(message)) return;
    errors.push(message);
  });

  const run = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => {
    await sleep(350);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), img.toPNG());
    shots.push(`${name}.png`);
  };

  // wait for the app module
  for (let i = 0; i < 40; i += 1) {
    const ok = await run(`typeof window.__lumenTestRun === 'function'`).catch(() => false);
    if (ok) break;
    await sleep(250);
  }
  await sleep(1000);

  const files = fs.readdirSync(CORPUS).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();

  for (const name of files) {
    const full = path.join(CORPUS, name);
    const size = fs.statSync(full).size;
    const row = { file: name, size };
    try {
      // ---- open and time the first painted page ---------------------------
      const load = await run(`(async () => {
        const app = window.__lumenTestRun((a) => a);
        for (const t of [...app.tabs]) { try { await window.__lumenTestRun((a, c) => c.closeTab(t, { force: true })); } catch (e) {} }
        await new Promise((r) => setTimeout(r, 400));
        const t0 = performance.now();
        await window.__lumenTestOpen([${JSON.stringify(full)}]);
        // wait for the tab to report loaded
        for (let i = 0; i < 120; i += 1) {
          if (app.active && app.active.loaded) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const loadedAt = performance.now();
        // wait for the first canvas to have been painted
        for (let i = 0; i < 200; i += 1) {
          const c = document.querySelector('.pdf-container:not([hidden]) .page canvas');
          if (c && c.width > 0) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        const firstPaintAt = performance.now();
        return JSON.stringify({
          pages: app.active ? app.active.pageCount : 0,
          openMs: loadedAt - t0,
          firstPaintMs: firstPaintAt - t0,
        });
      })()`).then(JSON.parse);
      row.pages = load.pages;
      row.openMs = Math.round(load.openMs);
      row.firstPaintMs = Math.round(load.firstPaintMs);

      // ---- paint every page and time it -----------------------------------
      const paintAll = await run(`(async () => {
        const app = window.__lumenTestRun((a) => a);
        const tab = app.active;
        const t0 = performance.now();
        tab.setZoom('page-fit');
        // walk the document so every page gets queued for rendering
        for (let p = 1; p <= tab.pageCount; p += 1) {
          tab.setPage(p, { center: false });
          await new Promise((r) => setTimeout(r, 120));
        }
        // then wait until the DOM holds a painted canvas per page, or the
        // render queue stops making progress
        const count = () =>
          [...document.querySelectorAll('.pdf-container:not([hidden]) .page canvas')].filter((c) => c.width > 0).length;
        let last = -1;
        let stable = 0;
        for (let i = 0; i < 900; i += 1) {
          const n = count();
          if (n >= tab.pageCount) break;
          if (n === last) {
            stable += 1;
            if (stable > 40) break; // nothing painted for ~4s
          } else {
            stable = 0;
            last = n;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        const elapsed = performance.now() - t0;
        const painted = count();

        // backing store: how much canvas memory is live right now
        let canvasPixels = 0;
        let canvasCount = 0;
        for (const c of document.querySelectorAll('.pdf-container .page canvas')) {
          canvasPixels += c.width * c.height;
          canvasCount += 1;
        }
        const mem = performance.memory
          ? { used: performance.memory.usedJSHeapSize, limit: performance.memory.jsHeapSizeLimit }
          : null;
        return JSON.stringify({
          painted,
          total: tab.pageCount,
          elapsed,
          canvasCount,
          canvasMB: (canvasPixels * 4) / 1024 / 1024,
          heapMB: mem ? mem.used / 1024 / 1024 : null,
          heapLimitMB: mem ? mem.jsHeapSizeLimit / 1024 / 1024 : null,
        });
      })()`).then(JSON.parse);
      row.painted = paintAll.painted;
      row.expectedPages = paintAll.total;
      row.paintAllMs = Math.round(paintAll.elapsed);
      row.msPerPage = Math.round(paintAll.elapsed / Math.max(1, paintAll.painted));
      row.canvasMB = Number(paintAll.canvasMB.toFixed(1));
      row.heapMB = paintAll.heapMB === null ? null : Number(paintAll.heapMB.toFixed(1));

      // ---- ink coverage: are the images actually there? -------------------
      const ink = await run(`(async () => {
        const out = [];
        const pages = [...document.querySelectorAll('.pdf-container:not([hidden]) .page')].slice(0, 4);
        for (const page of pages) {
          const c = page.querySelector('canvas');
          if (!c) continue;
          const tmp = document.createElement('canvas');
          tmp.width = 160; tmp.height = 160;
          const ctx = tmp.getContext('2d', { alpha: false });
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 160, 160);
          ctx.drawImage(c, 0, 0, 160, 160);
          const data = ctx.getImageData(0, 0, 160, 160).data;
          let varied = 0;
          let sum = 0;
          for (let i = 0; i < data.length; i += 4) {
            const v = (data[i] + data[i + 1] + data[i + 2]) / 3;
            sum += v;
            if (v < 240) varied += 1;
          }
          out.push({ ink: +(varied / (160 * 160)).toFixed(3), mean: Math.round(sum / (160 * 160)) });
        }
        return JSON.stringify(out);
      })()`).then(JSON.parse);
      row.ink = ink;

      // ---- thumbnails -----------------------------------------------------
      const thumbs = await run(`(async () => {
        const app = window.__lumenTestRun((a) => a);
        const tab = app.active;
        const t0 = performance.now();
        tab.invalidateThumbs();
        window.__lumenTestRun((a) => a.sidebar.setPane('thumbnails'));
        window.__lumenTestRun((a) => a.sidebar.renderThumbnails(tab));
        for (let i = 0; i < 400; i += 1) {
          const done = document.querySelectorAll('#thumb-list .thumb canvas').length;
          if (done >= Math.min(6, tab.pageCount)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const elapsed = performance.now() - t0;
        return JSON.stringify({
          rendered: document.querySelectorAll('#thumb-list .thumb canvas').length,
          placeholders: document.querySelectorAll('#thumb-list .thumb[data-placeholder]').length,
          firstSixMs: Math.round(elapsed),
        });
      })()`).then(JSON.parse);
      row.thumbs = thumbs;

      // ---- editor round trip ---------------------------------------------
      const edit = await run(`(async () => {
        const t0 = performance.now();
        await window.__lumenOpenOrganizer();
        await new Promise((r) => setTimeout(r, 600));
        const org = window.__lumenOrganizer;
        if (!org || !org.sessionId) return JSON.stringify({ error: 'organizer did not open' });
        // wait for the first thumbnails
        const want = Math.min(4, org.state.pages.length);
        for (let i = 0; i < 300; i += 1) {
          if (document.querySelectorAll('.organizer-thumb canvas').length >= want) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const openedAt = performance.now();
        const order = org.state.pages.map((_, i) => i);
        order.unshift(order.pop());
        await org.pushOp([{ type: 'reorder', order }]);
        await org.pushOp([{ type: 'rotate', indices: [0], delta: 90 }]);
        await org.pushOp([{ type: 'remove', indices: [1] }]);
        const editedAt = performance.now();
        const target = ${JSON.stringify(path.join(OUT_DIR, 'edited.pdf'))};
        const saved = await window.lumen.edit.save({ sessionId: org.sessionId, target });
        const savedAt = performance.now();
        const thumbs = document.querySelectorAll('.organizer-thumb canvas').length;
        await org.close(true);
        await new Promise((r) => setTimeout(r, 400));
        return JSON.stringify({
          openMs: Math.round(openedAt - t0),
          editMs: Math.round(editedAt - openedAt),
          saveMs: Math.round(savedAt - editedAt),
          pages: saved && saved.ok ? saved.pages : (saved && saved.error) || 'error',
          thumbCanvas: thumbs,
          bytes: (() => { try { return require('fs').statSync(target).size; } catch (e) { return 0; } })(),
        });
      })()`).then(JSON.parse);
      row.editor = edit;

      // ---- zoom stress: canvas pixel caps and allocation failures ---------
      const zoom = await run(`(async () => {
        const app = window.__lumenTestRun((a) => a);
        const tab = app.active;
        const out = [];
        const measure = async (label, scale) => {
          tab.viewer.currentScale = scale;
          await new Promise((r) => setTimeout(r, 700));
          for (let i = 0; i < 80; i += 1) {
            const c = document.querySelector('.pdf-container:not([hidden]) .page canvas');
            if (c && c.width > 0) break;
            await new Promise((r) => setTimeout(r, 100));
          }
          const c = document.querySelector('.pdf-container:not([hidden]) .page canvas');
          if (!c) { out.push({ label, canvas: null }); return; }
          // sample the canvas: a capped/failed render shows up as blank
          const tmp = document.createElement('canvas');
          tmp.width = 120; tmp.height = 120;
          const ctx = tmp.getContext('2d', { alpha: false });
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 120, 120);
          ctx.drawImage(c, 0, 0, 120, 120);
          const d = ctx.getImageData(0, 0, 120, 120).data;
          let ink = 0;
          for (let i = 0; i < d.length; i += 4) if ((d[i] + d[i + 1] + d[i + 2]) / 3 < 240) ink += 1;
          out.push({
            label,
            px: c.width * c.height,
            mb: +((c.width * c.height * 4) / 1024 / 1024).toFixed(1),
            cssW: Math.round(c.getBoundingClientRect().width),
            ink: +(ink / 14400).toFixed(3),
            dpr: window.devicePixelRatio,
          });
        };
        await measure('fit', tab.viewer.currentScale);
        await measure('100%', 1);
        await measure('200%', 2);
        await measure('400%', 4);
        tab.setZoom('page-fit');
        await new Promise((r) => setTimeout(r, 600));
        return JSON.stringify(out);
      })()`).then(JSON.parse);
      row.zoomStress = zoom;

      // ---- sustained scrolling: does memory stay bounded? ----------------
      const samples = [];
      const sampleMemory = async (label) => {
        try {
          const m = await run(`performance.memory ? {
            heap: Math.round(performance.memory.usedJSHeapSize / 1048576),
            canvases: [...document.querySelectorAll('.pdf-container:not([hidden]) .page canvas')]
              .reduce((a, c) => a + c.width * c.height * 4, 0) / 1048576,
            pages: document.querySelectorAll('.pdf-container:not([hidden]) .page canvas').length,
          } : null`);
          samples.push({ label, ...m });
        } catch (e) {
          samples.push({ label, error: String(e.message) });
        }
      };
      await sampleMemory('start');
      await run(`(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const app = window.__lumenTestRun((a) => a);
        const tab = app.active;
        tab.setZoom('page-fit');
        await sleep(600);
        for (let round = 0; round < 3; round += 1) {
          for (let p = 1; p <= tab.pageCount; p += 1) {
            tab.setPage(p, { center: false });
            await sleep(90);
          }
          for (let p = tab.pageCount; p >= 1; p -= 1) {
            tab.setPage(p, { center: false });
            await sleep(90);
          }
        }
        await sleep(1500);
        return true;
      })()`);
      await sampleMemory('after 6 sweeps');
      await run(`(async () => {
        const app = window.__lumenTestRun((a) => a);
        const tab = app.active;
        tab.setZoom('page-width');
        tab.setPage(Math.max(1, Math.floor(tab.pageCount / 2)));
        await new Promise((r) => setTimeout(r, 1500));
        return true;
      })()`);
      await sampleMemory('page-width centre');
      row.memSamples = samples;
      // put the view back so the screenshot shows a page
      await run(`(async () => {
        const app = window.__lumenTestRun((a) => a);
        const tab = app.active;
        tab.setZoom('page-fit');
        tab.setPage(1);
        await new Promise((r) => setTimeout(r, 1200));
        tab.viewerEl.scrollTop = 0;
        await new Promise((r) => setTimeout(r, 400));
        return true;
      })()`);
      // ---- organiser thumbnail cost, measured directly -------------------
      const thumbCost = await run(`(async () => {
        const app = window.__lumenTestRun((a) => a);
        const tab = app.active;
        const doc = tab.doc;
        const out = [];
        for (const pn of [1, Math.min(2, tab.pageCount)]) {
          const page = await doc.getPage(pn);
          const vp0 = page.getViewport({ scale: 1 });
          const targetW = Math.min(100, vp0.width);
          const s0 = targetW / vp0.width;
          for (const [label, dpr] of [['dpr1', 1], ['dpr1.25', 1.25]]) {
            const vp = page.getViewport({ scale: s0 * dpr });
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.floor(vp.width));
            canvas.height = Math.max(1, Math.floor(vp.height));
            const ctx = canvas.getContext('2d', { alpha: false });
            const t = performance.now();
            await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
            out.push({ pn, label, px: canvas.width * canvas.height, ms: Math.round(performance.now() - t) });
          }
        }
        return JSON.stringify(out);
      })()`).then(JSON.parse);
      row.thumbCost = thumbCost;

      // ---- search across an image-only document --------------------------
      const search = await run(`(async () => {
        const app = window.__lumenTestRun((a) => a);
        const tab = app.active;
        const t0 = performance.now();
        tab.search('xyzzy', { type: 'find' });
        await new Promise((r) => setTimeout(r, 2500));
        const elapsed = performance.now() - t0;
        const counter = document.querySelector('#find-counter').textContent;
        window.__lumenTestRun((a, c) => c.bus.emit('ui:close-find'));
        return JSON.stringify({ ms: Math.round(elapsed), counter });
      })()`).then(JSON.parse);
      row.search = search;

      await shot(`img-${name.replace(/\.pdf$/, '')}`);
      rows.push(row);
      console.log(
        `${name.padEnd(24)} ${String(row.pages).padStart(3)}p  open ${String(row.openMs).padStart(5)}ms` +
          `  first ${String(row.firstPaintMs).padStart(5)}ms  all ${String(row.paintAllMs).padStart(6)}ms` +
          `  (${String(row.msPerPage).padStart(4)}ms/p)  canvas ${String(row.canvasMB).padStart(6)}MB` +
          `  heap ${row.heapMB === null ? 'n/a' : String(row.heapMB).padStart(6) + 'MB'}` +
          `  thumbs ${String(row.thumbs.firstSixMs).padStart(5)}ms` +
          `  edit+sale ${row.editor.openMs}+${row.editor.editMs}+${row.editor.saveMs}ms` +
          `  ink ${row.ink.map((i) => i.ink).join('/')}` +
          `  mem ${(row.memSamples || []).map((m) => `${m.canvases ? Math.round(m.canvases) : '?'}MB/${m.pages || 0}c`).join('→')}`,
      );
    } catch (err) {
      row.error = String((err && err.message) || err);
      rows.push(row);
      console.log(`${name.padEnd(24)} ERROR ${row.error}`);
    }
  }

  fs.writeFileSync(
    path.join(OUT_DIR, 'report.json'),
    JSON.stringify({ when: new Date().toISOString(), rows, errors, shots }, null, 2),
    'utf8',
  );
  console.log('');
  console.log(`${rows.length} files measured, ${errors.length} console errors`);
  for (const e of errors.slice(0, 10)) console.log('  ERR ' + e);
  console.log(`report → ${path.join(OUT_DIR, 'report.json')}`);
  setTimeout(() => {
    app.exit(errors.length ? 1 : 0);
    process.exit(errors.length ? 1 : 0);
  }, 400);
};
