'use strict';
/**
 * Blank-page probe.
 *
 *   LUMEN_BLANKPROBE=1  (hooked from the main process, see src/main/main.js)
 *
 * Scrolls a document from top to bottom through the real scroll container and
 * reports, at each step, how many page elements actually hold a painted canvas.
 * This is the regression guard for "page 3 onward is blank": PDF.js decides
 * which pages to render from the scroll position of its container, so if the
 * container is not the element that scrolls, nothing past the first screenful
 * is ever drawn.
 *
 * Writes artifacts/blank-probe.json and artifacts/blank-probe-*.png.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'artifacts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function run({ win, app }) {
  const sample = process.env.LUMEN_PROBE_FILE || path.join(ROOT, 'samples', 'sample-small.pdf');
  fs.mkdirSync(OUT, { recursive: true });
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => {
    await sleep(400);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, 'blank-probe-' + name + '.png'), img.toPNG());
  };

  for (let i = 0; i < 60; i += 1) {
    const ready = await run("typeof window.__lumenTestRun === 'function'").catch(() => false);
    if (ready) break;
    await sleep(200);
  }

  const opened = await run(`(async () => {
    const app = window.__lumenTestRun((a) => a);
    for (const t of [...app.tabs]) { try { await window.__lumenTestRun((a, c) => c.closeTab(t, { force: true })); } catch (e) {} }
    await new Promise((r) => setTimeout(r, 400));
    await window.__lumenTestOpen([${JSON.stringify(sample)}]);
    for (let i = 0; i < 200; i += 1) {
      if (app.active && app.active.loaded) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return app.active ? app.active.pageCount : -1;
  })()`);
  await sleep(1500);

  const snap = () =>
    run(`JSON.stringify((() => {
      const app = window.__lumenTestRun((a) => a);
      const tab = app.active;
      const c = document.querySelector('.pdf-container:not([hidden])');
      if (!c) return { error: 'no visible container' };
      const pageEls = [...c.querySelectorAll('.page')];
      const canvases = [...c.querySelectorAll('.page canvas')];
      return {
        pages: pageEls.length,
        canvases: canvases.length,
        painted: canvases.filter((x) => x.width > 0 && x.height > 0).length,
        textSpans: c.querySelectorAll('.textLayer span').length,
        current: tab.page,
        scrollTop: Math.round(c.scrollTop),
        scrollHeight: Math.round(c.scrollHeight),
        clientHeight: Math.round(c.clientHeight),
        inView: pageEls
          .map((p) => {
            const r = p.getBoundingClientRect();
            const cv = p.querySelector('canvas');
            return { n: Number(p.dataset.pageNumber), top: Math.round(r.top), painted: !!(cv && cv.width > 0) };
          })
          .filter((x) => x.top < 700 && x.top > -700),
      };
    })())`).then(JSON.parse);

  const steps = [];
  const record = async (label) => {
    steps.push({ label, ...(await snap()) });
  };

  await record('opened');
  await shot('01-opened');

  const total = opened > 0 ? opened : 12;
  const perStep = 3;
  let idx = 0;
  for (let p = perStep; p <= total + perStep - 1; p += perStep) {
    const target = Math.min(p, total);
    await run(`(async () => {
      const app = window.__lumenTestRun((a) => a);
      app.active.setPage(${target});
      await new Promise((r) => setTimeout(r, 2200));
      return true;
    })()`);
    await record('setPage(' + target + ')');
    if (idx === 1) await shot('02-midway');
    idx += 1;
  }

  await run(`(async () => {
    const app = window.__lumenTestRun((a) => a);
    app.active.setPage(1);
    await new Promise((r) => setTimeout(r, 2000));
    return true;
  })()`);
  await record('back to page 1');
  await shot('03-top');

  const failures = steps.filter((s) => s.inView && s.inView.some((x) => !x.painted));
  const report = {
    sample,
    pageCount: opened,
    steps,
    blankInView: failures.map((f) => ({ label: f.label, blank: f.inView.filter((x) => !x.painted).map((x) => x.n) })),
    ok: failures.length === 0,
  };
  fs.writeFileSync(path.join(OUT, 'blank-probe.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('\n[blankprobe] ' + path.basename(sample) + ' ' + opened + 'p - ' + (report.ok ? 'PASS' : 'FAIL'));
  for (const s of steps) {
    const blank = (s.inView || []).filter((x) => !x.painted).map((x) => x.n);
    console.log(
      '  ' + s.label.padEnd(18) + ' painted ' + String(s.painted).padStart(3) + '/' + s.pages +
        '  in view ' + (s.inView || []).map((x) => x.n + (x.painted ? '' : '!')).join(',') +
        (blank.length ? '   BLANK: ' + blank.join(',') : ''),
    );
  }
  setTimeout(() => {
    app.exit(report.ok ? 0 : 1);
    process.exit(report.ok ? 0 : 1);
  }, 400);
};
