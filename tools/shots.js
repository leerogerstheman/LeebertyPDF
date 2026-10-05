'use strict';
/**
 * README screenshot rig.
 *
 *   LUMEN_SHOTS=1   (hooked from src/main/main.js)
 *
 * Drives the real window through the states worth showing and writes PNGs to
 * artifacts/shots/. Tools\make-docs-images.ps1 then trims and optimises them
 * into docs/screenshots/ for the README.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'artifacts', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function run({ win, app }) {
  fs.mkdirSync(OUT, { recursive: true });
  const run_ = (code) => win.webContents.executeJavaScript(code, true);

  const shot = async (name) => {
    // two composited frames, so a late canvas paint is included
    await run_('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))').catch(
      () => {},
    );
    await sleep(420);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    console.log('[shots] captured', name, `${img.getSize().width}x${img.getSize().height}`);
  };

  const open = async (files) => {
    await run_(`(async () => {
      const app = window.__lumenTestRun((a) => a);
      for (const t of [...app.tabs]) { try { window.__lumenTestRun((a, c) => c.closeTab(t, { force: true })); } catch (e) {} }
      await new Promise((r) => setTimeout(r, 500));
      await window.__lumenTestOpen(${JSON.stringify(files)});
      for (let i = 0; i < 240; i += 1) {
        if (app.active && app.active.loaded) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 900));
      return true;
    })()`);
  };

  const paper = path.join(ROOT, 'samples', 'real', 'real-1706.03762v7.pdf');
  const album = path.join(ROOT, 'samples', 'images', 'photos-24p-3mp.pdf');

  try {
    // wait for the shell to settle into the empty state
    for (let i = 0; i < 80; i += 1) {
      const ready = await run_("typeof window.__lumenTestRun === 'function'").catch(() => false);
      if (ready) break;
      await sleep(250);
    }
    await run_("window.__lumenTestRun((a, c) => c.store.set('sidebarVisible', true))");
    await sleep(1200);
    await shot('01-empty');

    /* ------------------------------------------------------- reading view */
    await open([paper]);
    await run_(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const app = window.__lumenTestRun((a) => a);
      const tab = app.active;
      tab.setZoom('page-width');
      tab.setPageMode('single');
      tab.setScrollMode('vertical');
      tab.setPage(1);
      await sleep(1800);
      return true;
    })()`);
    await sleep(900);
    await shot('02-reading');

    // sidebar with the outline, which shows the document structure
    await run_(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const btn = document.querySelector('#pane-switch') || document.querySelector('.sidebar-title');
      if (btn) btn.click();
      await sleep(400);
      const item = [...document.querySelectorAll('.pane-menu button, .pane-item, .sidebar-menu button')]
        .find((n) => /大纲|outline/i.test(n.textContent));
      if (item) item.click();
      await sleep(900);
      return true;
    })()`);
    await sleep(600);
    await shot('03-outline');

    /* ------------------------------------------------------ annotations */
    await run_(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const app = window.__lumenTestRun((a) => a);
      const tab = app.active;
      tab.setZoom('page-width');
      tab.setPage(2);
      await sleep(1500);
      window.__lumenTestRun((a, ctx) => ctx.setTool('highlight'));
      await sleep(600);
      const pv = tab.viewer.getPageView(1);
      const spans = [...pv.div.querySelectorAll('.textLayer span')]
        .filter((x) => x.textContent.trim().length > 8);
      for (const idx of [1, 4, 9]) {
        const span = spans[idx];
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
    await sleep(700);
    await shot('04-highlights');

    /* ------------------------------------------------------ reflow view */
    await run_(`(async () => {
      await window.__lumenTestRun((a, c) => c.__toggleReflowForTest(true));
      for (let i = 0; i < 200; i += 1) {
        const st = document.querySelector('.reflow-status');
        if (st && /已重排|返回/.test(st.textContent)) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      document.querySelector('.reflow-scroll').scrollTop = 260;
      return true;
    })()`);
    await sleep(1600);
    await shot('05-reflow');

    await run_("window.__lumenTestRun((a, c) => c.__toggleReflowForTest(false))");
    await sleep(1200);

    /* -------------------------------------------------------- command palette */
    await run_(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      document.querySelector('#btn-command').click();
      await sleep(700);
      const input = document.querySelector('#palette-input');
      input.value = '导出';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(600);
      return true;
    })()`);
    await sleep(500);
    await shot('06-palette');
    await run_("document.querySelector('#palette-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await sleep(500);

    /* ----------------------------------------------------------- organizer */
    await run_("window.__lumenOpenOrganizer()");
    await sleep(2600);
    await shot('07-organizer');
    await run_(`(async () => {
      const close = document.querySelector('#organizer .icon-btn[title*="关闭"], #organizer .organizer-close, #organizer [data-close]');
      if (close) close.click();
      else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 700));
      return true;
    })()`);
    await sleep(800);

    /* --------------------------------------------------------------- scanning */
    await open([album]);
    await shot('08-image-album');

    /* ------------------------------------------------------------ night mode */
    await open([paper]);
    await run_(`(async () => {
      window.__lumenTestRun((a, c) => c.toggleInvert());
      await new Promise((r) => setTimeout(r, 900));
      const app = window.__lumenTestRun((a) => a);
      app.active.setZoom('page-width');
      app.active.setPage(1);
      await new Promise((r) => setTimeout(r, 1600));
      return true;
    })()`);
    await sleep(900);
    await shot('09-night');
    await run_("window.__lumenTestRun((a, c) => c.toggleInvert())");
    await sleep(700);

    /* ------------------------------------------------------------- settings */
    await run_("window.__lumenTestRun((a, c) => c.openSettings())");
    await sleep(1600);
    await shot('10-settings');
    await run_("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await sleep(600);

    console.log('[shots] done');
  } catch (err) {
    console.error('[shots] failed:', err);
  }

  setTimeout(() => {
    app.exit(0);
    process.exit(0);
  }, 500);
};
