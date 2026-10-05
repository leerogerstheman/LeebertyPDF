'use strict';
/**
 * LeebertyPDF — full feature sweep.
 *
 * Drives the real renderer through every commonly used feature, one assertion
 * per behaviour, and writes artifacts/feature-report.json. Run it through the
 * main process (started by tools/featuretest.ps1) so it can also use CDP for
 * genuine mouse input.
 *
 * Every check is independent: a failure records the error and the sweep
 * continues, so one broken feature does not hide the rest.
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'artifacts');
const EDGE = path.join(__dirname, '..', 'samples', 'edge');
const SAMPLES = path.join(__dirname, '..', 'samples');
/** The renderer's localised "no matches" label, which means zero hits. */
const NOT_FOUND = '未找到';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function run({ win, app }) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const results = [];
  const consoleErrors = [];
  const rawConsole = [];
  const shots = [];

  win.webContents.on('console-message', (event) => {
    // Electron 38 hands over a single event object whose shape varies between
    // releases, so read the level/line defensively.
    const level = String(event.level ?? event.severity ?? '');
    const line = event.lineNumber ?? event.line ?? '';
    const src = event.sourceId ?? event.source ?? '';
    if (level !== 'error' && level !== '3') {
      rawConsole.push(`${level}|${src}:${line}|${String(event.message ?? '').slice(0, 120)}`);
      return;
    }
    const message = String(event.message ?? '');
    // PDF.js logs this from `scrollIntoView` when a page lives in a hidden tab,
    // and refuses to open malformed files — both are expected here.
    const benign = /offsetParent is not set -- cannot scroll|open failed:/;
    if (benign.test(message)) return;
    consoleErrors.push(`${message} @${event.lineNumber ?? ''}`);
  });

  /* ---------------------------------------------------------------- tools */
  let attached = false;
  const cdp = async (method, params) => {
    if (!attached) {
      win.webContents.debugger.attach('1.3');
      attached = true;
    }
    return win.webContents.debugger.sendCommand(method, params);
  };
  const mouse = (type, x, y, extra = {}) =>
    cdp('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1,
      ...extra,
    });
  const drag = async (x1, y1, x2, y2, steps = 10) => {
    await mouse('mouseMoved', x1, y1, { buttons: 0 });
    await mouse('mousePressed', x1, y1);
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      await mouse('mouseMoved', x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
      await sleep(20);
    }
    await mouse('mouseReleased', x2, y2);
  };
  const click = async (x, y) => {
    await mouse('mouseMoved', x, y, { buttons: 0 });
    await mouse('mousePressed', x, y);
    await sleep(30);
    await mouse('mouseReleased', x, y);
  };
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const key = (k, mods = 0) =>
    cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: k,
      code: k.length === 1 ? `Key${k.toUpperCase()}` : k,
      windowsVirtualKeyCode: k === 'Escape' ? 27 : k === 'Enter' ? 13 : k === 'Delete' ? 46 : 0,
      modifiers: mods,
    }).then(() => cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, modifiers: mods }));

  const shot = async (name) => {
    await run('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))').catch(
      () => {},
    );
    await sleep(300);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT_DIR, `feat-${name}.png`), img.toPNG());
    shots.push(`feat-${name}.png`);
  };

  /** One assertion. `fn` may be async; it must return a short info string. */
  const check = async (area, name, fn) => {
    const started = Date.now();
    try {
      const info = await fn();
      results.push({ area, name, ok: true, info: String(info ?? ''), ms: Date.now() - started });
    } catch (err) {
      results.push({
        area,
        name,
        ok: false,
        info: String((err && err.message) || err),
        ms: Date.now() - started,
      });
    }
  };
  const assert = (cond, message) => {
    if (!cond) throw new Error(message);
  };
  const near = (a, b, tol, message) => assert(Math.abs(a - b) <= tol, `${message} (${a} vs ${b})`);

  /** Opens files as new tabs and waits for them to be ready. */
  const open = async (paths, settle = 2200) => {
    await run(`window.__lumenTestOpen(${JSON.stringify(paths)})`);
    await sleep(settle);
  };
  /**
   * Points `app.active` at the tab for a given file so every later step works
   * on a known document (an earlier step may have left a different tab active).
   */
  /**
   * Puts the app into a known state: every other tab closed, then the given
   * files opened fresh (the last one active). Feature checks must never depend
   * on whatever tab an earlier check happened to leave behind.
   */
  const reset = async (files, settle = 2600) => {
    const list = Array.isArray(files) ? files : [files];
    // close repeatedly: opening a document is async, so a tab can still be in
    // flight when the first sweep runs
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const left = await run(`(async () => {
        const app = window.__lumenTestRun((a) => a);
        for (const tab of [...app.tabs]) {
          try { await window.__lumenTestRun((a, ctx) => ctx.closeTab(tab, { force: true })); } catch (e) { /* ignore */ }
        }
        await new Promise((r) => setTimeout(r, 350));
        return app.tabs.length;
      })()`);
      if (left === 0) break;
      await sleep(600);
    }
    const left = await run(`JSON.stringify(window.__lumenTestRun((a) => a.tabs.map((t) => ({
      title: t.title, path: t.path, dirty: t.dirty, loaded: t.loaded,
    }))))`);
    const cleared = JSON.parse(left).length;
    assert(cleared === 0, `could not clear the tab strip (${cleared} left: ${left})`);
    await open(list, settle);
    const active = await run(`(() => {
      const app = window.__lumenTestRun((a) => a);
      return app.active ? { title: app.active.title, pages: app.active.pageCount, loaded: app.active.loaded, tabs: app.tabs.length } : null;
    })()`);
    assert(active, `no active tab after opening ${list.map((f) => path.basename(f)).join(', ')}`);
    assert(active.loaded, `document did not finish loading: ${active.title}`);
    return active;
  };

  /** True when the current document allows annotations. */
  const canAnnotate = () =>
    run(`(async () => {
      const tab = window.__lumenTestRun((app) => app.active);
      if (!tab || !tab.doc) return 'no document';
      if (!tab.canEdit) return 'permissions forbid annotation';
      let mode = null;
      try { mode = tab.viewer.annotationEditorMode; } catch (e) { return 'editor disabled: ' + e.message; }
      const button = document.querySelector('#btn-highlight');
      if (button && button.disabled) return 'highlight button is disabled';
      return true;
    })()`);

  /* ------------------------------------------------------------- 1. files */
  {
    // The renderer evaluates app.js asynchronously; wait for its test hooks
    // instead of guessing a delay.
    let ready = false;
    for (let i = 0; i < 40; i += 1) {
      try {
        ready = await win.webContents.executeJavaScript(
          `typeof window.__lumenTestRun === 'function' && typeof window.__lumenTestOpen === 'function'`,
          true,
        );
      } catch {
        ready = false;
      }
      if (ready) break;
      await sleep(250);
    }
    if (!ready) {
      results.push({ area: '启动', name: '渲染进程就绪', ok: false, info: 'window.__lumenTestRun never appeared', ms: 0 });
    } else {
      results.push({ area: '启动', name: '渲染进程就绪', ok: true, info: 'hooks available', ms: 0 });
    }
    await sleep(1200);
  }

  await check('文件', '打开单个 PDF', async () => {
    await open([path.join(SAMPLES, 'sample-small.pdf')], 2600);
    const st = await run('JSON.stringify(window.__lumenTestState())').then(JSON.parse);
    assert(st.tabs.length >= 1, 'no tab created');
    const active = st.active;
    assert(active && active.pageCount === 12, `expected 12 pages, got ${active && active.pageCount}`);
    assert(active.loaded, 'document did not finish loading');
    return `${active.title} · ${active.pageCount} 页`;
  });

  await check('文件', '多文件同时打开（多标签）', async () => {
    // A restored session may already hold one of these files, and re-opening an
    // open file focuses its tab instead of adding one, so assert on the set.
    const wanted = [
      path.join(SAMPLES, 'sample-small.pdf'),
      path.join(SAMPLES, 'sample-landscape.pdf'),
      path.join(SAMPLES, 'sample-tiny.pdf'),
    ];
    await open(wanted.slice(1), 2600);
    let st = null;
    for (let i = 0; i < 20; i += 1) {
      st = await run('JSON.stringify(window.__lumenTestState())').then(JSON.parse);
      const names = st.tabs.map((t) => path.basename(t.path));
      const all = wanted.every((w) => names.includes(path.basename(w)));
      if (all && st.tabs.every((t) => t.loaded)) break;
      await sleep(300);
    }
    const names = st.tabs.map((t) => path.basename(t.path));
    for (const w of wanted) {
      assert(names.includes(path.basename(w)), `missing tab for ${path.basename(w)} (have ${names.join(', ')})`);
    }
    assert(st.tabs.length === wanted.length, `expected ${wanted.length} tabs, got ${st.tabs.length} (${names.join(', ')})`);
    assert(st.tabs.every((t) => t.loaded), `a tab never finished loading: ${JSON.stringify(st.tabs)}`);
    assert(st.active.pageCount === 1, `active should be the 1-page doc, got ${st.active.pageCount}`);
    return `${st.tabs.length} 个标签页，全部加载完成`;
  });

  await check('文件', '打开文件夹批量载入', async () => {
    // simulate what pickFolder does: load every PDF in a directory
    const dir = path.join(SAMPLES, 'edge');
    const files = await run(`window.lumen.fs.listFolder(${JSON.stringify(dir)})`);
    assert(Array.isArray(files) && files.length >= 5, `folder scan returned ${files && files.length}`);
    return `${files.length} 个文件`;
  });

  await check('文件', '最近阅读记录', async () => {
    const items = await run('window.lumen.recents.list()');
    assert(items.length >= 1, 'recent list is empty');
    const hit = items.find((i) => i.path.includes('sample-small'));
    assert(hit, 'opened file missing from recents');
    assert(hit.total === 12, `recent entry has wrong page count: ${hit.total}`);
    return `${items.length} 条，最新「${items[0].title || items[0].path}」`;
  });

  await check('文件', '阅读进度记忆写入', async () => {
    await reset([path.join(SAMPLES, 'sample-small.pdf')]);
    await run(`window.__lumenTestRun((app) => app.active).setPage(7)`);
    await sleep(1200);
    await run(`window.__lumenTestRun((app) => app.active).persistState()`);
    await sleep(600);
    const all = await run('window.lumen.reading.all()');
    const keys = Object.keys(all);
    assert(keys.length >= 1, 'reading store empty');
    const anySeven = keys.some((k) => all[k].page === 7);
    assert(anySeven, 'page 7 was not remembered');
    return `${keys.length} 条进度，含第 7 页`;
  });

  /* ------------------------------------------------- 2. error resilience */
  await check('容错', '损坏/非法文件被拒绝且不崩溃', async () => {
    const before = await run('window.__lumenTestState().tabs.length');
    await open([path.join(EDGE, 'not-a-pdf.pdf'), path.join(EDGE, 'empty.pdf'), path.join(EDGE, 'truncated.pdf')], 3200);
    const after = await run('JSON.stringify(window.__lumenTestState())').then(JSON.parse);
    const survived = after.tabs.length >= before;
    assert(survived, 'tab list shrank after bad files');
    // the app must still be interactive
    const ok = await run('document.querySelectorAll("#tabstrip .tab").length > 0');
    assert(ok, 'tab strip vanished');
    // and a good file must still open
    await open([path.join(SAMPLES, 'sample-tiny.pdf')], 2000);
    const st = await run('JSON.stringify(window.__lumenTestState())').then(JSON.parse);
    assert(st.active && st.active.loaded, 'app could not open a good file after bad ones');
    return `坏文件 ${after.tabs.length - before} 个被安全拒绝，之后仍可正常打开`;
  });

  /* --------------------------------------------------------- 3. navigation */
  await check('导航', '页码输入跳转 + 边界钳制', async () => {
    await reset([path.join(SAMPLES, 'sample-small.pdf')]);
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tab = window.__lumenTestRun(app => app.active);
      const input = document.querySelector('#page-input');
      const o = {};
      const setPage = (v) => { input.focus(); input.value = String(v);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); };
      setPage(5); await sleep(700); o.p5 = tab.page;
      setPage(999); await sleep(700); o.clampHigh = tab.page;
      setPage(-3); await sleep(700); o.clampLow = tab.page;
      setPage(1); await sleep(500);
      o.total = document.querySelector('#page-total').textContent.trim();
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    assert(out.p5 === 5, `page input jump failed: ${out.p5}`);
    assert(out.clampHigh === 12, `high clamp failed: ${out.clampHigh}`);
    assert(out.clampLow === 1, `low clamp failed: ${out.clampLow}`);
    assert(out.total === '/ 12', `page total wrong: ${out.total}`);
    return `5→${out.p5}, 999→${out.clampHigh}, -3→${out.clampLow}, 总数 ${out.total}`;
  });

  await check('导航', '上一页/下一页按钮与键盘', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tab = window.__lumenTestRun(app => app.active);
      const o = {};
      document.querySelector('#btn-page-next').click(); await sleep(500); o.next = tab.page;
      document.querySelector('#btn-page-prev').click(); await sleep(500); o.prev = tab.page;
      window.__lumenTestRun((app, ctx) => ctx.bus.emit('ui:focus-viewer'));
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    assert(out.next === 2, `next button failed: ${out.next}`);
    assert(out.prev === 1, `prev button failed: ${out.prev}`);
    return `next→${out.next}, prev→${out.prev}`;
  });

  await check('导航', 'Home / End / PgDn / PgUp 快捷键', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tab = window.__lumenTestRun(app => app.active);
      const send = (key, opts = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
      const o = {};
      send('End'); await sleep(600); o.end = tab.page;
      send('Home'); await sleep(600); o.home = tab.page;
      send('PageDown'); await sleep(500); o.pgdn = tab.page;
      send('PageUp'); await sleep(500); o.pgup = tab.page;
      send('j'); await sleep(500); o.j = tab.page;
      send('k'); await sleep(500); o.k = tab.page;
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    assert(out.end === 12, `End failed: ${out.end}`);
    assert(out.home === 1, `Home failed: ${out.home}`);
    assert(out.pgdn === 2 && out.pgup === 1, `PgUp/PgDn failed: ${out.pgdn}/${out.pgup}`);
    assert(out.j === 2 && out.k === 1, `J/K failed: ${out.j}/${out.k}`);
    return `End→${out.end} Home→${out.home} PgDn→${out.pgdn} J→${out.j}`;
  });

  await check('导航', '文档内前进/后退历史', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tab = window.__lumenTestRun(app => app.active);
      const o = { pages: tab.pageCount, recorded: 0 };
      tab.setPage(3); await sleep(800);
      tab.setPage(9); await sleep(1000);
      o.hasHistory = !!tab.history;
      o.hash = location.hash;
      if (tab.history) tab.history.back();
      await sleep(1200);
      o.back = tab.page;
      if (tab.history) tab.history.forward();
      await sleep(1200);
      o.forward = tab.page;
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    assert(out.pages === 12, `history test ran on a ${out.pages}-page document`);
    assert(out.hasHistory, 'viewer has no PDFHistory instance');
    assert(out.back !== 9, `history back did nothing (page ${out.back}, hash "${out.hash}")`);
    assert(out.forward === 9, `history forward did not return to 9 (got ${out.forward})`);
    return `3→9→back ${out.back}→forward ${out.forward}`;
  });

  await check('导航', '目录点击跳转', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tab = window.__lumenTestRun(app => app.active);
      window.__lumenTestRun((app) => app.sidebar.setPane('outline'));
      await sleep(800);
      const rows = [...document.querySelectorAll('#outline-list .outline-row')];
      const o = { rows: rows.length, pages: [...document.querySelectorAll('#outline-list .outline-page')].map(n => n.textContent) };
      if (rows.length) { rows[rows.length - 1].click(); await sleep(900); o.landed = tab.page; }
      window.__lumenTestRun((app) => app.sidebar.setPane('thumbnails'));
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    assert(out.rows >= 2, `outline rows: ${out.rows}`);
    assert(out.landed === 11, `outline jump landed on ${out.landed}, expected 11`);
    return `${out.rows} 条目录，跳到第 ${out.landed} 页`;
  });

  await check('导航', '侧边栏缩略图点击跳转', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tab = window.__lumenTestRun(app => app.active);
      window.__lumenTestRun((app) => app.sidebar.setPane('thumbnails'));
      await sleep(1600);
      const thumbs = [...document.querySelectorAll('#thumb-list .thumb')];
      const o = { count: thumbs.length };
      const target = thumbs[5];
      if (target) { target.click(); await sleep(900); o.landed = tab.page; o.current = document.querySelectorAll('#thumb-list .thumb.current').length; }
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    assert(out.count >= 12, `thumbnails rendered: ${out.count}`);
    assert(out.landed === 6, `thumbnail click landed on ${out.landed}`);
    assert(out.current === 1, `current highlight count: ${out.current}`);
    return `${out.count} 个缩略图，点击第 6 个 → 第 ${out.landed} 页`;
  });

  /* ------------------------------------------------------------- 4. search */
  await check('搜索', '全文搜索命中数与计数显示', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tab = window.__lumenTestRun(app => app.active);
      document.querySelector('#btn-find').click();
      await sleep(300);
      const input = document.querySelector('#find-input');
      input.value = 'lorem';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(1800);
      const o = {
        counter: document.querySelector('#find-counter').textContent,
        hits: document.querySelectorAll('.textLayer .highlight').length,
        findbarOpen: !document.querySelector('#findbar').hidden,
        query: tab._findQuery,
      };
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    assert(out.findbarOpen, 'findbar did not open');
    assert(out.query === 'lorem', `query not registered: ${out.query}`);
    assert(out.hits > 0, 'no search hits highlighted');
    assert(/^\d+\/12$/.test(out.counter), `counter looks wrong: ${out.counter}`);
    return `计数器 ${out.counter}，高亮 ${out.hits} 处`;
  });

  await check('搜索', '下一个/上一个命中与自动滚动', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tab = window.__lumenTestRun(app => app.active);
      const startPage = tab.page;
      document.querySelector('#find-next').click(); await sleep(900);
      const afterNext = { page: tab.page, counter: document.querySelector('#find-counter').textContent };
      document.querySelector('#find-prev').click(); await sleep(900);
      const afterPrev = { counter: document.querySelector('#find-counter').textContent };
      return JSON.stringify({ startPage, afterNext, afterPrev });
    })()`).then(JSON.parse);
    assert(out.afterNext.counter !== '0/0', 'next hit left the counter at 0/0');
    assert(out.afterPrev.counter !== '0/0', 'prev hit left the counter at 0/0');
    return `next ${out.afterNext.counter} · prev ${out.afterPrev.counter}`;
  });

  await check('搜索', '查找选项（区分大小写 / 全字 / 全部高亮）', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tab = window.__lumenTestRun(app => app.active);
      const input = document.querySelector('#find-input');
      const setQ = (q) => { input.value = q; input.dispatchEvent(new Event('input', { bubbles: true })); };
      const o = {};
      const probe = () => {
        const fc = tab.findController;
        return {
          counter: document.querySelector('#find-counter').textContent,
          q: fc && fc.state ? fc.state.query : null,
          cs: fc && fc.state ? fc.state.caseSensitive : null,
          type: fc && fc.state ? fc.state.type : null,
          perPage: fc && fc.pageMatches ? fc.pageMatches.map((m) => (m || []).length) : null,
          total: fc ? fc._matchesCountTotal : null,
          selected: fc && fc._selected ? [fc._selected.pageIdx, fc._selected.matchIdx] : null,
        };
      };
      o.probes = [];
      setQ('Chapter'); await sleep(1600); o.base = document.querySelector('#find-counter').textContent;
      o.probes.push(['Chapter ci', probe()]);
      document.querySelector('#find-case').click(); await sleep(1600);
      o.caseOn = document.querySelector('#find-counter').textContent;
      o.probes.push(['Chapter cs', probe()]);
      o.caseActive = document.querySelector('#find-case').classList.contains('active');
      o.storedFlag = window.__lumenTestRun((app, ctx) => ctx.store.get('findbar', {}).caseSensitive);
      o.controllerState = (() => {
        const fc = tab.findController;
        const st = fc && fc.state ? fc.state : null;
        return st ? { query: st.query, caseSensitive: st.caseSensitive, type: st.type } : null;
      })();
      o.rawProbe = (() => {
        const fc = tab.findController;
        if (!fc) return null;
        return {
          state: fc.state ? { q: fc.state.query, cs: fc.state.caseSensitive, type: fc.state.type } : null,
          perPage: fc.pageMatches ? fc.pageMatches.map((m) => (m || []).length) : null,
          total: fc._matchesCountTotal,
          selected: fc._selected ? { page: fc._selected.pageIdx, idx: fc._selected.matchIdx } : null,
        };
      })();
      setQ('chapter'); await sleep(1800); o.lowerWithCase = document.querySelector('#find-counter').textContent;
      o.probes.push(['chapter cs', probe()]);
      document.querySelector('#find-case').click(); await sleep(1800);
      o.probes.push(['chapter ci', probe()]);
      setQ('lorem'); await sleep(1500);
      document.querySelector('#find-highlightall').click(); await sleep(1200);
      o.highlightAllOff = document.querySelectorAll('.textLayer .highlight').length;
      document.querySelector('#find-highlightall').click(); await sleep(1200);
      o.highlightAllOn = document.querySelectorAll('.textLayer .highlight').length;
      document.querySelector('#find-close').click(); await sleep(400);
      o.closed = document.querySelector('#findbar').hidden;
      // ground truth: how many times does each casing actually occur?
      const text = await tab.pageText(1);
      o.textHasUpper = (text.match(/Chapter/g) || []).length;
      o.textHasLower = (text.match(/chapter/g) || []).length;
      o.probes.push(['after all', probe()]);
      o.findQuery = tab._findQuery;
      o.findState = tab.findController.state ? { q: tab.findController.state.query, cs: tab.findController.state.caseSensitive } : null;
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    assert(out.caseActive, 'case-sensitivity chip did not toggle');
    // the counter is either "n/total" or the localised not-found label, which
    // is the app's way of saying zero matches
    const num = (v) => {
      const str = String(v);
      if (str === NOT_FOUND) return 0;
      const m = /^(\d+)\/(\d+)$/.exec(str);
      return m ? Number(m[1]) : -1;
    };
    assert(out.storedFlag === true, `case chip did not persist its flag: ${out.storedFlag}`);
    // With "match case" on, a lowercase query must find nothing because the
    // document only contains the capitalised form.
    assert(out.textHasLower === 0, `document unexpectedly contains lowercase: ${out.textHasLower}`);
    assert(out.textHasUpper > 0, 'document has no capitalised matches');
    assert(
      num(out.lowerWithCase) === 0,
      `lowercase must not match with case on: ${out.lowerWithCase} probes=${JSON.stringify(out.probes)}`,
    );
    assert(num(out.base) > 0, `mixed-case query found nothing: ${out.base}`);
    assert(num(out.caseOn) > 0, `case-sensitive query found nothing: ${out.caseOn}`);
    assert(
      out.highlightAllOff <= 2,
      `highlight-all off left ${out.highlightAllOff} hits (expected the highlights to be cleared)`,
    );
    assert(out.highlightAllOn > 0, 'highlight-all on produced no hits');
    assert(out.closed, 'findbar did not close');
    return (
      `区分大小写生效（小写→${out.lowerWithCase}，原始计数 ${JSON.stringify(out.rawProbe && out.rawProbe.perPage)}` +
      ` 总 ${out.rawProbe && out.rawProbe.total}）`
    );
  });

  await check('搜索', '结果列表可见且可跳转', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tab = window.__lumenTestRun(app => app.active);
      document.querySelector('#btn-find').click(); await sleep(300);
      const input = document.querySelector('#find-input');
      input.value = 'lorem'; input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(1800);
      document.querySelector('#find-results-toggle').click(); await sleep(1200);
      const rows = [...document.querySelectorAll('#find-results .find-result')];
      const o = { rows: rows.length, header: (document.querySelector('#find-results .pane-toolbar') || {}).textContent };
      const last = rows[rows.length - 1];
      if (last) { last.click(); await sleep(900); o.landed = tab.page; }
      document.querySelector('#find-close').click(); await sleep(300);
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    assert(out.rows > 0, 'result list is empty');
    assert(out.landed > 1, `clicking the last result did not move (page ${out.landed})`);
    return `${out.rows} 条结果，末条跳到第 ${out.landed} 页`;
  });

  /* -------------------------------------------------------- 5. view / zoom */
  await check('视图', '缩放预设与 +/- 步进', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tab = window.__lumenTestRun(app => app.active);
      const o = { presets: {} };
      for (const p of ['page-actual', 'page-fit', 'page-width', 'page-height', 'auto']) {
        tab.setZoom(p); await sleep(500);
        o.presets[p] = Math.round((tab.viewer.currentScale) * 100) / 100;
        o.readout = document.querySelector('#btn-zoom').textContent;
      }
      document.querySelector('#btn-zoom-in').click(); await sleep(600);
      o.afterZoomIn = Math.round(tab.viewer.currentScale * 100) / 100;
      document.querySelector('#btn-zoom-out').click(); await sleep(600);
      o.afterZoomOut = Math.round(tab.viewer.currentScale * 100) / 100;
      o.toolbarText = document.querySelector('#btn-zoom').textContent;
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    const p = out.presets;
    assert(p['page-actual'] === 1, `actual size should be 1.0, got ${p['page-actual']}`);
    assert(p['page-fit'] > 0 && p['page-width'] > 0 && p['page-height'] > 0, 'a preset did not apply');
    assert(p['page-width'] !== p['page-actual'], 'presets produce the same scale');
    assert(out.afterZoomIn > p.auto, `zoom-in did not increase scale (${out.afterZoomIn} vs ${p.auto})`);
    assert(out.afterZoomOut < out.afterZoomIn, 'zoom-out did not decrease scale');
    return `实际 ${p['page-actual']} · 适合宽 ${p['page-width']} · 适合页 ${p['page-fit']} · 工具行读数 ${out.toolbarText}`;
  });

  await check('视图', '旋转（相对 + 绝对复位）', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tab = window.__lumenTestRun(app => app.active);
      const o = {};
      tab.setRotation(0); await sleep(400);
      document.querySelector('#btn-rotate-cw').click(); await sleep(600); o.cw1 = tab.rotation;
      document.querySelector('#btn-rotate-ccw').click(); await sleep(600); o.ccw1 = tab.rotation;
      const pv = () => tab.viewer.getPageView(0).viewport;
      o.vpAt0 = pv().rotation;
      tab.rotateBy(90); await sleep(700);
      o.at90 = tab.rotation;
      o.vpAt90 = pv().rotation;
      const b90 = document.querySelector('.pdf-container:not([hidden]) .page').getBoundingClientRect();
      o.landscapeAt90 = b90.width > b90.height;
      tab.rotateBy(90); await sleep(700);
      o.at180 = tab.rotation;
      tab.setRotation(0); await sleep(800);
      o.final = tab.rotation;
      o.vpFinal = pv().rotation;
      const b0 = document.querySelector('.pdf-container:not([hidden]) .page').getBoundingClientRect();
      o.portraitAt0 = b0.height > b0.width;
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    assert(out.cw1 === 90, `rotate cw: ${out.cw1}`);
    assert(out.ccw1 === 0, `rotate ccw: ${out.ccw1}`);
    assert(out.at180 === 180, `two rotations: ${out.at180}`);
    assert(out.vpAt90 === 90 && out.landscapeAt90, `90° viewport geometry wrong (${out.vpAt90})`);
    assert(out.portraitAt0 && out.final === 0 && out.vpFinal === 0, `rotation reset failed (${out.final})`);
    return `0→90(横置)→180→复位 0`;
  });

  await check('视图', '四种滚动方式与三种对开', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tab = window.__lumenTestRun(app => app.active);
      const visibleViewer = () => document.querySelector('.pdf-container:not([hidden]) .pdfViewer');
      const rects = () => [...visibleViewer().querySelectorAll('.page')].slice(0,3)
        .map(p => { const r = p.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; });
      const o = {};
      tab.setZoom('auto'); await sleep(500);
      tab.setScrollMode('vertical'); tab.setPageMode('single'); await sleep(700);
      o.vertical = rects();
      tab.setScrollMode('horizontal'); await sleep(700);
      o.horizontal = rects();
      tab.setScrollMode('vertical'); await sleep(500);
      tab.setPageMode('spread-odd'); await sleep(700);
      o.spreadOdd = rects();
      tab.setPageMode('single'); await sleep(500);
      tab.setScrollMode('page'); await sleep(700);
      o.pageMode = rects();
      tab.setScrollMode('vertical'); await sleep(600);
      tab.setPage(1);
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    const v = out.vertical;
    assert(v.length >= 2 && v[0][0] === v[1][0] && v[1][1] > v[0][1], 'vertical stacking wrong');
    const h = out.horizontal;
    assert(h.length >= 2 && h[0][1] === h[1][1] && h[1][0] > h[0][0], 'horizontal stacking wrong');
    const s = out.spreadOdd;
    assert(s.length >= 2 && s[0][1] === s[1][1] && s[1][0] > s[0][0], 'spread-odd pairing wrong');
    assert(out.pageMode.length === 1, `page mode should show one page, shows ${out.pageMode.length}`);
    return `垂直/水平/双页/整页 坐标断言通过`;
  });

  await check('视图', '手形工具与空格滚屏', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tab = window.__lumenTestRun(app => app.active);
      const o = {};
      document.querySelector('#btn-hand').click(); await sleep(400);
      o.handBodyClass = document.body.classList.contains('hand-tool');
      o.handActive = document.querySelector('#btn-hand').classList.contains('active');
      o.tool = window.__lumenTestState().tool;
      const before = tab.scroller.scrollTop;
      tab.scrollBy(0, 600); await sleep(700);
      o.scrolled = tab.scroller.scrollTop > before;
      document.querySelector('#btn-hand').click(); await sleep(300);
      o.handOff = !document.body.classList.contains('hand-tool');
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    assert(out.handBodyClass && out.handActive && out.tool === 'hand', 'hand tool did not activate');
    assert(out.scrolled, 'programmatic scroll did nothing');
    assert(out.handOff, 'hand tool did not turn off');
    return `手形工具开关正常，滚动生效`;
  });

  await check('视图', '主题切换与夜间纸张', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const o = { themes: {} };
      for (const th of ['light', 'dark', 'sepia', 'night']) {
        window.__lumenTestRun((app, ctx) => ctx.store.set('theme', th));
        await sleep(320);
        o.themes[th] = document.documentElement.dataset.theme;
      }
      window.__lumenTestRun((app, ctx) => ctx.store.set('theme', 'light')); await sleep(300);
      window.__lumenTestRun((app, ctx) => ctx.toggleInvert()); await sleep(500);
      o.invertOn = document.body.classList.contains('invert-mode');
      o.filter = getComputedStyle(document.querySelector('.pdf-container .canvasWrapper')).filter;
      window.__lumenTestRun((app, ctx) => ctx.toggleInvert()); await sleep(500);
      o.invertOff = !document.body.classList.contains('invert-mode');
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    for (const th of ['light', 'dark', 'sepia', 'night']) {
      assert(out.themes[th] === th, `theme ${th} did not apply (got ${out.themes[th]})`);
    }
    assert(out.invertOn && out.invertOff, 'night paper toggle failed');
    assert(/invert/.test(out.filter), `canvas filter not applied: ${out.filter}`);
    return `四套主题 + 夜间纸张反色（${out.filter.slice(0, 28)}…）`;
  });

  await check('视图', '侧边栏显示/隐藏与缩放', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const o = {};
      const sb = document.querySelector('#sidebar');
      o.initiallyVisible = !sb.hidden;
      document.querySelector('#btn-sidebar').click(); await sleep(400);
      o.hiddenAfterClick = sb.hidden;
      document.querySelector('#btn-sidebar').click(); await sleep(400);
      o.visibleAgain = !sb.hidden;
      const w0 = sb.getBoundingClientRect().width;
      document.documentElement.style.setProperty('--sidebar-w', (w0 + 80) + 'px');
      await sleep(300);
      o.grew = document.querySelector('#sidebar').getBoundingClientRect().width > w0 + 40;
      document.documentElement.style.setProperty('--sidebar-w', w0 + 'px');
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    assert(out.initiallyVisible, 'sidebar should be visible by default');
    assert(out.hiddenAfterClick && out.visibleAgain, 'sidebar toggle failed');
    assert(out.grew, 'sidebar width did not follow the CSS variable');
    return `显示/隐藏/宽度调节正常`;
  });

  await check('视图', '演示模式进入与退出', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const o = {};
      o.before = document.body.classList.contains('presentation');
      document.querySelector('#btn-view') && null;
      window.__lumenTestRun(() => {}); // noop to keep hook warm
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true, cancelable: true }));
      await sleep(1200);
      o.during = document.body.classList.contains('presentation');
      o.chromeHidden = getComputedStyle(document.querySelector('.chrome')).display === 'none';
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await sleep(1400);
      o.after = document.body.classList.contains('presentation');
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    assert(!out.before && out.during, 'F5 did not enter presentation mode');
    assert(out.chromeHidden, 'chrome was not hidden in presentation mode');
    assert(!out.after, 'Escape did not leave presentation mode');
    return `F5 进入（隐藏 chrome）→ Esc 退出`;
  });

  /* ------------------------------------------------------ 6. tabs & session */
  await check('标签页', '切换 / 关闭 / 中键关闭', async () => {
    await reset(
      [
        path.join(SAMPLES, 'sample-small.pdf'),
        path.join(SAMPLES, 'sample-tiny.pdf'),
        path.join(SAMPLES, 'sample-landscape.pdf'),
      ],
      3200,
    );
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const o = {};
      const tabs = () => [...document.querySelectorAll('#tabstrip .tab')];
      o.count = tabs().length;
      if (o.count >= 2) {
        tabs()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        await sleep(600);
        o.activeTitle = document.querySelector('#tabstrip .tab.active .tab-title').textContent;
        const before = tabs().length;
        tabs()[tabs().length - 1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 1 }));
        await sleep(900);
        o.closedByMiddleClick = tabs().length === before - 1;
      }
      o.remaining = tabs().length;
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    assert(out.count >= 2, `expected several tabs, got ${out.count}`);
    assert(out.closedByMiddleClick, 'middle-click did not close a tab');
    assert(out.remaining === out.count - 1, `tab count wrong after close: ${out.remaining}`);
    return `${out.count} → 切换 → 中键关闭 → ${out.remaining}`;
  });

  await check('标签页', '会话保存与恢复', async () => {
    const saved = await run('window.lumen.session.get()');
    assert(Array.isArray(saved.tabs) && saved.tabs.length >= 1, `session has no tabs: ${JSON.stringify(saved)}`);
    const st = await run('JSON.stringify(window.__lumenTestState())').then(JSON.parse);
    assert(saved.tabs.length === st.tabs.length, `session ${saved.tabs.length} vs open ${st.tabs.length}`);
    return `会话记录 ${saved.tabs.length} 个文件`;
  });

  /* ---------------------------------------------------------- 7. annotations */
  /**
   * Opens a fresh copy of the sample, switches to the highlighter and drags a
   * real mouse selection across a line of text. Returns the store size and the
   * screen position of the created highlight.
   */
  /**
   * Creates one highlight deterministically.
   *
   * The genuine pointer gesture is covered by the first annotation check; the
   * remaining checks need a repeatable starting point, so they drive the same
   * editor through its own `highlightSelection` entry point with a real text
   * selection. This keeps them independent of synthetic-input timing.
   */
  const makeHighlight = async (label = 'annotation') => {
    const target = path.join(OUT_DIR, `feat-${label}.pdf`);
    fs.copyFileSync(path.join(SAMPLES, 'sample-small.pdf'), target);
    await reset([target], 2800);
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tab = window.__lumenTestRun((app) => app.active);
      tab.setRotation(0);
      tab.setPageMode('single');
      tab.setScrollMode('vertical');
      tab.setZoom('page-width');
      tab.setPage(1);
      await sleep(1300);
      window.__lumenTestRun((app, ctx) => ctx.setTool('highlight'));
      await sleep(900);
      const pv = tab.viewer.getPageView(0);
      const span = [...pv.div.querySelectorAll('.textLayer span')].filter((s) => s.textContent.trim().length > 4)[3];
      if (!span) return JSON.stringify({ error: 'no text span' });
      const range = document.createRange();
      range.selectNodeContents(span);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const manager = tab.editorUiManager;
      if (!manager || typeof manager.highlightSelection !== 'function') {
        return JSON.stringify({ error: 'editor manager unavailable' });
      }
      manager.highlightSelection('highlight');
      await sleep(1600);
      const serial = tab.doc.annotationStorage.serializable;
      const size = serial && serial.map && typeof serial.map.size === 'number'
        ? serial.map.size : Object.keys((serial && serial.map) || {}).length;
      const rect = span.getBoundingClientRect();
      return JSON.stringify({
        size,
        geo: { x1: Math.round(rect.left + 2), x2: Math.round(rect.right - 2), y: Math.round(rect.top + rect.height / 2) },
        tool: tab.tool,
      });
    })()`).then(JSON.parse);
    assert(!out.error, `${out.error} (${label})`);
    return { size: out.size, geo: out.geo, path: target, diag: out };
  };

  await check('批注', '真实鼠标拖拽生成高亮（整条链路）', async () => {
    const target = path.join(OUT_DIR, 'feat-drag.pdf');
    fs.copyFileSync(path.join(SAMPLES, 'sample-small.pdf'), target);
    await reset([target], 3000);
    const editable = await canAnnotate();
    assert(editable === true, `annotation editor unavailable: ${editable}`);

    // lay the page out, then arm the highlighter — exactly what a user does
    await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tab = window.__lumenTestRun((app) => app.active);
      tab.setRotation(0);
      tab.setPageMode('single');
      tab.setScrollMode('vertical');
      tab.setZoom('page-width');
      tab.setPage(1);
      await sleep(1400);
      window.__lumenTestRun((app, ctx) => ctx.setTool('highlight'));
      await sleep(1000);
      return true;
    })()`);
    await sleep(600);

    const geo = await run(`JSON.stringify((() => {
      const tab = window.__lumenTestRun((app) => app.active);
      const pv = tab.viewer.getPageView(0);
      const spans = [...pv.div.querySelectorAll('.textLayer span')].filter((s) => s.textContent.trim().length > 4);
      const el = spans[3] || spans[0];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x1: Math.round(r.left + 2), x2: Math.round(r.right - 2), y: Math.round(r.top + r.height / 2) };
    })())`).then(JSON.parse);
    assert(geo, 'no text span available to drag over');

    await drag(geo.x1, geo.y, geo.x2, geo.y, 12);
    await sleep(2200);

    const out = await run(`(() => {
      const tab = window.__lumenTestRun((app) => app.active);
      const serial = tab.doc.annotationStorage.serializable;
      const size = serial && serial.map && typeof serial.map.size === 'number'
        ? serial.map.size : Object.keys((serial && serial.map) || {}).length;
      return { size, listed: tab.listAnnotations().length, dirty: tab.dirty };
    })()`);
    assert(out.size >= 1, `a real drag did not create a highlight (store ${out.size})`);
    assert(out.listed >= 1, 'annotation list is empty after highlighting');
    assert(out.dirty, 'document not marked dirty after annotating');
    return `(${geo.x1},${geo.y})→(${geo.x2},${geo.y}) → 存储 ${out.size} 条，列表 ${out.listed} 条，dirty=${out.dirty}`;
  });

  await check('批注', '撤销 / 重做', async () => {
  const made = await makeHighlight('undo');
    assert(made.size >= 1, `precondition failed: no highlight (${made.size}, ${JSON.stringify(made.diag)})`);
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tab = window.__lumenTestRun((app) => app.active);
      const size = () => {
        const s = tab.doc.annotationStorage.serializable;
        return s && s.map && typeof s.map.size === 'number' ? s.map.size : Object.keys((s && s.map) || {}).length;
      };
      const o = { before: size() };
      o.undoReturned = tab.undo();
      await sleep(1200);
      o.afterUndo = size();
      o.redoReturned = tab.redo();
      await sleep(1200);
      o.afterRedo = size();
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    assert(out.undoReturned === true, 'undo() reported failure');
    assert(out.afterUndo === out.before - 1, `undo did not remove the highlight (${out.before}→${out.afterUndo})`);
    assert(out.redoReturned === true, 'redo() reported failure');
    assert(out.afterRedo === out.before, `redo did not restore the highlight (${out.afterRedo})`);
    return `${out.before} → undo ${out.afterUndo} → redo ${out.afterRedo}`;
  });

  await check('批注', '删除选中批注（编辑栏 / 工具模式 / API 诚实性）', async () => {
    const target = path.join(OUT_DIR, 'feat-delete.pdf');
    fs.copyFileSync(path.join(SAMPLES, 'sample-small.pdf'), target);
    await reset([target], 2800);

    const size = () => run(`(() => {
      const tab = window.__lumenTestRun((app) => app.active);
      const s = tab.doc.annotationStorage.serializable;
      return s && s.map && typeof s.map.size === 'number' ? s.map.size : Object.keys((s && s.map) || {}).length;
    })()`);

    // 1. with nothing selected the API must report failure, not claim success
    await run(`window.__lumenTestRun((app, ctx) => ctx.setTool('select'))`);
    await sleep(500);
    const honest = await run(`(() => window.__lumenTestRun((app) => app.active).deleteSelectedAnnotation())()`);
    assert(honest === false, 'delete reported success with nothing selected');
    assert((await size()) === 0, 'a failed delete changed the store');

    // 2. erase mode is a picking mode and must not edit anything by itself
    const eraseTool = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      document.querySelector('#btn-erase').click();
      await sleep(700);
      return { tool: window.__lumenTestState().tool, active: document.querySelector('#btn-erase').classList.contains('active') };
    })()`);
    assert(eraseTool.tool === 'erase' && eraseTool.active, `erase mode did not arm (${JSON.stringify(eraseTool)})`);
    assert((await size()) === 0, 'arming erase edited the document');

    // 3. create a highlight; the editor leaves the new one selected, so delete
    //    must now succeed and shrink the store
    const made = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tab = window.__lumenTestRun((app) => app.active);
      tab.setRotation(0);
      tab.setZoom('page-width');
      tab.setPage(1);
      await sleep(1200);
      window.__lumenTestRun((app, ctx) => ctx.setTool('highlight'));
      await sleep(800);
      const pv = tab.viewer.getPageView(0);
      const span = [...pv.div.querySelectorAll('.textLayer span')].filter((s) => s.textContent.trim().length > 4)[3];
      if (!span) return JSON.stringify({ error: 'no span' });
      const range = document.createRange();
      range.selectNodeContents(span);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      tab.editorUiManager.highlightSelection('highlight');
      await sleep(1500);
      const serial = tab.doc.annotationStorage.serializable;
      const n = serial && serial.map && typeof serial.map.size === 'number'
        ? serial.map.size : Object.keys((serial && serial.map) || {}).length;
      return JSON.stringify({ n, selected: tab.annotationSelected });
    })()`).then(JSON.parse);
    assert(!made.error, made.error || '');
    assert(made.n === 1, `highlight not created (${made.n})`);

    const deleted = await run(`(() => window.__lumenTestRun((app) => app.active).deleteSelectedAnnotation())()`);
    await sleep(1200);
    const after = await size();
    await run(`window.__lumenTestRun((app, ctx) => ctx.setTool('select'))`);
    await sleep(400);

    if (made.selected) {
      assert(deleted === true, 'delete reported failure while the new highlight was selected');
      assert(after === 0, `delete did not remove the highlight (store ${after})`);
      return `无选中时拒绝删除；编辑后删除 → 批注 1 → ${after}`;
    }
    assert(deleted === false, 'delete reported success without a selection');
    return `无选中时拒绝删除（编辑器未保持选中，selection=${made.selected}）`;
  });

  await check('批注', '批注本地持久化与重新打开恢复', async () => {
    const made = await makeHighlight('persist');
    const before = await run(`(async () => {
      const tab = window.__lumenTestRun((app) => app.active);
      const serial = tab.doc.annotationStorage.serializable;
      const live = serial && serial.map && typeof serial.map.size === 'number'
        ? serial.map.size : Object.keys((serial && serial.map) || {}).length;
      await tab.persistAnnotations();
      const key = typeof tab.docKey === 'function' ? tab.docKey() : tab.path;
      await new Promise((r) => setTimeout(r, 500));
      const saved = await window.lumen.annotations.get(key);
      const stored = saved && saved.serialized ? Object.keys(JSON.parse(saved.serialized)).length : 0;
      return { live, stored, path: tab.path };
    })()`);
    assert(before.live >= 1, `nothing to persist (live ${before.live})`);
    assert(before.stored === before.live, `stored ${before.stored} != live ${before.live}`);

    await reset([before.path], 3000);
    const after = await run(`(async () => {
      const tab = window.__lumenTestRun((app) => app.active);
      for (let i = 0; i < 15; i += 1) {
        const s = tab.doc.annotationStorage.serializable;
        const n = s && s.map && typeof s.map.size === 'number' ? s.map.size : Object.keys((s && s.map) || {}).length;
        if (n > 0) return { restored: n, waited: i };
        await new Promise((r) => setTimeout(r, 400));
      }
      const s = tab.doc.annotationStorage.serializable;
      return { restored: s && s.map ? Object.keys(s.map).length : 0, waited: 15 };
    })()`);
    assert(after.restored === before.live, `restore lost annotations: ${after.restored} vs ${before.live}`);
    return `写入 ${before.stored} 条 → 重新打开 ${after.waited * 400}ms 后恢复 ${after.restored} 条`;
  });

  await check('批注', '批注写回 PDF 并可再次打开', async () => {
    const target = path.join(OUT_DIR, 'feat-annotated.pdf');
    const out = await run(`(async () => {
      const tab = window.__lumenTestRun(app => app.active);
      const res = await tab.saveCopy(${JSON.stringify(target)});
      return JSON.stringify({ ok: res.ok, error: res.error || null, bytes: res.ok ? (await window.lumen.fs.stat(${JSON.stringify(target)})).size : 0 });
    })()`).then(JSON.parse);
    assert(out.ok, `saveCopy failed: ${out.error}`);
    assert(out.bytes > 5000, `written file looks too small: ${out.bytes}`);
    await reset([target], 2800);
    const st = await run('JSON.stringify(window.__lumenTestState())').then(JSON.parse);
    assert(st.active.loaded && st.active.pageCount === 12, `annotated copy reopened as ${st.active.pageCount} pages`);
    return `${out.bytes} 字节，重新打开 ${st.active.pageCount} 页正常`;
  });

  await check('批注', '批注列表与定位', async () => {
    const made = await makeHighlight('pane');
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tab = window.__lumenTestRun((app) => app.active);
      window.__lumenTestRun((app) => app.sidebar.setPane('annotations'));
      await sleep(800);
      window.__lumenTestRun((app) => app.sidebar.renderAnnotations(true));
      await sleep(500);
      const rows = [...document.querySelectorAll('#annot-list .annot-row')];
      const o = { rows: rows.length, text: rows.map((r) => r.textContent.trim()), landed: null };
      if (rows.length) {
        tab.setPage(6);
        await sleep(600);
        rows[0].click();
        await sleep(800);
        o.landed = tab.page;
        o.flash = !!document.querySelector('.page.lumen-flash');
      }
      window.__lumenTestRun((app) => app.sidebar.setPane('thumbnails'));
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    assert(out.rows >= 1, `annotation pane shows ${out.rows} rows (${JSON.stringify(out.text)})`);
    assert(out.landed === 1, `annotation row did not jump to page 1 (landed ${out.landed})`);
    return `${out.rows} 条批注行，点击从第 6 页跳到第 ${out.landed} 页`;
  });

  /* --------------------------------------------------------- 8. bookmarks */
  await check('书签', '添加 / 跳转 / 删除', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tab = window.__lumenTestRun(app => app.active);
      window.__lumenTestRun((app) => app.sidebar.setPane('bookmarks'));
      await sleep(700);
      const before = tab.bookmarks.length;
      const added = await tab.addBookmark(4);
      await sleep(700);
      window.__lumenTestRun((app) => app.sidebar.setPane('bookmarks'));
      await sleep(600);
      const rows = [...document.querySelectorAll('#bookmark-list .bookmark-row')];
      const o = { before, added, after: tab.bookmarks.length, rows: rows.length };
      const target = rows.find(r => r.textContent.includes('4'));
      if (target) { target.click(); await sleep(700); o.landed = tab.page; }
      const dup = await tab.addBookmark(4);
      o.duplicateRejected = dup === false;
      if (tab.bookmarks.length) { await tab.removeBookmark(tab.bookmarks[tab.bookmarks.length - 1].id); await sleep(500); }
      o.afterRemove = tab.bookmarks.length;
      window.__lumenTestRun((app) => app.sidebar.setPane('thumbnails'));
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    assert(out.added === true, 'addBookmark returned false');
    assert(out.after === out.before + 1, `bookmark not stored (${out.before}→${out.after})`);
    assert(out.duplicateRejected, 'duplicate bookmark was accepted');
    assert(out.landed === 4, `bookmark jump landed on ${out.landed}`);
    assert(out.afterRemove === out.before, 'bookmark removal failed');
    return `添加→跳到第 ${out.landed} 页→拒绝重复→删除`;
  });

  /* ---------------------------------------------------------- 9. organizer */
  await check('页面整理', '打开 / 重排 / 旋转 / 保存', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      await window.__lumenOpenOrganizer();
      await sleep(2600);
      const org = window.__lumenOrganizer;
      if (!org || !org.sessionId) return JSON.stringify({ error: 'organizer did not open' });
      const o = { pages: org.state.pages.length, cells: document.querySelectorAll('.organizer-cell').length };
      const order = org.state.pages.map((_, i) => i);
      order.unshift(order.pop());
      await org.pushOp([{ type: 'reorder', order }]);
      await sleep(600);
      await org.pushOp([{ type: 'rotate', indices: [0], delta: 90 }]);
      await sleep(600);
      o.rotated = org.state.pages[0].rotate;
      await org.pushOp([{ type: 'remove', indices: [1] }]);
      await sleep(600);
      o.afterDelete = org.state.pages.length;
      const target = ${JSON.stringify(path.join(OUT_DIR, 'feat-organized.pdf'))};
      const saved = await window.lumen.edit.save({ sessionId: org.sessionId, target });
      o.saved = saved && saved.ok ? saved.pages : (saved && saved.error);
      o.thumbs = document.querySelectorAll('.organizer-thumb canvas').length;
      await org.close(true);
      await sleep(500);
      o.closed = !document.querySelector('.organizer');
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    assert(!out.error, out.error || '');
    assert(out.cells === out.pages, `grid ${out.cells} != model ${out.pages}`);
    assert(out.rotated === 90, `rotate op failed: ${out.rotated}`);
    assert(out.afterDelete === out.pages - 1, `delete op failed: ${out.afterDelete}`);
    assert(out.saved === out.pages - 1, `save reported ${out.saved} pages`);
    assert(out.closed, 'organizer did not close');
    return `${out.pages} 页 → 重排/旋转/删除 → 保存 ${out.saved} 页，缩略图 ${out.thumbs}`;
  });

  await check('页面整理', '整理结果可正常打开', async () => {
    await reset([path.join(OUT_DIR, 'feat-organized.pdf')], 2800);
    const st = await run('JSON.stringify(window.__lumenTestState())').then(JSON.parse);
    assert(st.active.loaded, 'organized file failed to load');
    const rot = await run(`JSON.stringify(window.__lumenTestRun(app => app.active).viewer.getPageView(0).viewport.rotation)`);
    assert(Number(rot) === 90, `first page rotation lost: ${rot}`);
    return `${st.active.pageCount} 页，首页 /Rotate=90`;
  });

  /* ----------------------------------------------------------- 10. exports */
  await check('导出', '页面转图片（PNG）', async () => {
    const tabPath = path.join(SAMPLES, 'sample-small.pdf');
    await reset([tabPath], 2800);
    const dir = path.join(OUT_DIR, 'feat-images');
    fs.mkdirSync(dir, { recursive: true });
    const out = await run(`(async () => {
      const tab = window.__lumenTestRun(app => app.active);
      const imgs = await tab.exportPageImages({ from: 1, to: 3, scale: 1, mime: 'image/png' });
      const res = [];
      for (const img of imgs) {
        const p = ${JSON.stringify(dir)} + '\\\\p' + img.index + '.' + img.ext;
        const w = await window.lumen.fs.write(p, img.data);
        res.push({ p, ok: w.ok, size: img.data.length, head: String.fromCharCode(img.data[0], img.data[1], img.data[2], img.data[3]) });
      }
      return JSON.stringify(res);
    })()`).then(JSON.parse);
    assert(out.length === 3, `exported ${out.length} images, expected 3`);
    for (const img of out) {
      assert(img.ok, `write failed for ${img.p}`);
      assert(img.size > 2000, `image too small: ${img.size}`);
      assert(img.head.includes('PNG'), `not a PNG: ${img.head}`);
    }
    return `3 张 PNG，最小 ${Math.min(...out.map((i) => i.size))} 字节`;
  });

  await check('导出', '导出文本', async () => {
    const target = path.join(OUT_DIR, 'feat-text.txt');
    const out = await run(`(async () => {
      const tab = window.__lumenTestRun(app => app.active);
      const parts = [];
      for (let i = 1; i <= tab.pageCount; i++) parts.push(await tab.pageText(i));
      const w = await window.lumen.fs.write(${JSON.stringify(target)}, parts.join('\\n\\n'));
      return JSON.stringify({ ok: w.ok, chars: parts.join('').length, nonEmptyPages: parts.filter(p => p.trim().length).length });
    })()`).then(JSON.parse);
    assert(out.ok, 'text export write failed');
    assert(out.chars > 500, `extracted only ${out.chars} chars`);
    assert(out.nonEmptyPages === 12, `only ${out.nonEmptyPages}/12 pages had text`);
    return `${out.chars} 字符，12/12 页有文本`;
  });

  await check('导出', '导出 HTML / 批注摘要', async () => {
    const htmlPath = path.join(OUT_DIR, 'feat-export.html');
    const mdPath = path.join(OUT_DIR, 'feat-export.md');
    const out = await run(`(async () => {
      const tab = window.__lumenTestRun(app => app.active);
      const text = [];
      for (let i = 1; i <= 3; i++) text.push(await tab.pageText(i));
      const html = '<!DOCTYPE html><html><body>' + text.map((t, i) => '<section><h2>' + (i+1) + '</h2><p>' + t.replace(/[<>&]/g, '') + '</p></section>').join('') + '</body></html>';
      const w1 = await window.lumen.fs.write(${JSON.stringify(htmlPath)}, html);
      const items = tab.listAnnotations();
      const md = ['# 摘要', ''].concat(items.map(x => '- ' + x.kind + ' p' + x.page)).join('\\n');
      const w2 = await window.lumen.fs.write(${JSON.stringify(mdPath)}, md);
      return JSON.stringify({ html: w1.ok, md: w2.ok, htmlBytes: html.length, mdLines: md.split('\\n').length });
    })()`).then(JSON.parse);
    assert(out.html && out.md, 'export write failed');
    assert(out.htmlBytes > 800, `html too small: ${out.htmlBytes}`);
    return `HTML ${out.htmlBytes} 字节，摘要 ${out.mdLines} 行`;
  });

  await check('导出', '打印渲染通道', async () => {
    const out = await run(`(async () => {
      const tab = window.__lumenTestRun(app => app.active);
      const page = await tab.doc.getPage(1);
      const vp = page.getViewport({ scale: 1 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
      const url = canvas.toDataURL('image/jpeg', 0.9);
      return JSON.stringify({ len: url.length, isJpeg: url.startsWith('data:image/jpeg') });
    })()`).then(JSON.parse);
    assert(out.isJpeg && out.len > 5000, `print raster path failed: ${out.len}`);
    return `打印用栅格 ${Math.round(out.len / 1024)} KB JPEG`;
  });

  /* -------------------------------------------------------- 11. UI surfaces */
  await check('界面', '命令面板可搜索并执行', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      document.querySelector('#btn-command').click();
      await sleep(700);
      const input = document.querySelector('#palette-input');
      const o = { open: !document.querySelector('#palette').hidden, items: document.querySelectorAll('.palette-item').length };
      input.value = '旋转';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(500);
      const filtered = [...document.querySelectorAll('.palette-item .pi-title')];
      o.filtered = filtered.length;
      o.firstTitle = filtered[0] ? filtered[0].textContent : null;
      input.value = 'page';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(500);
      o.pagesFound = [...document.querySelectorAll('.palette-item .pi-title')].length;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(400);
      o.closed = document.querySelector('#palette').hidden;
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    assert(out.open, 'palette did not open');
    assert(out.items > 20, `palette only lists ${out.items} items`);
    assert(out.filtered >= 1 && out.filtered < out.items, `filtering failed (${out.filtered}/${out.items})`);
    assert(out.closed, 'palette did not close on Escape');
    return `${out.items} 条命令，搜索「旋转」→ ${out.filtered} 条`;
  });

  await check('界面', '命令面板模糊搜索', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      document.querySelector('#btn-command').click();
      await sleep(700);
      const input = document.querySelector('#palette-input');
      const titles = () => [...document.querySelectorAll('.palette-item .pi-title')].map((n) => n.textContent);
      const probe = async (q) => {
        input.value = q;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(450);
        return { first: titles()[0] || null, count: titles().length, all: titles().slice(0, 4) };
      };
      const o = {};
      o.initials = await probe('opfo');
      o.english = await probe('eraser');
      o.wordBoundary = await probe('fit h');
      o.chinese = await probe('旋转');
      o.exact = await probe('打印');
      o.noMatch = await probe('zzzzqqq');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(400);
      return JSON.stringify(o);
    })()`).then(JSON.parse);

    // word-boundary and initials matching: "opfo" is not a substring of any title
    assert(/打开文件夹|Open Folder/.test(out.initials.first || ''), `initials search failed: ${out.initials.first}`);
    assert(out.initials.count >= 1 && out.initials.count <= 6, `initials search too noisy: ${out.initials.count} hits`);
    assert(out.english.count >= 1, `English keyword search found nothing: ${JSON.stringify(out.english)}`);
    assert(out.wordBoundary.count >= 1 && out.wordBoundary.count <= 8, `word search noisy: ${out.wordBoundary.count}`);
    assert(out.chinese.count >= 1, `Chinese query found nothing: ${JSON.stringify(out.chinese)}`);
    // a loose subsequence must not match everything
    assert(out.noMatch.count === 0, `a nonsense query matched ${out.noMatch.count} commands`);
    return (
      `opfo→「${out.initials.first}」(${out.initials.count}) · eraser→${out.english.count} 条 · ` +
      `fit h→${out.wordBoundary.count} 条 · 旋转→${out.chinese.count} 条 · 乱码→0 条`
    );
  });

  await check('界面', '主菜单与视图菜单弹出', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const o = {};
      document.querySelector('#btn-menu').click(); await sleep(500);
      o.menuItems = document.querySelectorAll('#main-menu .menu-item').length;
      o.menuHeaders = [...document.querySelectorAll('#main-menu .menu-group-label')].map(n => n.textContent);
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await sleep(300);
      o.closedAfterOutsideClick = document.querySelector('#main-menu').hidden;
      document.querySelector('#btn-view').click(); await sleep(500);
      o.viewItems = document.querySelectorAll('#main-menu .menu-item').length;
      o.checkedRows = document.querySelectorAll('#main-menu .menu-item.checked').length;
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await sleep(300);
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    assert(out.menuItems > 15, `main menu has ${out.menuItems} items`);
    assert(out.menuHeaders.length >= 5, `menu headers: ${out.menuHeaders.join(',')}`);
    assert(out.closedAfterOutsideClick, 'menu did not close on outside click');
    assert(out.viewItems > 20, `view menu has ${out.viewItems} items`);
    assert(out.checkedRows >= 1, 'view menu shows no current state');
    return `主菜单 ${out.menuItems} 项 / 视图菜单 ${out.viewItems} 项（${out.checkedRows} 项选中态）`;
  });

  await check('界面', '设置 / 属性 / 快捷键 / 关于 弹窗', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const closeModals = () => { for (const m of document.querySelectorAll('#modal-root .modal')) m.remove(); document.querySelector('#modal-root').hidden = true; };
      const o = {};
      window.__lumenTestRun((app, ctx) => ctx.openSettings()); await sleep(600);
      o.settingsPanes = document.querySelectorAll('.settings-nav button').length;
      o.settingsRows = document.querySelectorAll('.settings-pane:not([hidden]) .setting-row').length;
      closeModals(); await sleep(200);
      window.__lumenTestRun((app, ctx) => ctx.openProperties(app.active)); await sleep(1200);
      o.propRows = document.querySelectorAll('#modal-root .prop-table tr').length;
      closeModals(); await sleep(200);
      window.__lumenTestRun((app, ctx) => ctx.openShortcuts()); await sleep(600);
      o.shortcutRows = document.querySelectorAll('.keys-row').length;
      closeModals(); await sleep(200);
      window.__lumenTestRun((app, ctx) => ctx.openAbout()); await sleep(600);
      o.aboutShown = document.querySelectorAll('#modal-root .modal').length === 1;
      closeModals();
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    assert(out.settingsPanes === 5, `settings has ${out.settingsPanes} sections`);
    assert(out.settingsRows > 3, `settings pane shows ${out.settingsRows} rows`);
    assert(out.propRows > 8, `properties table has ${out.propRows} rows`);
    assert(out.shortcutRows > 20, `shortcut list has ${out.shortcutRows} rows`);
    assert(out.aboutShown, 'about dialog did not open');
    return `设置 ${out.settingsPanes} 节/${out.settingsRows} 行 · 属性 ${out.propRows} 行 · 快捷键 ${out.shortcutRows} 行`;
  });

  await check('界面', '最近阅读弹窗与置顶', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const items = await window.lumen.recents.list();
      const target = items[0].path;
      const pinned = await window.lumen.recents.pin(target, true);
      const o = { count: items.length, pinnedFlag: pinned.find(i => i.path === target).pinned };
      await window.lumen.recents.pin(target, false);
      const removed = await window.lumen.recents.remove(items[items.length - 1].path);
      o.afterRemove = removed.length;
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    assert(out.count >= 1, 'recents empty');
    assert(out.pinnedFlag === true, 'pin did not stick');
    assert(out.afterRemove === out.count - 1, `remove failed: ${out.afterRemove}`);
    return `${out.count} 条最近记录，置顶/删除正常`;
  });

  await check('界面', '状态提示与进度线', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tab = window.__lumenTestRun(app => app.active);
      const fill = document.querySelector('#progress-fill');
      tab.setPage(1); await sleep(600); const first = fill.style.width;
      tab.setPage(12); await sleep(900); const last = fill.style.width;
      const hint = document.querySelector('#status-hint').textContent;
      const rawHint = document.querySelector('#statusline').textContent;
      const tabs = window.__lumenTestRun((app) => app.tabs.length);
      const state = window.__lumenTestState();
      return JSON.stringify({ first, last, hint, rawHint, tabs, dirty: state.active && state.active.dirty });
    })()`).then(JSON.parse);
    assert(parseFloat(out.first) < 5, `progress at page 1 is ${out.first}`);
    assert(parseFloat(out.last) > 90, `progress at last page is ${out.last}`);
    assert(out.hint.length > 0, `status hint is empty (tabs=${JSON.stringify(out.tabs)}, raw=${JSON.stringify(out.rawHint)})`);
    return `进度 ${out.first} → ${out.last}，状态「${out.hint}」`;
  });

  /* ------------------------------------------------------- 12. persistence */
  await check('持久化', '设置项写入并立即生效', async () => {
    const out = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const o = {};
      window.__lumenTestRun((app, ctx) => ctx.store.set('showPageShadow', false)); await sleep(400);
      o.shadowOff = document.body.classList.contains('no-page-shadow');
      o.shadowValue = window.__lumenTestRun((app, ctx) => ctx.store.get('showPageShadow', true));
      window.__lumenTestRun((app, ctx) => ctx.store.set('showPageShadow', true)); await sleep(400);
      o.shadowBack = !document.body.classList.contains('no-page-shadow');
      window.__lumenTestRun((app, ctx) => ctx.store.set('animation', false)); await sleep(300);
      o.animOff = document.body.classList.contains('no-animation');
      window.__lumenTestRun((app, ctx) => ctx.store.set('animation', true)); await sleep(300);
      window.__lumenTestRun((app, ctx) => ctx.store.set('useSystemCursor', true)); await sleep(300);
      o.nativeCursor = document.body.classList.contains('using-native-cursor');
      window.__lumenTestRun((app, ctx) => ctx.store.set('useSystemCursor', false));
      o.persisted = await window.lumen.settings.all().then(s => s.showPageShadow === true && s.animation === true);
      return JSON.stringify(o);
    })()`).then(JSON.parse);
    assert(out.shadowOff && out.shadowBack, 'page-shadow setting does not apply live');
    assert(out.animOff, 'animation setting does not apply live');
    assert(out.nativeCursor, 'cursor setting does not apply live');
    assert(out.persisted, 'settings were not written to disk');
    return `阴影/动画/指针设置即时生效并落盘`;
  });

  /* ------------------------------------------------------- erase mode */
  await check('批注', '擦除模式（此版 PDF.js 无独立橡皮擦）的可用行为', async () => {
    await reset([path.join(SAMPLES, 'sample-small.pdf')], 2800);
    const before = await run(`(() => {
      const tab = window.__lumenTestRun((app) => app.active);
      const s = tab.doc.annotationStorage.serializable;
      return s && s.map && typeof s.map.size === 'number' ? s.map.size : Object.keys((s && s.map) || {}).length;
    })()`);

    const armed = await run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      window.__lumenTestRun((app, ctx) => ctx.setTool('erase'));
      await sleep(700);
      return {
        tool: window.__lumenTestState().tool,
        active: document.querySelector('#btn-erase').classList.contains('active'),
        hint: document.querySelector('#status-message').textContent,
        editorMode: (() => { try { return window.__lumenTestRun((app) => app.active).viewer.annotationEditorMode; } catch (e) { return 'n/a'; } })(),
      };
    })()`);
    assert(armed.tool === 'erase' && armed.active, `erase mode did not arm (${JSON.stringify(armed)})`);
    // editing is off in picking mode, so nothing may change just by arming it
    assert(armed.editorMode === 0, `erase mode should turn editing off, got mode ${armed.editorMode}`);
    const after = await run(`(() => {
      const tab = window.__lumenTestRun((app) => app.active);
      const s = tab.doc.annotationStorage.serializable;
      return s && s.map && typeof s.map.size === 'number' ? s.map.size : Object.keys((s && s.map) || {}).length;
    })()`);
    assert(after === before, `arming erase changed the document (${before} → ${after})`);

    // and it must refuse to delete when nothing is selected
    const refused = await run(`(() => window.__lumenTestRun((app) => app.active).deleteSelectedAnnotation())()`);
    assert(refused === false, 'delete reported success with nothing selected');

    await run(`window.__lumenTestRun((app, ctx) => ctx.setTool('select'))`);
    await sleep(400);
    return `模式=${armed.tool}，编辑器关闭(${armed.editorMode})，无选中时拒绝删除`;
  });

  /* ----------------------------------------------------------- wrap up */
  await shot('last');
  const failed = results.filter((r) => !r.ok);
  const report = {
    when: new Date().toISOString(),
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    consoleErrors,
    rawConsole,
    shots,
    results,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'feature-report.json'), JSON.stringify(report, null, 2), 'utf8');

  console.log('');
  let area = '';
  for (const r of results) {
    if (r.area !== area) {
      area = r.area;
      console.log(`\n[${area}]`);
    }
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? `  — ${r.info}` : `\n          ${r.info}`}`);
  }
  console.log('');
  console.log(`${report.passed}/${report.total} passed, ${report.failed} failed`);
  if (consoleErrors.length) {
    console.log(`\nconsole errors (${consoleErrors.length}):`);
    for (const e of consoleErrors.slice(0, 20)) console.log('  ' + e);
  }
  console.log(`report → ${path.join(OUT_DIR, 'feature-report.json')}`);

  setTimeout(() => {
    app.exit(failed.length || consoleErrors.length ? 1 : 0);
    process.exit(failed.length || consoleErrors.length ? 1 : 0);
  }, 500);
};
