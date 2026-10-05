/* =========================================================================
   LeebertyPDF — dialogs: settings, document properties, shortcuts, about
   ========================================================================= */
import { $, el, fmtBytes, fmtDate, store, t, bus, clamp } from './lib/core.js';
import { openModal, toast } from './lib/widgets.js';

/* --------------------------------------------------------------- helpers */
function row(label, help, control) {
  return el(
    'div',
    { class: 'setting-row' },
    el('div', { class: 'setting-info' }, el('div', { class: 'setting-label', text: label }), help ? el('div', { class: 'setting-help', text: help }) : null),
    el('div', { class: 'setting-control' }, control),
  );
}

/**
 * Live memory readout for the settings dialog.
 *
 * Chromium exposes `performance.memory` to the renderer; on top of that the
 * canvas backing store is counted explicitly, because that is the part the
 * image-quality setting actually controls.
 */
function memoryBox() {
  const box = el('div', { class: 'setting-value', text: '\u2014' });
  const update = () => {
    const parts = [];
    const mem = performance.memory;
    if (mem && mem.usedJSHeapSize) parts.push(`JS ${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB`);
    let pixels = 0;
    for (const c of document.querySelectorAll('canvas')) pixels += (c.width || 0) * (c.height || 0);
    if (pixels) parts.push(`\u753b\u5e03 ${((pixels * 4) / 1048576).toFixed(0)} MB`);
    const pages = document.querySelectorAll('.pdf-container .page canvas').length;
    if (pages) parts.push(`${pages} \u9875\u5df2\u7f13\u5b58`);
    const limit = mem && mem.jsHeapSizeLimit ? ` / \u4e0a\u9650 ${(mem.jsHeapSizeLimit / 1048576).toFixed(0)} MB` : '';
    box.textContent = (parts.join(' \u00b7 ') || '\u2014') + limit;
  };
  update();
  const timer = setInterval(() => {
    if (!box.isConnected) {
      clearInterval(timer);
      return;
    }
    update();
  }, 1000);
  return box;
}

function switchControl(initial, onChange) {
  const node = el('div', { class: `switch${initial ? ' on' : ''}` });
  node.addEventListener('click', () => {
    const next = !node.classList.contains('on');
    node.classList.toggle('on', next);
    onChange(next);
  });
  return node;
}

function segControl(options, current, onChange) {
  const box = el('div', { class: 'seg-control' });
  for (const opt of options) {
    const b = el('button', {
      class: opt.value === current ? 'active' : '',
      text: opt.label,
      title: opt.title || '',
    });
    b.addEventListener('click', () => {
      for (const child of box.children) child.classList.remove('active');
      b.classList.add('active');
      onChange(opt.value);
    });
    box.append(b);
  }
  return box;
}

function selectControl(options, current, onChange) {
  const sel = el('select', { class: 'select' });
  for (const opt of options) {
    sel.append(el('option', { value: String(opt.value), text: opt.label, selected: String(opt.value) === String(current) }));
  }
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function numberControl(value, min, max, step, onChange) {
  const input = el('input', {
    class: 'num-input',
    type: 'number',
    value: String(value),
    min: String(min),
    max: String(max),
    step: String(step),
    style: { width: '68px', textAlign: 'center', border: '1px solid var(--border)', borderRadius: '8px', height: '28px', background: 'var(--bg-input)', color: 'var(--fg)' },
  });
  input.addEventListener('change', () => onChange(clamp(Number(input.value) || min, min, max)));
  return input;
}

/* -------------------------------------------------------------- settings */
export function openSettings(initialSection = 'general') {
  const sections = [
    { id: 'general', label: t('settings.general') },
    { id: 'view', label: t('settings.view') },
    { id: 'annotations', label: t('settings.annotations') },
    { id: 'data', label: t('settings.data') },
    { id: 'about', label: t('settings.about') },
  ];
  let current = initialSection;

  const nav = el('div', { class: 'settings-nav' });
  const panes = el('div', { class: 'settings-panes' });
  const paneNodes = {};

  const buildPane = (id) => {
    const box = el('div', { class: 'settings-pane' });
    paneNodes[id] = box;
    if (id === 'general') {
      box.append(
        el('div', { class: 'section-title', text: t('settings.general') }),
        row(
          t('settings.language'),
          t('settings.languageHelp'),
          selectControl(
            [
              { value: 'zh-CN', label: '简体中文' },
              { value: 'en-US', label: 'English' },
            ],
            store.get('language', 'zh-CN'),
            (v) => {
              store.set('language', v);
              bus.emit('ui:language', v);
            },
          ),
        ),
        row(
          t('settings.theme'),
          '',
          segControl(
            [
              { value: 'auto', label: t('settings.themeAuto') },
              { value: 'light', label: t('settings.themeLight') },
              { value: 'dark', label: t('settings.themeDark') },
              { value: 'sepia', label: t('settings.themeSepia') },
              { value: 'night', label: t('settings.themeNight') },
            ],
            store.get('theme', 'auto'),
            (v) => store.set('theme', v),
          ),
        ),
        row(t('settings.animation'), '', switchControl(store.get('animation', true), (v) => store.set('animation', v))),
        row(t('settings.restoreSession'), '', switchControl(store.get('restoreSession', true), (v) => store.set('restoreSession', v))),
        row(
          t('settings.recentLimit'),
          '',
          numberControl(store.get('recentLimit', 40), 5, 200, 5, (v) => store.set('recentLimit', v)),
        ),
      );
    } else if (id === 'view') {
      box.append(
        el('div', { class: 'section-title', text: t('settings.readingDefault') }),
        row(
          t('nav.zoom'),
          '',
          selectControl(
            [
              { value: 'auto', label: t('nav.zoomAuto') },
              { value: 'page-width', label: t('nav.zoomFitWidth') },
              { value: 'page-fit', label: t('nav.zoomFitPage') },
              { value: 'page-height', label: t('nav.zoomFitHeight') },
              { value: 'page-actual', label: t('nav.zoomActual') },
            ],
            store.get('zoomMode', 'auto'),
            (v) => {
              store.set('zoomMode', v);
              bus.emit('ui:apply-default-view');
            },
          ),
        ),
        row(
          t('view.pageMode'),
          '',
          segControl(
            [
              { value: 'single', label: t('view.single') },
              { value: 'spread-odd', label: t('view.spreadOdd') },
              { value: 'spread-even', label: t('view.spreadEven') },
            ],
            store.get('pageMode', 'single'),
            (v) => {
              store.set('pageMode', v);
              bus.emit('ui:apply-default-view');
            },
          ),
        ),
        row(
          '滚动方式',
          '',
          segControl(
            [
              { value: 'vertical', label: '垂直' },
              { value: 'horizontal', label: '水平' },
              { value: 'wrapped', label: '换行' },
              { value: 'page', label: '整页' },
            ],
            store.get('scrollMode', 'vertical'),
            (v) => {
              store.set('scrollMode', v);
              bus.emit('ui:apply-default-view');
            },
          ),
        ),
        el('div', { class: 'section-title', text: '显示' }),
        row(t('settings.pageShadow'), t('settings.pageShadowHelp'), switchControl(store.get('showPageShadow', true), (v) => store.set('showPageShadow', v))),
        row('使用系统鼠标指针', '默认使用手形/文本指针以贴近阅读器习惯。', switchControl(store.get('useSystemCursor', false), (v) => store.set('useSystemCursor', v))),
        row(
          '重排字号',
          '重排阅读（Ctrl+Shift+E）的正文字号。',
          numberControl(store.get('reflowFontSize', 16), 12, 30, 1, (v) => {
            store.set('reflowFontSize', v);
            bus.emit('ui:apply-reflow-type');
          }),
        ),
        row(
          '重排行距',
          '',
          numberControl(store.get('reflowLineHeight', 1.7), 1.2, 2.6, 0.05, (v) => {
            store.set('reflowLineHeight', v);
            bus.emit('ui:apply-reflow-type');
          }),
        ),
        row(
          '重排栏宽',
          '单栏阅读区的最大宽度（像素）。',
          numberControl(store.get('reflowWidth', 760), 420, 1300, 20, (v) => {
            store.set('reflowWidth', v);
            bus.emit('ui:apply-reflow-type');
          }),
        ),
        row(
          '重排时保留图片',
          '关闭后重排视图只保留文字。',
          switchControl(store.get('reflowKeepImages', true) !== false, (v) => {
            store.set('reflowKeepImages', v);
            bus.emit('ui:apply-reflow-type');
          }),
        ),
        row(
          '图像清晰度',
          '大图 PDF 在放大时的画布预算：越高，放大照片越清晰，单页显存占用也越大（改动对已打开的文档立即生效）。',
          selectControl(
            [
              { value: 'standard', label: '标准 · 16 MP' },
              { value: 'high', label: '高 · 28 MP' },
              { value: 'ultra', label: '超清 · 48 MP' },
              { value: 'max', label: '极致 · 80 MP' },
            ],
            store.get('renderQuality', 'ultra'),
            (v) => {
              store.set('renderQuality', v);
              bus.emit('ui:apply-render-quality');
            },
          ),
        ),
        row(
          t('settings.invertMode'),
          '夜间阅读会对纸张做智能反色，图片在“高对比”下会变灰。',
          selectControl(
            [
              { value: 'off', label: t('settings.invertOff') },
              { value: 'smart', label: t('settings.invertSmart') },
              { value: 'sepia', label: t('settings.invertSepia') },
              { value: 'contrast', label: t('settings.invertContrast') },
            ],
            store.get('invertMode', 'off'),
            (v) => {
              store.set('invertMode', v);
              bus.emit('ui:apply-invert');
            },
          ),
        ),
      );
    } else if (id === 'annotations') {
      box.append(
        el('div', { class: 'section-title', text: t('settings.annotations') }),
        row(t('settings.annotationStorage'), t('settings.annotationStorageHelp'), switchControl(store.get('annotationStorage', true), (v) => store.set('annotationStorage', v))),
        row(
          t('settings.exportFormat'),
          '',
          segControl(
            [
              { value: 'image/png', label: 'PNG' },
              { value: 'image/jpeg', label: 'JPEG' },
            ],
            store.get('exportFormat', 'image/png'),
            (v) => store.set('exportFormat', v),
          ),
        ),
        row(
          t('settings.exportScale'),
          '导出图片时的分辨率倍率（2 ≈ 144 DPI）。',
          numberControl(store.get('exportScale', 2), 1, 6, 0.5, (v) => store.set('exportScale', v)),
        ),
        el('div', { class: 'setting-help', style: { marginTop: '10px' }, text: t('editor.hintEdit') }),
      );
    } else if (id === 'data') {
      const info = store.info || {};
      const statsBox = el('div', { class: 'setting-help', text: '…' });
      window.lumen.library
        .stats()
        .then((s) => {
          statsBox.textContent = t('settings.statsValue', s.docs, s.pages, s.notes, s.bookmarks);
        })
        .catch(() => {
          statsBox.textContent = '';
        });
      box.append(
        el('div', { class: 'section-title', text: t('settings.data') }),
        row(t('settings.stats'), '', statsBox),
        row(
          '运行时占用',
          '渲染进程的 JS 堆与画布背储。图像密集的文档占用较高，可在「显示」里调低图像清晰度。',
          memoryBox(),
        ),
        row(
          t('settings.dataDir'),
          info.userData || '',
          el('button', {
            class: 'chip-btn',
            text: t('settings.openDataDir'),
            onclick: () => window.lumen.shell.openPath(info.userData || ''),
          }),
        ),
        el('div', { class: 'section-title', text: '清理' }),
        row(t('settings.clearReading'), '', el('button', { class: 'chip-btn danger', text: t('action.clearHistory'), onclick: () => bus.emit('ui:clear-history') })),
        row(t('settings.clearAnnotations'), '', el('button', { class: 'chip-btn danger', text: t('modal.ok'), onclick: () => bus.emit('ui:clear-all-annotations') })),
        row(t('settings.resetSettings'), '', el('button', { class: 'chip-btn danger', text: t('settings.resetSettings'), onclick: () => bus.emit('ui:reset-settings') })),
      );
    } else if (id === 'about') {
      const info = store.info || {};
      const tbl = el('table', { class: 'prop-table' });
      const add = (k, v) => tbl.append(el('tr', {}, el('th', { text: k }), el('td', { text: String(v) })));
      add('LeebertyPDF', `v${info.version || '1.0.0'}`);
      add('PDF.js', info.pdfjs || '6.3.289');
      add('Electron', info.electron || '');
      add('Chromium', info.chrome || '');
      add('Node.js', info.node || '');
      add('系统', `${info.platform || ''} · ${info.locale || ''}`);
      add('许可', 'MIT · PDF.js (Apache-2.0)');
      box.append(
        el('div', { class: 'section-title', text: t('action.about') }),
        tbl,
        el('div', { class: 'setting-help', style: { marginTop: '12px' }, text: '渲染内核来自 Mozilla PDF.js；界面、批注与阅读增强由 Lumen 提供。' }),
      );
    }
    return box;
  };

  for (const s of sections) {
    const b = el('button', { class: s.id === current ? 'active' : '', text: s.label });
    b.addEventListener('click', () => {
      current = s.id;
      for (const child of nav.children) child.classList.remove('active');
      b.classList.add('active');
      for (const [k, node] of Object.entries(paneNodes)) node.hidden = k !== current;
    });
    nav.append(b);
  }
  for (const s of sections) {
    const node = buildPane(s.id);
    node.hidden = s.id !== current;
    panes.append(node);
  }

  const layout = el('div', { class: 'settings-layout' }, nav, panes);
  openModal({
    title: t('settings.title'),
    wide: true,
    body: layout,
    buttons: [{ label: t('modal.close'), kind: 'primary' }],
  });
}

/* ------------------------------------------------------------ properties */
export async function openProperties(tab) {
  if (!tab || !tab.doc) {
    toast(t('toast.noDoc'), { kind: 'warn' });
    return;
  }
  const info = tab.metadata?.info || {};
  const meta = tab.metadata?.metadata || null;
  const st = await window.lumen.fs.stat(tab.path);
  const perms = await tab.doc.getPermissions().catch(() => null);
  const hasJs = await tab.doc.hasJSActions().catch(() => null);
  const tbl = el('table', { class: 'prop-table' });
  const add = (k, v) => {
    if (v === null || v === undefined || v === '') return;
    tbl.append(el('tr', {}, el('th', { text: k }), el('td', { text: String(v) })));
  };
  const yesno = (v) => (v === null || v === undefined ? t('props.unknown') : v ? t('props.yes') : t('props.no'));

  add(t('props.fileName'), tab.path.split(/[\\/]/).pop());
  add(t('props.path'), tab.path);
  add(t('props.size'), st?.ok ? `${fmtBytes(st.size)} (${st.size.toLocaleString()} 字节)` : '');
  add(t('props.pages'), tab.pageCount);
  add(t('props.titleField'), info.Title);
  add(t('props.author'), info.Author);
  add(t('props.subject'), info.Subject);
  add(t('props.keywords'), info.Keywords);
  add(t('props.creator'), info.Creator);
  add(t('props.producer'), info.Producer);
  if (info.CreationDate) add(t('props.creationDate'), pdfDate(info.CreationDate));
  if (info.ModDate) add(t('props.modDate'), pdfDate(info.ModDate));
  if (meta) {
    add('XMP: 标题', meta.get?.('dc:title'));
    add('XMP: 作者', meta.get?.('dc:creator'));
    add('XMP: 创建工具', meta.get?.('xmp:CreatorTool'));
  }
  add(t('props.version'), tab.doc.pdfInfo?.version ?? '');
  add('线性化', yesno(tab.doc.pdfInfo?.linearized));
  add(t('props.encrypted'), yesno(tab.doc.pdfInfo?.encrypted || tab.doc.isEncrypted));
  if (perms) {
    add(t('props.printing'), yesno(perms.includes(4) || perms.includes(12) || perms.includes(8) || perms.length === 0));
    add(t('props.copying'), yesno(perms.includes(16) || perms.length === 0));
    add(t('props.modifying'), yesno(perms.includes(8) || perms.length === 0));
    add(t('props.annotating'), yesno(perms.includes(1024) || perms.length === 0));
    add('填写表单', yesno(perms.includes(256) || perms.length === 0));
    add('内容提取', yesno(perms.includes(512) || perms.length === 0));
    add('文档组装', yesno(perms.includes(2048) || perms.length === 0));
    add('高质量打印', yesno(perms.includes(2048) || perms.length === 0));
  }
  add(t('props.javascript'), yesno(hasJs));
  add(t('props.xfa'), yesno(tab.doc.isPureXfa));
  add(t('props.fingerprint'), tab.doc.fingerprint);
  add('文件大小 (字节)', st?.ok ? st.size : '');
  add('打开次数', '');
  add('书签数', tab.bookmarks.length);
  add('本地批注数', tab.listAnnotations().length);
  add('上次阅读页码', tab.page);
  tbl.querySelectorAll('tr').forEach((tr) => {
    if (tr.lastElementChild && !tr.lastElementChild.textContent) tr.remove();
  });
  const node = el('div', {}, tbl);
  openModal({
    title: t('props.title'),
    wide: true,
    body: node,
    buttons: [
      {
        label: t('action.reveal'),
        kind: 'ghost',
        close: false,
        handler: () => window.lumen.shell.showItem(tab.path),
      },
      { label: t('modal.close'), kind: 'primary' },
    ],
  });
}

function pdfDate(raw) {
  try {
    const s = String(raw).replace(/^D:/, '');
    const m = /^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s);
    if (!m) return raw;
    const [, y, mo = '01', d = '01', h = '00', mi = '00', sec = '00'] = m;
    const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec));
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  } catch {
    return raw;
  }
}

/* ------------------------------------------------------------- shortcuts */
export function openShortcuts() {
  const groups = [
    {
      title: t('keys.groupNav'),
      rows: [
        [t('keys.nextPage'), 'PgDn · ↓ · Space · J'],
        [t('keys.prevPage'), 'PgUp · ↑ · Shift+Space · K'],
        [t('keys.firstLast'), 'Home · End'],
        ['跳转页码', 'Ctrl+G'],
        ['滚动一屏', 'Shift+↑ / Shift+↓'],
      ],
    },
    {
      title: t('keys.groupView'),
      rows: [
        [t('keys.zoom'), 'Ctrl+= · Ctrl+-'],
        [t('keys.actual'), 'Ctrl+0'],
        [t('keys.fitWidth'), 'Ctrl+1'],
        [t('keys.fitPage'), 'Ctrl+2'],
        [t('keys.rotate'), 'Ctrl+R · Ctrl+Shift+R'],
        [t('keys.fullscreen'), 'F11'],
        [t('keys.presentation'), 'F5'],
        [t('keys.sidebar'), 'F4'],
        [t('keys.invert'), 'Ctrl+Shift+I'],
      ],
    },
    {
      title: t('keys.groupTools'),
      rows: [
        [t('keys.find'), 'Ctrl+F'],
        [t('keys.nextHit'), 'Enter · Shift+Enter'],
        [t('keys.palette'), 'Ctrl+K'],
        [t('keys.settings'), 'Ctrl+,'],
        [t('keys.print'), 'Ctrl+P'],
        [t('keys.hand'), 'H'],
        [t('keys.highlight'), 'Ctrl+H'],
        [t('keys.ink'), 'Ctrl+D'],
        [t('keys.text'), 'Ctrl+Shift+T'],
        ['撤销 / 重做', 'Ctrl+Z · Ctrl+Y'],
        ['删除选中批注', 'Delete'],
        [t('keys.escape'), 'Esc'],
        ['复制选中文本', 'Ctrl+C'],
      ],
    },
    {
      title: t('keys.groupTabs'),
      rows: [
        [t('keys.tabs'), 'Ctrl+Tab · Ctrl+Shift+Tab'],
        [t('keys.closeTab'), 'Ctrl+W'],
        [t('keys.newTab'), 'Ctrl+T'],
        ['打开文件', 'Ctrl+O'],
        ['保存副本', 'Ctrl+S'],
        [t('keys.bookmark'), 'Ctrl+B'],
      ],
    },
  ];
  const box = el('div', {});
  for (const g of groups) {
    box.append(el('div', { class: 'section-title', text: g.title }));
    const grid = el('div', { class: 'keys-grid' });
    for (const [label, keys] of g.rows) {
      grid.append(el('div', { class: 'keys-row' }, el('span', { class: 'keys-label', text: label }), el('kbd', { text: keys })));
    }
    box.append(grid);
  }
  openModal({ title: t('keys.title'), wide: true, body: box, buttons: [{ label: t('modal.close'), kind: 'primary' }] });
}

/* ----------------------------------------------------------------- about */
export function openAbout() {
  const info = store.info || {};
  const body = el(
    'div',
    { style: { textAlign: 'center', padding: '10px 6px 4px' } },
    el(
          'div',
          { class: 'empty-logo', style: { fontSize: '30px' } },
          'Leeberty',
          el('span', {}, 'PDF'),
        ),
    el('div', { class: 'muted', style: { marginTop: '6px' }, text: `v${info.version || '1.0.0'} · PDF.js ${info.pdfjs || '6.3.289'}` }),
    el('div', {
      class: 'muted',
      style: { marginTop: '14px', fontSize: '12px', lineHeight: '1.8' },
      text: '一个为 Windows 打造的本地 PDF 阅读器：全文搜索、高亮批注、书签、目录、夜间阅读、标签页与阅读进度记忆。所有数据只保存在本机。',
    }),
    el(
      'div',
      { style: { marginTop: '16px', display: 'flex', gap: '8px', justifyContent: 'center' } },
      el('button', { class: 'chip-btn', text: 'PDF.js 主页', onclick: () => window.lumen.shell.openExternal('https://mozilla.github.io/pdf.js/') }),
      el('button', { class: 'chip-btn', text: t('settings.openDataDir'), onclick: () => window.lumen.shell.openPath(info.userData || '') }),
    ),
  );
  openModal({ title: t('action.about'), narrow: true, body, buttons: [{ label: t('modal.close'), kind: 'primary' }] });
}
