/* =========================================================================
   LeebertyPDF — page organizer.

   A modal workspace that manipulates the *page set* of a document: reorder by
   dragging, delete, rotate, duplicate, reverse, insert pages from another file,
   extract a range into a new file, split into several files, then save the
   result. Thumbnails come from PDF.js in this process; the structural edits run
   in the main process over the object-level PDF engine.
   ========================================================================= */
import { $, baseName, bus, clamp, clear, dirName, el, stripExt, t, getLanguage } from './lib/core.js';
import { icon } from './lib/icons.js';
import { confirmDialog, openModal, promptDialog, toast } from './lib/widgets.js';

const zh = () => getLanguage() === 'zh-CN';
const L = (cn, en) => (zh() ? cn : en);

export class PageOrganizer {
  /**
   * @param {import('./viewer.js').DocTab} tab
   */
  constructor(tab) {
    this.tab = tab;
    this.sessionId = null;
    this.state = null;
    this.selection = new Set();
    this.anchor = null;
    this.thumbCache = new Map(); // `${srcId}:${page}:${rotate}` -> canvas
    this.thumbQueue = [];
    this.activeThumbs = 0;
    this.renderToken = null;
    this.docs = new Map(); // srcId -> PDFDocumentProxy
    this.zoom = 118;
    this.dirty = false;
    this.history = [];
    this.future = [];
    this.grid = null;
    this.modal = null;
    this.busy = false;
  }

  /* --------------------------------------------------------------- helpers */
  key(page) {
    return `${page.srcId}:${page.srcPage}:${page.rotate}`;
  }

  selectedIndices() {
    return [...this.selection].sort((a, b) => a - b);
  }

  async pushOp(ops, { snapshot = true } = {}) {
    if (this.busy) return;
    this.busy = true;
    try {
      if (snapshot && this.state) {
        this.history.push(this.state.pages.map((p) => ({ ...p })));
        if (this.history.length > 60) this.history.shift();
        this.future.length = 0;
      }
      const res = await window.lumen.edit.apply({ sessionId: this.sessionId, ops });
      if (!res || !res.ok) {
        toast(L('页面操作失败', 'Page operation failed'), { kind: 'error', sub: (res && res.error) || '' });
        if (snapshot && this.history.length) this.history.pop();
        return false;
      }
      this.state = res;
      this.dirty = true;
      this.pruneSelection();
      await this.render();
      this.updateToolbar();
      return true;
    } finally {
      this.busy = false;
    }
  }

  pruneSelection() {
    const n = this.state ? this.state.pages.length : 0;
    for (const i of [...this.selection]) if (i >= n) this.selection.delete(i);
  }

  selectRange(from, to, additive) {
    const [a, b] = from <= to ? [from, to] : [to, from];
    if (!additive) this.selection.clear();
    for (let i = a; i <= b; i += 1) this.selection.add(i);
  }

  /* ------------------------------------------------------------- lifecycle */
  async open() {
    if (!this.tab || !this.tab.doc) {
      toast(t('toast.noDoc'), { kind: 'warn' });
      return;
    }
    const res = await window.lumen.edit.open({ path: this.tab.path });
    if (!res || !res.ok) {
      toast(L('无法进入页面编辑', 'Could not open the page editor'), {
        kind: 'error',
        sub: (res && res.error) || '',
      });
      return;
    }
    this.sessionId = res.sessionId;
    this.state = res;
    this.dirty = false;
    await this.loadSourceDocs();
    this.buildModal();
    await this.render();
  }

  /** Loads a PDF.js document for every source so thumbnails can be drawn. */
  async loadSourceDocs() {
    const { getDocument } = await import('./vendor/pdfjs/pdf.min.mjs');
    for (const src of this.state.sources) {
      if (this.docs.has(src.id)) continue;
      try {
        const reg = await window.lumen.doc.open(src.path);
        if (!reg || !reg.ok) continue;
        const doc = await getDocument({
          url: reg.url,
          cMapUrl: new URL('./vendor/pdfjs/cmaps/', import.meta.url).href,
          cMapPacked: true,
          standardFontDataUrl: new URL('./vendor/pdfjs/standard_fonts/', import.meta.url).href,
          wasmUrl: new URL('./vendor/pdfjs/wasm/', import.meta.url).href,
          verbosity: 0,
        }).promise;
        this.docs.set(src.id, { doc, token: reg.token });
      } catch (err) {
        console.warn('[lumen] editor: source load failed', src.path, err);
      }
    }
  }

  async close(skipConfirm = false) {
    if (!skipConfirm && this.dirty) {
      const ok = await confirmDialog(
        L('放弃页面修改？', 'Discard page changes?'),
        L('尚未保存的页面调整将会丢失。', 'Unsaved page changes will be lost.'),
        { okLabel: L('放弃', 'Discard'), danger: true },
      );
      if (!ok) return false;
    }
    if (this.sessionId) await window.lumen.edit.close({ sessionId: this.sessionId }).catch(() => {});
    for (const [, entry] of this.docs) {
      try {
        await entry.doc.destroy();
      } catch {
        /* ignore */
      }
      window.lumen.doc.release(entry.token).catch(() => {});
    }
    this.docs.clear();
    this.thumbCache.clear();
    this.modal?.close(true);
    return true;
  }

  /* ------------------------------------------------------------------- UI */
  buildModal() {
    const name = baseName(this.tab.path);
    const body = el('div', { class: 'organizer' });

    const toolbar = el('div', { class: 'organizer-toolbar', id: 'organizer-toolbar' });
    const gridWrap = el('div', { class: 'organizer-gridwrap' }, el('div', { class: 'organizer-grid', id: 'organizer-grid' }));
    this.grid = gridWrap.querySelector('#organizer-grid');
    body.append(toolbar, gridWrap);

    const handle = openModal({
      title: `${L('整理页面', 'Organize pages')} — ${name}`,
      wide: true,
      closable: true,
      body,
      buttons: [
        {
          label: L('取消', 'Cancel'),
          kind: 'ghost',
          handler: async () => {
            const ok = await this.close();
            if (ok === false) return false;
          },
        },
        {
          label: L('另存为新文件…', 'Save as new file…'),
          kind: 'ghost',
          close: false,
          handler: () => this.saveAs(false),
        },
        {
          label: L('覆盖原文件', 'Overwrite original'),
          kind: 'ghost',
          close: false,
          handler: () => this.saveAs(true),
        },
        {
          label: L('保存', 'Save'),
          kind: 'primary',
          close: false,
          handler: () => this.saveAs(null),
        },
      ],
      onClose: () => {
        if (this.sessionId) window.lumen.edit.close({ sessionId: this.sessionId }).catch(() => {});
        this.sessionId = null;
      },
    });
    this.modal = handle;
    this.buildToolbar();
  }

  buildToolbar() {
    const bar = $('#organizer-toolbar');
    if (!bar) return;
    clear(bar);
    const group = (children) => el('div', { class: 'organizer-group' }, ...children);
    const btn = (label, title, onClick, cls = 'chip-btn') =>
      el('button', { class: cls, text: label, title, onclick: onClick });

    bar.append(
      group([
        btn(L('全选', 'Select all'), L('选中全部页面 (Ctrl+A)', 'Select all pages'), () => this.selectAll()),
        btn(L('反选', 'Invert'), L('反选当前选择', 'Invert selection'), () => this.invertSelection()),
        btn(L('清除选择', 'Clear'), L('取消选择 (Esc)', 'Clear selection'), () => {
          this.selection.clear();
          this.render();
          this.updateToolbar();
        }),
      ]),
      el('div', { class: 'organizer-sep' }),
      group([
        btn(L('⟲ 左转', '⟲ Left'), L('选中的页面逆时针旋转 90°', 'Rotate selected 90° CCW'), () =>
          this.rotateSelection(-90)),
        btn(L('⟳ 右转', '⟳ Right'), L('选中的页面顺时针旋转 90°', 'Rotate selected 90° CW'), () =>
          this.rotateSelection(90)),
        btn(L('复制页', 'Duplicate'), L('复制选中的页面', 'Duplicate selected pages'), () => this.duplicateSelection()),
        btn(L('删除页', 'Delete'), L('删除选中的页面 (Delete)', 'Delete selected pages'), () => this.deleteSelection(), 'chip-btn danger'),
      ]),
      el('div', { class: 'organizer-sep' }),
      group([
        btn(L('撤销', 'Undo'), L('撤销上一步 (Ctrl+Z)', 'Undo (Ctrl+Z)'), () => this.undo()),
        btn(L('重做', 'Redo'), L('重做 (Ctrl+Y)', 'Redo (Ctrl+Y)'), () => this.redo()),
        btn(L('反转顺序', 'Reverse'), L('整本页面顺序反转', 'Reverse the whole document'), () => this.pushOp([{ type: 'reverse' }])),
      ]),
      el('div', { class: 'organizer-sep' }),
      group([
        btn(L('插入文件…', 'Insert file…'), L('把另一个 PDF 的页面插入到当前位置', 'Insert pages from another PDF'), () =>
          this.insertFile()),
        btn(L('提取所选…', 'Extract…'), L('把选中的页面导出为新 PDF', 'Export the selected pages as a new PDF'), () =>
          this.extractSelection()),
        btn(L('拆分…', 'Split…'), L('按每 N 页拆分成多个文件', 'Split into files of N pages'), () => this.splitDialog()),
      ]),
      el('div', { class: 'organizer-spacer' }),
      group([
        el('span', { class: 'organizer-count', id: 'organizer-count', text: '' }),
        el('label', { class: 'organizer-zoom' },
          el('span', { text: L('大小', 'Size') }),
          el('input', {
            type: 'range',
            class: 'range',
            min: '70',
            max: '220',
            step: '10',
            value: String(this.zoom),
            oninput: (e) => {
              this.zoom = Number(e.target.value);
              this.grid?.style.setProperty('--thumb-size', `${this.zoom}px`);
            },
          }),
        ),
      ]),
    );
    this.grid?.style.setProperty('--thumb-size', `${this.zoom}px`);
  }

  updateToolbar() {
    const node = $('#organizer-count');
    if (!node || !this.state) return;
    const sel = this.selection.size;
    node.textContent = sel
      ? L(`${sel} / ${this.state.pages.length} 页已选`, `${sel} of ${this.state.pages.length} selected`)
      : L(`共 ${this.state.pages.length} 页`, `${this.state.pages.length} pages`);
  }

  /* --------------------------------------------------------------- render */
  async render() {
    if (!this.grid || !this.state) return;
    // invalidate any in-flight thumbnail renders for the old cell set
    this.renderToken = {};
    for (const job of this.thumbQueue) job.task?.cancel?.();
    this.thumbQueue.length = 0;
    clear(this.grid);
    this.grid.style.setProperty('--thumb-size', `${this.zoom}px`);
    const pages = this.state.pages;
    pages.forEach((page, index) => {
      const cell = el(
        'div',
        {
          class: `organizer-cell${this.selection.has(index) ? ' selected' : ''}`,
          dataset: { index: String(index) },
          draggable: 'true',
          title: `${L('第', 'Page')} ${index + 1}${page.label && page.label !== String(index + 1) ? ` (${page.label})` : ''} · ${Math.round(page.width)}×${Math.round(page.height)}${page.rotate ? ` · ${page.rotate}°` : ''}`,
        },
        el('div', { class: 'organizer-thumb' }),
        el('div', { class: 'organizer-label' },
          el('span', { class: 'organizer-index', text: String(index + 1) }),
          page.rotate ? el('span', { class: 'organizer-badge', text: `${page.rotate}°` }) : null,
        ),
      );
      cell.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.ctrlKey || e.metaKey) {
          if (this.selection.has(index)) this.selection.delete(index);
          else this.selection.add(index);
          this.anchor = index;
        } else if (e.shiftKey && this.anchor !== null) {
          this.selectRange(this.anchor, index, e.ctrlKey || e.metaKey);
        } else if (!this.selection.has(index)) {
          this.selection.clear();
          this.selection.add(index);
          this.anchor = index;
        } else {
          this.anchor = index;
        }
        this.paintSelection();
        this.updateToolbar();
        e.preventDefault();
      });
      cell.addEventListener('dblclick', () => this.previewPage(index));
      cell.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!this.selection.has(index)) {
          this.selection.clear();
          this.selection.add(index);
          this.paintSelection();
          this.updateToolbar();
        }
        this.cellMenu(e.clientX, e.clientY);
      });
      this.grid.append(cell);
      this.paintThumb(cell, page, index);
    });
    this.updateToolbar();
  }

  paintSelection() {
    if (!this.grid) return;
    for (const cell of this.grid.children) {
      cell.classList.toggle('selected', this.selection.has(Number(cell.dataset.index)));
    }
  }

  /** Renders (or reuses) the thumbnail for one cell. */
  async paintThumb(cell, page, index) {
    const host = cell.querySelector('.organizer-thumb');
    if (!host) return;
    const key = this.key(page);
    const cached = this.thumbCache.get(key);
    if (cached) {
      host.append(cached.cloneNode(true));
      return;
    }
    host.append(el('div', { class: 'thumb-skeleton' }));
    const entry = this.docs.get(page.srcId);
    if (!entry) {
      host.append(el('div', { class: 'organizer-fail', text: L('缩略图不可用', 'no preview') }));
      return;
    }
    const job = { cell, page, index, host };
    this.thumbQueue.push(job);
    this.pumpThumbs();
  }

  /**
   * Renders queued thumbnails a couple at a time. PDF.js cancels overlapping
   * render tasks on the same canvas, so the queue keeps the failures out.
   */
  pumpThumbs() {
    if (this.renderToken === null) this.renderToken = {};
    const token = this.renderToken;
    while (this.activeThumbs < 2 && this.thumbQueue.length) {
      const job = this.thumbQueue.shift();
      if (!job.cell.isConnected) continue;
      this.activeThumbs += 1;
      this.renderThumb(job, token)
        .catch(() => {})
        .finally(() => {
          this.activeThumbs -= 1;
          if (this.renderToken === token) this.pumpThumbs();
        });
    }
  }

  async renderThumb(job, token) {
    const { cell, page, host } = job;
    const entry = this.docs.get(page.srcId);
    if (!entry) return;
    const pdfPage = await entry.doc.getPage(page.srcPage + 1);
    if (!cell.isConnected || token !== this.renderToken) return;
    const rotation = page.rotate || 0;
    const base = pdfPage.getViewport({ scale: 1, rotation });
    const targetW = Math.max(120, this.zoom * 1.35);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = pdfPage.getViewport({ scale: (targetW / base.width) * dpr, rotation });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(vp.width));
    canvas.height = Math.max(1, Math.floor(vp.height));
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const task = pdfPage.render({ canvasContext: ctx, canvas, viewport: vp });
    job.task = task;
    await task.promise;
    if (!cell.isConnected || token !== this.renderToken) return;
    // `canvas.cloneNode()` is a deep clone but copies no bitmap, so the cached
    // node has to be drawn onto a fresh canvas before it is stored.
    const snapshot = document.createElement('canvas');
    snapshot.width = canvas.width;
    snapshot.height = canvas.height;
    snapshot.style.width = '100%';
    snapshot.style.height = 'auto';
    snapshot.getContext('2d').drawImage(canvas, 0, 0);
    this.thumbCache.set(this.key(page), snapshot);
    // The grid only shows a screenful or two, so snapshots far outside that
    // window are dropped; they are re-rendered on demand from the cached source
    // document when the user scrolls back.
    if (this.thumbCache.size > 120) {
      const drop = [...this.thumbCache.keys()].slice(0, this.thumbCache.size - 120);
      for (const k of drop) this.thumbCache.delete(k);
    }
    host.querySelector('.thumb-skeleton')?.remove();
    const failure = host.querySelector('.organizer-fail');
    if (failure) failure.remove();
    host.append(canvas);
  }

  /** Resolves once every queued thumbnail has been rendered. */
  async waitForThumbs(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.thumbQueue.length && this.activeThumbs === 0) return true;
      await new Promise((r) => setTimeout(r, 60));
    }
    return false;
  }

  async previewPage(index) {
    const page = this.state.pages[index];
    if (!page) return;
    this.tab?.setPage(1);
    bus.emit('ui:toast', {
      title: L(`第 ${index + 1} 页`, `Page ${index + 1}`),
      sub: L('关闭整理窗口后在主窗口查看', 'Close the organizer to view it in the reader'),
      duration: 1800,
    });
  }

  cellMenu(x, y) {
    const count = this.selection.size;
    import('./lib/widgets.js').then(({ openContextMenu }) => {
      openContextMenu(x, y, [
        { label: L(`已选 ${count} 页`, `${count} selected`), disabled: true },
        { separator: true },
        { label: L('顺时针旋转', 'Rotate right'), onClick: () => this.rotateSelection(90) },
        { label: L('逆时针旋转', 'Rotate left'), onClick: () => this.rotateSelection(-90) },
        { label: L('复制所选页', 'Duplicate'), onClick: () => this.duplicateSelection() },
        { separator: true },
        { label: L('仅保留所选页', 'Keep only selected'), onClick: () => this.keepSelection() },
        { label: L('提取所选为新文件…', 'Extract selection…'), onClick: () => this.extractSelection() },
        { separator: true },
        { label: L('删除所选页', 'Delete selected'), onClick: () => this.deleteSelection() },
      ]);
    });
  }

  /* -------------------------------------------------------------- actions */
  selectAll() {
    this.selection = new Set(this.state.pages.map((_, i) => i));
    this.paintSelection();
    this.updateToolbar();
  }

  invertSelection() {
    const next = new Set();
    this.state.pages.forEach((_, i) => {
      if (!this.selection.has(i)) next.add(i);
    });
    this.selection = next;
    this.paintSelection();
    this.updateToolbar();
  }

  async rotateSelection(delta) {
    if (!this.selection.size) {
      toast(L('请先选择页面', 'Select pages first'), { kind: 'warn', duration: 1600 });
      return;
    }
    await this.pushOp([{ type: 'rotate', indices: this.selectedIndices(), delta }]);
    // rotation changes the thumbnail key, so drop the affected cache entries
    for (const i of this.selection) {
      const page = this.state.pages[i];
      if (!page) continue;
      for (const rot of [0, 90, 180, 270]) this.thumbCache.delete(`${page.srcId}:${page.srcPage}:${rot}`);
    }
    await this.render();
  }

  async duplicateSelection() {
    if (!this.selection.size) {
      toast(L('请先选择页面', 'Select pages first'), { kind: 'warn', duration: 1600 });
      return;
    }
    await this.pushOp([{ type: 'duplicate', indices: this.selectedIndices() }]);
  }

  async deleteSelection() {
    if (!this.selection.size) {
      toast(L('请先选择页面', 'Select pages first'), { kind: 'warn', duration: 1600 });
      return;
    }
    if (this.selection.size === this.state.pages.length) {
      toast(L('不能删除全部页面', 'Cannot delete every page'), { kind: 'warn' });
      return;
    }
    await this.pushOp([{ type: 'remove', indices: this.selectedIndices() }]);
  }

  async keepSelection() {
    if (!this.selection.size) return;
    await this.pushOp([{ type: 'keep', indices: this.selectedIndices() }]);
  }

  async undo() {
    if (!this.history.length) {
      toast(L('没有可撤销的操作', 'Nothing to undo'), { kind: 'warn', duration: 1400 });
      return;
    }
    const snapshot = this.history.pop();
    this.future.push(this.state.pages.map((p) => ({ ...p })));
    await this.restore(snapshot);
  }

  async redo() {
    if (!this.future.length) {
      toast(L('没有可重做的操作', 'Nothing to redo'), { kind: 'warn', duration: 1400 });
      return;
    }
    const snapshot = this.future.pop();
    this.history.push(this.state.pages.map((p) => ({ ...p })));
    await this.restore(snapshot);
  }

  /**
   * Rebuilds the whole working set from a page-list snapshot.
   *
   * Everything is re-inserted from the source files in snapshot order, then the
   * per-page rotations are re-applied, so a restored state is byte-for-byte
   * equivalent to the state it was captured from.
   */
  async restore(snapshot) {
    if (this.busy) return;
    this.busy = true;
    try {
      const primary = this.state.sources[0];
      const res = await window.lumen.edit.open({ path: primary.path, pages: [] });
      if (!res || !res.ok) throw new Error((res && res.error) || 'open failed');
      await window.lumen.edit.close({ sessionId: this.sessionId }).catch(() => {});
      this.sessionId = res.sessionId;
      this.state = res;

      // 1. drop the automatically loaded pages
      let step = await window.lumen.edit.apply({ sessionId: this.sessionId, ops: [{ type: 'keep', indices: [] }] });
      if (!step || !step.ok) throw new Error((step && step.error) || 'keep failed');

      // 2. insert every page in snapshot order, one file at a time
      const bySource = new Map();
      snapshot.forEach((page) => {
        if (!bySource.has(page.srcId)) bySource.set(page.srcId, []);
        bySource.get(page.srcId).push(page);
      });
      for (const [srcId, list] of bySource) {
        const meta = this.state.sources.find((s) => s.id === srcId) || primary;
        step = await window.lumen.edit.apply({
          sessionId: this.sessionId,
          ops: [{ type: 'insert', path: meta.path, pages: list.map((p) => p.srcPage) }],
        });
        if (!step || !step.ok) throw new Error((step && step.error) || 'insert failed');
      }

      // 3. re-apply rotations (the insert above produced rotation 0 pages)
      const rotations = [];
      snapshot.forEach((page, index) => {
        if (page.rotate) rotations.push({ type: 'setRotation', indices: [index], value: page.rotate });
      });
      if (rotations.length) {
        step = await window.lumen.edit.apply({ sessionId: this.sessionId, ops: rotations });
        if (step && step.ok) this.state = step;
      }

      await this.loadSourceDocs();
      this.selection.clear();
      this.anchor = null;
      await this.render();
      this.updateToolbar();
      this.dirty = true;
    } catch (err) {
      toast(L('恢复历史状态失败', 'Could not restore the previous state'), {
        kind: 'error',
        sub: String(err.message || err),
      });
    } finally {
      this.busy = false;
    }
  }

  /* -------------------------------------------------------------- insert */
  async insertFile() {
    const files = await window.lumen.dialog.open({ title: L('选择要插入的 PDF', 'Choose a PDF to insert') });
    if (!files || !files.length) return;
    const info = await window.lumen.edit.inspect({ path: files[0] });
    if (!info || !info.ok) {
      toast(L('无法读取该文件', 'Could not read that file'), { kind: 'error', sub: (info && info.error) || '' });
      return;
    }
    if (info.encrypted) {
      toast(L('加密 PDF 无法插入', 'Encrypted PDFs cannot be inserted'), { kind: 'warn' });
      return;
    }
    const sel = this.selectedIndices();
    const at = sel.length ? sel[sel.length - 1] + 1 : this.state.pages.length;
    const range = await promptDialog(
      L('插入页码范围', 'Pages to insert'),
      {
        value: `1-${info.pageCount}`,
        placeholder: `1-${info.pageCount}`,
        select: true,
      },
    );
    if (range === null) return;
    const pages = parseRange(range, info.pageCount);
    if (!pages.length) {
      toast(L('页码范围无效', 'Invalid page range'), { kind: 'warn' });
      return;
    }
    const before = this.state.pages.length;
    const ok = await this.pushOp([{ type: 'insert', path: files[0], pages, at }]);
    if (!ok) return;
    await this.loadSourceDocs();
    await this.render();
    const added = this.state.pages.length - before;
    toast(L(`已插入 ${added} 页`, `Inserted ${added} pages`), { kind: 'ok', sub: baseName(files[0]) });
    // select the freshly inserted pages
    this.selection.clear();
    for (let i = at; i < at + added; i += 1) this.selection.add(i);
    this.paintSelection();
    this.updateToolbar();
  }

  /* ------------------------------------------------------------- extract */
  async extractSelection() {
    const indices = this.selectedIndices();
    if (!indices.length) {
      toast(L('请先选择要提取的页面', 'Select pages to extract'), { kind: 'warn' });
      return;
    }
    const target = await window.lumen.dialog.save({
      title: L('提取为新文件', 'Extract to a new file'),
      defaultPath: `${dirName(this.tab.path)}\\${stripExt(baseName(this.tab.path))} 提取.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (!target) return;
    // build a throwaway session that contains just the selected pages
    const primary = this.state.sources[0];
    const res = await window.lumen.edit.open({ path: primary.path, pages: [] });
    if (!res || !res.ok) {
      toast(L('提取失败', 'Extract failed'), { kind: 'error', sub: (res && res.error) || '' });
      return;
    }
    try {
      await window.lumen.edit.apply({ sessionId: res.sessionId, ops: [{ type: 'keep', indices: [] }] });
      const groups = new Map();
      indices.forEach((i) => {
        const page = this.state.pages[i];
        if (!page) return;
        if (!groups.has(page.srcId)) groups.set(page.srcId, []);
        groups.get(page.srcId).push({ index: i, srcPage: page.srcPage, rotate: page.rotate });
      });
      for (const [srcId, list] of groups) {
        const meta = this.state.sources.find((s) => s.id === srcId) || primary;
        await window.lumen.edit.apply({
          sessionId: res.sessionId,
          ops: [{ type: 'insert', path: meta.path, pages: list.map((x) => x.srcPage) }],
        });
      }
      const cur = await window.lumen.edit.apply({ sessionId: res.sessionId, ops: [] });
      const order = indices.map((i) => {
        const page = this.state.pages[i];
        return cur.pages.findIndex((p) => p.srcId === page.srcId && p.srcPage === page.srcPage);
      });
      if (order.every((v) => v >= 0)) {
        await window.lumen.edit.apply({ sessionId: res.sessionId, ops: [{ type: 'reorder', order }] });
      }
      const rotations = [];
      indices.forEach((i, pos) => {
        const page = this.state.pages[i];
        if (page.rotate) rotations.push({ type: 'setRotation', indices: [pos], value: page.rotate });
      });
      if (rotations.length) await window.lumen.edit.apply({ sessionId: res.sessionId, ops: rotations });
      const saved = await window.lumen.edit.save({ sessionId: res.sessionId, target });
      if (saved && saved.ok) {
        toast(L('已提取', 'Extracted'), {
          kind: 'ok',
          sub: `${saved.pages} ${L('页', 'pages')} → ${baseName(saved.path)}`,
          action: t('action.reveal'),
          onAction: () => window.lumen.shell.showItem(saved.path),
        });
      } else {
        toast(L('提取失败', 'Extract failed'), { kind: 'error', sub: (saved && saved.error) || '' });
      }
    } finally {
      await window.lumen.edit.close({ sessionId: res.sessionId }).catch(() => {});
    }
  }

  /* --------------------------------------------------------------- split */
  async splitDialog() {
    const total = this.state.pages.length;
    const value = await promptDialog(L('拆分成多个文件', 'Split into several files'), {
      value: '1',
      placeholder: L('每个文件包含多少页', 'Pages per file'),
      select: true,
    });
    if (value === null) return;
    const size = clamp(parseInt(value, 10) || 1, 1, total);
    const dir = await window.lumen.dialog.save({
      title: L('选择输出目录（文件名自动生成）', 'Choose an output folder'),
      defaultPath: `${dirName(this.tab.path)}\\${stripExt(baseName(this.tab.path))} 拆分`,
    });
    if (!dir) return;
    const res = await window.lumen.edit.split({
      sessionId: this.sessionId,
      dir,
      size,
      prefix: stripExt(baseName(this.tab.path)),
    });
    if (res && res.ok) {
      toast(L('拆分完成', 'Split finished'), {
        kind: 'ok',
        sub: `${res.files.length} ${L('个文件', 'files')} → ${dir}`,
        action: t('action.reveal'),
        onAction: () => window.lumen.shell.showItem(dir),
      });
    } else {
      toast(L('拆分失败', 'Split failed'), { kind: 'error', sub: (res && res.error) || '' });
    }
  }

  /* ---------------------------------------------------------------- save */
  /** mode: true = overwrite original, false = save-as, null = ask */
  async saveAs(mode) {
    if (!this.state || !this.state.pages.length) {
      toast(L('页面为空', 'No pages left'), { kind: 'warn' });
      return;
    }
    let target = this.tab.path;
    let overwrite = false;
    if (mode === true) {
      overwrite = true;
    } else {
      if (mode === null) {
        const choice = await confirmDialog(
          L('保存整理结果', 'Save the organised document'),
          L(
            `将把整理后的 ${this.state.pages.length} 页写入新文件（不修改原文件）。`,
            `${this.state.pages.length} pages will be written to a new file; the original is untouched.`,
          ),
          { okLabel: L('另存为新文件', 'Save as new file') },
        );
        if (!choice) return;
      }
      const suggested = `${stripExt(baseName(this.tab.path))} (整理).pdf`;
      target = await window.lumen.dialog.save({
        title: L('另存为新文件', 'Save as a new file'),
        defaultPath: `${dirName(this.tab.path)}\\${suggested}`,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (!target) return;
    }
    if (overwrite) {
      const ok = await confirmDialog(
        L('覆盖原文件', 'Overwrite the original'),
        L(
          `将用整理后的页面覆盖：\n${this.tab.path}\n\n原文件会被替换，此操作不可撤销。`,
          `This replaces:\n${this.tab.path}\n\nThis cannot be undone.`,
        ),
        { okLabel: L('覆盖', 'Overwrite'), danger: true },
      );
      if (!ok) return;
    }
    const res = await window.lumen.edit.save({
      sessionId: this.sessionId,
      target,
      overwrite,
      keepOutline: true,
      title: this.tab.docTitle(),
    });
    if (!res || !res.ok) {
      toast(L('保存失败', 'Save failed'), { kind: 'error', sub: (res && res.error) || '' });
      return;
    }
    this.dirty = false;
    toast(L('已保存', 'Saved'), {
      kind: 'ok',
      sub: `${res.pages} ${L('页', 'pages')} · ${(res.bytes / 1024).toFixed(0)} KB → ${baseName(res.path)}`,
      action: t('action.reveal'),
      onAction: () => window.lumen.shell.showItem(res.path),
    });
    const closed = await this.close(true);
    if (closed && res.path) bus.emit('ui:open-file', { path: res.path, replace: overwrite ? this.tab.path : null });
  }

  /* ------------------------------------------------------------- keyboard */
  handleKey(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return false;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      this.deleteSelection();
      return true;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      this.selectAll();
      return true;
    }
    if (mod && e.key.toLowerCase() === 'z') {
      this.undo();
      return true;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      this.redo();
      return true;
    }
    if (e.key === 'Escape') {
      this.selection.clear();
      this.paintSelection();
      this.updateToolbar();
      return true;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const step = e.key === 'ArrowRight' ? 1 : -1;
      const cur = this.anchor === null ? -1 : this.anchor;
      const next = clamp(cur + step, 0, this.state.pages.length - 1);
      this.anchor = next;
      if (e.shiftKey) this.selection.add(next);
      else {
        this.selection.clear();
        this.selection.add(next);
      }
      this.paintSelection();
      this.updateToolbar();
      this.grid?.children[next]?.scrollIntoView({ block: 'nearest' });
      return true;
    }
    return false;
  }
}

/* ------------------------------------------------------------- drag & drop */
/**
 * Attaches HTML5 drag reordering to a grid element.
 * @param {HTMLElement} grid
 * @param {(order:number[])=>void} onDrop
 */
export function attachGridDrag(grid, onDrop) {
  let dragging = null;
  grid.addEventListener('dragstart', (e) => {
    const cell = e.target.closest('.organizer-cell');
    if (!cell) return;
    dragging = Number(cell.dataset.index);
    cell.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', String(dragging));
    } catch {
      /* ignore */
    }
  });
  grid.addEventListener('dragover', (e) => {
    if (dragging === null) return;
    e.preventDefault();
    const cell = e.target.closest('.organizer-cell');
    if (!cell) return;
    const target = Number(cell.dataset.index);
    for (const child of grid.children) {
      child.classList.toggle('drop-before', child === cell && target > dragging);
      child.classList.toggle('drop-after', child === cell && target <= dragging);
    }
  });
  grid.addEventListener('dragleave', () => {
    for (const child of grid.children) child.classList.remove('drop-before', 'drop-after');
  });
  grid.addEventListener('drop', (e) => {
    if (dragging === null) return;
    e.preventDefault();
    const cell = e.target.closest('.organizer-cell');
    for (const child of grid.children) child.classList.remove('dragging', 'drop-before', 'drop-after');
    if (!cell) {
      dragging = null;
      return;
    }
    const target = Number(cell.dataset.index);
    const rect = cell.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    const order = [...grid.children].map((c) => Number(c.dataset.index));
    const from = order.indexOf(dragging);
    order.splice(from, 1);
    let to = order.indexOf(target);
    if (to < 0) to = order.length;
    if (after) to += 1;
    order.splice(to, 0, dragging);
    dragging = null;
    if (order.some((v, i) => v !== i)) onDrop(order);
  });
  grid.addEventListener('dragend', () => {
    dragging = null;
    for (const child of grid.children) child.classList.remove('dragging', 'drop-before', 'drop-after');
  });
}

/**
 * Convenience entry point used by the toolbar / menu / palette.
 * @param {import('./viewer.js').DocTab} tab
 */
export async function openPageOrganizer(tab) {
  const organizer = new PageOrganizer(tab);
  await organizer.open();
  if (!organizer.sessionId) return null;
  // wire drag reordering and keyboard handling now that the grid exists
  attachGridDrag(organizer.grid, (order) => {
    organizer.pushOp([{ type: 'reorder', order }]);
  });
  const onKey = (e) => {
    if (!organizer.sessionId) {
      window.removeEventListener('keydown', onKey, true);
      return;
    }
    if (organizer.handleKey(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  window.addEventListener('keydown', onKey, true);
  const originalClose = organizer.close.bind(organizer);
  organizer.close = async (skip) => {
    window.removeEventListener('keydown', onKey, true);
    return originalClose(skip);
  };
  return organizer;
}

/** "1-3,5,8-10" → [0,1,2,4,7,8,9] (0-based, clamped) */
export function parseRange(text, pageCount) {
  const out = new Set();
  for (const part of String(text || '').split(/[,，\s]+/)) {
    if (!part) continue;
    const m = /^(\d+)\s*[-~–]\s*(\d+)$/.exec(part);
    if (m) {
      const a = clamp(parseInt(m[1], 10), 1, pageCount);
      const b = clamp(parseInt(m[2], 10), 1, pageCount);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) out.add(i - 1);
      continue;
    }
    const single = parseInt(part, 10);
    if (Number.isFinite(single) && single >= 1 && single <= pageCount) out.add(single - 1);
  }
  return [...out].sort((a, b) => a - b);
}
