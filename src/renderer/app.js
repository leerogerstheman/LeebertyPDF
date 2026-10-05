/* =========================================================================
   LeebertyPDF — application shell: tabs, toolbar, shortcuts, session, tools
   ========================================================================= */
/* Runtime shims must run before PDF.js is evaluated. */
import './lib/polyfills.js';
import { GlobalWorkerOptions } from './vendor/pdfjs/pdf.min.mjs';
import { DocTab, ZOOM_PRESETS } from './viewer.js';
import { Sidebar } from './sidebar.js';
import { openSettings, openProperties, openShortcuts, openAbout } from './dialogs.js';
import { openPageOrganizer } from './organizer.js';
import * as eraserModule from './eraser.js';
import { disposeEraser, setEraserActive } from './eraser.js';
import { disposeReflow, reflowFor } from './reflow.js';
import { HIGHLIGHT_COLORS, INK_COLORS, TEXT_COLORS, icon } from './lib/icons.js';
import {
  $,
  baseName,
  bus,
  clamp,
  clear,
  debounce,
  dirName,
  el,
  escapeHtml,
  fmtBytes,
  fmtDate,
  getLanguage,
  isTextInput,
  store,
  stripExt,
  t,
  throttle,
} from './lib/core.js';
import {
  closeContextMenu,
  closePalette,
  closePopover,
  confirmDialog,
  isPaletteOpen,
  openContextMenu,
  openModal,
  openPalette,
  openPopover,
  promptDialog,
  toast,
} from './lib/widgets.js?v=7';

/* --------------------------------------------------------------- runtime */
GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const L = (cn, en) => (getLanguage() === 'zh-CN' ? cn : en);

/** Set once boot() has restored state; until then, opened files are queued. */
let bootDone = false;

const app = {
  /** Paths handed over by the main process before the session restore ran. */
  startupFiles: [],
  tabs: [],
  active: null,
  tool: 'select',
  colors: { highlight: '#ffd24a', ink: '#e5484d', freeText: '#111111' },
  thickness: { ink: 2, freeText: 16 },
  sidebar: null,
  find: { query: '', total: 0, pages: 0, matches: [], state: null },
  findChips: {},
  _prePresentation: null,
};

window.__lumen = {
  thumbnailZoom: 120,
  setThumbnailZoom(v) {
    this.thumbnailZoom = v;
    store.set('thumbnailZoom', v);
  },
};

/* Development hooks used by tools/selftest.js — harmless in normal use. */
window.__lumenTestOpen = (paths) => openFiles(Array.isArray(paths) ? paths : [paths]);
window.__lumenTestState = () => ({
  tabs: app.tabs.map((tb) => ({
    title: tb.title,
    page: tb.page,
    pages: tb.pageCount,
    loaded: tb.loaded,
    path: tb.path,
  })),
  active: app.active
    ? {
        title: app.active.title,
        page: app.active.page,
        pageCount: app.active.pageCount,
        scale: app.active.scale,
        rotation: app.active.rotation,
        loaded: app.active.loaded,
        dirty: app.active.dirty,
        scrollMode: app.active.scrollModeKey,
        pageMode: app.active.pageModeKey,
      }
    : null,
  tool: app.tool,
  settings: { ...store.settings },
});
window.__lumenTestViewer = () =>
  app.active
    ? {
        scrollMode: app.active.viewer?.scrollMode,
        spreadMode: app.active.viewer?.spreadMode,
        scrollModeKey: app.active.scrollModeKey,
        pageModeKey: app.active.pageModeKey,
        scale: app.active.viewer?.currentScale,
        scaleValue: app.active.viewer?.currentScaleValue,
      }
    : null;
/** Development hook: drive the reflow toggle from tools/featureprobe.js. */
window.__lumenToggleReflow = (on) => toggleReflow(on);
/** Development hook: the most recent palette item list. */
let paletteItemsSnapshot = [];
window.__lumenEraserProbe = () => {
  const tab = app.active;
  if (!tab) return null;
  const view = tab.viewer?.getPageView(0);
  if (!view) return null;
  const mod = eraserModule;
  const items = mod.collectPageAnnotations(tab, 0);
  return {
    nodes: items.length,
    withStorage: items.filter((i) => i.storage).length,
    ids: items.map((i) => (i.storage ? i.storage.id : null)),
  };
};

window.__lumenTestRun = (fn) =>
  fn(app, {
    store,
    bus,
    toast,
    openFiles,
    closeTab,
    setTool,
    __toggleReflowForTest: (on) => toggleReflow(on),
    setPageMode,
    setScrollMode,
    organizePages,
    openSettings,
    openProperties,
    openShortcuts,
    openAbout,
    toggleInvert: () => {
      store.set('invertMode', store.get('invertMode', 'off') === 'off' ? 'smart' : 'off');
      applyInvert();
      updateToolbarState();
    },
  });
window.__lumenOpenOrganizer = async () => {
  if (app.active) await organizePages(app.active);
  return !!app.organizer;
};
Object.defineProperty(window, '__lumenOrganizer', { get: () => app.organizer || null });

// Development-only control experiment (tools/bare-control.dev.js is copied in
// by the test rig when needed; it is never part of the shipped app).
if (window.__LUMEN_CONTROL) {
  import('./bare-control.js')
    .then((m) => m.installBareControlProbe())
    .catch((err) => console.warn('[lumen] bare control probe unavailable', err));
}

bus.on('ui:toast', ({ title, kind, sub }) => toast(title, { kind, sub }));

/* ------------------------------------------------------------------ boot */
/**
 * Files normally arrive from the main process (command line, file
 * association, second instance). When the renderer is loaded directly — as the
 * development harness does — `?open=` carries the paths instead.
 */
/**
 * Files the user explicitly asked for on the command line, through a file
 * association, or by dropping them on the executable.
 *
 * They must win over the restored session: `LeebertyPDF.exe report.pdf` has to
 * show report.pdf, not last session's document with the requested file added
 * as a background tab. The main process pushes them over IPC right after
 * `did-finish-load`; this waits briefly for that message.
 */
async function maybeOpenStartupFiles(timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (!app.startupFiles.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 40));
  }
  if (!app.startupFiles.length) return false;
  const files = app.startupFiles.splice(0);
  // the last path given was the one the user expects to see, so open in
  // reverse so that it ends up as the active tab
  await openFiles([...files].reverse());
  return true;
}

async function boot() {
  await store.init();
  window.__lumen.thumbnailZoom = store.get('thumbnailZoom', 120);
  app.colors.highlight = store.get('highlightColor', app.colors.highlight);
  app.colors.ink = store.get('inkColor', app.colors.ink);
  app.colors.freeText = store.get('freeTextColor', app.colors.freeText);
  app.thickness.ink = store.get('inkThickness', app.thickness.ink);
  app.thickness.freeText = store.get('freeTextSize', app.thickness.freeText);

  applyTheme();
  applyReadingFlags();
  app.sidebar = new Sidebar();
  app.sidebar.setPane(store.get('sidebar', { tab: 'thumbnails' })?.tab || 'thumbnails');
  buildChrome();
  bindChromeEvents();
  bindKeyboard();
  bindDragDrop();
  bindBusEvents();
  bindMainProcess();
  restoreSidebarWidth();

  // explicit command-line files first, so a file association never appears
  // behind the previously restored document
  const openedFromArgv = await maybeOpenStartupFiles();

  const sessionState = store.session || {};
  const wanted = [];
  if (!openedFromArgv && store.get('restoreSession', true) && Array.isArray(sessionState.tabs)) {
    for (const p of sessionState.tabs) {
      if (p && (await window.lumen.fs.exists(p))) wanted.push(p);
    }
  }
  if (wanted.length) {
    await openFiles(wanted, { silent: true, activateIndex: sessionState.activeIndex || 0 });
  } else if (!openedFromArgv) {
    showEmptyState(true);
  }
  updateStatus();
  renderEmptyRecents();
  bootDone = true;

  setTimeout(() => {
    toast(getLanguage() === 'zh-CN' ? 'LeebertyPDF 已就绪' : 'LeebertyPDF is ready', {
      kind: 'ok',
      sub: `${t('palette.placeholder')} Ctrl+K`,
      duration: 2400,
    });
  }, 550);
}

/* ---------------------------------------------------------------- themes */
function systemPrefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme() {
  const pref = store.get('theme', 'auto');
  const resolved = pref === 'auto' ? (systemPrefersDark() ? 'dark' : 'light') : pref;
  document.documentElement.dataset.theme = resolved;
  window.lumen.theme
    .set(pref === 'auto' ? 'system' : pref === 'night' ? 'dark' : pref)
    .catch(() => {});
}

function applyInvert() {
  const mode = store.get('invertMode', 'off');
  document.body.classList.toggle('invert-mode', mode !== 'off');
  document.body.classList.toggle('sepia-read', mode === 'sepia');
  document.body.classList.toggle('contrast-read', mode === 'contrast');
}

function applyReadingFlags() {
  document.body.classList.toggle('no-page-shadow', !store.get('showPageShadow', true));
  document.body.classList.toggle('no-animation', !store.get('animation', true));
  document.body.classList.toggle('using-native-cursor', !!store.get('useSystemCursor', false));
  applyInvert();
}

/* ---------------------------------------------------------------- chrome */
function buildChrome() {
  renderTabs();
  renderEditorBar();
  updateToolbarState();
}

function renderTabs() {
  const strip = clear($('#tabstrip'));
  app.tabs.forEach((tab, index) => {
    const node = el(
      'div',
      {
        class: `tab${tab === app.active ? ' active' : ''}${tab.dirty ? ' dirty' : ''}`,
        title: tab.path,
        draggable: 'true',
        dataset: { index: String(index) },
      },
      tab.loaded ? null : el('span', { class: 'tab-spinner' }),
      el('span', { class: 'tab-title', text: tab.title }),
      el('span', {
        class: 'tab-close',
        html: icon('close', 'ic-sm'),
        onclick: (e) => {
          e.stopPropagation();
          closeTab(tab);
        },
      }),
    );
    node.addEventListener('mousedown', (e) => {
      if (e.button === 0) activateTab(tab);
      if (e.button === 1) {
        e.preventDefault();
        closeTab(tab);
      }
    });
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, [
        { label: t('action.closeTab'), accel: 'Ctrl+W', onClick: () => closeTab(tab) },
        { label: t('action.closeOthers'), onClick: () => closeOtherTabs(tab) },
        { label: t('action.closeAll'), onClick: () => closeAllTabs() },
        { separator: true },
        { label: t('action.copyPath'), onClick: () => copyText(tab.path) },
        { label: t('action.reveal'), onClick: () => window.lumen.shell.showItem(tab.path) },
        { separator: true },
        { label: t('action.saveCopy'), accel: 'Ctrl+S', onClick: () => saveCopyAs(tab) },
        { label: t('action.properties'), onClick: () => openProperties(tab) },
      ]);
    });
    strip.append(node);
  });
  bindTabDrag(strip);
  strip.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

let draggingTab = null;

function bindTabDrag(strip) {
  strip.addEventListener('dragstart', (e) => {
    const node = e.target.closest('.tab');
    if (!node) return;
    draggingTab = app.tabs[Number(node.dataset.index)];
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', draggingTab?.path || '');
    } catch {
      /* ignore */
    }
  });
  strip.addEventListener('dragover', (e) => {
    if (!draggingTab) return;
    e.preventDefault();
    const over = e.target.closest('.tab');
    if (!over) return;
    const overIndex = Number(over.dataset.index);
    if (!Number.isFinite(overIndex)) return;
    const rect = over.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    const from = app.tabs.indexOf(draggingTab);
    if (from < 0) return;
    let to = overIndex + (before ? 0 : 1);
    if (to > from) to -= 1;
    if (to === from) return;
    app.tabs.splice(from, 1);
    app.tabs.splice(to, 0, draggingTab);
    renderTabs();
  });
  strip.addEventListener('dragend', () => {
    draggingTab = null;
    persistSession();
  });
}

function updateToolbarState() {
  const tab = app.active;
  const has = !!tab;
  for (const id of [
    'btn-page-prev',
    'btn-page-next',
    'btn-zoom-in',
    'btn-zoom-out',
    'btn-rotate-cw',
    'btn-rotate-ccw',
    'btn-highlight',
    'btn-ink',
    'btn-erase',
    'btn-hand',
    'btn-find',
  ]) {
    const node = $(`#${id}`);
    if (node) node.disabled = !has;
  }
  const pageInput = $('#page-input');
  if (pageInput) pageInput.disabled = !has;
  const zoomBtn = $('#btn-zoom');
  if (zoomBtn) zoomBtn.disabled = !has;
  const total = $('#page-total');
  if (total) total.textContent = has ? `/ ${tab.pageCount}` : '/ 0';
  if (!has) {
    if (pageInput) pageInput.value = '';
    if (zoomBtn) zoomBtn.textContent = '—';
    return;
  }
  if (pageInput && document.activeElement !== pageInput) pageInput.value = String(tab.page);
  const pct = `${Math.round((tab.viewer?.currentScale || tab.scale || 1) * 100)}%`;
  if (zoomBtn) zoomBtn.textContent = pct;
  $('#btn-hand')?.classList.toggle('active', app.tool === 'hand');
  $('#btn-highlight')?.classList.toggle('active', app.tool === 'highlight');
  $('#btn-ink')?.classList.toggle('active', app.tool === 'ink');
  $('#btn-erase')?.classList.toggle('active', app.tool === 'erase');
  $('#btn-sidebar')?.classList.toggle('active', !$('#sidebar').hidden);
  $('#btn-view')?.classList.toggle('active', store.get('invertMode', 'off') !== 'off');
  $('#btn-reflow')?.classList.toggle('active', !!app.reflow);
  const reflowBtn = $('#btn-reflow');
  if (reflowBtn) reflowBtn.disabled = !has;
}

/* --------------------------------------------------------------- toolbar */
function bindChromeEvents() {
  const onClick = (id, fn) => {
    const node = $(`#${id}`);
    if (node) node.addEventListener('click', fn);
  };
  onClick('btn-open', () => pickFiles());
  onClick('empty-open', () => pickFiles());
  onClick('empty-folder', () => pickFolder());
  onClick('empty-recent', () => showRecentModal());
  onClick('btn-page-prev', () => app.active?.prevPage());
  onClick('btn-page-next', () => app.active?.nextPage());
  onClick('btn-zoom-in', () => zoomStep(1));
  onClick('btn-zoom-out', () => zoomStep(-1));
  onClick('btn-zoom', () => showZoomMenu());
  onClick('btn-rotate-cw', () => app.active?.rotateBy(90));
  onClick('btn-rotate-ccw', () => app.active?.rotateBy(-90));
  onClick('btn-hand', () => setTool(app.tool === 'hand' ? 'select' : 'hand'));
  onClick('btn-highlight', () => setTool(app.tool === 'highlight' ? 'select' : 'highlight'));
  onClick('btn-ink', () => setTool(app.tool === 'ink' ? 'select' : 'ink'));
  onClick('btn-erase', () => setTool(app.tool === 'erase' ? 'select' : 'erase'));
  onClick('btn-find', () => toggleFindbar(true));
  onClick('btn-view', () => showViewMenu());
  onClick('btn-reflow', () => toggleReflow());
  onClick('btn-sidebar', () => toggleSidebar());
  onClick('btn-menu', () => showMainMenu());
  onClick('btn-command', () => showPalette());
  onClick('btn-min', () => window.lumen.win.minimize());
  onClick('btn-max', () => window.lumen.win.maximizeToggle());
  onClick('btn-close', () => window.lumen.win.close());
  onClick('sidebar-title', () => showPaneMenu());

  const pageInput = $('#page-input');
  const commitPage = () => {
    const tab = app.active;
    if (!tab) return;
    const v = parseInt(pageInput.value, 10);
    if (Number.isFinite(v)) tab.setPage(v);
    pageInput.value = String(tab.page);
    pageInput.blur();
  };
  pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commitPage();
    else if (e.key === 'Escape') {
      pageInput.value = String(app.active?.page ?? '');
      pageInput.blur();
    }
  });
  pageInput.addEventListener('blur', () => {
    if (app.active && pageInput.value !== String(app.active.page)) commitPage();
  });

  // findbar ---------------------------------------------------------------
  const findInput = $('#find-input');
  findInput.addEventListener('input', debounce(() => runFind('find'), 180));
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runFind('again', !e.shiftKey);
    } else if (e.key === 'Escape') {
      toggleFindbar(false);
    }
  });
  const chip = (id, key) => {
    const node = $(`#${id}`);
    node.addEventListener('click', () => {
      const findbar = { ...(store.get('findbar', {}) || {}) };
      findbar[key] = !findbar[key];
      store.set('findbar', findbar);
      node.classList.toggle('active', !!findbar[key]);
      if (findInput.value) runFind('find');
    });
    return node;
  };
  app.findChips = {
    caseSensitive: chip('find-case', 'caseSensitive'),
    entireWord: chip('find-word', 'entireWord'),
    diacritics: chip('find-diacritics', 'diacritics'),
    highlightAll: chip('find-highlightall', 'highlightAll'),
  };
  onClick('find-next', () => runFind('again', true));
  onClick('find-prev', () => runFind('again', false));
  onClick('find-close', () => toggleFindbar(false));
  onClick('find-results-toggle', () => {
    const box = $('#find-results');
    box.hidden = !box.hidden;
    if (!box.hidden) renderFindResults();
  });
  syncFindChips();

  // editor bar ------------------------------------------------------------
  $('#editor-done').addEventListener('click', () => setTool('select'));
  $('#editor-delete').addEventListener('click', () => app.active?.deleteSelectedAnnotation());
  $('#editor-thickness').addEventListener('input', (e) => {
    app.thickness.ink = Number(e.target.value);
    app.active?.setInkThickness(app.thickness.ink);
    store.set('inkThickness', app.thickness.ink);
  });
  $('#editor-fontsize').addEventListener('input', (e) => {
    app.thickness.freeText = Number(e.target.value);
    app.active?.setFreeTextSize(app.thickness.freeText);
    store.set('freeTextSize', app.thickness.freeText);
  });

  // sidebar resizer -------------------------------------------------------
  const resizer = $('#sidebar-resizer');
  let dragging = false;
  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = clamp(e.clientX, 190, Math.min(620, window.innerWidth * 0.5));
    document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10);
    const sidebar = store.get('sidebar', { open: true, tab: 'thumbnails' });
    store.set('sidebar', { ...sidebar, width: w });
  });

  $('#drag-region').addEventListener('dblclick', () => window.lumen.win.maximizeToggle());

  document.addEventListener('selectionchange', debounce(reportSelection, 220));
}

function syncFindChips() {
  const findbar = store.get('findbar', {}) || {};
  for (const [key, node] of Object.entries(app.findChips || {})) {
    node.classList.toggle('active', !!findbar[key]);
  }
}

/* ------------------------------------------------------------- main menu */
function renderMenuItems(node, items) {
  clear(node);
  for (const it of items) {
    if (!it) continue;
    if (it.separator) {
      node.append(el('div', { class: 'menu-sep' }));
      continue;
    }
    if (it.header) {
      node.append(el('div', { class: 'menu-group-label', text: it.header }));
      continue;
    }
    node.append(
      el(
        'div',
        {
          class: `menu-item${it.checked ? ' checked' : ''}`,
          onclick: () => {
            closePopover();
            it.onClick?.();
          },
        },
        el('span', { class: 'menu-label', text: it.label }),
        it.accel ? el('span', { class: 'menu-key', text: it.accel }) : null,
      ),
    );
  }
}

function showMainMenu() {
  openPopover($('#btn-menu'), (node) => {
    const items = [];
    items.push({ header: t('menu.file') });
    items.push({ label: t('action.open'), accel: 'Ctrl+O', onClick: () => pickFiles() });
    items.push({ label: t('action.openFolder'), accel: 'Ctrl+Shift+O', onClick: () => pickFolder() });
    items.push({ label: t('action.openRecent'), onClick: () => showRecentModal() });
    items.push({ separator: true });
    items.push({
      label: t('action.saveCopy'),
      accel: 'Ctrl+S',
      onClick: () => app.active && saveCopyAs(app.active),
    });
    items.push({
      label: getLanguage() === 'zh-CN' ? '保存（覆盖原文件，含批注）' : 'Save (overwrite, with annotations)',
      onClick: () => app.active && saveOverwrite(app.active),
    });
    items.push({ separator: true });
    items.push({ header: t('menu.pdfTools') });
    items.push({
      label: getLanguage() === 'zh-CN' ? '整理页面…（删除/旋转/重排/合并/拆分）' : 'Organize pages… (delete/rotate/reorder/merge/split)',
      accel: 'Ctrl+Shift+P',
      onClick: () => app.active && organizePages(app.active),
    });
    items.push({ label: t('action.exportImages'), onClick: () => app.active && exportImages(app.active) });
    items.push({ label: t('action.exportText'), onClick: () => app.active && exportText(app.active) });
    items.push({ label: t('action.exportAnnotations'), onClick: () => app.active && exportAnnotations(app.active) });
    items.push({ label: t('action.exportHtml'), onClick: () => app.active && exportHtml(app.active) });
    items.push({ separator: true });
    items.push({
      label: t('action.print'),
      accel: 'Ctrl+P',
      onClick: () => app.active && printDocument(app.active),
    });
    items.push({ separator: true });
    items.push({ header: t('menu.view') });
    for (const [key, label] of [
      ['auto', t('nav.zoomAuto')],
      ['page-width', t('nav.zoomFitWidth')],
      ['page-fit', t('nav.zoomFitPage')],
      ['page-actual', t('nav.zoomActual')],
    ]) {
      items.push({ label, onClick: () => app.active?.setZoom(key) });
    }
    items.push({ separator: true });
    items.push({ header: t('menu.theme') });
    for (const [value, label] of [
      ['auto', t('settings.themeAuto')],
      ['light', t('settings.themeLight')],
      ['dark', t('settings.themeDark')],
      ['sepia', t('settings.themeSepia')],
      ['night', t('settings.themeNight')],
    ]) {
      items.push({
        label,
        checked: store.get('theme', 'auto') === value,
        onClick: () => {
          store.set('theme', value);
          applyTheme();
        },
      });
    }
    items.push({ separator: true });
    items.push({ header: t('menu.tools') });
    items.push({ label: t('action.properties'), onClick: () => app.active && openProperties(app.active) });
    items.push({ label: t('action.settings'), accel: 'Ctrl+,', onClick: () => openSettings() });
    items.push({ label: t('action.shortcuts'), accel: 'F1', onClick: () => openShortcuts() });
    items.push({ separator: true });
    items.push({ label: t('action.clearHistory'), onClick: () => bus.emit('ui:clear-history') });
    items.push({ label: t('action.about'), onClick: () => openAbout() });
    renderMenuItems(node, items);
  });
}


/* ------------------------------------------------------------------ tabs */
async function pickFiles() {
  const files = await window.lumen.dialog.open();
  if (files && files.length) await openFiles(files);
}

async function pickFolder() {
  const res = await window.lumen.dialog.openFolder();
  if (!res) return;
  if (!res.files.length) {
    toast(getLanguage() === 'zh-CN' ? '该文件夹里没有可打开的文档' : 'No openable documents in that folder', {
      kind: 'warn',
      sub: res.dir,
    });
    return;
  }
  await openFiles(res.files);
}

/** PDF.js rejects with plain objects ({name, message}); make them printable. */
function describeError(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err.message) return String(err.message);
  if (err.name) return String(err.name);
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function safeDocKey(p) {
  return String(p).toLowerCase();
}

async function openFiles(paths, opts = {}) {
  const list = [...new Set(paths.filter(Boolean))];
  if (!list.length) return;
  const created = [];
  const missing = [];
  for (const p of list) {
    const existing = app.tabs.find((tb) => tb.path.toLowerCase() === p.toLowerCase());
    if (existing) {
      created.push(existing);
      continue;
    }
    const st = await window.lumen.fs.stat(p).catch(() => null);
    if (!st || !st.ok) {
      missing.push(p);
      continue;
    }
    const tab = new DocTab({ path: p, host: $('#viewers') });
    app.tabs.push(tab);
    created.push(tab);
    renderTabs();
  }
  if (missing.length && !opts.silent) {
    toast(getLanguage() === 'zh-CN' ? '部分文件无法打开' : 'Some files could not be opened', {
      kind: 'warn',
      sub: missing.map((m) => baseName(m)).join('、'),
    });
  }
  if (!created.length) {
    showEmptyState(app.tabs.length === 0);
    return;
  }
  activateTab(created[opts.activateIndex ?? created.length - 1] || created[0]);
  showEmptyState(app.tabs.length === 0);

  const pending = created.filter((tab) => !tab.doc && !tab.loadingTask);
  pending.forEach(markLoading);

  await Promise.all(
    pending.map(async (tab) => {
      try {
        const cached = store.get('autoReload', false) ? null : await window.lumen.reading.get(safeDocKey(tab.path));
        await tab.load(cached);
        if (!opts.silent) {
          await window.lumen.recents.touch({
            path: tab.path,
            title: tab.docTitle(),
            total: tab.pageCount,
            page: cached?.page || 1,
            size: tab.size,
          });
        }
        renderTabs();
        if (tab === app.active) {
          syncChromeFromTab(tab);
          app.sidebar.setTab(tab);
        }
        bus.emit('library:changed');
      } catch (err) {
        // A file the user picked turning out not to be a readable PDF is an
        // expected outcome, not a fault: it is reported in the UI and logged at
        // warn level so it does not pollute error monitoring.
        console.warn('[lumen] open failed:', describeError(err));
        toast(t('toast.loadFailed'), {
          kind: 'error',
          sub: `${baseName(tab.path)} — ${describeError(err)}`,
        });
        renderTabs();
        updateToolbarState();
      }
    }),
  );
  pending.forEach(markLoaded);
  persistSession();
}

function activateTab(tab) {
  if (!tab || tab === app.active) return;
  if (app.active) {
    app.active.containerEl.hidden = true;
    app.active.persistState();
  }
  app.active = tab;
  tab.containerEl.hidden = false;
  renderTabs();
  showEmptyState(false);
  syncChromeFromTab(tab);
  app.sidebar.setTab(tab);
  updateToolbarState();
  updateStatus();
  window.lumen.win.setTitle(`${tab.title} — LeebertyPDF`).catch(() => {});
  persistSession();
  setTimeout(() => tab.viewerEl?.focus?.(), 30);
  bus.emit('tab:activated', { tab });
}

function syncChromeFromTab(tab) {
  if (!tab) return;
  $('#page-input').value = String(tab.page);
  $('#page-total').textContent = `/ ${tab.pageCount}`;
  if (app.tool === 'hand') applyHandTool(true);
  else if (app.tool !== 'select') tab.setTool(app.tool);
  updateStatus();
}

async function closeTab(tab, opts = {}) {
  const idx = app.tabs.indexOf(tab);
  if (idx < 0) return;
  if (tab.dirty && !opts.force) {
    const ok = await confirmDialog(
      t('action.closeTab'),
      getLanguage() === 'zh-CN'
        ? '此文档有尚未写入 PDF 的批注（已自动保存在本地库）。仍要关闭吗？'
        : 'This document has annotations that are not written back into the PDF (they are kept locally). Close anyway?',
      { okLabel: t('action.closeTab') },
    );
    if (!ok) return;
  }
  app.tabs.splice(idx, 1);
  const wasActive = app.active === tab;
  disposeEraser(tab);
  disposeReflow(tab);
  await tab.destroy();
  markLoaded(tab);
  if (wasActive) {
    app.active = null;
    const next = app.tabs[Math.min(idx, app.tabs.length - 1)];
    if (next) {
      activateTab(next);
    } else {
      showEmptyState(true);
      window.lumen.win.setTitle('LeebertyPDF').catch(() => {});
      updateToolbarState();
      renderEmptyRecents();
    }
  }
  renderTabs();
  persistSession();
}

function closeOtherTabs(keep) {
  for (const tab of [...app.tabs]) {
    if (tab !== keep) {
      app.tabs.splice(app.tabs.indexOf(tab), 1);
      markLoaded(tab);
      tab.destroy();
    }
  }
  if (app.active !== keep) activateTab(keep);
  renderTabs();
  persistSession();
}

function closeAllTabs() {
  for (const tab of [...app.tabs]) {
    app.tabs.splice(app.tabs.indexOf(tab), 1);
    markLoaded(tab);
    tab.destroy();
  }
  app.active = null;
  showEmptyState(true);
  renderTabs();
  updateToolbarState();
  persistSession();
  renderEmptyRecents();
}

function showEmptyState(on) {
  const node = $('#empty-state');
  if (node) node.hidden = !on;
  if (app.active) app.active.containerEl.hidden = false;
  if (on) {
    renderEmptyRecents();
    // nothing is open any more, so the sidebar must let go of the closed
    // document's thumbnails instead of keeping their canvases alive
    app.sidebar?.setTab(null);
  }
}

/* --------------------------------------------------------- loading status */
/** Tabs that are still loading; the indicator disappears when the set empties. */
const loadingTabs = new Set();

function refreshLoadingIndicator() {
  // the title-bar mark doubles as the "busy" light, so a slow document is
  // visible without looking at the status line
  const brand = $('.brand-mark');
  if (brand) brand.dataset.busy = loadingTabs.size ? '1' : '0';
  const node = $('#status-progress');
  if (!node) return;
  if (loadingTabs.size) {
    node.hidden = false;
    if (!node.dataset.busy) {
      node.dataset.busy = '1';
      $('#status-progress-text').textContent = t('status.loading');
    }
  } else {
    node.hidden = true;
    delete node.dataset.busy;
  }
}

function markLoading(tab) {
  loadingTabs.add(tab);
  refreshLoadingIndicator();
}

function markLoaded(tab) {
  if (tab) loadingTabs.delete(tab);
  else loadingTabs.clear();
  refreshLoadingIndicator();
}

function setLoadingProgress(progress) {
  const node = $('#status-progress');
  if (!node || node.hidden) return;
  $('#status-progress-text').textContent = `${t('status.loading')} ${Math.round(
    clamp(progress, 0, 1) * 100,
  )}%`;
}

async function renderEmptyRecents() {
  const host = $('#empty-recent-list');
  if (!host) return;
  const items = await window.lumen.recents.list().catch(() => []);
  clear(host);
  const recent = items.slice(0, 8);
  if (!recent.length) {
    host.append(
      el('div', {
        class: 'pane-empty',
        text: getLanguage() === 'zh-CN' ? '还没有阅读记录' : 'No recent files yet',
      }),
    );
    return;
  }
  host.append(el('div', { class: 'section-title', text: t('menu.recent') }));
  for (const it of recent) {
    const row = el(
      'div',
      { class: 'outline-row', title: it.path },
      el('span', { class: 'outline-toggle', html: icon('file', 'ic-sm') }),
      el('span', { class: 'outline-title', text: it.title || baseName(it.path) }),
      it.total ? el('span', { class: 'outline-page', text: `${it.page || 1}/${it.total}` }) : null,
    );
    row.addEventListener('click', () => openFiles([it.path]));
    host.append(row);
  }
}

async function showRecentModal() {
  const items = await window.lumen.recents.list().catch(() => []);
  const body = el('div', {});
  if (!items.length) {
    body.append(
      el('div', {
        class: 'pane-empty',
        text: getLanguage() === 'zh-CN' ? '还没有阅读记录' : 'No recent files yet',
      }),
    );
  } else {
    const list = el('div', { class: 'annot-list' });
    for (const it of items) {
      const meta = [
        fmtDate(it.openedAt),
        it.total ? `${it.page || 1}/${it.total}` : '',
        it.size ? fmtBytes(it.size) : '',
      ]
        .filter(Boolean)
        .join(' · ');
      const row = el(
        'div',
        { class: 'annot-row', title: it.path },
        el('span', {
          class: 'annot-color-bar',
          style: { background: it.pinned ? 'var(--accent)' : 'transparent' },
        }),
        el(
          'div',
          { style: { flex: '1 1 auto', minWidth: '0' } },
          el('div', { class: 'annot-text', text: it.title || baseName(it.path) }),
          el('div', { class: 'setting-help', text: meta }),
        ),
        el('span', {
          class: 'row-remove',
          html: icon('pin', 'ic-sm'),
          title: it.pinned ? t('action.unpin') : t('action.pin'),
          style: { opacity: it.pinned ? '1' : '' },
          onclick: async (e) => {
            e.stopPropagation();
            await window.lumen.recents.pin(it.path, !it.pinned);
            row.remove();
          },
        }),
        el('span', {
          class: 'row-remove',
          html: icon('close', 'ic-sm'),
          onclick: async (e) => {
            e.stopPropagation();
            await window.lumen.recents.remove(it.path);
            row.remove();
          },
        }),
      );
      row.addEventListener('click', () => openFiles([it.path]));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, [
          { label: t('action.reveal'), onClick: () => window.lumen.shell.showItem(it.path) },
          { label: t('action.copyPath'), onClick: () => copyText(it.path) },
        ]);
      });
      list.append(row);
    }
    body.append(list);
  }
  openModal({
    title: t('action.openRecent'),
    body,
    buttons: [
      {
        label: t('action.clearHistory'),
        kind: 'ghost',
        close: false,
        handler: async () => {
          await window.lumen.recents.clear();
          bus.emit('library:changed');
        },
      },
      { label: t('modal.close'), kind: 'primary' },
    ],
  });
}

/* --------------------------------------------------------------- actions */
function setPageMode(mode) {
  const tab = app.active;
  if (!tab) return;
  tab.setPageMode(mode);
  store.set('pageMode', mode);
  updateToolbarState();
}

function setScrollMode(mode) {
  const tab = app.active;
  if (!tab) return;
  tab.setScrollMode(mode);
  store.set('scrollMode', mode);
  updateToolbarState();
}

const TOOL_HINTS = {
  highlight: ['在文字上拖动即可高亮', 'Drag across text to highlight'],
  ink: ['按住左键自由绘制', 'Hold the left button to draw'],
  freeText: ['在页面上单击以放置文本框', 'Click the page to place a text box'],
  stamp: ['在页面上单击以放置图章', 'Click the page to place a stamp'],
  signature: ['在页面上单击以放置签名', 'Click the page to place a signature'],
  erase: ['单击或按住拖动即可擦除批注', 'Click or drag over annotations to erase them'],
  hand: ['拖动页面可平移视图', 'Drag to pan the page'],
};

function setTool(tool) {
  app.tool = tool;
  const tab = app.active;
  if (tab) tab.setTool(tool);
  applyHandTool(tool === 'hand');
  document.body.classList.toggle('eraser-mode', tool === 'erase');
  // the eraser is our own overlay, so every tab has to be told; inactive tabs
  // keep theirs switched off
  for (const each of app.tabs) setEraserActive(each, tool === 'erase' && each === tab);
  updateToolbarState();
  renderEditorBar();
  if (tab) {
    if (tool === 'highlight') tab.setHighlightColor(app.colors.highlight);
    if (tool === 'erase' && tab.listAnnotations().length === 0) {
      bus.emit('ui:toast', { title: t('sidebar.noAnnotations'), duration: 1800 });
    }
    if (tool === 'ink') {
      tab.setInkColor(app.colors.ink);
      tab.setInkThickness(app.thickness.ink);
    }
    if (tool === 'freeText') {
      tab.setFreeTextColor(app.colors.freeText);
      tab.setFreeTextSize(app.thickness.freeText);
    }
  }
  const hint = TOOL_HINTS[tool];
  if (hint) {
    const esc = getLanguage() === 'zh-CN' ? '按 Esc 退出' : 'Press Esc to exit';
    toast(getLanguage() === 'zh-CN' ? hint[0] : hint[1], { duration: 2200, sub: esc });
  }
}

/**
 * Switches the active tab between the original page layout and a reflowed
 * single column. Both views stay alive, so toggling back is instant.
 */
async function toggleReflow(force) {
  const tab = app.active;
  if (!tab) return false;
  const pane = reflowFor(tab);
  const next = force === undefined ? !pane.visible : !!force;
  pane.setVisible(next);
  app.reflow = next;
  $('#btn-reflow')?.classList.toggle('active', next);
  if (next) await pane.render();
  else tab.setPage(tab.page, { center: false });
  updateToolbarState();
  return next;
}

function applyHandTool(on) {
  document.body.classList.toggle('hand-tool', on);
  store.set('handTool', on);
}

function renderEditorBar() {
  const bar = $('#editor-bar');
  const active = ['highlight', 'ink', 'freeText', 'stamp', 'signature'].includes(app.tool);
  bar.hidden = !active;
  if (!active) return;
  const colors =
    app.tool === 'highlight' ? HIGHLIGHT_COLORS : app.tool === 'freeText' ? TEXT_COLORS : INK_COLORS;
  const current =
    app.tool === 'highlight' ? app.colors.highlight : app.tool === 'freeText' ? app.colors.freeText : app.colors.ink;
  const host = clear($('#editor-colors'));
  for (const c of colors) {
    host.append(
      el('div', {
        class: `swatch${c.value === current ? ' active' : ''}`,
        style: { background: c.value },
        title: c.name,
        onclick: () => {
          if (app.tool === 'highlight') {
            app.colors.highlight = c.value;
            app.active?.setHighlightColor(c.value);
            store.set('highlightColor', c.value);
          } else if (app.tool === 'freeText') {
            app.colors.freeText = c.value;
            app.active?.setFreeTextColor(c.value);
            store.set('freeTextColor', c.value);
          } else {
            app.colors.ink = c.value;
            app.active?.setInkColor(c.value);
            store.set('inkColor', c.value);
          }
          renderEditorBar();
        },
      }),
    );
  }
  $('#editor-thickness').parentElement.hidden = app.tool !== 'ink';
  $('#editor-fontsize').parentElement.hidden = app.tool !== 'freeText';
  $('#editor-thickness').value = String(app.thickness.ink);
  $('#editor-fontsize').value = String(app.thickness.freeText);
}

async function saveCopyAs(tab) {
  const suggested = `${stripExt(baseName(tab.path))} (已批注).pdf`;
  const target = await window.lumen.dialog.save({
    title: t('action.saveCopy'),
    defaultPath: `${dirName(tab.path)}\\${suggested}`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (!target) return;
  toast(getLanguage() === 'zh-CN' ? '正在生成 PDF…' : 'Generating PDF…', { duration: 1600 });
  try {
    const res = await tab.saveCopy(target);
    if (res.ok) {
      toast(t('toast.saved'), {
        kind: 'ok',
        sub: target,
        action: t('action.reveal'),
        onAction: () => window.lumen.shell.showItem(target),
      });
    } else {
      toast(t('toast.failed'), { kind: 'error', sub: res.error });
    }
  } catch (err) {
    toast(t('toast.failed'), { kind: 'error', sub: describeError(err) });
  }
  updateStatus();
}

async function saveOverwrite(tab) {
  const ok = await confirmDialog(
    t('action.savePdf'),
    getLanguage() === 'zh-CN'
      ? `批注将被写入并覆盖原文件：\n${tab.path}\n\n此操作不可撤销，建议改用“另存为副本”。继续吗？`
      : `Annotations will be written into and overwrite:\n${tab.path}\n\nThis cannot be undone. Continue?`,
    { okLabel: t('modal.ok') },
  );
  if (!ok) return;
  toast(getLanguage() === 'zh-CN' ? '正在写入…' : 'Writing…', { duration: 1600 });
  try {
    const res = await tab.saveCopy(tab.path);
    if (res.ok) {
      toast(t('toast.saved'), { kind: 'ok', sub: tab.path });
      renderTabs();
    } else {
      toast(t('toast.failed'), { kind: 'error', sub: res.error });
    }
  } catch (err) {
    toast(t('toast.failed'), { kind: 'error', sub: describeError(err) });
  }
  updateStatus();
}

async function exportImages(tab) {
  const zh = getLanguage() === 'zh-CN';
  const html = `
    <div class="setting-row"><div class="setting-info"><div class="setting-label">${zh ? '页码范围' : 'Page range'}</div>
      <div class="setting-help">${zh ? `例如 1-5，留空导出全部（共 ${tab.pageCount} 页）` : `e.g. 1-5, empty = all ${tab.pageCount} pages`}</div></div>
      <div class="setting-control"><input id="exp-range" class="find-input" style="width:130px" placeholder="${zh ? '全部' : 'all'}" /></div></div>
    <div class="setting-row"><div class="setting-info"><div class="setting-label">${zh ? '倍率' : 'Scale'}</div>
      <div class="setting-help">${zh ? '2 ≈ 144 DPI，4 ≈ 288 DPI' : '2 ≈ 144 DPI, 4 ≈ 288 DPI'}</div></div>
      <div class="setting-control"><input id="exp-scale" class="num-input" type="number" min="1" max="6" step="0.5" value="${store.get('exportScale', 2)}" style="width:70px;border:1px solid var(--border);border-radius:8px;height:28px;background:var(--bg-input);color:var(--fg)" /></div></div>
    <div class="setting-row"><div class="setting-info"><div class="setting-label">${zh ? '格式' : 'Format'}</div></div>
      <div class="setting-control"><select id="exp-format" class="select"><option value="image/png">PNG</option><option value="image/jpeg">JPEG</option></select></div></div>`;
  openModal({
    title: t('action.exportImages'),
    narrow: true,
    body: html,
    buttons: [
      { label: t('modal.cancel'), kind: 'ghost' },
      {
        label: t('action.exportImages'),
        kind: 'primary',
        close: false,
        handler: async (close, ev) => {
          const rangeRaw = document.getElementById('exp-range').value.trim();
          const scale = Number(document.getElementById('exp-scale').value) || 2;
          const mime = document.getElementById('exp-format').value;
          let [from, to] = [1, tab.pageCount];
          if (rangeRaw) {
            const m = /^(\d+)\s*-\s*(\d+)$/.exec(rangeRaw);
            if (m) {
              from = clamp(Number(m[1]), 1, tab.pageCount);
              to = clamp(Number(m[2]), from, tab.pageCount);
            } else {
              const single = clamp(parseInt(rangeRaw, 10) || 1, 1, tab.pageCount);
              from = to = single;
            }
          }
          ev.target.disabled = true;
          ev.target.textContent = '…';
          const dir = await window.lumen.dialog.save({
            title: zh ? '选择导出目录（文件名自动生成）' : 'Choose an output folder',
            defaultPath: `${dirName(tab.path)}\\${stripExt(baseName(tab.path))} 导出`,
          });
          if (!dir) {
            ev.target.disabled = false;
            ev.target.textContent = t('action.exportImages');
            return;
          }
          try {
            const images = await tab.exportPageImages({ from, to, scale, mime });
            for (const img of images) {
              const name = `${stripExt(baseName(tab.path))}_p${String(img.index).padStart(3, '0')}.${img.ext}`;
              await window.lumen.fs.write(`${dir}\\${name}`, img.data);
            }
            toast(t('toast.exported'), {
              kind: 'ok',
              sub: `${images.length} → ${dir}`,
              action: t('action.reveal'),
              onAction: () => window.lumen.shell.showItem(dir),
            });
          } catch (err) {
            toast(t('toast.failed'), { kind: 'error', sub: describeError(err) });
          }
          close(true);
        },
      },
    ],
  });
}

async function exportText(tab) {
  const target = await window.lumen.dialog.save({
    title: t('action.exportText'),
    defaultPath: `${dirName(tab.path)}\\${stripExt(baseName(tab.path))}.txt`,
    filters: [{ name: 'Text', extensions: ['txt'] }],
  });
  if (!target) return;
  toast(getLanguage() === 'zh-CN' ? '正在提取文本…' : 'Extracting text…', { duration: 2000 });
  try {
    const chunks = [];
    for (let i = 1; i <= tab.pageCount; i += 1) {
      chunks.push(`\n\n===== ${i} =====\n`);
      chunks.push(await tab.pageText(i));
    }
    const header = `${tab.docTitle()}\n${tab.path}\n${tab.pageCount} pages\n\n`;
    await window.lumen.fs.write(target, header + chunks.join(''));
    toast(t('toast.exported'), {
      kind: 'ok',
      sub: target,
      action: t('action.reveal'),
      onAction: () => window.lumen.shell.showItem(target),
    });
  } catch (err) {
    toast(t('toast.failed'), { kind: 'error', sub: describeError(err) });
  }
}

async function exportAnnotations(tab) {
  const items = tab.listAnnotations();
  const target = await window.lumen.dialog.save({
    title: t('action.exportAnnotations'),
    defaultPath: `${dirName(tab.path)}\\${stripExt(baseName(tab.path))} 批注.md`,
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'Text', extensions: ['txt'] },
    ],
  });
  if (!target) return;
  const lines = [`# ${tab.docTitle()} — 批注摘要`, '', `\`${tab.path}\``, '', `共 ${items.length} 条`, ''];
  let lastPage = -1;
  for (const item of items) {
    if (item.page !== lastPage) {
      lastPage = item.page;
      lines.push('', `## ${item.page}`, '');
    }
    lines.push(`- **${item.kind}**${item.text ? `：${item.text}` : ''}`);
  }
  if (!items.length) lines.push('_没有批注_');
  await window.lumen.fs.write(target, lines.join('\n'));
  toast(t('toast.exported'), {
    kind: 'ok',
    sub: target,
    action: t('action.reveal'),
    onAction: () => window.lumen.shell.showItem(target),
  });
}

async function exportHtml(tab) {
  const target = await window.lumen.dialog.save({
    title: t('action.exportHtml'),
    defaultPath: `${dirName(tab.path)}\\${stripExt(baseName(tab.path))}.html`,
    filters: [{ name: 'HTML', extensions: ['html'] }],
  });
  if (!target) return;
  const sections = [];
  for (let i = 1; i <= tab.pageCount; i += 1) {
    const text = await tab.pageText(i);
    sections.push(
      `<section class="page"><h2>${i}</h2><p>${escapeHtml(text).replace(/\s{2,}/g, ' ')}</p></section>`,
    );
  }
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(
    tab.docTitle(),
  )}</title>
<style>body{font-family:"Segoe UI","Microsoft YaHei",sans-serif;max-width:830px;margin:40px auto;padding:0 20px;line-height:1.8;color:#1c1f24}
h1{font-size:24px}h2{font-size:13px;color:#8a9099;font-weight:500;margin-top:30px;border-top:1px solid #eceef1;padding-top:12px}
.page p{white-space:pre-wrap}</style></head><body><h1>${escapeHtml(tab.docTitle())}</h1>
<p style="color:#8a9099;font-size:12px">${escapeHtml(tab.path)} · ${tab.pageCount} pages</p>${sections.join(
    '\n',
  )}</body></html>`;
  await window.lumen.fs.write(target, html);
  toast(t('toast.exported'), {
    kind: 'ok',
    sub: target,
    action: t('action.reveal'),
    onAction: () => window.lumen.shell.showItem(target),
  });
}

function printDocument(tab) {
  const zh = getLanguage() === 'zh-CN';
  const win = window.open('', '_blank', 'width=920,height=1180');
  if (!win) {
    toast(t('toast.failed'), { kind: 'error', sub: zh ? '无法打开打印窗口' : 'Could not open print window' });
    return;
  }
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(tab.docTitle())}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'" />
<style>@page{size:auto;margin:0}html,body{margin:0;padding:0}img{display:block;width:100%;page-break-after:always}
body{background:#fff}.hint{font:12px sans-serif;padding:14px;color:#666}</style></head>
<body><div class="hint">${zh ? '正在渲染…' : 'Rendering…'}</div></body></html>`);
  win.document.close();
  (async () => {
    try {
      const host = win.document.body;
      host.innerHTML = '';
      for (let p = 1; p <= tab.pageCount; p += 1) {
        const page = await tab.doc.getPage(p);
        const vp = page.getViewport({ scale: 2 });
        const canvas = win.document.createElement('canvas');
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
        const img = win.document.createElement('img');
        img.src = canvas.toDataURL('image/jpeg', 0.92);
        host.append(img);
      }
      setTimeout(() => {
        win.focus();
        win.print();
      }, 400);
    } catch (err) {
      win.document.body.innerHTML = `<div class="hint">${escapeHtml(describeError(err))}</div>`;
    }
  })();
}

/* ----------------------------------------------------------- page editor */
/** Opens the page organizer for a tab (one instance per tab). */
async function organizePages(tab) {
  if (!tab || !tab.doc) {
    toast(t('toast.noDoc'), { kind: 'warn' });
    return;
  }
  if (app.organizer && app.organizer.tab === tab && app.organizer.sessionId) {
    toast(getLanguage() === 'zh-CN' ? '整理窗口已经打开' : 'The organizer is already open', {
      kind: 'warn',
      duration: 1600,
    });
    return;
  }
  try {
    const organizer = await openPageOrganizer(tab);
    if (organizer) {
      app.organizer = organizer;
      toast(getLanguage() === 'zh-CN' ? '拖动缩略图即可重排页面' : 'Drag thumbnails to reorder pages', {
        duration: 2600,
        sub: getLanguage() === 'zh-CN' ? 'Ctrl+A 全选 · Delete 删除 · Ctrl+Z 撤销' : 'Ctrl+A select · Delete · Ctrl+Z undo',
      });
    }
  } catch (err) {
    console.error('[lumen] organizer failed', err);
    toast(getLanguage() === 'zh-CN' ? '无法打开页面整理' : 'Could not open the organizer', {
      kind: 'error',
      sub: describeError(err),
    });
  }
}

async function clearAnnotations(tab) {
  const ok = await confirmDialog(
    t('sidebar.clearAnnotations'),
    getLanguage() === 'zh-CN'
      ? '将删除此文档在本地保存的全部批注，PDF 文件本身不受影响。'
      : 'Removes locally stored annotations for this document. The PDF itself is untouched.',
    { okLabel: t('modal.ok'), danger: true },
  );
  if (!ok) return;
  await window.lumen.annotations.clear(tab.docKey());
  const storage = tab.doc.annotationStorage;
  const map = storage.serializable?.map;
  const ids = map instanceof Map ? [...map.keys()] : Object.keys(map || {});
  for (const id of ids) {
    try {
      storage.remove(id);
    } catch {
      /* ignore */
    }
  }
  try {
    storage.resetModified();
  } catch {
    /* ignore */
  }
  tab.dirty = false;
  renderTabs();
  app.sidebar.renderAnnotations(true);
  toast(t('toast.annotationsCleared'), {
    kind: 'ok',
    sub: getLanguage() === 'zh-CN' ? '重新打开文档即可完全生效' : 'Reopen the document to apply',
  });
}

/* ------------------------------------------------------------------ find */
function toggleFindbar(on) {
  const bar = $('#findbar');
  const show = on === undefined ? bar.hidden : on;
  bar.hidden = !show;
  if (show) {
    const input = $('#find-input');
    const sel = window.getSelection()?.toString() || '';
    if (sel && sel.trim().length < 80 && !input.value) input.value = sel.trim();
    input.focus();
    input.select();
    if (app.active && input.value) runFind('find');
  } else {
    app.active?.clearFind();
    $('#find-results').hidden = true;
  }
}

function runFind(type, forward = true) {
  const tab = app.active;
  if (!tab) return;
  const query = $('#find-input').value;
  app.find.query = query;
  if (!query) {
    $('#find-counter').textContent = '0/0';
    $('#find-results').hidden = true;
    clear($('#find-results'));
    tab.clearFind();
    return;
  }
  const findbar = store.get('findbar', {}) || {};
  tab.search(query, {
    type,
    findPrevious: !forward,
    caseSensitive: !!findbar.caseSensitive,
    entireWord: !!findbar.entireWord,
    highlightAll: findbar.highlightAll !== false,
    matchDiacritics: !!findbar.diacritics,
  });
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightSnippet(text, query) {
  const safe = escapeHtml(text);
  if (!query) return safe;
  const re = new RegExp(escapeRegExp(escapeHtml(query)), 'gi');
  return safe.replace(re, (m) => `<mark>${m}</mark>`);
}

function renderFindResults() {
  const box = $('#find-results');
  const matches = app.find.matches || [];
  clear(box);
  if (!matches.length) {
    box.append(
      el('div', { class: 'pane-empty', text: $('#find-input').value ? t('find.notFound') : '' }),
    );
    return;
  }
  box.append(
    el('div', {
      class: 'pane-toolbar',
      text: t('find.resultsCount', app.find.total, app.find.pages),
    }),
  );
  const query = app.find.query;
  const rows = [];
  for (const m of matches.slice(0, 300)) {
    const row = el(
      'div',
      { class: 'find-result', dataset: { page: String(m.page) } },
      el('span', { class: 'find-result-page', text: String(m.page) }),
      el('span', { class: 'find-result-text', text: '…' }),
    );
    row.addEventListener('click', () => {
      app.active?.setPage(m.page);
      for (const r of rows) r.classList.toggle('active', r === row);
    });
    rows.push(row);
    box.append(row);
    app.active
      ?.pageTextSnippet(m.page, m.index, m.length)
      .then((snippet) => {
        const target = row.querySelector('.find-result-text');
        if (target) target.innerHTML = highlightSnippet(snippet, query);
      })
      .catch(() => {});
  }
}

/* --------------------------------------------------------------- status */
/**
 * The status line lives just under the pages and is intentionally quiet: only
 * transient messages appear there. Page/zoom readouts live in the toolbar, and
 * reading progress is the hairline at the very bottom of the window.
 */
const updateStatus = throttle(() => {
  const tab = app.active;
  const hint = $('#status-hint');
  if (!tab) {
    if (hint) hint.textContent = '';
    setProgress(0);
    return;
  }
  if (hint) {
    const parts = [fmtBytes(tab.size)];
    if (tab.rotation) parts.push(`${tab.rotation}°`);
    if (tab.dirty) parts.push(t('status.unsaved'));
    hint.textContent = parts.filter(Boolean).join(' · ');
  }
  const total = tab.pageCount || 1;
  setProgress(Math.min(1, Math.max(0, (tab.page - 1) / Math.max(1, total - 1))));
}, 120);

/** Hairline reading-progress indicator at the bottom edge of the stage. */
function setProgress(ratio) {
  const fill = $('#progress-fill');
  if (!fill) return;
  fill.style.width = `${Math.round((Number.isFinite(ratio) ? ratio : 0) * 100)}%`;
}

function reportSelection() {
  const sel = window.getSelection();
  const text = sel ? sel.toString() : '';
  const node = $('#status-message');
  if (!node) return;
  node.textContent = text && text.trim().length ? t('status.selected', text.trim().length) : '';
}

/* ----------------------------------------------------------- presentation */
/* ------------------------------------------------------------ popovers */
/** Zoom presets, anchored to the zoom readout in the toolbar. */
function showZoomMenu() {
  const tab = app.active;
  if (!tab) return;
  const current = tab.scaleValue;
  openPopover($('#btn-zoom'), (node) => {
    renderMenuItems(node, [
      { header: t('nav.zoom') },
      ...[
        ['auto', t('nav.zoomAuto')],
        ['page-fit', t('nav.zoomFitPage')],
        ['page-width', t('nav.zoomFitWidth')],
        ['page-height', t('nav.zoomFitHeight')],
        ['page-actual', t('nav.zoomActual')],
      ].map(([value, label]) => ({
        label,
        checked: current === value,
        onClick: () => {
          tab.setZoom(value);
          updateToolbarState();
          updateStatus();
        },
      })),
      { separator: true },
      { label: `${t('nav.zoomIn')}  Ctrl+=`, onClick: () => zoomStep(1) },
      { label: `${t('nav.zoomOut')}  Ctrl+-`, onClick: () => zoomStep(-1) },
    ]);
  });
}

/** The toolbar's overflow menu: layout modes, reading aids, exports, tools. */
function showViewMenu() {
  const tab = app.active;
  openPopover($('#btn-view'), (node) => {
    const items = [];
    items.push({ header: t('view.pageMode') });
    for (const [key, label, extra] of [
      ['single', t('view.single'), () => setScrollMode('vertical')],
      ['spread-odd', t('view.spreadOdd'), () => setScrollMode('vertical')],
      ['spread-even', t('view.spreadEven'), () => setScrollMode('vertical')],
    ]) {
      items.push({
        label,
        checked: tab ? tab.pageModeKey === key : store.get('pageMode', 'single') === key,
        onClick: () => {
          setPageMode(key);
          extra?.();
        },
      });
    }
    items.push({ separator: true });
    items.push({ header: L('滚动方式', 'Scrolling') });
    for (const [key, label] of [
      ['vertical', L('垂直连续', 'Continuous vertical')],
      ['horizontal', L('水平连续', 'Continuous horizontal')],
      ['wrapped', L('换行网格', 'Wrapped grid')],
      ['page', L('整页翻页', 'One page at a time')],
    ]) {
      items.push({
        label,
        checked: tab ? tab.scrollModeKey === key : store.get('scrollMode', 'vertical') === key,
        onClick: () => setScrollMode(key),
      });
    }
    items.push({ separator: true });
    items.push({ header: L('阅读', 'Reading') });
    const invert = store.get('invertMode', 'off');
    for (const [value, label] of [
      ['off', t('settings.invertOff')],
      ['smart', L('夜间纸张（智能反色）', 'Night paper (smart invert)')],
      ['sepia', L('夜间纸张 + 米色', 'Night paper + sepia')],
      ['contrast', L('高对比', 'High contrast')],
    ]) {
      items.push({
        label,
        checked: invert === value,
        onClick: () => {
          store.set('invertMode', value);
          applyInvert();
          updateToolbarState();
        },
      });
    }
    items.push({
      label: t('settings.pageShadow'),
      checked: store.get('showPageShadow', true),
      onClick: () => {
        store.set('showPageShadow', !store.get('showPageShadow', true));
        applyReadingFlags();
      },
    });
    items.push({ separator: true });
    items.push({ header: t('tool.editor') });
    items.push({ label: t('tool.freeText'), accel: 'Ctrl+Shift+T', onClick: () => setTool('freeText') });
    items.push({ label: t('tool.stamp'), onClick: () => setTool('stamp') });
    items.push({ label: t('tool.signature'), onClick: () => setTool('signature') });
    items.push({ label: t('tool.undo'), accel: 'Ctrl+Z', onClick: () => tab?.undo() });
    items.push({ label: t('tool.redo'), accel: 'Ctrl+Y', onClick: () => tab?.redo() });
    items.push({ separator: true });
    items.push({ header: t('menu.pdfTools') });
    items.push({ label: t('cmd.organize'), accel: 'Ctrl+Shift+P', onClick: () => tab && organizePages(tab) });
    items.push({ label: t('action.exportImages'), onClick: () => tab && exportImages(tab) });
    items.push({ label: t('action.exportText'), onClick: () => tab && exportText(tab) });
    items.push({ label: t('action.exportAnnotations'), onClick: () => tab && exportAnnotations(tab) });
    items.push({ label: t('action.exportHtml'), onClick: () => tab && exportHtml(tab) });
    items.push({ separator: true });
    items.push({ label: t('action.print'), accel: 'Ctrl+P', onClick: () => tab && printDocument(tab) });
    items.push({ label: t('action.saveCopy'), accel: 'Ctrl+S', onClick: () => tab && saveCopyAs(tab) });
    items.push({ separator: true });
    items.push({
      label: L('重排阅读（图文重排）', 'Reflow text'),
      accel: 'Ctrl+Shift+E',
      checked: !!app.reflow,
      onClick: () => toggleReflow(),
    });
    items.push({ label: t('action.presentation'), accel: 'F5', onClick: () => togglePresentation() });
    items.push({ label: t('action.fullscreen'), accel: 'F11', onClick: () => window.lumen.win.toggleFullscreen() });
    items.push({ label: t('action.properties'), onClick: () => tab && openProperties(tab) });
    items.push({ label: t('action.settings'), accel: 'Ctrl+,', onClick: () => openSettings() });
    items.push({ label: t('action.shortcuts'), accel: 'F1', onClick: () => openShortcuts() });
    items.push({ separator: true });
    items.push({ label: t('action.clearHistory'), onClick: () => bus.emit('ui:clear-history') });
    items.push({ label: t('action.about'), onClick: () => openAbout() });
    renderMenuItems(node, items);
  });
}

/** Sidebar pane switcher, anchored to the sidebar's text title. */
function showPaneMenu() {
  const panes = [
    ['thumbnails', t('sidebar.thumbnails')],
    ['outline', t('sidebar.outline')],
    ['bookmarks', t('sidebar.bookmarks')],
    ['annotations', t('sidebar.annotations')],
  ];
  openPopover($('#sidebar-title'), (node) => {
    const items = panes.map(([key, label]) => ({
      label,
      checked: app.sidebar.pane === key,
      onClick: () => app.sidebar.setPane(key),
    }));
    items.push({ separator: true });
    items.push({
      label: L('关闭侧边栏  F4', 'Hide sidebar  F4'),
      onClick: () => toggleSidebar(false),
    });
    renderMenuItems(node, items);
  });
}

function togglePresentation() {
  const body = document.body;
  const on = !body.classList.contains('presentation');
  body.classList.toggle('presentation', on);
  const tab = app.active;
  if (tab) {
    if (on) {
      app._prePresentation = { scrollMode: tab.scrollModeKey, pageMode: tab.pageModeKey };
      tab.setScrollMode('page');
      tab.setPageMode('single');
      tab.setZoom('page-fit');
    } else if (app._prePresentation) {
      tab.setScrollMode(app._prePresentation.scrollMode);
      tab.setPageMode(app._prePresentation.pageMode);
      app._prePresentation = null;
    }
  }
  if (on) window.lumen.win.toggleFullscreen().catch(() => {});
  else window.lumen.win.isFullscreen().then((f) => f && window.lumen.win.toggleFullscreen());
  updateToolbarState();
}

function toggleSidebar(on, silent = false) {
  const sidebar = $('#sidebar');
  const resizer = $('#sidebar-resizer');
  const show = on === undefined ? sidebar.hidden : on;
  sidebar.hidden = !show;
  resizer.hidden = !show;
  $('#btn-sidebar')?.classList.toggle('active', show);
  if (!silent) {
    const cfg = store.get('sidebar', { open: true, tab: 'thumbnails' });
    store.set('sidebar', { ...cfg, open: show });
  }
}

function restoreSidebarWidth() {
  const w = store.get('sidebar', {})?.width;
  if (w) document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
  toggleSidebar(store.get('sidebar', { open: true }).open !== false, true);
}

/* ------------------------------------------------------------- zoom steps */
function zoomStep(dir) {
  const tab = app.active;
  if (!tab) return;
  const current = tab.scale || 1;
  let next;
  if (dir > 0) next = ZOOM_PRESETS.find((z) => z > current + 0.001) ?? Math.min(10, current * 1.2);
  else next = [...ZOOM_PRESETS].reverse().find((z) => z < current - 0.001) ?? Math.max(0.1, current / 1.2);
  tab.setZoom(String(next));
  updateToolbarState();
}

/* -------------------------------------------------------------- clipboard */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('toast.copied'), { kind: 'ok', duration: 1500 });
  } catch (err) {
    toast(t('toast.failed'), { kind: 'error', sub: describeError(err) });
  }
}

/* ------------------------------------------------------------- shortcuts */
function bindKeyboard() {
  window.addEventListener(
    'keydown',
    (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const inInput = isTextInput(e.target);
      const key = e.key;

      if (key === 'Escape') {
        if (isPaletteOpen()) {
          closePalette();
          e.preventDefault();
          return;
        }
        if (!$('#main-menu').hidden || !$('#context-menu').hidden) {
          closePopover();
          closeContextMenu();
          e.preventDefault();
          return;
        }
        if (document.body.classList.contains('presentation')) {
          togglePresentation();
          e.preventDefault();
          return;
        }
        if (!$('#findbar').hidden) {
          toggleFindbar(false);
          e.preventDefault();
          return;
        }
        if (app.tool !== 'select') {
          setTool('select');
          e.preventDefault();
          return;
        }
      }

      if (mod && key.toLowerCase() === 'k') {
        e.preventDefault();
        showPalette();
        return;
      }
      if (mod && key === ',') {
        e.preventDefault();
        openSettings();
        return;
      }
      if (key === 'F1') {
        e.preventDefault();
        openShortcuts();
        return;
      }
      if (key === 'F4') {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      if (key === 'F5') {
        e.preventDefault();
        togglePresentation();
        return;
      }
      if (key === 'F11') {
        e.preventDefault();
        window.lumen.win.toggleFullscreen();
        return;
      }
      if (mod && key.toLowerCase() === 'f') {
        e.preventDefault();
        toggleFindbar(true);
        return;
      }
      if (mod && key.toLowerCase() === 'o') {
        e.preventDefault();
        if (e.shiftKey) pickFolder();
        else pickFiles();
        return;
      }
      if (mod && key.toLowerCase() === 's') {
        e.preventDefault();
        app.active && saveCopyAs(app.active);
        return;
      }
      if (mod && key.toLowerCase() === 'p') {
        e.preventDefault();
        app.active && printDocument(app.active);
        return;
      }
      if (mod && key.toLowerCase() === 'w') {
        e.preventDefault();
        app.active && closeTab(app.active);
        return;
      }
      if (mod && key.toLowerCase() === 't') {
        e.preventDefault();
        if (e.shiftKey) setTool(app.tool === 'freeText' ? 'select' : 'freeText');
        else pickFiles();
        return;
      }
      if (mod && key.toLowerCase() === 'b') {
        e.preventDefault();
        if (app.active) {
          const target = app.active;
          target.addBookmark(target.page).then((added) => {
            toast(added ? t('toast.bookmarkAdded') : t('toast.bookmarkExists'), {
              kind: added ? 'ok' : 'warn',
              duration: 1800,
            });
            if (app.sidebar.pane !== 'bookmarks') app.sidebar.setPane('bookmarks');
            else app.sidebar.renderBookmarks(target);
          });
        }
        return;
      }
      if (mod && key === 'Tab') {
        e.preventDefault();
        cycleTab(e.shiftKey ? -1 : 1);
        return;
      }
      if (mod && key.toLowerCase() === 'g') {
        e.preventDefault();
        gotoPageDialog();
        return;
      }
      if (mod && (key === '=' || key === '+')) {
        e.preventDefault();
        zoomStep(1);
        return;
      }
      if (mod && key === '-') {
        e.preventDefault();
        zoomStep(-1);
        return;
      }
      if (mod && key === '0') {
        e.preventDefault();
        app.active?.setZoom('page-actual');
        return;
      }
      if (mod && key === '1') {
        e.preventDefault();
        app.active?.setZoom('page-width');
        return;
      }
      if (mod && key === '2') {
        e.preventDefault();
        app.active?.setZoom('page-fit');
        return;
      }
      if (mod && e.shiftKey && key.toLowerCase() === 'i') {
        e.preventDefault();
        store.set('invertMode', store.get('invertMode', 'off') === 'off' ? 'smart' : 'off');
        applyInvert();
        updateToolbarState();
        return;
      }
      if (mod && key.toLowerCase() === 'h') {
        e.preventDefault();
        setTool(app.tool === 'highlight' ? 'select' : 'highlight');
        return;
      }
      if (mod && key.toLowerCase() === 'd') {
        e.preventDefault();
        setTool(app.tool === 'ink' ? 'select' : 'ink');
        return;
      }
      if (mod && e.shiftKey && key.toLowerCase() === 'p') {
        e.preventDefault();
        app.active && organizePages(app.active);
        return;
      }
      if (mod && key.toLowerCase() === 'r') {
        e.preventDefault();
        app.active?.rotateBy(e.shiftKey ? -90 : 90);
        return;
      }
      if (mod && key.toLowerCase() === 'c' && !inInput && !window.getSelection()?.toString()) {
        e.preventDefault();
        const tab = app.active;
        if (tab) tab.pageText(tab.page).then((txt) => txt && copyText(txt));
        return;
      }
      if (mod && key.toLowerCase() === 'a' && !inInput) {
        const tab = app.active;
        const pv = tab?.viewer?.getPageView((tab?.page || 1) - 1);
        const textLayer = pv?.div?.querySelector('.textLayer');
        if (textLayer) {
          e.preventDefault();
          const range = document.createRange();
          range.selectNodeContents(textLayer);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
        return;
      }

      if (inInput) return;

      // Deleting the selected annotation. PDF.js's own editor would handle this
      // key, but only while its toolbar has the selection — routing it here
      // makes the Editor-bar "delete selected" action and the keyboard agree.
      if ((key === 'Delete' || key === 'Backspace') && app.active?.annotationSelected) {
        if (app.active.deleteSelectedAnnotation()) {
          e.preventDefault();
          bus.emit('ui:toast', { title: t('toast.annotationDeleted'), kind: 'ok', duration: 1400 });
          return;
        }
      }

      switch (key) {
        case 'j':
        case 'PageDown':
          app.active?.nextPage();
          e.preventDefault();
          break;
        case 'k':
        case 'PageUp':
          app.active?.prevPage();
          e.preventDefault();
          break;
        case 'ArrowDown':
          if (e.shiftKey) app.active?.scrollBy(0, window.innerHeight * 0.85);
          break;
        case 'ArrowUp':
          if (e.shiftKey) app.active?.scrollBy(0, -window.innerHeight * 0.85);
          break;
        case ' ':
          app.active?.scrollBy(0, (e.shiftKey ? -1 : 1) * window.innerHeight * 0.9);
          e.preventDefault();
          break;
        case 'Home':
          app.active?.setPage(1);
          e.preventDefault();
          break;
        case 'End':
          if (app.active) app.active.setPage(app.active.pageCount);
          e.preventDefault();
          break;
        case 'h':
          setTool(app.tool === 'hand' ? 'select' : 'hand');
          break;
        case 'v':
          setTool('select');
          break;
        case 'e':
          if (e.ctrlKey || e.metaKey || e.shiftKey) {
            toggleReflow();
            e.preventDefault();
          } else {
            setTool(app.tool === 'erase' ? 'select' : 'erase');
          }
          break;
        case 'n':
          toggleSidebar();
          break;
        default:
          break;
      }
    },
    true,
  );
}

function cycleTab(delta) {
  if (app.tabs.length < 2) return;
  const idx = app.tabs.indexOf(app.active);
  activateTab(app.tabs[(idx + delta + app.tabs.length) % app.tabs.length]);
}

function gotoPageDialog() {
  if (!app.active) return;
  promptDialog(t('cmd.goToPage'), {
    value: String(app.active.page),
    placeholder: `1 - ${app.active.pageCount}`,
  }).then((v) => {
    if (v === null) return;
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) app.active?.setPage(n);
  });
}

/* ---------------------------------------------------------------- palette */
function showPalette() {
  openPalette(async () => {
    setTimeout(() => {
      window.__lumenPaletteItemsForTest = () => paletteItemsSnapshot;
    }, 0);
    const items = [];
    const tab = app.active;
    // `keywords` holds the English (and any alias) wording for a command, so the
    // palette can be driven from either language: "opfo" finds 打开文件夹.
    const cmd = (id, title, keys, run, iconName = 'command', keywords = '') =>
      items.push({ id, title, keys, group: t('palette.commands'), run, icon: icon(iconName), keywords });
    // exposed for tools/featuretest.js so the palette's own data can be asserted
    paletteItemsSnapshot = items;

    cmd('open', t('action.open'), 'Ctrl+O', () => pickFiles(), 'folder', 'open file pdf');
    cmd('open-folder', t('cmd.openFolder'), 'Ctrl+Shift+O', () => pickFolder(), 'folder', 'open folder directory');
    cmd('recent', t('action.openRecent'), '', () => showRecentModal(), 'history', 'recent history');
    cmd('settings', t('action.settings'), 'Ctrl+,', () => openSettings(), 'settings', 'settings preferences options');
    cmd('shortcuts', t('action.shortcuts'), 'F1', () => openShortcuts(), 'keyboard', 'shortcuts keys hotkeys');
    cmd('props', t('cmd.docProps'), '', () => tab && openProperties(tab), 'info', 'properties metadata info');
    cmd('organize', t('cmd.organize'), 'Ctrl+Shift+P', () => tab && organizePages(tab), 'grid', 'organize pages reorder rotate merge split');
    cmd('find', t('view.find'), 'Ctrl+F', () => toggleFindbar(true), 'search', 'find search text');
    cmd('goto', t('cmd.goToPage'), 'Ctrl+G', () => gotoPageDialog(), 'page', 'go to page jump');
    cmd('sidebar', t('cmd.toggleSidebar'), 'F4 / N', () => toggleSidebar(), 'sidebar', 'sidebar panel thumbnails outline');
    cmd(
      'theme',
      t('cmd.toggleInvert'),
      'Ctrl+Shift+I',
      () => {
        store.set('invertMode', store.get('invertMode', 'off') === 'off' ? 'smart' : 'off');
        applyInvert();
        updateToolbarState();
      },
      'moon',
    );
    cmd('present', t('cmd.presentation'), 'F5', () => togglePresentation(), 'presentation', 'presentation fullscreen slides');
    cmd('print', t('action.print'), 'Ctrl+P', () => tab && printDocument(tab), 'print', 'print paper');
    cmd('save', t('action.saveCopy'), 'Ctrl+S', () => tab && saveCopyAs(tab), 'save copy export as');
    cmd('export-img', t('action.exportImages'), '', () => tab && exportImages(tab), 'image', 'export images png jpeg');
    cmd('export-txt', t('action.exportText'), '', () => tab && exportText(tab), 'textFile', 'export text txt plain');
    cmd('export-ann', t('action.exportAnnotations'), '', () => tab && exportAnnotations(tab), 'annotation', 'export annotations markdown notes');
    cmd('export-html', t('action.exportHtml'), '', () => tab && exportHtml(tab), 'file', 'export html web page');
    cmd('fit-width', t('cmd.fitWidth'), 'Ctrl+1', () => tab?.setZoom('page-width'), 'fitWidth', 'fit width zoom');
    cmd('fit-page', t('cmd.fitPage'), 'Ctrl+2', () => tab?.setZoom('page-fit'), 'fitPage', 'fit page zoom');
    cmd('actual', t('nav.zoomActual'), 'Ctrl+0', () => tab?.setZoom('page-actual'), 'page', 'actual size 100%');
    cmd('rotate', t('cmd.rotate'), 'Ctrl+R', () => tab?.rotateBy(90), 'rotateCw', 'rotate turn landscape');
    cmd('mode-single', t('view.single'), '', () => setPageMode('single'), 'page', 'single page layout');
    cmd('mode-spread', t('view.spreadOdd'), '', () => setPageMode('spread-odd'), 'compare', 'two page spread layout');
    cmd('mode-h', t('view.horizontal'), '', () => setScrollMode('horizontal'), 'compare', 'horizontal scroll layout');
    cmd('tool-hand', t('cmd.toggleHand'), 'H', () => setTool(app.tool === 'hand' ? 'select' : 'hand'), 'hand', 'hand tool pan drag');
    cmd(
      'tool-hl',
      t('tool.highlight'),
      'Ctrl+H',
      () => setTool(app.tool === 'highlight' ? 'select' : 'highlight'),
      'highlight',
    );
    cmd('tool-ink', t('tool.ink'), 'Ctrl+D', () => setTool(app.tool === 'ink' ? 'select' : 'ink'), 'pen', 'ink draw pen freehand');
    cmd(
      'tool-text',
      t('tool.freeText'),
      'Ctrl+Shift+T',
      () => setTool(app.tool === 'freeText' ? 'select' : 'freeText'),
      'text',
    );
    cmd('cmd-reflow', L('重排阅读（图文重排）', 'Reflow text'), 'Ctrl+Shift+E', () => toggleReflow(), 'reflow', 'reflow text mode reading column');
  cmd('tool-erase', t('tool.eraser'), 'E', () => setTool(app.tool === 'erase' ? 'select' : 'erase'), 'eraser', 'eraser delete annotation');
    cmd('undo', t('tool.undo'), 'Ctrl+Z', () => tab?.undo(), 'undo');
    cmd('redo', t('tool.redo'), 'Ctrl+Y', () => tab?.redo(), 'redo');
    cmd('bookmark', t('keys.bookmark'), 'Ctrl+B', () => tab?.addBookmark(tab.page), 'bookmark');
    cmd('close-tab', t('cmd.closeTab'), 'Ctrl+W', () => tab && closeTab(tab), 'close');
    cmd('close-all', t('action.closeAll'), '', () => closeAllTabs(), 'close');
    cmd('about', t('action.about'), '', () => openAbout(), 'info');

    if (tab) {
      const goGroup = getLanguage() === 'zh-CN' ? '跳转' : 'Go to';
      for (let i = 1; i <= Math.min(tab.pageCount, 60); i += 1) {
        items.push({
          id: `page-${i}`,
          title: `${i}`,
          subtitle: i === tab.page ? (getLanguage() === 'zh-CN' ? '当前页' : 'current') : '',
          group: goGroup,
          icon: icon('page'),
          keywords: `page ${i}`,
          run: () => tab.setPage(i),
        });
      }
    }
    const recents = await window.lumen.recents.list().catch(() => []);
    for (const r of recents.slice(0, 20)) {
      items.push({
        id: `file-${r.path}`,
        title: r.title || baseName(r.path),
        subtitle: dirName(r.path),
        group: t('palette.files'),
        icon: icon('file'),
        keywords: r.path,
        run: () => openFiles([r.path]),
      });
    }
    return items;
  });
}

/* -------------------------------------------------------------- bus glue */
function bindBusEvents() {
  bus.on('tab:ready', ({ tab }) => {
    if (tab === app.active) {
      syncChromeFromTab(tab);
      updateToolbarState();
      updateStatus();
    }
    renderTabs();
    window.lumen.reading
      .get(safeDocKey(tab.path))
      .then((st) => {
        if (st && st.page && tab.page === 1 && st.page > 1) tab.setPage(st.page);
      })
      .catch(() => {});
  });
  bus.on('tab:visible', ({ tab }) => markLoaded(tab));
  bus.on('tab:password', ({ tab, updateCallback, reason }) => {
    markLoaded(tab);
    const zh = getLanguage() === 'zh-CN';
    const isWrong = reason === 2; /* PasswordResponses.INCORRECT_PASSWORD */
    promptDialog(
      zh
        ? isWrong
          ? '密码错误，请重试'
          : '此文档已加密，请输入密码'
        : isWrong
          ? 'Wrong password, try again'
          : 'This document is encrypted',
      { value: '', placeholder: '••••••', select: true },
    ).then((pw) => {
      if (pw === null) return;
      updateCallback(pw);
    });
  });
  bus.on('tab:page', ({ tab }) => {
    if (tab !== app.active) return;
    updateStatus();
    if (app.sidebar.pane === 'thumbnails') app.sidebar.highlightThumb(tab.page);
    if (app.sidebar.pane === 'outline') app.sidebar.markOutlineCurrent(tab.page);
    if (app.sidebar.pane === 'bookmarks') app.sidebar.renderBookmarks(tab);
    if (app.sidebar.pane === 'annotations') app.sidebar.renderAnnotations();
    tab.persistState();
  });
  bus.on('tab:scale', ({ tab }) => {
    if (tab !== app.active) return;
    updateToolbarState();
    updateStatus();
  });
  bus.on('tab:rotation', ({ tab }) => {
    if (tab === app.active) updateStatus();
  });
  bus.on('tab:dirty', ({ tab }) => {
    if (tab === app.active) {
      renderTabs();
      updateStatus();
    }
  });
  // the eraser removes annotations directly from the storage, so the sidebar
  // and the status line have to be told to refresh
  bus.on('tab:annotations-changed', ({ tab }) => {
    if (tab === app.active && app.sidebar.pane === 'annotations') app.sidebar.renderAnnotations(true);
    updateStatus();
  });
  bus.on('tab:annotations-saved', ({ tab }) => {
    if (tab === app.active && app.sidebar.pane === 'annotations') app.sidebar.renderAnnotations();
  });
  bus.on('tab:editors', ({ tab }) => {
    if (tab === app.active) {
      updateStatus();
      if (app.sidebar.pane === 'annotations') app.sidebar.renderAnnotations();
    }
  });
  bus.on('tab:progress', ({ tab, loaded, total }) => {
    if (tab !== app.active || !total) return;
    setLoadingProgress(loaded / total);
    $('#status-message').textContent = `${t('status.loading')} ${Math.round((loaded / total) * 100)}%`;
  });
  bus.on('tab:find-results', ({ tab, total, pages, matches }) => {
    if (tab !== app.active) return;
    app.find.total = total;
    app.find.pages = pages;
    app.find.matches = matches || [];
    const idx = app.find.state?.current ?? 0;
    $('#find-counter').textContent = total ? `${idx + 1}/${total}` : t('find.notFound');
    if (!$('#find-results').hidden) renderFindResults();
  });
  bus.on('tab:find-state', ({ tab, state }) => {
    if (tab !== app.active) return;
    app.find.state = state;
    // PDF.js numbers FindState as 0 = FOUND, 1 = NOT_FOUND, 2 = PENDING. A
    // search that matches nothing only reports its state and never an updated
    // match count, so without this the counter keeps the previous query's
    // total — "1/12" after a search that found nothing at all.
    if (state === 1) {
      app.find.total = 0;
      app.find.pages = 0;
      app.find.matches = [];
      $('#find-counter').textContent = t('find.notFound');
      if (!$('#find-results').hidden) renderFindResults();
      return;
    }
    const total = app.find.total;
    const idx = state?.current ?? 0;
    $('#find-counter').textContent = total ? `${idx + 1}/${total}` : t('find.notFound');
  });
  bus.on('tab:bookmarks', ({ tab }) => {
    if (tab === app.active && app.sidebar.pane === 'bookmarks') app.sidebar.renderBookmarks(tab);
  });
  bus.on('tab:tool', ({ tab, tool }) => {
    if (tab === app.active && tool !== app.tool) {
      app.tool = tool;
      applyHandTool(tool === 'hand');
      updateToolbarState();
    }
  });
  bus.on('tab:activated', () => {
    if (!$('#find-results').hidden) renderFindResults();
  });
  bus.on('ui:focus-viewer', () => app.active?.viewerEl?.focus?.());
  bus.on('ui:apply-default-view', () => {
    const tab = app.active;
    if (!tab) return;
    tab.setZoom(store.get('zoomMode', 'auto'));
    setPageMode(store.get('pageMode', 'single'));
    setScrollMode(store.get('scrollMode', 'vertical'));
  });
  bus.on('ui:apply-invert', () => {
    applyInvert();
    updateToolbarState();
  });
  /**
   * The canvas budget is read when a viewer is constructed, so a change has to
   * reload the open documents to take effect.
   */
  bus.on('ui:apply-render-quality', async () => {
    for (const tab of [...app.tabs]) {
      try {
        await tab.reloadViewer();
      } catch (err) {
        console.warn('[lumen] could not re-apply render quality', err);
      }
    }
    bus.emit('ui:toast', {
      title: getLanguage() === 'zh-CN' ? '图像清晰度已更新' : 'Image quality updated',
      kind: 'ok',
      duration: 1600,
    });
  });
  // typography changes are cheap: restyle the pane, and only re-extract when the
  // figure setting changed (it decides what gets extracted in the first place)
  bus.on('ui:apply-reflow-type', () => {
    const tab = app.active;
    if (!tab) return;
    const pane = reflowFor(tab);
    pane.applyTypography();
    if (pane.visible) pane.render();
  });
  bus.on('ui:language', () => location.reload());
  bus.on('ui:clear-history', async () => {
    const ok = await confirmDialog(t('action.clearHistory'), t('modal.confirmClear'));
    if (!ok) return;
    await window.lumen.recents.clear();
    const all = await window.lumen.reading.all();
    for (const key of Object.keys(all)) {
      await window.lumen.reading.set(key, { page: 1, total: all[key]?.total });
    }
    toast(t('status.ready'), { kind: 'ok' });
    renderEmptyRecents();
  });
  bus.on('ui:clear-all-annotations', async () => {
    const ok = await confirmDialog(t('settings.clearAnnotations'), t('modal.confirmClear'), { danger: true });
    if (!ok) return;
    const all = await window.lumen.annotations.all();
    for (const key of Object.keys(all)) await window.lumen.annotations.clear(key);
    toast(t('toast.annotationsCleared'), {
      kind: 'ok',
      sub: getLanguage() === 'zh-CN' ? '重新打开文档后生效' : 'Reopen documents to apply',
    });
  });
  bus.on('ui:reset-settings', async () => {
    const ok = await confirmDialog(t('settings.resetSettings'), t('modal.confirmClear'));
    if (!ok) return;
    await store.resetSettings();
    location.reload();
  });
  bus.on('ui:clear-annotations', ({ tab }) => clearAnnotations(tab));
  bus.on('ui:open-file', async ({ path, replace }) => {
    if (replace) {
      const existing = app.tabs.find((tb) => tb.path.toLowerCase() === String(replace).toLowerCase());
      if (existing) await closeTab(existing);
    }
    if (!path) return;
    // before the initial session restore finishes these belong to the startup
    // set, so queue them and let boot() decide the order
    if (!bootDone) app.startupFiles.push(path);
    else await openFiles([path]);
  });
  bus.on('library:changed', () => renderEmptyRecents());
  window.lumen.onLibraryChange(() => renderEmptyRecents());
}

/* -------------------------------------------------- main-process messages */
function bindMainProcess() {
  window.lumen.onMenu(async ({ action }) => {
    const tab = app.active;
    switch (action) {
      case 'open':
        pickFiles();
        break;
      case 'open-folder':
        pickFolder();
        break;
      case 'save-copy':
        if (tab) saveCopyAs(tab);
        break;
      case 'export-annotations':
        if (tab) exportAnnotations(tab);
        break;
      case 'export-images':
        if (tab) exportImages(tab);
        break;
      case 'export-text':
        if (tab) exportText(tab);
        break;
      case 'print':
        if (tab) printDocument(tab);
        break;
      case 'zoom-in':
        zoomStep(1);
        break;
      case 'zoom-out':
        zoomStep(-1);
        break;
      case 'zoom-reset':
        tab?.setZoom('page-actual');
        break;
      case 'rotate-cw':
        tab?.rotateBy(90);
        break;
      case 'rotate-ccw':
        tab?.rotateBy(-90);
        break;
      case 'find':
        toggleFindbar(true);
        break;
      case 'palette':
        showPalette();
        break;
      case 'settings':
        openSettings();
        break;
      case 'properties':
        if (tab) openProperties(tab);
        break;
      case 'organize':
        if (tab) organizePages(tab);
        break;
      case 'shortcuts':
        openShortcuts();
        break;
      case 'about':
        openAbout();
        break;
      case 'presentation':
        togglePresentation();
        break;
      case 'copy-page-text':
        if (tab) tab.pageText(tab.page).then((txt) => txt && copyText(txt));
        break;
      default:
        break;
    }
  });
  window.lumen.onOpenFiles(({ files }) => openFiles(files));
  window.lumen.onToast(({ title, kind, sub }) => toast(title || '', { kind, sub }));
  window.lumen.onAppEvent(({ action }) => {
    if (action === 'before-quit') {
      for (const tab of app.tabs) {
        tab.persistState();
        tab.persistAnnotations();
      }
      persistSession();
    }
  });
}

/* ------------------------------------------------------------- drag & drop */
function bindDragDrop() {
  const overlay = $('#drop-overlay');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    depth += 1;
    overlay.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.hidden = true;
  });
  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const zh = getLanguage() === 'zh-CN';
    const paths = [];
    for (const file of e.dataTransfer.files) {
      const p = window.lumen.pathForFile(file);
      if (p) paths.push(p);
    }
    if (!paths.length) {
      toast(t('toast.failed'), {
        kind: 'error',
        sub: zh ? '无法解析拖入的文件路径' : 'Could not resolve the dropped path',
      });
      return;
    }
    const files = [];
    const folders = [];
    for (const p of paths) {
      const st = await window.lumen.fs.stat(p);
      if (st.ok) files.push(p);
      else folders.push(p);
    }
    const expanded = [...files];
    for (const dir of folders) expanded.push(...(await window.lumen.fs.listFolder(dir)));
    if (!expanded.length) {
      toast(zh ? '拖入的内容里没有可打开的文档' : 'Nothing openable was dropped', { kind: 'warn' });
      return;
    }
    openFiles(expanded);
  });
}

/* --------------------------------------------------------------- session */
const persistSession = debounce(() => {
  store.sessionSet({
    tabs: app.tabs.map((tb) => tb.path),
    activeIndex: app.active ? app.tabs.indexOf(app.active) : 0,
  });
}, 400);

const persistAll = debounce(() => {
  for (const tab of app.tabs) tab.persistState();
  persistSession();
}, 1200);

bus.on('tab:page', () => persistAll());
bus.on('tab:scale', () => persistAll());

window.addEventListener('beforeunload', () => {
  for (const tab of app.tabs) {
    tab.persistState();
    tab.persistAnnotations();
  }
  persistSession.flush();
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (store.get('theme', 'auto') === 'auto') applyTheme();
});

store.on('setting', ({ key }) => {
  if (key === 'theme' || key === '*') applyTheme();
  if (key === 'showPageShadow' || key === 'animation' || key === 'useSystemCursor' || key === '*') {
    applyReadingFlags();
  }
  if (key === 'invertMode' || key === '*') {
    applyInvert();
    updateToolbarState();
  }
});

boot().catch((err) => {
  console.error('[lumen] boot failed', err);
  document.body.innerHTML = `<pre style="color:#fff;padding:24px;font:13px monospace;white-space:pre-wrap">LeebertyPDF 启动失败:\n${escapeHtml(
    String(err && err.stack ? err.stack : err),
  )}</pre>`;
});
