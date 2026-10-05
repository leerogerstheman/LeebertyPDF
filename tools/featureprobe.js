'use strict';
/**
 * Probe for the two features added on request:
 *   - the independent eraser (src/renderer/eraser.js)
 *   - reflowed reading (src/renderer/reflow.js)
 *
 *   LUMEN_FEATUREPROBE=1   (hooked from src/main/main.js)
 *
 * Writes artifacts/feature-probe.json and screenshots.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'artifacts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function run({ win, app }) {
  fs.mkdirSync(OUT, { recursive: true });
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => {
    await sleep(400);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, 'featprobe-' + name + '.png'), img.toPNG());
  };
  const results = [];

  for (let i = 0; i < 60; i += 1) {
    const ready = await run("typeof window.__lumenTestRun === 'function'").catch(() => false);
    if (ready) break;
    await sleep(200);
  }

  const sample = path.join(ROOT, 'samples', 'sample-small.pdf');
  await run(`(async () => {
    const app = window.__lumenTestRun((a) => a);
    for (const t of [...app.tabs]) { try { await window.__lumenTestRun((a, c) => c.closeTab(t, { force: true })); } catch (e) {} }
    await new Promise((r) => setTimeout(r, 400));
    await window.__lumenTestOpen([${JSON.stringify(sample)}]);
    for (let i = 0; i < 200; i += 1) {
      if (app.active && app.active.loaded) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return true;
  })()`);
  await sleep(1600);

  /* ---------------------------------------------------------------- eraser */
  const eraser = await run(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = window.__lumenTestRun((a) => a);
    const tab = app.active;
    tab.setZoom('page-width');
    tab.setRotation(0);
    tab.setPage(1);
    await sleep(1300);
    const count = () => {
      const s = tab.doc.annotationStorage.serializable;
      return s && s.map ? s.map.size : 0;
    };
    const out = { before: count() };

    // make two highlights on different lines
    window.__lumenTestRun((a, ctx) => ctx.setTool('highlight'));
    await sleep(700);
    const pv = tab.viewer.getPageView(0);
    const spans = [...pv.div.querySelectorAll('.textLayer span')].filter((x) => x.textContent.trim().length > 4);
    for (const idx of [2, 5]) {
      const span = spans[idx];
      if (!span) continue;
      const range = document.createRange();
      range.selectNodeContents(span);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      tab.editorUiManager.highlightSelection('highlight');
      await sleep(1200);
    }
    window.__lumenTestRun((a, ctx) => ctx.setTool('select'));
    await sleep(500);
    out.afterCreate = count();

    // switch to the eraser and check the overlay + hover marker
    window.__lumenTestRun((a, ctx) => ctx.setTool('erase'));
    await sleep(700);
    const overlay = tab.containerEl.querySelector('.eraser-layer');
    out.overlayPresent = !!overlay;
    out.overlayVisible = !!overlay && !overlay.hidden;

    // hover the first rendered highlight by geometry
    const nodes = [...pv.div.querySelectorAll('.annotationEditorLayer > *')];
    out.renderedNodes = nodes.length;
    const boxes = nodes.map((n) => {
      const r = n.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    });

    // ask the module itself what it pairs up
    const paired = window.__lumenEraserProbe ? window.__lumenEraserProbe() : null;
    out.paired = paired;

    // drive the overlay's own hit test through a synthetic pointer event
    const target = nodes[0];
    if (target && overlay) {
      const r = target.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      overlay.dispatchEvent(new PointerEvent('pointermove', { clientX: cx, clientY: cy, bubbles: true }));
      await sleep(300);
      const marker = overlay.querySelector('.eraser-marker');
      out.markerShown = !!marker && !marker.hidden;
      out.markerBox = marker && !marker.hidden
        ? [Math.round(marker.getBoundingClientRect().width), Math.round(marker.getBoundingClientRect().height)]
        : null;
      overlay.dispatchEvent(new PointerEvent('pointerdown', { clientX: cx, clientY: cy, button: 0, bubbles: true }));
      await sleep(900);
    }
    out.afterErase = count();
    out.boxes = boxes;
    window.__lumenTestRun((a, ctx) => ctx.setTool('select'));
    await sleep(400);
    return JSON.stringify(out);
  })()`).then(JSON.parse);
  results.push({ name: 'independent eraser', data: eraser });
  await shot('eraser');

  /* ---------------------------------------------------------------- reflow */
  const reflow = await run(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = window.__lumenTestRun((a) => a);
    const tab = app.active;
    const out = {};
    const t0 = performance.now();
    await window.__lumenTestRun((a, ctx) => ctx.__toggleReflowForTest(true));
    await sleep(2500);
    for (let i = 0; i < 120; i += 1) {
      const st = document.querySelector('.reflow-status');
      if (st && /已重排|返回/.test(st.textContent)) break;
      await sleep(250);
    }
    out.totalMs = Math.round(performance.now() - t0);
    const pane = document.querySelector('.reflow-pane');
    out.paneVisible = !!pane && !pane.hidden;
    out.pageViewHidden = tab.containerEl.hidden;
    out.articles = document.querySelectorAll('.reflow-page').length;
    out.paragraphs = document.querySelectorAll('.reflow-p').length;
    out.headings = document.querySelectorAll('.reflow-h').length;
    out.figures = document.querySelectorAll('.reflow-figure').length;
    out.status = document.querySelector('.reflow-status').textContent;
    const first = document.querySelector('.reflow-p');
    out.firstParagraph = first ? first.textContent.slice(0, 90) : null;
    out.firstFontSize = first ? getComputedStyle(first).fontSize : null;
    out.columnWidth = getComputedStyle(document.querySelector('.reflow-articles')).maxWidth;
    out.selectable = first ? getComputedStyle(first).userSelect : null;

    // typography change must restyle without a re-extract
    window.__lumenTestRun((a, ctx) => { ctx.store.set('reflowFontSize', 22); ctx.bus.emit('ui:apply-reflow-type'); });
    await sleep(1200);
    const after = document.querySelector('.reflow-p');
    out.fontSizeAfter = after ? getComputedStyle(after).fontSize : null;

    // back to the original layout
    await window.__lumenTestRun((a, ctx) => ctx.__toggleReflowForTest(false));
    await sleep(900);
    out.backToPaged = tab.containerEl.hidden === false;
    return JSON.stringify(out);
  })()`).then(JSON.parse);
  results.push({ name: 'reflow', data: reflow });
  await shot('reflow-off');

  // capture the reflow view itself
  await run(`window.__lumenTestRun((a, ctx) => ctx.__toggleReflowForTest(true))`);
  await sleep(3000);
  await shot('reflow-on');

  // an image-heavy page should produce figures
  const figures = await run(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const app = window.__lumenTestRun((a) => a);
    for (const t of [...app.tabs]) { try { await window.__lumenTestRun((a, c) => c.closeTab(t, { force: true })); } catch (e) {} }
    await new Promise((r) => setTimeout(r, 400));
    await window.__lumenTestOpen([${JSON.stringify(path.join(ROOT, 'samples', 'images', 'tiles-12p-24img.pdf'))}]);
    for (let i = 0; i < 200; i += 1) {
      if (app.active && app.active.loaded) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await sleep(800);
    await window.__lumenTestRun((a, ctx) => ctx.__toggleReflowForTest(true));
    for (let i = 0; i < 160; i += 1) {
      const st = document.querySelector('.reflow-status');
      if (st && /已重排|返回/.test(st.textContent)) break;
      await sleep(250);
    }
    return JSON.stringify({
      figures: document.querySelectorAll('.reflow-figure').length,
      paragraphs: document.querySelectorAll('.reflow-p').length,
      canvasSizes: [...document.querySelectorAll('.reflow-figure-canvas')].slice(0, 3).map((c) => c.width + 'x' + c.height),
      status: document.querySelector('.reflow-status').textContent,
    });
  })()`).then(JSON.parse);
  results.push({ name: 'reflow with figures', data: figures });
  await shot('reflow-images');

  const report = { when: new Date().toISOString(), results };
  fs.writeFileSync(path.join(OUT, 'feature-probe.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('\n[featureprobe] ' + JSON.stringify(report, null, 1));
  setTimeout(() => {
    app.exit(0);
    process.exit(0);
  }, 400);
};
