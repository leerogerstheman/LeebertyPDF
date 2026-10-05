'use strict';
/**
 * Memory baseline / regression probe.
 *
 *   LUMEN_MEMPROBE=1  (hooked from src/main/main.js)
 *
 * Loads a set of documents, scrolls them, opens the reflow view, creates and
 * erases annotations, then reports where the memory actually goes: JS heap,
 * canvas backing store, live DOM nodes and detached nodes. Every number is
 * reported per phase so a regression is obvious.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'artifacts', 'mem');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function run({ win, app }) {
  fs.mkdirSync(OUT, { recursive: true });
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const phases = [];

  for (let i = 0; i < 60; i += 1) {
    const ready = await run("typeof window.__lumenTestRun === 'function'").catch(() => false);
    if (ready) break;
    await sleep(200);
  }

  /** Everything that costs memory on the renderer side. */
  const snapshot = () =>
    run(`JSON.stringify((() => {
      const m = performance.memory || {};
      let canvasPixels = 0;
      let canvasCount = 0;
      for (const c of document.querySelectorAll('canvas')) {
        canvasPixels += (c.width || 0) * (c.height || 0);
        canvasCount += 1;
      }
      const app = window.__lumenTestRun((a) => a);
      let storageEntries = 0;
      let thumbCache = 0;
      for (const t of app.tabs) {
        try {
          const s = t.doc && t.doc.annotationStorage && t.doc.annotationStorage.serializable;
          if (s && s.map) storageEntries += s.map.size;
        } catch (e) { /* ignore */ }
        thumbCache += (t._thumbCache && t._thumbCache.size) || 0;
      }
      return {
        heapMB: m.usedJSHeapSize ? +(m.usedJSHeapSize / 1048576).toFixed(1) : null,
        limitMB: m.jsHeapSizeLimit ? +(m.jsHeapSizeLimit / 1048576).toFixed(1) : null,
        canvasMB: +(canvasPixels * 4 / 1048576).toFixed(1),
        canvasCount,
        domNodes: document.getElementsByTagName('*').length,
        reflowArticles: document.querySelectorAll('.reflow-page').length,
        reflowFigures: document.querySelectorAll('.reflow-figure-canvas').length,
        reflowMounted: document.querySelectorAll('.reflow-figure-canvas[data-mounted="1"]').length,
        tabs: app.tabs.length,
        pageViews: document.querySelectorAll('.pdf-container .page').length,
        renderedPages: document.querySelectorAll('.pdf-container .page canvas').length,
        storageEntries,
        thumbCacheNodes: thumbCache,
        eraserLayers: document.querySelectorAll('.eraser-layer').length,
        reflowPanes: document.querySelectorAll('.reflow-pane').length,
      };
    })())`).then(JSON.parse);

  const record = async (label) => {
    // let the engine settle so the heap number is comparable between phases
    await run('new Promise((r) => setTimeout(r, 50))');
    const snap = await snapshot();
    // app.getAppMetrics() is the supported way to see process memory
    let privateMB = null;
    try {
      const metrics = app.getAppMetrics() || [];
      const renderer = metrics.filter((m) => m.type === 'Tab' || m.type === 'renderer');
      const total = renderer.reduce((sum, m) => sum + ((m.memory && m.memory.privateBytes) || 0), 0);
      privateMB = total ? +(total / 1024).toFixed(1) : null;
    } catch (err) {
      privateMB = null;
    }
    phases.push({ label, ...snap, privateMB });
  };

  const openFiles = async (paths) => {
    await run(`(async () => {
      const app = window.__lumenTestRun((a) => a);
      for (const t of [...app.tabs]) { try { await window.__lumenTestRun((a, c) => c.closeTab(t, { force: true })); } catch (e) {} }
      await new Promise((r) => setTimeout(r, 500));
      await window.__lumenTestOpen(${JSON.stringify(paths)});
      for (let i = 0; i < 200; i += 1) {
        if (app.active && app.active.loaded) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 800));
      return true;
    })()`);
  };

  await record('baseline (empty)');

  const text = path.join(ROOT, 'samples', 'sample-small.pdf');
  const photos = path.join(ROOT, 'samples', 'images', 'photos-24p-3mp.pdf');
  const scans = path.join(ROOT, 'samples', 'images', 'scans-30p.pdf');

  await openFiles([text]);
  await record('1 text document');

  await openFiles([photos]);
  await record('1 image document (24 pages)');

  // scroll the whole album so every page gets painted at least once
  await run(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = window.__lumenTestRun((a) => a);
    const tab = app.active;
    tab.setZoom('page-fit');
    await sleep(600);
    for (let p = 1; p <= tab.pageCount; p += 1) { tab.setPage(p); await sleep(220); }
    await sleep(1500);
    return true;
  })()`);
  await record('after scrolling all 24 pages');

  // back to the top and let the buffer settle
  await run(`(async () => {
    const app = window.__lumenTestRun((a) => a);
    app.active.setPage(1);
    await new Promise((r) => setTimeout(r, 2500));
    return true;
  })()`);
  await record('back at page 1');

  // Is the page-eviction hook actually installing, and what sizes result?
  const eviction = await run(`(async () => {
    const app = window.__lumenTestRun((a) => a);
    const tab = app.tabs[0];
    if (!tab || !tab.viewer) return JSON.stringify({ error: 'no tab' });
    const pv = tab.viewer.getPageView(0);
    const proto = pv ? Object.getPrototypeOf(pv) : null;
    const sizes = [];
    for (const v of tab.viewer._pages || []) {
      const c = v.canvas;
      if (c && c.width) sizes.push(c.width + 'x' + c.height);
    }
    return JSON.stringify({
      patchedFlag: !!tab._evictionPatched,
      hasDestroy: typeof (proto && proto.destroy),
      destroyPatched: !!(proto && proto.destroy && /patchedDestroy/.test(String(proto.destroy))),
      buffered: (tab.viewer.getCachedPageViews ? tab.viewer.getCachedPageViews().size : -1),
      canvasSizes: sizes.slice(0, 14),
      hasShrink: typeof tab._shrinkCanvas,
    });
  })()`).then(JSON.parse);
  console.log('[eviction] ' + JSON.stringify(eviction));
  phases.push({ label: 'eviction diagnostics', ...(await snapshot()), eviction });



  // open every tab kind at once
  await openFiles([text, photos, scans]);
  await record('3 tabs open');

  // annotations: create two, erase one
  await run(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = window.__lumenTestRun((a) => a);
    const tab = app.tabs[0];
    await window.__lumenTestRun((a, c) => c.activateTabForTest ? c.activateTabForTest(tab) : null);
    tab.setZoom('page-width');
    tab.setPage(1);
    await sleep(1200);
    window.__lumenTestRun((a, ctx) => ctx.setTool('highlight'));
    await sleep(600);
    const pv = tab.viewer.getPageView(0);
    const spans = [...pv.div.querySelectorAll('.textLayer span')].filter((x) => x.textContent.trim().length > 4);
    for (const i of [2, 6]) {
      const span = spans[i];
      if (!span) continue;
      const range = document.createRange();
      range.selectNodeContents(span);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      tab.editorUiManager.highlightSelection('highlight');
      await sleep(1100);
    }
    window.__lumenTestRun((a, ctx) => ctx.setTool('select'));
    await sleep(500);
    return true;
  })()`);
  await record('after 2 annotations');

  // reflow on and off
  await run(`(async () => {
    await window.__lumenTestRun((a, ctx) => ctx.__toggleReflowForTest(true));
    for (let i = 0; i < 160; i += 1) {
      const st = document.querySelector('.reflow-status');
      if (st && /已重排|返回/.test(st.textContent)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    return true;
  })()`);
  await record('reflow rendered (3 tabs)');

  await run(`window.__lumenTestRun((a, ctx) => ctx.__toggleReflowForTest(false))`);
  await sleep(1200);
  await record('reflow off again');

  // close everything
  await run(`(async () => {
    const app = window.__lumenTestRun((a) => a);
    for (const t of [...app.tabs]) { try { await window.__lumenTestRun((a, c) => c.closeTab(t, { force: true })); } catch (e) {} }
    await new Promise((r) => setTimeout(r, 1200));
    return true;
  })()`);
  await record('all tabs closed');

  // Where do the leftover canvases live after everything is closed?
  const leftovers = await run(`JSON.stringify((() => {
    const out = [];
    for (const c of document.querySelectorAll('canvas')) {
      const path = [];
      let n = c;
      while (n && n !== document.body) {
        path.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className ? '.' + String(n.className).split(' ')[0] : ''));
        n = n.parentElement;
      }
      out.push({ size: c.width + 'x' + c.height, mb: +((c.width * c.height * 4) / 1048576).toFixed(2), path: path.join(' < ') });
    }
    out.sort((a, b) => b.mb - a.mb);
    return out.slice(0, 20);
  })())`).then(JSON.parse);
  console.log('[leftover canvases] ' + JSON.stringify(leftovers, null, 1));

  const report = { when: new Date().toISOString(), phases, leftovers };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('\n[memprobe]');
  const keys = ['heapMB', 'canvasMB', 'canvasCount', 'domNodes', 'renderedPages', 'reflowFigures', 'reflowMounted', 'eraserLayers', 'reflowPanes', 'tabs'];
  console.log('  phase'.padEnd(34) + keys.map((k) => k.padStart(11)).join(''));
  for (const p of phases) {
    console.log('  ' + p.label.padEnd(32) + keys.map((k) => String(p[k]).padStart(11)).join(''));
  }
  setTimeout(() => {
    app.exit(0);
    process.exit(0);
  }, 400);
};
