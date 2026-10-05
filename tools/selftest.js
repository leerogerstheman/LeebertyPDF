'use strict';
/**
 * LeebertyPDF — automated smoke test / screenshot driver.
 *
 * Runs inside the real main process (started from `main.js` when
 * `LUMEN_SELFTEST` is set), drives the real renderer through
 * `executeJavaScript`, and writes PNG captures plus a JSON report to
 * `<repo>/artifacts`.
 *
 *   $env:LUMEN_SELFTEST="1"
 *   $env:LUMEN_SELFTEST_FILES="D:\path\a.pdf;D:\path\b.pdf"
 *   .\_vendor\electron\electron.exe .
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'artifacts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  console.log('[selftest]', ...args);
}

async function run({ win, app }) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const errors = [];
  const notes = [];

  // Real input events through the DevTools protocol — synthetic DOM events do
  // not trigger text selection, so drags have to go through the browser input
  // pipeline to exercise the highlight editor.
  let cdpReady = false;
  const cdp = async (method, params) => {
    if (!cdpReady) {
      try {
        win.webContents.debugger.attach('1.3');
        cdpReady = true;
      } catch (err) {
        errors.push(`cdp attach failed: ${err.message}`);
        return null;
      }
    }
    try {
      return await win.webContents.debugger.sendCommand(method, params);
    } catch (err) {
      errors.push(`cdp ${method} failed: ${err.message}`);
      return null;
    }
  };
  const mouse = async (type, x, y, extra = {}) =>
    cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
  const drag = async (x1, y1, x2, y2, steps = 8) => {
    await mouse('mouseMoved', x1, y1, { buttons: 0 });
    await mouse('mousePressed', x1, y1);
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      await mouse('mouseMoved', x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
      await sleep(25);
    }
    await mouse('mouseReleased', x2, y2);
  };

  win.webContents.on('console-message', (event) => {
    const level = String(event.level ?? '');
    const isErr = level === 'error' || level === '3';
    const isWarn = level === 'warning' || level === '2';
    console.log(`[renderer:${isErr ? 'ERR' : isWarn ? 'WRN' : 'LOG'}] ${event.message}`);
    if (isErr || isWarn) {
      errors.push(`[console:${level}] ${event.message} @${event.lineNumber ?? ''}`);
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => errors.push(`render-process-gone ${JSON.stringify(d)}`));
  win.webContents.on('preload-error', (_e, p, err) => errors.push(`preload-error ${p} ${err && err.message}`));

  const run_ = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => {
    // force a couple of composited frames so late canvas paints are included
    await run_('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))').catch(
      () => {},
    );
    await sleep(340);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), img.toPNG());
    log('captured', name);
  };

  try {
    await run_('window.__LUMEN_CONTROL = true');
    await sleep(2200);
    await shot('01-empty');

    const files = (process.env.LUMEN_SELFTEST_FILES || '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    if (files.length) {
      log('opening', files.join(', '));
      await run_(`window.__lumenTestOpen(${JSON.stringify(files)})`);
      await sleep(3200);
      await shot('02-document');

      // Control experiment: a bare pdf.js viewer with stock CSS only.
      try {
        await run_('window.__lumenBareControl && window.__lumenBareControl()');
        await sleep(2600);
        const bare = await run_('JSON.stringify(window.__lumenBareProbe ? window.__lumenBareProbe() : null)');
        notes.push({ bareViewer: JSON.parse(bare || 'null') });
        await shot('02b-bare-control');
      } catch (err) {
        notes.push({ bareViewerError: String(err && err.message) });
      }

      const state = await run_('JSON.stringify(window.__lumenTestState())');
      notes.push({ state: JSON.parse(state || '{}') });

      const diag = await run_(`JSON.stringify({
        busy: !document.querySelector('#status-progress').hidden,
        pagerText: document.querySelector('#page-input').value + document.querySelector('#page-total').textContent,
        zoomText: document.querySelector('#btn-zoom').textContent,
        progressWidth: document.querySelector('#progress-fill').style.width,
        viewers: [...document.querySelectorAll('.pdf-container')].map(c => ({
          id: c.id, hidden: c.hidden,
          pages: c.querySelectorAll('.page').length,
          canvases: c.querySelectorAll('canvas').length,
          viewerClass: c.querySelector('.pdfViewer')?.className,
          viewerDisplay: getComputedStyle(c.querySelector('.pdfViewer')).display,
          containerDisplay: getComputedStyle(c).display,
          hostDisplay: getComputedStyle(c.parentElement).display,
          scrollTop: c.scrollTop,
          pageRects: [...c.querySelectorAll('.page')].slice(0,3).map(p => { const r = p.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }),
        })),
        stageRect: (() => { const r = document.querySelector('#stage').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
      })`);
      notes.push({ diag: JSON.parse(diag || '{}') });

      // explicit layout probe: drive the modes through the UI that now hosts
      // them (the toolbar's view menu) and assert on real page coordinates
      const probe = await run_(`(async () => {
        const out = [];
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const click = sel => { const n = document.querySelector(sel); if (n) n.click(); return !!n; };
        const rects = () => [...document.querySelectorAll('.pdf-container:not([hidden]) .page')].slice(0,3)
          .map(p => { const r = p.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; });
        const cls = () => document.querySelector('.pdf-container:not([hidden]) .pdfViewer').className;
        const run_2 = () => {
          const view = window.__lumenTestViewer ? window.__lumenTestViewer() : null;
          return { scrollMode: view && view.scrollMode, spreadMode: view && view.spreadMode, cls: cls() };
        };
        // mode switching still exists but is now reached through the view menu
        const mode = (fn) => { click('#btn-view'); return { menu: true, fn }; };
        out.push(['initial', rects(), cls()]);

        // scroll modes via the app's own command path
        window.__lumenTestRun((app, ctx) => ctx.bus.emit('ui:apply-default-view'));
        await sleep(400);
        window.__lumenTestRun((app) => app.active.setScrollMode('horizontal'));
        await sleep(800);
        out.push(['horizontal', rects(), cls()]);
        const direct = run_2();
        out.push(['direct-get', direct.scrollMode, direct.spreadMode, direct.cls]);

        window.__lumenTestRun((app) => app.active.setScrollMode('vertical'));
        await sleep(800);
        out.push(['vertical-again', rects(), cls()]);
        const direct2 = run_2();
        out.push(['direct-get-after', direct2.scrollMode, direct2.spreadMode, direct2.cls]);

        window.__lumenTestRun((app) => app.active.setPageMode('spread-odd'));
        await sleep(800);
        out.push(['spread-odd', rects(), cls()]);
        window.__lumenTestRun((app) => app.active.setPageMode('spread-even'));
        await sleep(800);
        out.push(['spread-even', rects(), cls()]);
        window.__lumenTestRun((app) => app.active.setPageMode('spread-odd'));
        await sleep(600);
        window.__lumenTestRun((app) => app.active.setPageMode('single'));
        await sleep(600);
        window.__lumenTestRun((app) => app.active.setScrollMode('page'));
        await sleep(800);
        out.push(['page-mode', rects(), cls()]);
        window.__lumenTestRun((app) => app.active.setScrollMode('vertical'));
        await sleep(800);
        out.push(['back-to-vertical', rects(), cls()]);

        // the view menu must open and expose the layout entries
        click('#btn-view');
        await sleep(400);
        out.push(['viewMenuItems', document.querySelectorAll('#main-menu .menu-item').length]);
        out.push(['viewMenuLabels', [...document.querySelectorAll('#main-menu .menu-label')].slice(0, 6).map(n => n.textContent)]);
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await sleep(200);
        return JSON.stringify(out);
      })()`);
      notes.push({ layoutProbe: JSON.parse(probe || '[]') });

      // find bar
      await run_(`(() => { document.querySelector('#btn-find').click();
        const i = document.querySelector('#find-input');
        i.value = 'lorem'; i.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
      await sleep(1500);
      await shot('03-find');

      // navigation + zoom
      await run_(`(() => { document.querySelector('#btn-page-next').click();
        document.querySelector('#btn-page-next').click();
        window.__lumenTestRun((app) => app.active.setZoom('page-width'));
        return true; })()`);
      await sleep(1400);
      await shot('04-zoom-width');

      // outline pane
      await run_(`window.__lumenTestRun((app) => app.sidebar.setPane('outline'))`);
      await sleep(900);
      await shot('05-outline');

      // bookmarks
      await run_(`(async () => {
        window.__lumenTestRun((app) => app.sidebar.setPane('bookmarks'));
        await window.__lumenTestRun((app) => app.active).addBookmark(2);
        return true;
      })()`);
      await sleep(800);
      await shot('06-bookmarks');

      // highlight tool + editor bar
      await run_(`document.querySelector('#btn-highlight').click()`);
      await sleep(700);
      await shot('07-highlight-tool');

      // command palette
      await run_(`document.querySelector('#btn-ink').click(); document.querySelector('#btn-command').click()`);
      await sleep(800);
      await shot('08-palette');
      await run_(`document.querySelector('#palette-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);

      // main menu
      await run_(`document.querySelector('#btn-menu').click()`);
      await sleep(700);
      await shot('09-menu');
      await run_(`document.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`);

      // settings modal
      await run_(`(() => { for (const m of document.querySelectorAll('#modal-root .modal')) m.remove(); document.querySelector('#modal-root').hidden = true; window.__lumenTestRun((app, ctx) => ctx.openSettings()); return true; })()`);
      await sleep(900);
      await shot('10-settings');
      await run_(`document.querySelector('#modal-root').hidden = true`);

      // night reading
      await run_(`window.__lumenTestRun((app, ctx) => ctx.toggleInvert())`);
      await sleep(900);
      await shot('11-night');

      // spread mode
      await run_(`(() => {
        window.__lumenTestRun((app, ctx) => ctx.toggleInvert());
        window.__lumenTestRun((app) => { app.active.setPageMode('spread-odd'); app.active.setZoom('page-fit'); });
        return true;
      })()`);
      await sleep(1600);
      await shot('12-spread');

      const finalState = await run_('JSON.stringify(window.__lumenTestState())');
      notes.push({ final: JSON.parse(finalState || '{}') });

      // ---- annotation round trip (real drag through the input pipeline) ---
      await run_(`(() => {
        const tab = window.__lumenTestRun((app) => app.active);
        tab.setPage(1); tab.setZoom('page-width');
        document.querySelector('#btn-highlight').click();
        return true;
      })()`);
      await sleep(1800);

      const editorProbe = JSON.parse(
        (await run_(`JSON.stringify((() => {
          const tab = window.__lumenTestRun((app) => app.active);
          const mode = tab.viewer.annotationEditorMode;
          const storage = tab.doc.annotationStorage;
          const serial = storage.serializable;
          return {
            tool: tab.tool,
            editorMode: mode ? mode.mode : 'none',
            hasUiManager: !!tab.editorUiManager,
            storageSize: storage.size,
            serialMapType: serial && serial.map ? (serial.map instanceof Map ? 'Map' : typeof serial.map) : String(serial && serial.map),
            highlightSpans: document.querySelectorAll('.textLayer .highlight').length,
            editorLayers: document.querySelectorAll('.annotationEditorLayer').length,
            editorLayerHidden: [...document.querySelectorAll('.annotationEditorLayer')].map(n => n.hidden),
          };
        })())`)) || '{}',
      );
      notes.push({ editorProbe });

      const geometry = JSON.parse(
        (await run_(`JSON.stringify((() => {
          const tab = window.__lumenTestRun((app) => app.active);
          const pv = tab.viewer.getPageView(0);
          const spans = [...pv.div.querySelectorAll('.textLayer span')].filter(s => s.textContent.trim().length > 3);
          if (!spans.length) return null;
          const pick = spans[Math.min(3, spans.length - 1)];
          const r = pick.getBoundingClientRect();
          return { x1: Math.round(r.left + 2), x2: Math.round(r.right - 2), y: Math.round(r.top + r.height / 2), text: pick.textContent.slice(0, 30) };
        })())`)) || 'null',
      );

      if (geometry) {
        await drag(geometry.x1, geometry.y, geometry.x2, geometry.y, 10);
        await sleep(2000);
      }

      const annot = await run_(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const tab = window.__lumenTestRun((app) => app.active);
        const out = { geometry: ${JSON.stringify(geometry)} };
        const map = tab.doc.annotationStorage.serializable.map;
        out.mapSize = map instanceof Map ? map.size : -1;
        out.dirty = tab.dirty;
        const listed = tab.listAnnotations();
        out.listed = listed.length;
        out.listedFirst = listed[0] ? { page: listed[0].page, kind: listed[0].kind, color: listed[0].color } : null;

        await tab.persistAnnotations();
        await sleep(500);
        const saved = await window.lumen.annotations.get(tab.docKey());
        out.persisted = saved && saved.serialized ? Object.keys(JSON.parse(saved.serialized)).length : 0;

        window.__lumenTestRun((app) => app.sidebar.setPane('annotations'));
        await sleep(700);
        out.rows = document.querySelectorAll('#annot-list .annot-row').length;
        out.rowText = [...document.querySelectorAll('#annot-list .annot-row')].map(r => r.textContent.trim()).slice(0, 4);
        out.highlightNodes = document.querySelectorAll('.textLayer .highlight').length;

        try {
          const bytes = await tab.exportBytes();
          out.savedBytes = bytes ? bytes.length : 0;
          if (bytes && bytes.length) {
            out.savedHeader = String.fromCharCode.apply(null, bytes.slice(0, 8));
            out.savedTail = String.fromCharCode.apply(null, bytes.slice(bytes.length - 6));
            await window.lumen.fs.write(
              ${JSON.stringify(path.join(OUT_DIR, 'annotated-export.pdf'))},
              bytes,
            );
            out.exportPath = ${JSON.stringify(path.join(OUT_DIR, 'annotated-export.pdf'))};
          }
        } catch (err) {
          out.savedBytes = -1;
          out.saveError = String((err && err.message) || err);
        }
        window.__lumenTestRun((app, ctx) => ctx.setTool('select'));
        await sleep(300);
        return JSON.stringify(out);
      })()`);
      notes.push({ annotations: JSON.parse(annot || '{}') });
      await shot('13-annotations');

      // ---- bookmark + text extraction + outline --------------------------
      const extras = await run_(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const tab = window.__lumenTestRun((app) => app.active);
        const out = {};
        out.bookmarkAdded = await tab.addBookmark(3);
        out.bookmarkCount = tab.bookmarks.length;
        const text = await tab.pageText(1);
        out.pageTextLen = text.length;
        out.pageTextHead = text.slice(0, 48);
        const matches = tab.findController._pageMatches ? tab.findController._pageMatches.length : -1;
        out.findPagesWithMatches = matches;
        // outline
        window.__lumenTestRun((app) => app.sidebar.setPane('outline'));
        await sleep(700);
        out.outlineRows = document.querySelectorAll('#outline-list .outline-row').length;
        out.outlineTitles = [...document.querySelectorAll('#outline-list .outline-title')].map((n) => n.textContent);
        out.outlinePages = [...document.querySelectorAll('#outline-list .outline-page')].map((n) => n.textContent);
        const raw = await tab.doc.getOutline();
        out.rawOutline = (raw || []).map((o) => ({ title: o.title, destType: typeof o.dest, dest: JSON.stringify(o.dest) }));
        try {
          const dest = raw && raw[1] ? raw[1].dest : null;
          if (typeof dest === 'string') {
            const explicit = await tab.doc.getDestination(dest);
            out.destResolved = explicit ? await tab.doc.getPageIndex(explicit[0]) : 'no-destination';
          } else if (Array.isArray(dest)) {
            out.destResolved = await tab.doc.getPageIndex(dest[0]);
          }
        } catch (err) {
          out.destError = String(err && err.message);
        }
        if (out.outlineRows) {
          const rows = [...document.querySelectorAll('#outline-list .outline-row')];
          rows[rows.length - 1].click();
          await sleep(900);
          out.pageAfterOutlineClick = tab.page;
        }
        // bookmarks pane
        window.__lumenTestRun((app) => app.sidebar.setPane('bookmarks'));
        await sleep(400);
        out.bookmarkRows = document.querySelectorAll('#bookmark-list .bookmark-row').length;
        // properties dialog
        document.querySelector('#modal-root').hidden = true;
        return JSON.stringify(out);
      })()`);
      notes.push({ extras: JSON.parse(extras || '{}') });
      await shot('14-outline');

      // ---- page navigation + zoom presets --------------------------------
      const navProbe = await run_(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const tab = window.__lumenTestRun((app) => app.active);
        const out = {};
        tab.setPage(6); await sleep(400); out.page6 = tab.page;
        tab.setPage(999); await sleep(400); out.pageClamped = tab.page;
        for (const z of ['page-actual', 'page-fit', 'page-width', 'auto']) {
          tab.setZoom(z); await sleep(500);
          out['zoom_' + z] = Math.round((tab.scale || 0) * 1000) / 1000;
        }
        tab.rotateBy(90); await sleep(300); out.rotation = tab.rotation;
        tab.rotateBy(90); await sleep(300); out.rotation180 = tab.rotation;
        tab.setRotation(0); await sleep(400); out.rotationReset = tab.rotation;
        tab.setRotation(270); await sleep(300); out.rotationAbs = tab.rotation;
        return JSON.stringify(out);
      })()`);
      notes.push({ navigation: JSON.parse(navProbe || '{}') });
      await shot('15-rotated');
      await run_(`window.__lumenTestRun((app) => app.active).setRotation(270)`);
      // the absolute-vs-relative rotation split is asserted above; reset it here
      await run_(`window.__lumenTestRun((app) => app.active).setRotation(0)`);

      // ---- dark theme + reading progress ---------------------------------
      await run_(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const tab = window.__lumenTestRun((app) => app.active);
        window.__rotTrace = ['enter:' + tab.rotation + '/' + tab.viewer.pagesRotation];
        tab.setRotation(0);
        window.__rotTrace.push('after0:' + tab.rotation + '/' + tab.viewer.pagesRotation);
        await sleep(700);
        window.__rotTrace.push('settled:' + tab.rotation + '/' + tab.viewer.pagesRotation);
        tab.setPageMode('single');
        tab.setScrollMode('vertical');
        tab.setZoom('page-width');
        tab.setPage(5);
        window.__lumenTestRun((app, ctx) => { ctx.store.set('theme', 'dark'); });
        await sleep(700);
        const pv = tab.viewer.getPageView(4);
        window.__rotDiag = {
          tabRotation: tab.rotation,
          viewerRotation: tab.viewer.pagesRotation,
          viewportRotation: pv ? pv.viewport.rotation : null,
          viewportW: pv ? Math.round(pv.viewport.width) : null,
          viewportH: pv ? Math.round(pv.viewport.height) : null,
          scale: tab.viewer.currentScale,
        };
        return true;
      })()`);
      await sleep(800);
      notes.push({ rotDiag: await run_('JSON.stringify(window.__rotDiag || null)').then((v) => JSON.parse(v || 'null')) });
      notes.push({ rotTrace: await run_('JSON.stringify(window.__rotTrace || null)').then((v) => JSON.parse(v || 'null')) });
      await shot('17-dark');
      await run_(`(async () => {
        const tab = window.__lumenTestRun((app) => app.active);
        tab.setPage(1);
        window.__lumenTestRun((app, ctx) => { ctx.store.set('theme', 'auto'); });
        return true;
      })()`);
      await sleep(500);

      // ---- page organizer -------------------------------------------------
      // drop any modal left over from the earlier steps
      await run_(`(() => {
        for (const m of document.querySelectorAll('#modal-root .modal')) m.remove();
        document.querySelector('#modal-root').hidden = true;
        return true;
      })()`);
      await sleep(400);

      const organizer = await run_(`(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const out = {};
        await window.__lumenOpenOrganizer();
        await sleep(2600);

        const org = window.__lumenOrganizer;
        if (!org || !org.sessionId) return JSON.stringify({ error: 'organizer did not start' });
        out.initialPages = org.state.pages.length;
        out.domCells = document.querySelectorAll('.organizer-cell').length;

        const order = org.state.pages.map((_, i) => i);
        order.push(order.shift());
        await org.pushOp([{ type: 'reorder', order }]);
        await sleep(500);
        out.afterReorder = org.state.pages.length;

        await org.pushOp([{ type: 'rotate', indices: [0, 1], delta: 90 }]);
        await sleep(500);
        out.rotated = org.state.pages.slice(0, 2).map((p) => p.rotate);

        await org.pushOp([{ type: 'duplicate', indices: [0] }]);
        await sleep(500);
        out.afterDuplicate = org.state.pages.length;

        await org.pushOp([{ type: 'remove', indices: [0, 1] }]);
        await sleep(500);
        out.afterDelete = org.state.pages.length;

        await org.undo();
        await sleep(900);
        await org.undo();
        await sleep(900);
        out.afterUndo = org.state.pages.length;

        out.insertBefore = org.state.pages.length;
        await org.pushOp([
          { type: 'insert', path: ${JSON.stringify(path.join(__dirname, '..', 'samples', 'sample-tiny.pdf'))}, pages: [0], at: 0 },
        ]);
        await sleep(1200);
        await org.loadSourceDocs();
        await org.render();
        await sleep(1200);
        out.inserted = org.state.pages.length - out.insertBefore;
        out.sources = org.state.sources.length;
        out.thumbsRendered = document.querySelectorAll('.organizer-thumb canvas').length;
        // select a few pages so the screenshot shows the selection styling
        org.selection.clear();
        org.selection.add(0);
        org.selection.add(1);
        org.selection.add(2);
        org.paintSelection();
        org.updateToolbar();
        await sleep(200);

        out.rotationsBeforeSave = org.state.pages.map((p) => p.rotate).join(',');
        const target = ${JSON.stringify(path.join(OUT_DIR, 'organizer-result.pdf'))};
        const saved = await window.lumen.edit.save({ sessionId: org.sessionId, target });
        out.saved = saved && saved.ok ? { pages: saved.pages, bytes: saved.bytes } : { error: saved && saved.error };

        const splitDir = ${JSON.stringify(path.join(OUT_DIR, 'organizer-split'))};
        const split = await window.lumen.edit.split({
          sessionId: org.sessionId,
          dir: splitDir,
          size: 4,
          prefix: 'chunk',
        });
        out.split = split && split.ok ? split.files.map((f) => f.pages) : { error: split && split.error };

        // let every thumbnail finish before the screenshot
        await org.waitForThumbs(25000);
        await sleep(300);
        out.thumbsRenderedFinal = document.querySelectorAll('.organizer-thumb canvas').length;
        // does the bitmap actually contain paper?
        out.thumbStats = [...document.querySelectorAll('.organizer-thumb canvas')].slice(0, 4).map((c, i) => {
          try {
            const ctx = c.getContext('2d', { willReadFrequently: true });
            const d = ctx.getImageData(0, 0, Math.min(40, c.width), Math.min(40, c.height)).data;
            let nonWhite = 0;
            for (let k = 0; k < d.length; k += 4) if (d[k] < 240 || d[k + 1] < 240 || d[k + 2] < 240) nonWhite += 1;
            return [i, c.width, c.height, nonWhite];
          } catch (e) { return [i, 'err', String(e.message)]; }
        });
        out.srcDocInfo = [...org.docs.entries()].map(([id, e]) => [id, e.doc.numPages]);
        out.pageSrcIds = org.state.pages.slice(0, 4).map(p => p.srcId + '#' + p.srcPage);
        out.keepOpen = true;
        return JSON.stringify(out);
      })()`);
      notes.push({ organizer: JSON.parse(organizer || '{}') });
      await sleep(600);
      await shot('16-organizer');
      await run_(`window.__lumenOrganizer && window.__lumenOrganizer.close(true)`);
      await sleep(400);
    } else {
      notes.push({ info: 'no LUMEN_SELFTEST_FILES provided — captured the empty state only' });
    }
  } catch (err) {
    errors.push(`driver: ${err && err.stack ? err.stack : err}`);
  }

  const report = { when: new Date().toISOString(), errors, notes };
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  log('errors:', errors.length);
  for (const e of errors.slice(0, 25)) log('  ', e);
  log('report →', path.join(OUT_DIR, 'report.json'));

  const code = errors.length ? 2 : 0;
  setTimeout(() => {
    app.exit(code);
    process.exit(code);
  }, 400);
}

module.exports = { run };
