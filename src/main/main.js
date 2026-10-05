'use strict';
/**
 * LeebertyPDF — main process.
 * Responsibilities: window lifecycle, native menu/shortcuts, file dialogs,
 * persistence (settings / session), file-association helpers, single instance.
 */
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  shell,
  nativeTheme,
  screen,
  protocol,
  net,
} = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');
const { Store } = require('./store');
const pageEdit = require('./pdfedit');

const IS_DEV = process.argv.includes('--dev') || !!process.env.LUMEN_DEV;
const APP_DIR = path.join(__dirname, '..', '..');
const SRC_DIR = path.join(APP_DIR, 'src');
const RENDERER_DIR = path.join(SRC_DIR, 'renderer');

/** token -> { path, size, mtime, openedAt } for documents served to the renderer */
const documents = new Map();
let tokenSeq = 0;

function newToken() {
  tokenSeq += 1;
  return `${Date.now().toString(36)}${tokenSeq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Custom schemes. Documents are streamed straight off disk (with Range
// support) instead of being copied through IPC, and bundled assets are served
// from a locked-down root. Both schemes must be registered before `ready`.
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'lumen-file',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false, corsEnabled: true },
  },
  {
    scheme: 'lumen-app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false, corsEnabled: true },
  },
]);

const MIME = {
  '.pdf': 'application/pdf',
  '.xps': 'application/oxps',
  '.epub': 'application/epub+zip',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.txt': 'text/plain; charset=utf-8',
  '.ftl': 'text/plain; charset=utf-8',
};

function mimeFor(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

/** Streams `filePath` with correct Range handling. */
function serveFile(request, filePath, extraHeaders = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('not a file');
  } catch (err) {
    return new Response(`Not found: ${path.basename(filePath)}`, {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const size = stat.size;
  const type = mimeFor(filePath);
  const rangeHeader = request.headers.get('range') || request.headers.get('Range');
  const baseHeaders = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
    'access-control-allow-origin': '*',
    ...extraHeaders,
  };

  if (rangeHeader) {
    const m = /bytes=(\d*)-(\d*)/i.exec(rangeHeader);
    if (m) {
      let start = m[1] === '' ? null : Number(m[1]);
      let end = m[2] === '' ? null : Number(m[2]);
      if (start === null && end !== null) {
        start = Math.max(0, size - end);
        end = size - 1;
      }
      if (start !== null) {
        if (end === null || end >= size) end = size - 1;
        if (start > end || start >= size) {
          return new Response(null, { status: 416, headers: { ...baseHeaders, 'content-range': `bytes */${size}` } });
        }
        const stream = fs.createReadStream(filePath, { start, end });
        return new Response(Readable.toWeb(stream), {
          status: 206,
          headers: {
            ...baseHeaders,
            'content-range': `bytes ${start}-${end}/${size}`,
            'content-length': String(end - start + 1),
          },
        });
      }
    }
  }

  const stream = fs.createReadStream(filePath);
  return new Response(Readable.toWeb(stream), {
    status: 200,
    headers: { ...baseHeaders, 'content-length': String(size) },
  });
}

function registerProtocols() {
  protocol.handle('lumen-file', async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('bad url', { status: 400 });
    }
    const token = decodeURIComponent(url.pathname.replace(/^\/+/, '') || url.hostname);
    const rec = documents.get(token);
    if (!rec) return new Response('unknown document token', { status: 404 });
    return serveFile(request, rec.path);
  });

  protocol.handle('lumen-app', async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('bad url', { status: 400 });
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const target = path.resolve(RENDERER_DIR, rel);
    if (!target.startsWith(RENDERER_DIR)) return new Response('forbidden', { status: 403 });
    return serveFile(request, target);
  });
}

function registerDocument(filePath) {
  const resolved = path.resolve(filePath);
  const token = newToken();
  let size = 0;
  let mtime = 0;
  try {
    const st = fs.statSync(resolved);
    size = st.size;
    mtime = st.mtimeMs;
  } catch {
    /* keep zeroes */
  }
  documents.set(token, { path: resolved, size, mtime, openedAt: Date.now() });
  if (documents.size > 120) {
    const oldest = [...documents.entries()].sort((a, b) => a[1].openedAt - b[1].openedAt).slice(0, documents.size - 120);
    for (const [k] of oldest) documents.delete(k);
  }
  return { token, path: resolved, size, mtime, name: path.basename(resolved) };
}

// ---------------------------------------------------------------------------
// Chromium switches. Touchpad pinch zoom is handled by the app itself, and we
// want crisp canvases, so disable the browser-level zoom machinery.
// ---------------------------------------------------------------------------
app.commandLine.appendSwitch('disable-pinch');

/** @type {Electron.BrowserWindow|null} */
let win = null;
/** @type {Electron.Menu|null} */
let nativeMenu = null;
/** @type {string[]} */
let pendingFiles = [];
let readyToReceive = false;

const settings = new Store(path.join(app.getPath('userData'), 'settings.json'), {
  theme: 'auto', // auto | light | dark | sepia | night
  language: 'zh-CN', // zh-CN | en-US
  pageMode: 'single', // single | spread-odd | spread-even
  scrollMode: 'vertical', // vertical | horizontal | wrapped | page
  zoomMode: 'auto',
  zoomScale: 1,
  sidebar: { open: true, tab: 'thumbnails', width: 260 },
  findbar: { caseSensitive: false, entireWord: false, highlightAll: true, diacritics: false },
  showPageShadow: true,
  useSystemCursor: false,
  animation: true,
  invertMode: 'off', // off | invert | sepia | contrast | smart-dark
  autoReload: false,
  restoreSession: true,
  recentLimit: 40,
  handTool: false,
  scrollWrap: false,
  enableTextLayer: true,
  enableAnnotations: true,
  uiScale: 1,
});

const session = new Store(path.join(app.getPath('userData'), 'session.json'), {
  tabs: [],
  activeIndex: 0,
  windowBounds: null,
  maximized: false,
});

const reading = new Store(path.join(app.getPath('userData'), 'reading.json'), {
  // key -> { page, scale, scrollMode, pageMode, scrollTop, updatedAt, total, title }
  docs: {},
});

const bookmarks = new Store(path.join(app.getPath('userData'), 'bookmarks.json'), {
  // key -> [{id, page, label, createdAt}]
  docs: {},
});

const recents = new Store(path.join(app.getPath('userData'), 'recents.json'), {
  items: [], // [{path, title, page, total, openedAt, pinned}]
});

const annotations = new Store(path.join(app.getPath('userData'), 'annotations.json'), {
  docs: {}, // key -> { serialized: <annotationStorage serialized>, updatedAt }
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const PDF_EXTS = ['.pdf', '.xps', '.epub', '.mobi', '.fb2', '.cbz'];
const isPdfLike = (p) => PDF_EXTS.includes(path.extname(p).toLowerCase());
const exists = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

function docKey(filePath) {
  if (!filePath) return '';
  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch {
    /* ignore */
  }
  const base = path.resolve(filePath).toLowerCase();
  return stat ? `${base}::${stat.size}::${Math.round(stat.mtimeMs)}` : base;
}

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** All regular files of a directory, natural-sorted (used for "open folder"). */
async function listFolder(dir) {
  const out = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile() && isPdfLike(e.name)) out.push(path.join(dir, e.name));
  }
  out.sort(naturalCompare);
  return out;
}

function expandTargets(targets) {
  const files = [];
  for (const t of targets) {
    try {
      const st = fs.statSync(t);
      if (st.isDirectory()) {
        for (const e of fs.readdirSync(t, { withFileTypes: true })) {
          if (e.isFile() && isPdfLike(e.name)) files.push(path.join(t, e.name));
        }
      } else if (st.isFile()) {
        files.push(t);
      }
    } catch {
      /* ignore */
    }
  }
  files.sort(naturalCompare);
  return files;
}

function extractPaths(argv) {
  const out = [];
  for (const a of argv) {
    if (!a || a.startsWith('-')) continue;
    if (a === '.' || a.endsWith('main.js') || a.endsWith('entry.js') || a.endsWith('electron.exe')) continue;
    const p = path.resolve(a);
    try {
      if (fs.statSync(p).isFile()) out.push(p);
    } catch {
      /* not a path we can open */
    }
  }
  return out;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function syncMenuBar() {
  if (!win || win.isDestroyed()) return;
  Menu.setApplicationMenu(win.isFullScreen() ? (nativeMenu = buildNativeMenu()) : null);
}

function buildNativeMenu() {
  const isMac = process.platform === 'darwin';
  const t = (zh, en) => (settings.get('language') === 'en-US' ? en : zh);
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    {
      label: t('文件', 'File'),
      submenu: [
        {
          label: t('打开…', 'Open…'),
          accelerator: 'CmdOrCtrl+O',
          click: () => send('menu', { action: 'open' }),
        },
        {
          label: t('打开文件夹…', 'Open Folder…'),
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => send('menu', { action: 'open-folder' }),
        },
        { type: 'separator' },
        {
          label: t('保存副本…', 'Save a Copy…'),
          accelerator: 'CmdOrCtrl+S',
          click: () => send('menu', { action: 'save-copy' }),
        },
        {
          label: t('导出批注摘要…', 'Export Annotations…'),
          click: () => send('menu', { action: 'export-annotations' }),
        },
        {
          label: t('导出页面为图片…', 'Export Pages as Images…'),
          click: () => send('menu', { action: 'export-images' }),
        },
        { type: 'separator' },
        {
          label: t('打印…', 'Print…'),
          accelerator: 'CmdOrCtrl+P',
          click: () => send('menu', { action: 'print' }),
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: t('关闭窗口', 'Close Window') } : { role: 'quit', label: t('退出', 'Quit') },
      ],
    },
    {
      label: t('编辑', 'Edit'),
      submenu: [
        { role: 'undo', label: t('撤销', 'Undo') },
        { role: 'redo', label: t('重做', 'Redo') },
        { type: 'separator' },
        { role: 'cut', label: t('剪切', 'Cut') },
        { role: 'copy', label: t('复制', 'Copy') },
        { role: 'paste', label: t('粘贴', 'Paste') },
        { role: 'selectAll', label: t('全选', 'Select All') },
        { type: 'separator' },
        {
          label: t('复制当前页文本', 'Copy Page Text'),
          click: () => send('menu', { action: 'copy-page-text' }),
        },
        {
          label: t('页面另存为文本…', 'Save Document Text…'),
          click: () => send('menu', { action: 'export-text' }),
        },
      ],
    },
    {
      label: t('视图', 'View'),
      submenu: [
        {
          label: t('放大', 'Zoom In'),
          accelerator: 'CmdOrCtrl+=',
          click: () => send('menu', { action: 'zoom-in' }),
        },
        {
          label: t('缩小', 'Zoom Out'),
          accelerator: 'CmdOrCtrl+-',
          click: () => send('menu', { action: 'zoom-out' }),
        },
        {
          label: t('实际大小', 'Actual Size'),
          accelerator: 'CmdOrCtrl+0',
          click: () => send('menu', { action: 'zoom-reset' }),
        },
        { type: 'separator' },
        {
          label: t('顺时针旋转', 'Rotate Clockwise'),
          accelerator: 'CmdOrCtrl+R',
          click: () => send('menu', { action: 'rotate-cw' }),
        },
        {
          label: t('逆时针旋转', 'Rotate Counter-clockwise'),
          click: () => send('menu', { action: 'rotate-ccw' }),
        },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('全屏', 'Full Screen') },
        {
          label: t('演示模式', 'Presentation Mode'),
          accelerator: 'F5',
          click: () => send('menu', { action: 'presentation' }),
        },
        { type: 'separator' },
        { role: 'reload', label: t('重新加载', 'Reload') },
        { role: 'toggleDevTools', label: t('开发者工具', 'Developer Tools') },
      ],
    },
    {
      label: t('工具', 'Tools'),
      submenu: [
        {
          label: t('查找…', 'Find…'),
          accelerator: 'CmdOrCtrl+F',
          click: () => send('menu', { action: 'find' }),
        },
        {
          label: t('命令面板', 'Command Palette'),
          accelerator: 'CmdOrCtrl+K',
          click: () => send('menu', { action: 'palette' }),
        },
        {
          label: t('设置', 'Settings'),
          accelerator: 'CmdOrCtrl+,',
          click: () => send('menu', { action: 'settings' }),
        },
        { type: 'separator' },
        {
          label: t('文档属性', 'Document Properties'),
          click: () => send('menu', { action: 'properties' }),
        },
        {
          label: t('整理页面…', 'Organize Pages…'),
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => send('menu', { action: 'organize' }),
        },
        { type: 'separator' },
        {
          label: t('清空阅读记录', 'Clear Reading History'),
          click: () => {
            reading.reset();
            recents.set('items', []);
            send('library', { changed: true });
          },
        },
      ],
    },
    {
      label: t('帮助', 'Help'),
      submenu: [
        {
          label: t('键盘快捷键', 'Keyboard Shortcuts'),
          accelerator: 'F1',
          click: () => send('menu', { action: 'shortcuts' }),
        },
        {
          label: t('关于 LeebertyPDF', 'About LeebertyPDF'),
          click: () => send('menu', { action: 'about' }),
        },
        { type: 'separator' },
        {
          label: t('PDF.js 项目主页', 'PDF.js Homepage'),
          click: () => shell.openExternal('https://mozilla.github.io/pdf.js/'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  nativeMenu = Menu.getApplicationMenu();
  return nativeMenu;
}

function createWindow() {
  const bounds = session.get('windowBounds') || null;
  const opts = {
    width: 1440,
    height: 920,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: settings.get('theme') === 'dark' ? '#1b1d22' : '#2b2f36',
    title: 'LeebertyPDF',
    // The renderer draws the whole chrome, including its own minimise /
    // maximise / close buttons, so the native caption bar must be removed —
    // otherwise Windows paints a second set of controls right above ours.
    frame: false,
    // keeps the window resizable from every edge while frameless
    thickFrame: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(SRC_DIR, 'main', 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
      webSecurity: true,
    },
  };
  if (bounds && Number.isFinite(bounds.x)) {
    const displays = screen.getAllDisplays();
    const visible = displays.some((d) => {
      const b = d.workArea;
      return (
        bounds.x < b.x + b.width && bounds.x + 200 > b.x && bounds.y < b.y + b.height && bounds.y + 100 > b.y
      );
    });
    if (visible) {
      opts.x = bounds.x;
      opts.y = bounds.y;
      opts.width = bounds.width;
      opts.height = bounds.height;
    }
  }

  win = new BrowserWindow(opts);
  const iconPath = path.join(APP_DIR, 'assets', 'icon.ico');
  if (fs.existsSync(iconPath)) {
    try {
      win.setIcon(iconPath);
    } catch {
      /* icon is cosmetic */
    }
  }
  if (session.get('maximized')) win.maximize();

  win.once('ready-to-show', () => {
    win.show();
    if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });
  });

  // Lumen draws its own chrome; the native menu bar only exists while the
  // window is full screen (where it is auto-hidden until Alt is pressed), which
  // keeps every accelerator working without stealing a row of pixels.
  win.on('enter-full-screen', syncMenuBar);
  win.on('leave-full-screen', syncMenuBar);
  syncMenuBar();

  // Keep the OS window title under our control (no flicker from document.title).
  win.on('page-title-updated', (e) => e.preventDefault());

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    const maximized = win.isMaximized();
    session.set('maximized', maximized);
    if (!maximized && !win.isFullScreen()) {
      const b = win.getBounds();
      session.set('windowBounds', { x: b.x, y: b.y, width: b.width, height: b.height });
    }
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('maximize', saveBounds);
  win.on('unmaximize', saveBounds);

  win.on('close', () => {
    saveBounds();
    try {
      session.flush();
      settings.flush();
      reading.flush();
      bookmarks.flush();
      recents.flush();
      annotations.flush();
    } catch {
      /* ignore */
    }
    send('app', { action: 'before-quit' });
  });

  win.on('closed', () => {
    win = null;
  });

  // external links open in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  win.loadFile(path.join(SRC_DIR, 'renderer', 'index.html'));

  // Surface renderer diagnostics on the terminal while developing.
  if (IS_DEV || process.env.LUMEN_SELFTEST || process.env.LUMEN_FEATURETEST || process.env.LUMEN_IMGTEST || process.env.LUMEN_BLANKPROBE || process.env.LUMEN_FEATUREPROBE || process.env.LUMEN_MEMPROBE || process.env.LUMEN_SHOTS) {
    win.webContents.on('console-message', (event) => {
      const level = String(event.level ?? '');
      const tag = level === 'error' || level === '3' ? 'ERR' : level === 'warning' || level === '2' ? 'WRN' : 'LOG';
      console.log(`[renderer:${tag}] ${event.message}  (${event.sourceId || ''}:${event.lineNumber || ''})`);
    });
    win.webContents.on('render-process-gone', (_e, d) => console.error('[renderer] gone', d));
    win.webContents.on('preload-error', (_e, p, err) => console.error('[preload]', p, err));
  }

  win.webContents.once('did-finish-load', () => {
    readyToReceive = true;
    if (pendingFiles.length) {
      send('open-files', { files: pendingFiles.splice(0) });
    }
    if (process.env.LUMEN_SELFTEST) {
      require(path.join(APP_DIR, 'tools', 'selftest.js')).run({ win, app, documents });
    }
    if (process.env.LUMEN_FEATURETEST) {
      console.log('[featuretest] hook running');
      require(path.join(APP_DIR, 'tools', 'featuretest.js'))({ win, app, documents }).catch((err) => {
        console.error('[featuretest] crashed:', err);
        app.exit(1);
      });
    }
    if (process.env.LUMEN_SHOTS) {
      require(path.join(APP_DIR, 'tools', 'shots.js'))({ win, app, documents }).catch((err) => {
        console.error('[shots] crashed:', err);
        app.exit(1);
      });
    }
    if (process.env.LUMEN_MEMPROBE) {
      require(path.join(APP_DIR, 'tools', 'memprobe.js'))({ win, app, documents }).catch((err) => {
        console.error('[memprobe] crashed:', err);
        app.exit(1);
      });
    }
    if (process.env.LUMEN_FEATUREPROBE) {
      require(path.join(APP_DIR, 'tools', 'featureprobe.js'))({ win, app, documents }).catch((err) => {
        console.error('[featureprobe] crashed:', err);
        app.exit(1);
      });
    }
    if (process.env.LUMEN_BLANKPROBE) {
      require(path.join(APP_DIR, 'tools', 'blankprobe.js'))({ win, app, documents }).catch((err) => {
        console.error('[blankprobe] crashed:', err);
        app.exit(1);
      });
    }
    if (process.env.LUMEN_IMGTEST) {
      console.log('[imgtest] hook running from', path.join(APP_DIR, 'tools', 'imgtest.js'));
      require(path.join(APP_DIR, 'tools', 'imgtest.js'))({ win, app, documents }).catch((err) => {
        console.error('[imgtest] crashed:', err);
        app.exit(1);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// single instance
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const files = extractPaths(argv.slice(1));
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (files.length) {
        if (readyToReceive) send('open-files', { files });
        else pendingFiles.push(...files);
      }
    }
  });

  app.on('open-file', (e, p) => {
    e.preventDefault();
    if (win && readyToReceive) send('open-files', { files: [p] });
    else pendingFiles.push(p);
  });

  app.whenReady().then(() => {
    pendingFiles.push(...extractPaths(process.argv.slice(IS_DEV ? 2 : 1)));
    nativeTheme.themeSource = 'system';
    registerProtocols();
    nativeMenu = buildNativeMenu();
    Menu.setApplicationMenu(null);
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
const handle = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => fn(...args));

handle('app:info', () => ({
  version: app.getVersion(),
  name: 'LeebertyPDF',
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  userData: app.getPath('userData'),
  locale: app.getLocale(),
  isDev: IS_DEV,
  pdfjs: '6.3.289',
}));

/** Register a file for streaming and hand the renderer an opaque token URL. */
handle('doc:open', (filePath) => {
  try {
    const rec = registerDocument(filePath);
    return { ok: true, ...rec, url: `lumen-file://doc/${rec.token}` };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

handle('doc:release', (token) => {
  documents.delete(String(token));
  return true;
});

handle('doc:register-path', (filePath) =>
  registerDocument(filePath),
);

handle('doc:url-for', (token) => `lumen-file://doc/${encodeURIComponent(String(token))}`);

handle('settings:all', () => settings.get());
handle('settings:set', (key, value) => {
  settings.set(key, value);
  if (key === 'language') syncMenuBar();
  return true;
});
handle('settings:patch', (obj) => {
  settings.patch(obj);
  if (obj && obj.language) syncMenuBar();
  return settings.get();
});
handle('settings:reset', () => {
  settings.reset();
  syncMenuBar();
  return settings.get();
});

handle('session:get', () => session.get());
handle('session:set', (obj) => {
  session.patch(obj);
  return true;
});

handle('reading:all', () => reading.get('docs'));
handle('reading:get', (key) => reading.get('docs')[key] || null);
handle('reading:set', (key, value) => {
  const docs = reading.get('docs');
  docs[key] = { ...(docs[key] || {}), ...value, updatedAt: Date.now() };
  const keys = Object.keys(docs);
  if (keys.length > 800) {
    keys
      .sort((a, b) => (docs[a].updatedAt || 0) - (docs[b].updatedAt || 0))
      .slice(0, keys.length - 800)
      .forEach((k) => delete docs[k]);
  }
  reading.set('docs', docs);
  return true;
});

handle('bookmarks:all', () => bookmarks.get('docs'));
handle('bookmarks:get', (key) => bookmarks.get('docs')[key] || []);
handle('bookmarks:set', (key, list) => {
  const docs = bookmarks.get('docs');
  docs[key] = list;
  bookmarks.set('docs', docs);
  return true;
});

handle('annotations:get', (key) => annotations.get('docs')[key] || null);
handle('annotations:set', (key, value) => {
  const docs = annotations.get('docs');
  docs[key] = { ...value, updatedAt: Date.now() };
  annotations.set('docs', docs);
  return true;
});
handle('annotations:clear', (key) => {
  const docs = annotations.get('docs');
  delete docs[key];
  annotations.set('docs', docs);
  return true;
});
handle('annotations:all', () => annotations.get('docs'));

handle('recents:list', () => recents.get('items'));
handle('recents:touch', (item) => {
  const items = recents.get('items').filter((i) => i.path !== item.path);
  items.unshift({ ...item, openedAt: Date.now() });
  const limited = items.slice(0, settings.get('recentLimit', 40));
  recents.set('items', limited);
  return limited;
});
handle('recents:remove', (p) => {
  const items = recents.get('items').filter((i) => i.path !== p);
  recents.set('items', items);
  return items;
});
handle('recents:pin', (p, pinned) => {
  const items = recents.get('items').map((i) => (i.path === p ? { ...i, pinned } : i));
  recents.set('items', items);
  return items;
});
handle('recents:clear', () => {
  recents.set('items', []);
  return [];
});

handle('library:stats', () => {
  const docs = reading.get('docs');
  const keys = Object.keys(docs);
  let pages = 0;
  let finished = 0;
  let opened = 0;
  for (const k of keys) {
    const d = docs[k];
    opened += 1;
    pages += d.total || 0;
    if (d.total && d.page >= d.total - 1) finished += 1;
  }
  const ann = annotations.get('docs');
  let notes = 0;
  for (const k of Object.keys(ann)) {
    try {
      notes += Object.keys(JSON.parse(ann[k].serialized || '{}')).length;
    } catch {
      /* ignore */
    }
  }
  const marks = bookmarks.get('docs');
  let bookmarkCount = 0;
  for (const k of Object.keys(marks)) bookmarkCount += (marks[k] || []).length;
  return { docs: opened, pages, finished, notes, bookmarks: bookmarkCount };
});

handle('dialog:open', async (opts = {}) => {
  const res = await dialog.showOpenDialog(win, {
    title: opts.title || '打开 PDF',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'PDF 文档', extensions: ['pdf'] },
      { name: '所有支持的文件', extensions: ['pdf', 'xps', 'epub', 'mobi', 'fb2', 'cbz'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  return res.canceled ? [] : res.filePaths;
});

handle('dialog:open-folder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '打开文件夹',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const dir = res.filePaths[0];
  return { dir, files: await listFolder(dir) };
});

handle('dialog:save', async (opts = {}) => {
  const res = await dialog.showSaveDialog(win, {
    title: opts.title || '保存',
    defaultPath: opts.defaultPath,
    filters: opts.filters || [{ name: '所有文件', extensions: ['*'] }],
  });
  return res.canceled ? null : res.filePath;
});

handle('fs:write', async (filePath, data, encoding) => {
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
      await fsp.writeFile(filePath, Buffer.from(data));
    } else {
      await fsp.writeFile(filePath, String(data), encoding || 'utf8');
    }
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

handle('fs:read', async (filePath) => {
  try {
    const buf = await fsp.readFile(filePath);
    return { ok: true, data: new Uint8Array(buf) };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

handle('fs:exists', (p) => exists(p));
handle('fs:list-folder', async (dir) => {
  try {
    return await listFolder(dir);
  } catch {
    return [];
  }
});
handle('fs:stat', (p) => {
  try {
    const s = fs.statSync(p);
    return { ok: true, size: s.size, mtime: s.mtimeMs, dir: path.dirname(p), name: path.basename(p) };
  } catch (err) {
    return { ok: false, error: String(err.message) };
  }
});
handle('fs:default-dir', () => app.getPath('documents'));

/* ------------------------------------------------------------- page editor */
handle('edit:open', (payload) => pageEdit.handlers.open(payload || {}));
handle('edit:apply', (payload) => pageEdit.handlers.apply(payload || {}));
handle('edit:save', (payload) => pageEdit.handlers.save(payload || {}));
handle('edit:split', (payload) => pageEdit.handlers.split(payload || {}));
handle('edit:inspect', (payload) => pageEdit.handlers.inspect(payload || {}));
handle('edit:close', (payload) => pageEdit.handlers.close(payload || {}));

handle('shell:open-path', (p) => shell.openPath(p));
handle('shell:show-item', (p) => {
  shell.showItemInFolder(p);
});
handle('shell:open-external', (url) => {
  if (/^https?:/i.test(url)) return shell.openExternal(url);
  return null;
});

handle('win:set-title', (title) => {
  if (win && !win.isDestroyed()) win.setTitle(title || 'LeebertyPDF');
  return true;
});
handle('win:toggle-fullscreen', () => {
  if (!win) return false;
  win.setFullScreen(!win.isFullScreen());
  return win.isFullScreen();
});
handle('win:is-fullscreen', () => (win ? win.isFullScreen() : false));
handle('win:minimize', () => win && win.minimize());
handle('win:maximize-toggle', () => {
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return win.isMaximized();
});
handle('win:close', () => win && win.close());

handle('theme:set', (source) => {
  if (['system', 'light', 'dark'].includes(source)) nativeTheme.themeSource = source;
  return nativeTheme.shouldUseDarkColors;
});

handle('app:reload', () => {
  if (win) win.webContents.reload();
});
handle('app:relaunch', () => {
  app.relaunch();
  app.exit(0);
});

/** Renders an offscreen window to PDF — used by "print / export PDF". */
handle('print:document', async (payload) => {
  const { urls, pageSize = 'A4', landscape = false, printBackground = true } = payload || {};
  if (!Array.isArray(urls) || !urls.length) return { ok: false, error: 'no url' };
  const hidden = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, javascript: true, sandbox: true },
  });
  try {
    await hidden.loadURL(urls[0]);
    // give pdf.js a moment to paint the first page canvas
    await new Promise((r) => setTimeout(r, 1500));
    const data = await hidden.webContents.printToPDF({
      pageSize,
      landscape,
      printBackground,
      margins: { marginType: 'none' },
      preferCSSPageSize: true,
    });
    return { ok: true, data: new Uint8Array(data) };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally {
    hidden.destroy();
  }
});

/** Silent screenshot-free "print to default printer" is intentionally omitted. */
handle('ui:notify', (payload) => {
  send('toast', payload);
  return true;
});

module.exports = { docKey };
