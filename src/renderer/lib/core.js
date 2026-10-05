/* =========================================================================
   LeebertyPDF — core helpers: events, dom, util, i18n, persisted store
   ========================================================================= */

/* ------------------------------------------------------------------ events */
export class Emitter {
  constructor() {
    this._map = new Map();
  }
  on(type, fn) {
    if (!this._map.has(type)) this._map.set(type, new Set());
    this._map.get(type).add(fn);
    return () => this.off(type, fn);
  }
  once(type, fn) {
    const off = this.on(type, (...a) => {
      off();
      fn(...a);
    });
    return off;
  }
  off(type, fn) {
    this._map.get(type)?.delete(fn);
  }
  emit(type, payload) {
    const set = this._map.get(type);
    if (set) {
      for (const fn of [...set]) {
        try {
          fn(payload);
        } catch (err) {
          console.error(`[lumen] handler for "${type}" failed`, err);
        }
      }
    }
    const all = this._map.get('*');
    if (all) {
      for (const fn of [...all]) {
        try {
          fn({ type, payload });
        } catch (err) {
          console.error('[lumen] wildcard handler failed', err);
        }
      }
    }
  }
}

export const bus = new Emitter();

/* --------------------------------------------------------------------- dom */
export function $(sel, root = document) {
  return root.querySelector(sel);
}
export function $$(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
export function svg(markup, cls = 'ic') {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true">${markup}</svg>`;
  return wrap.firstElementChild;
}
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}
export function toggleClass(node, cls, on) {
  if (!node) return;
  node.classList.toggle(cls, !!on);
}
export function show(node, on = true) {
  if (node) node.hidden = !on;
}

/* -------------------------------------------------------------------- util */
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function debounce(fn, wait = 200) {
  let t = null;
  const wrapped = (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, wait);
  };
  wrapped.cancel = () => {
    if (t) clearTimeout(t);
    t = null;
  };
  wrapped.flush = (...args) => {
    wrapped.cancel();
    fn(...args);
  };
  return wrapped;
}

export function throttle(fn, wait = 100) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    const delta = now - last;
    if (delta >= wait) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...args);
      }, wait - delta);
    }
  };
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = (x) => String(x).padStart(2, '0');
  if (sameDay) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function baseName(p = '') {
  const m = String(p).split(/[\\/]/);
  return m[m.length - 1] || p;
}

export function dirName(p = '') {
  const parts = String(p).split(/[\\/]/);
  parts.pop();
  return parts.join('\\');
}

export function stripExt(name = '') {
  return name.replace(/\.[^.\\/]+$/, '');
}

export function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function escapeRe(s = '') {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Escape a filesystem path for use in a URL (file:// safe, keeps / and :). */
export function pathToFileURL(p) {
  let s = String(p).replace(/\\/g, '/');
  if (!s.startsWith('/')) s = `/${s}`;
  return `file://${encodeURI(s).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

export function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function isTextInput(node) {
  if (!node) return false;
  const tag = node.tagName;
  return (
    (tag === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'submit'].includes(node.type)) ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    node.isContentEditable
  );
}

/** Roving list selection helper used by palette / menus. */
export function moveIndex(list, current, delta) {
  if (!list.length) return 0;
  return (current + delta + list.length) % list.length;
}

export function uid(prefix = 'id') {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}

/* -------------------------------------------------------------------- i18n */
const ZH = {
  'app.name': 'LeebertyPDF',
  'app.untitled': '未命名',
  'action.open': '打开',
  'action.openFolder': '打开文件夹',
  'action.newTab': '新建标签页',
  'action.saveCopy': '另存为副本',
  'action.savePdf': '保存（含批注）',
  'action.exportImages': '导出页面为图片',
  'action.exportText': '导出文本',
  'action.exportAnnotations': '导出批注摘要',
  'action.exportHtml': '导出为 HTML',
  'action.print': '打印',
  'action.close': '关闭',
  'action.closeTab': '关闭标签页',
  'action.closeOthers': '关闭其他标签页',
  'action.closeAll': '关闭全部',
  'action.copy': '复制',
  'action.copyPath': '复制文件路径',
  'action.copyPageText': '复制本页文本',
  'action.reveal': '在资源管理器中显示',
  'action.settings': '设置',
  'action.properties': '文档属性',
  'action.shortcuts': '键盘快捷键',
  'action.about': '关于',
  'action.reload': '重新加载',
  'action.devTools': '开发者工具',
  'action.presentation': '演示模式',
  'action.fullscreen': '全屏',
  'action.clearHistory': '清空阅读记录',
  'action.openRecent': '最近阅读',
  'action.removeFromRecent': '从列表移除',
  'action.pin': '置顶',
  'action.unpin': '取消置顶',
  'action.fitWidth': '适合宽度',
  'action.fitPage': '适合页面',

  'nav.prevPage': '上一页',
  'nav.nextPage': '下一页',
  'nav.firstPage': '第一页',
  'nav.lastPage': '最后一页',
  'nav.back': '后退',
  'nav.forward': '前进',
  'nav.zoomIn': '放大',
  'nav.zoomOut': '缩小',
  'nav.rotateCw': '顺时针旋转',
  'nav.rotateCcw': '逆时针旋转',
  'nav.page': '页码',
  'nav.zoom': '缩放',
  'nav.gotoPage': '跳转到页码',
  'nav.pageOf': '第 {0} 页 / 共 {1} 页',
  'nav.zoomAuto': '自动',
  'nav.zoomFitPage': '适合页面',
  'nav.zoomFitWidth': '适合宽度',
  'nav.zoomFitHeight': '适合高度',
  'nav.zoomActual': '实际大小',

  'view.single': '单页滚动',
  'view.spreadOdd': '双页（奇数起）',
  'view.spreadEven': '双页（偶数起）',
  'view.pageMode': '单页模式',
  'view.horizontal': '水平滚动',
  'view.sidebar': '侧边栏',
  'view.invert': '夜间阅读',
  'view.find': '查找',
  'view.more': '更多工具',

  'tool.select': '文本选择',
  'tool.hand': '手形工具',
  'tool.textSelect': '文本选择模式',
  'tool.highlight': '高亮',
  'tool.ink': '自由绘制',
  'tool.eraser': '橡皮擦',
  'tool.freeText': '添加文本',
  'tool.stamp': '图章',
  'tool.signature': '签名',
  'tool.undo': '撤销',
  'tool.redo': '重做',
  'tool.editor': '批注工具',

  'sidebar.thumbnails': '缩略图',
  'sidebar.outline': '目录',
  'sidebar.bookmarks': '书签',
  'sidebar.annotations': '批注',
  'sidebar.thumbZoom': '缩放',
  'sidebar.focus': '聚焦',
  'sidebar.focusTitle': '只渲染当前页附近的缩略图',
  'sidebar.addBookmark': '+ 添加当前页书签',
  'sidebar.refresh': '刷新',
  'sidebar.clearAnnotations': '清除本文件批注',
  'sidebar.noOutline': '此文档没有目录',
  'sidebar.noBookmarks': '还没有书签。\n用 Ctrl+B 或点击上方按钮添加。',
  'sidebar.noAnnotations': '还没有批注。\n用工具栏的高亮 / 绘制工具添加。',
  'sidebar.bookmarkLabel': '第 {0} 页',

  'find.placeholder': '查找…',
  'find.next': '下一个',
  'find.prev': '上一个',
  'find.caseSensitive': '区分大小写',
  'find.wholeWord': '全字匹配',
  'find.diacritics': '区分变音符号',
  'find.highlightAll': '全部高亮',
  'find.results': '结果列表',
  'find.notFound': '未找到',
  'find.count': '{0} / {1}',
  'find.resultsCount': '{0} 处匹配 · {1} 页',

  'status.ready': '就绪',
  'status.loading': '正在打开…',
  'status.rendering': '正在渲染…',
  'status.saved': '已保存',
  'status.unsaved': '有未保存的批注',
  'status.pages': '{0} 页',
  'status.selected': '已选择 {0} 个字符',
  'status.copied': '已复制到剪贴板',

  'toast.opened': '已打开',
  'toast.saved': '已保存',
  'toast.failed': '操作失败',
  'toast.copied': '已复制',
  'toast.noDoc': '没有打开的文档',
  'toast.exported': '已导出',
  'toast.annotationsCleared': '已清除批注',
  'toast.annotationDeleted': '已删除批注',
  'toast.bookmarkAdded': '已添加书签',
  'toast.bookmarkExists': '该页已有书签',
  'toast.loadFailed': '无法打开文件',

  'settings.title': '设置',
  'settings.general': '常规',
  'settings.view': '阅读',
  'settings.annotations': '批注',
  'settings.data': '数据',
  'settings.about': '关于',
  'settings.language': '界面语言',
  'settings.languageHelp': '切换后需要重启窗口才能完全生效。',
  'settings.theme': '界面主题',
  'settings.themeAuto': '跟随系统',
  'settings.themeLight': '浅色',
  'settings.themeDark': '深色',
  'settings.themeSepia': '护眼米色',
  'settings.themeNight': '纯黑',
  'settings.pageShadow': '页面阴影',
  'settings.pageShadowHelp': '关闭后页面与背景融合，适合沉浸阅读。',
  'settings.animation': '界面动画',
  'settings.restoreSession': '启动时恢复上次的标签页',
  'settings.recentLimit': '最近文件数量上限',
  'settings.readingDefault': '默认缩放与布局',
  'settings.invertMode': '夜间纸张',
  'settings.invertOff': '关闭',
  'settings.invertSmart': '智能反色',
  'settings.invertSepia': '反色 + 米色',
  'settings.invertContrast': '高对比',
  'settings.annotationStorage': '批注自动保存',
  'settings.annotationStorageHelp': '高亮、绘制、文本等批注会自动保存到本地，重新打开时自动恢复。',
  'settings.exportFormat': '导出图片格式',
  'settings.exportScale': '导出图片缩放',
  'settings.clearReading': '清空阅读进度',
  'settings.clearAnnotations': '清空全部批注',
  'settings.resetSettings': '恢复默认设置',
  'settings.dataDir': '数据目录',
  'settings.openDataDir': '打开数据目录',
  'settings.stats': '本地库统计',
  'settings.statsValue': '{docs} 个文档 · {pages} 页 · {notes} 条批注 · {bookmarks} 个书签',

  'props.title': '文档属性',
  'props.fileName': '文件名',
  'props.path': '路径',
  'props.size': '文件大小',
  'props.pages': '页数',
  'props.titleField': '标题',
  'props.author': '作者',
  'props.subject': '主题',
  'props.keywords': '关键词',
  'props.creator': '创建程序',
  'props.producer': 'PDF 制作',
  'props.creationDate': '创建时间',
  'props.modDate': '修改时间',
  'props.version': 'PDF 版本',
  'props.linearized': '快速 Web 查看',
  'props.encrypted': '加密',
  'props.permissions': '权限',
  'props.printing': '允许打印',
  'props.copying': '允许复制',
  'props.modifying': '允许修改',
  'props.annotating': '允许批注',
  'props.form': '表单',
  'props.fingerprint': '指纹',
  'props.javascript': '包含 JavaScript',
  'props.xfa': 'XFA 表单',
  'props.yes': '是',
  'props.no': '否',
  'props.unknown': '未知',

  'keys.title': '键盘快捷键',
  'keys.groupNav': '导航',
  'keys.groupView': '视图',
  'keys.groupTools': '工具',
  'keys.groupTabs': '标签页',
  'keys.nextPage': '下一页 / 向下滚动',
  'keys.prevPage': '上一页 / 向上滚动',
  'keys.firstLast': '第一页 / 最后一页',
  'keys.zoom': '放大 / 缩小',
  'keys.actual': '实际大小',
  'keys.fitWidth': '适合宽度',
  'keys.fitPage': '适合页面',
  'keys.rotate': '旋转页面',
  'keys.fullscreen': '全屏',
  'keys.presentation': '演示模式',
  'keys.sidebar': '显示/隐藏侧边栏',
  'keys.find': '查找',
  'keys.nextHit': '下一个匹配',
  'keys.palette': '命令面板',
  'keys.settings': '设置',
  'keys.print': '打印',
  'keys.hand': '手形工具',
  'keys.highlight': '高亮',
  'keys.ink': '自由绘制',
  'keys.text': '添加文本',
  'keys.escape': '退出当前工具 / 关闭面板',
  'keys.tabs': '切换标签页',
  'keys.closeTab': '关闭当前标签页',
  'keys.newTab': '新建标签页',
  'keys.bookmark': '添加/查看书签',
  'keys.copy': '复制选中文本',
  'keys.selectAllPage': '选中本页全部文本',

  'menu.file': '文件',
  'menu.edit': '编辑',
  'menu.view': '视图',
  'menu.tools': '工具',
  'menu.help': '帮助',
  'menu.library': '阅读库',
  'menu.theme': '主题',
  'menu.pdfTools': 'PDF 工具',
  'menu.recent': '最近打开',
  'menu.export': '导出',

  'empty.title': '把 PDF 拖到这里',
  'empty.sub': '或者从下面开始：',
  'empty.open': '打开文件…',
  'empty.folder': '打开文件夹…',
  'empty.recent': '最近阅读',
  'empty.hint': '支持 PDF / XPS / EPUB 等格式 · 全文搜索 · 高亮批注 · 深色阅读 · 标签页',
  'empty.drop': '松开鼠标以打开 PDF',
  'empty.pickRecent': '最近阅读',

  'palette.placeholder': '输入命令或文件名…',
  'palette.empty': '没有匹配的命令',
  'palette.commands': '命令',
  'palette.files': '最近文件',
  'palette.actions': '操作',

  'modal.cancel': '取消',
  'modal.ok': '确定',
  'modal.close': '关闭',
  'modal.apply': '应用',
  'modal.yes': '是',
  'modal.no': '否',
  'modal.confirmClear': '确定要执行此操作吗？',

  'editor.done': '完成',
  'editor.delete': '删除选中',
  'editor.thickness': '粗细',
  'editor.fontSize': '字号',
  'editor.color': '颜色',
  'editor.hintEdit': '双击批注可编辑；按 Delete 删除选中；Esc 退出批注模式。',

  'cmd.goToPage': '跳转到页…',
  'cmd.toggleInvert': '切换夜间阅读',
  'cmd.toggleSidebar': '切换侧边栏',
  'cmd.toggleHand': '切换手形工具',
  'cmd.fitWidth': '适合宽度',
  'cmd.fitPage': '适合页面',
  'cmd.rotate': '旋转视图',
  'cmd.tabNext': '下一个标签页',
  'cmd.tabPrev': '上一个标签页',
  'cmd.openFolder': '打开文件夹',
  'cmd.closeTab': '关闭当前标签页',
  'cmd.presentation': '演示模式',
  'cmd.docProps': '文档属性',
  'cmd.organize': '整理页面（删除/旋转/重排/合并/拆分）',
};

const EN = {
  'app.name': 'LeebertyPDF',
  'app.untitled': 'Untitled',
  'action.open': 'Open',
  'action.openFolder': 'Open Folder',
  'action.newTab': 'New Tab',
  'action.saveCopy': 'Save a Copy',
  'action.savePdf': 'Save (with annotations)',
  'action.exportImages': 'Export pages as images',
  'action.exportText': 'Export text',
  'action.exportAnnotations': 'Export annotation summary',
  'action.exportHtml': 'Export as HTML',
  'action.print': 'Print',
  'action.close': 'Close',
  'action.closeTab': 'Close tab',
  'action.closeOthers': 'Close other tabs',
  'action.closeAll': 'Close all',
  'action.copy': 'Copy',
  'action.copyPath': 'Copy file path',
  'action.copyPageText': 'Copy page text',
  'action.reveal': 'Show in Explorer',
  'action.settings': 'Settings',
  'action.properties': 'Document properties',
  'action.shortcuts': 'Keyboard shortcuts',
  'action.about': 'About',
  'action.reload': 'Reload',
  'action.devTools': 'Developer tools',
  'action.presentation': 'Presentation mode',
  'action.fullscreen': 'Full screen',
  'action.clearHistory': 'Clear reading history',
  'action.openRecent': 'Recent',
  'action.removeFromRecent': 'Remove from list',
  'action.pin': 'Pin',
  'action.unpin': 'Unpin',
  'action.fitWidth': 'Fit width',
  'action.fitPage': 'Fit page',

  'nav.prevPage': 'Previous page',
  'nav.nextPage': 'Next page',
  'nav.firstPage': 'First page',
  'nav.lastPage': 'Last page',
  'nav.back': 'Back',
  'nav.forward': 'Forward',
  'nav.zoomIn': 'Zoom in',
  'nav.zoomOut': 'Zoom out',
  'nav.rotateCw': 'Rotate clockwise',
  'nav.rotateCcw': 'Rotate counter-clockwise',
  'nav.page': 'Page',
  'nav.zoom': 'Zoom',
  'nav.gotoPage': 'Go to page',
  'nav.pageOf': 'Page {0} of {1}',
  'nav.zoomAuto': 'Automatic',
  'nav.zoomFitPage': 'Fit page',
  'nav.zoomFitWidth': 'Fit width',
  'nav.zoomFitHeight': 'Fit height',
  'nav.zoomActual': 'Actual size',

  'view.single': 'Single page scroll',
  'view.spreadOdd': 'Two pages (odd)',
  'view.spreadEven': 'Two pages (even)',
  'view.pageMode': 'Page mode',
  'view.horizontal': 'Horizontal scroll',
  'view.sidebar': 'Sidebar',
  'view.invert': 'Night reading',
  'view.find': 'Find',
  'view.more': 'More tools',

  'tool.select': 'Text selection',
  'tool.hand': 'Hand tool',
  'tool.textSelect': 'Text selection mode',
  'tool.highlight': 'Highlight',
  'tool.ink': 'Free draw',
  'tool.eraser': 'Eraser',
  'tool.freeText': 'Add text',
  'tool.stamp': 'Stamp',
  'tool.signature': 'Signature',
  'tool.undo': 'Undo',
  'tool.redo': 'Redo',
  'tool.editor': 'Annotation tools',

  'sidebar.thumbnails': 'Thumbnails',
  'sidebar.outline': 'Outline',
  'sidebar.bookmarks': 'Bookmarks',
  'sidebar.annotations': 'Annotations',
  'sidebar.thumbZoom': 'Zoom',
  'sidebar.focus': 'Focus',
  'sidebar.focusTitle': 'Only render thumbnails near the current page',
  'sidebar.addBookmark': '+ Bookmark this page',
  'sidebar.refresh': 'Refresh',
  'sidebar.clearAnnotations': 'Clear document annotations',
  'sidebar.noOutline': 'This document has no outline',
  'sidebar.noBookmarks': 'No bookmarks yet.\nPress Ctrl+B or use the button above.',
  'sidebar.noAnnotations': 'No annotations yet.\nUse the highlight / draw tools.',
  'sidebar.bookmarkLabel': 'Page {0}',

  'find.placeholder': 'Find…',
  'find.next': 'Next',
  'find.prev': 'Previous',
  'find.caseSensitive': 'Match case',
  'find.wholeWord': 'Whole words',
  'find.diacritics': 'Match diacritics',
  'find.highlightAll': 'Highlight all',
  'find.results': 'Results',
  'find.notFound': 'Not found',
  'find.count': '{0} / {1}',
  'find.resultsCount': '{0} matches · {1} pages',

  'status.ready': 'Ready',
  'status.loading': 'Opening…',
  'status.rendering': 'Rendering…',
  'status.saved': 'Saved',
  'status.unsaved': 'Unsaved annotations',
  'status.pages': '{0} pages',
  'status.selected': '{0} characters selected',
  'status.copied': 'Copied to clipboard',

  'toast.opened': 'Opened',
  'toast.saved': 'Saved',
  'toast.failed': 'Failed',
  'toast.copied': 'Copied',
  'toast.noDoc': 'No document open',
  'toast.exported': 'Exported',
  'toast.annotationsCleared': 'Annotations cleared',
  'toast.annotationDeleted': 'Annotation deleted',
  'toast.bookmarkAdded': 'Bookmark added',
  'toast.bookmarkExists': 'Bookmark already exists',
  'toast.loadFailed': 'Could not open file',

  'settings.title': 'Settings',
  'settings.general': 'General',
  'settings.view': 'Reading',
  'settings.annotations': 'Annotations',
  'settings.data': 'Data',
  'settings.about': 'About',
  'settings.language': 'Language',
  'settings.languageHelp': 'A window reload is needed for every string to update.',
  'settings.theme': 'Theme',
  'settings.themeAuto': 'System',
  'settings.themeLight': 'Light',
  'settings.themeDark': 'Dark',
  'settings.themeSepia': 'Sepia',
  'settings.themeNight': 'Black',
  'settings.pageShadow': 'Page shadow',
  'settings.pageShadowHelp': 'Turn off for a seamless reading surface.',
  'settings.animation': 'Animations',
  'settings.restoreSession': 'Restore tabs on startup',
  'settings.recentLimit': 'Recent files limit',
  'settings.readingDefault': 'Default zoom & layout',
  'settings.invertMode': 'Night paper',
  'settings.invertOff': 'Off',
  'settings.invertSmart': 'Smart invert',
  'settings.invertSepia': 'Invert + sepia',
  'settings.invertContrast': 'High contrast',
  'settings.annotationStorage': 'Autosave annotations',
  'settings.annotationStorageHelp': 'Highlights, drawings and text boxes are stored locally and restored on open.',
  'settings.exportFormat': 'Image export format',
  'settings.exportScale': 'Image export scale',
  'settings.clearReading': 'Clear reading progress',
  'settings.clearAnnotations': 'Clear all annotations',
  'settings.resetSettings': 'Reset settings',
  'settings.dataDir': 'Data directory',
  'settings.openDataDir': 'Open data directory',
  'settings.stats': 'Local library',
  'settings.statsValue': '{docs} documents · {pages} pages · {notes} annotations · {bookmarks} bookmarks',

  'props.title': 'Document properties',
  'props.fileName': 'File name',
  'props.path': 'Path',
  'props.size': 'File size',
  'props.pages': 'Pages',
  'props.titleField': 'Title',
  'props.author': 'Author',
  'props.subject': 'Subject',
  'props.keywords': 'Keywords',
  'props.creator': 'Creator',
  'props.producer': 'Producer',
  'props.creationDate': 'Created',
  'props.modDate': 'Modified',
  'props.version': 'PDF version',
  'props.linearized': 'Fast web view',
  'props.encrypted': 'Encrypted',
  'props.permissions': 'Permissions',
  'props.printing': 'Printing',
  'props.copying': 'Copying',
  'props.modifying': 'Modifying',
  'props.annotating': 'Annotating',
  'props.form': 'Forms',
  'props.fingerprint': 'Fingerprint',
  'props.javascript': 'JavaScript',
  'props.xfa': 'XFA form',
  'props.yes': 'Yes',
  'props.no': 'No',
  'props.unknown': 'Unknown',

  'keys.title': 'Keyboard shortcuts',
  'keys.groupNav': 'Navigation',
  'keys.groupView': 'View',
  'keys.groupTools': 'Tools',
  'keys.groupTabs': 'Tabs',
  'keys.nextPage': 'Next page / scroll down',
  'keys.prevPage': 'Previous page / scroll up',
  'keys.firstLast': 'First / last page',
  'keys.zoom': 'Zoom in / out',
  'keys.actual': 'Actual size',
  'keys.fitWidth': 'Fit width',
  'keys.fitPage': 'Fit page',
  'keys.rotate': 'Rotate pages',
  'keys.fullscreen': 'Full screen',
  'keys.presentation': 'Presentation mode',
  'keys.sidebar': 'Toggle sidebar',
  'keys.find': 'Find',
  'keys.nextHit': 'Next match',
  'keys.palette': 'Command palette',
  'keys.settings': 'Settings',
  'keys.print': 'Print',
  'keys.hand': 'Hand tool',
  'keys.highlight': 'Highlight',
  'keys.ink': 'Free draw',
  'keys.text': 'Add text',
  'keys.escape': 'Exit tool / close panel',
  'keys.tabs': 'Switch tabs',
  'keys.closeTab': 'Close current tab',
  'keys.newTab': 'New tab',
  'keys.bookmark': 'Add / show bookmarks',
  'keys.copy': 'Copy selection',
  'keys.selectAllPage': 'Select all text on page',

  'menu.file': 'File',
  'menu.edit': 'Edit',
  'menu.view': 'View',
  'menu.tools': 'Tools',
  'menu.help': 'Help',
  'menu.library': 'Library',
  'menu.theme': 'Theme',
  'menu.pdfTools': 'PDF tools',
  'menu.recent': 'Recent',
  'menu.export': 'Export',

  'empty.title': 'Drop a PDF here',
  'empty.sub': 'or start with:',
  'empty.open': 'Open file…',
  'empty.folder': 'Open folder…',
  'empty.recent': 'Recent',
  'empty.hint': 'PDF / XPS / EPUB · full-text search · highlights · night reading · tabs',
  'empty.drop': 'Release to open the PDF',
  'empty.pickRecent': 'Recent',

  'palette.placeholder': 'Type a command or file name…',
  'palette.empty': 'No matching command',
  'palette.commands': 'Commands',
  'palette.files': 'Recent files',
  'palette.actions': 'Actions',

  'modal.cancel': 'Cancel',
  'modal.ok': 'OK',
  'modal.close': 'Close',
  'modal.apply': 'Apply',
  'modal.yes': 'Yes',
  'modal.no': 'No',
  'modal.confirmClear': 'Are you sure?',

  'editor.done': 'Done',
  'editor.delete': 'Delete selected',
  'editor.thickness': 'Width',
  'editor.fontSize': 'Size',
  'editor.color': 'Colour',
  'editor.hintEdit': 'Double-click to edit · Delete removes the selection · Esc leaves the tool.',

  'cmd.goToPage': 'Go to page…',
  'cmd.toggleInvert': 'Toggle night reading',
  'cmd.toggleSidebar': 'Toggle sidebar',
  'cmd.toggleHand': 'Toggle hand tool',
  'cmd.fitWidth': 'Fit width',
  'cmd.fitPage': 'Fit page',
  'cmd.rotate': 'Rotate view',
  'cmd.tabNext': 'Next tab',
  'cmd.tabPrev': 'Previous tab',
  'cmd.openFolder': 'Open folder',
  'cmd.closeTab': 'Close current tab',
  'cmd.presentation': 'Presentation mode',
  'cmd.docProps': 'Document properties',
  'cmd.organize': 'Organize pages (delete/rotate/reorder/merge/split)',
};

const DICT = { 'zh-CN': ZH, 'en-US': EN };

let lang = 'zh-CN';

export function setLanguage(code) {
  lang = DICT[code] ? code : 'zh-CN';
  document.documentElement.lang = lang;
}
export function getLanguage() {
  return lang;
}

export function t(key, ...args) {
  const table = DICT[lang] || ZH;
  let s = table[key];
  if (s === undefined) s = ZH[key];
  if (s === undefined) return key;
  return s.replace(/\{(\d+)\}/g, (_, i) => (args[Number(i)] === undefined ? '' : String(args[Number(i)])));
}

/* ------------------------------------------------------------------- store */
class AppStore extends Emitter {
  constructor() {
    super();
    this.settings = {};
    this.session = {};
    this.info = {};
    this._save = debounce(() => {
      window.lumen.settings.patch(this.settings).catch(() => {});
    }, 300);
  }

  async init() {
    const [settings, session, info] = await Promise.all([
      window.lumen.settings.all(),
      window.lumen.session.get(),
      window.lumen.info(),
    ]);
    this.settings = settings || {};
    this.session = session || {};
    this.info = info || {};
    setLanguage(this.settings.language || 'zh-CN');
    return this;
  }

  get(key, fallback) {
    const v = this.settings[key];
    return v === undefined ? fallback : v;
  }

  set(key, value) {
    this.settings[key] = value;
    this.emit('setting', { key, value });
    this._save();
  }

  patch(obj) {
    Object.assign(this.settings, obj);
    for (const [k, v] of Object.entries(obj)) this.emit('setting', { key: k, value: v });
    this._save();
  }

  async resetSettings() {
    this.settings = await window.lumen.settings.reset();
    setLanguage(this.settings.language || 'zh-CN');
    this.emit('setting', { key: '*', value: null });
  }

  sessionSet(obj) {
    Object.assign(this.session, obj);
    window.lumen.session.set(obj).catch(() => {});
  }
}

export const store = new AppStore();

/**
 * Relevance score for a fuzzy match, or -1 when the query does not match.
 *
 * Lower is better. The ladder is exact < prefix < word boundary < substring <
 * subsequence, which is what makes "fh" find "Fit Height" and "opfo" find
 * "Open Folder" without burying the obvious results.
 */
export function fuzzyScore(haystack, query) {
  const hay = String(haystack || '').toLowerCase();
  const q = String(query || '').toLowerCase();
  if (!q) return 0;
  if (!hay) return -1;
  if (hay === q) return 0;
  if (hay.startsWith(q)) return 1;
  const boundary = hay.search(new RegExp(`(^|[\\s\\-_/.])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  if (boundary >= 0) return 2 + boundary / 100;
  const at = hay.indexOf(q);
  if (at >= 0) return 4 + at / 100;
  // Subsequence matching is the loosest rung of the ladder, so it has to be
  // bounded: without the span check, "opfo" matches any title containing those
  // four letters in order somewhere ("文档属性" does) and the palette fills up
  // with noise. The span may not exceed ~1.5x the query length.
  let hi = 0;
  let first = -1;
  let last = -1;
  let streak = 0;
  let best = 0;
  for (const ch of q) {
    const found = hay.indexOf(ch, hi);
    if (found < 0) return -1;
    if (first < 0) first = found;
    streak = found === hi ? streak + 1 : 1;
    best = Math.max(best, streak);
    hi = found + 1;
    last = found;
  }
  const span = last - first + 1;
  if (span > q.length * 1.5 + 2) return -1;
  return 8 - Math.min(3, best / 2) + hi / hay.length;
}
