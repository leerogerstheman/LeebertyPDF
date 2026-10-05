/* =========================================================================
   LeebertyPDF — sidebar panes: thumbnails, outline, bookmarks, annotations
   ========================================================================= */
import { $, bus, clear, el, escapeHtml, t, clamp, throttle } from './lib/core.js';
import { icon } from './lib/icons.js';

export class Sidebar {
  constructor() {
    this.tab = null;
    this.pane = 'thumbnails';
    this.thumbNodes = new Map();
    this.thumbObserver = null;
    this.focusMode = false;
    this._currentOutlinePage = 0;
    this._bind();
  }

  _bind() {
    // The pane switcher lives in a popover anchored to the sidebar title, so the
    // rail itself stays a single line of text.
    const tabs = $('#sidebar-tabs');
    tabs?.addEventListener('click', (e) => {
      const btn = e.target.closest('.sidebar-tab');
      if (!btn) return;
      this.setPane(btn.dataset.pane);
    });
    // Thumbnail density is adjusted with Ctrl+wheel inside the rail instead of a
    // slider, which keeps the minimal surface free of controls.
    const list = $('#thumb-list');
    list?.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const next = clamp((window.__lumen?.thumbnailZoom ?? 120) + (e.deltaY < 0 ? 10 : -10), 70, 220);
        window.__lumen?.setThumbnailZoom?.(next);
        if (this.tab) {
          this.tab.invalidateThumbs();
          this.renderThumbnails(this.tab);
        }
      },
      { passive: false },
    );
    list?.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.thumb')) return;
      window.__lumen?.setThumbnailZoom?.(120);
      if (this.tab) {
        this.tab.invalidateThumbs();
        this.renderThumbnails(this.tab);
      }
    });
  }

  /** Switches the visible pane and keeps the text title in sync. */
  setPane(pane) {
    this.pane = pane;
    const labels = {
      thumbnails: t('sidebar.thumbnails'),
      outline: t('sidebar.outline'),
      bookmarks: t('sidebar.bookmarks'),
      annotations: t('sidebar.annotations'),
    };
    const title = document.getElementById('sidebar-title');
    if (title) title.textContent = labels[pane] || pane;
    for (const key of ['thumbnails', 'outline', 'bookmarks', 'annotations']) {
      const node = $(`#pane-${key}`);
      if (node) node.hidden = key !== pane;
    }
    if (this.tab) this.refresh();
  }

  setTab(tab) {
    if (this.tab === tab) {
      this.refresh();
      return;
    }
    // Switching documents must also drop the previous document's thumbnails:
    // each one holds a canvas, so leaving them in the cache keeps several
    // megabytes alive for a file the user has already left.
    this.tab?.invalidateThumbs?.();
    this.tab = tab;
    this.thumbNodes.clear();
    this.thumbObserver?.disconnect();
    this.thumbObserver = null;
    this.refresh();
  }

  refresh() {
    if (!this.tab) {
      clear($('#thumb-list'));
      clear($('#outline-list'));
      clear($('#bookmark-list'));
      clear($('#annot-list'));
      return;
    }
    if (this.pane === 'thumbnails') this.renderThumbnails(this.tab);
    else if (this.pane === 'outline') this.renderOutline(this.tab);
    else if (this.pane === 'bookmarks') this.renderBookmarks(this.tab);
    else if (this.pane === 'annotations') this.renderAnnotations();
  }

  /* ---------------------------------------------------------- thumbnails */
  renderThumbnails(tab) {
    const host = clear($('#thumb-list'));
    this.thumbNodes.clear();
    this.thumbObserver?.disconnect();
    if (!tab || !tab.doc) {
      host.append(el('div', { class: 'pane-empty', text: t('status.loading') }));
      return;
    }
    const grid = el('div', { class: 'thumb-grid', style: { '--thumb-min': `${clamp(window.__lumen?.thumbnailZoom ?? 120, 60, 220) * 0.9}px` } });
    host.append(grid);

    const total = tab.pageCount;
    const near = this.focusMode ? 40 : 0;

    const ensure = (pageNumber) => {
      if (this.thumbNodes.has(pageNumber)) return;
      const node = tab.getThumbElement(pageNumber);
      this.thumbNodes.set(pageNumber, node);
      grid.append(node);
    };

    const build = (from, to) => {
      for (let i = from; i <= to; i += 1) ensure(i);
    };

    if (this.focusMode) {
      const center = tab.page;
      build(clamp(center - near, 1, total), clamp(center + near, 1, total));
    } else {
      // placeholders keep the scroll height sane for very large documents
      for (let i = 1; i <= total; i += 1) {
        const ph = el('div', { class: 'thumb', dataset: { page: String(i), placeholder: '1' } }, el('div', { class: 'thumb-skeleton' }));
        grid.append(ph);
      }
      this.thumbObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const val = entry.target.dataset.page;
            const p = Number(val);
            if (!Number.isFinite(p)) continue;
            this.thumbObserver.unobserve(entry.target);
            const real = tab.getThumbElement(p);
            entry.target.replaceWith(real);
            this.thumbNodes.set(p, real);
          }
        },
        { root: host, rootMargin: '320px 0px' },
      );
      for (const ph of grid.children) this.thumbObserver.observe(ph);
    }
    this.highlightThumb(tab.page);
  }

  highlightThumb(page) {
    const host = $('#thumb-list');
    if (!host) return;
    for (const node of host.querySelectorAll('.thumb')) {
      node.classList.toggle('current', Number(node.dataset.page) === page);
    }
    const current = host.querySelector(`.thumb[data-page="${page}"]`);
    if (current && !current.dataset.placeholder && !this._suppressScroll) {
      const box = current.getBoundingClientRect();
      const hostBox = host.getBoundingClientRect();
      if (box.top < hostBox.top || box.bottom > hostBox.bottom) {
        current.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  /* ------------------------------------------------------------- outline */
  async renderOutline(tab) {
    const host = clear($('#outline-list'));
    this._outlineNodes = null;
    if (!tab || !tab.doc) return;
    this._outlineRequest = tab;
    let outline = tab.outline;
    if (outline === null || outline === undefined) {
      outline = await tab.doc.getOutline().catch(() => null);
      tab.outline = outline;
    }
    if (this._outlineRequest !== tab) return;
    if (!outline || !outline.length) {
      host.append(el('div', { class: 'pane-empty', text: t('sidebar.noOutline') }));
      return;
    }

    const resolveDest = async (dest) => {
      try {
        let explicit = dest;
        if (typeof dest === 'string') explicit = await tab.doc.getDestination(dest);
        if (!Array.isArray(explicit)) return null;
        const idx = await tab.doc.getPageIndex(explicit[0]);
        return idx + 1;
      } catch {
        return null;
      }
    };

    const buildInto = async (target, items, depth) => {
      for (const item of items) {
        const pageNumber = await resolveDest(item.dest);
        const hasChildren = !!(item.items && item.items.length);
        const row = el(
          'div',
          { class: 'outline-row', title: item.title || '' },
          el('span', {
            class: `outline-toggle${hasChildren ? '' : ' empty'}`,
            html: icon('chevronRight', 'ic-sm'),
          }),
          el('span', {
            class: `outline-title${item.bold ? ' bold' : ''}${item.italic ? ' italic' : ''}`,
            text: item.title || '(无标题)',
          }),
          pageNumber ? el('span', { class: 'outline-page', text: String(pageNumber) }) : null,
        );
        let childBox = null;
        if (hasChildren) {
          childBox = el('div', { class: 'outline-children', hidden: true });
          await buildInto(childBox, item.items, depth + 1);
        }
        row.addEventListener('click', (e) => {
          if (e.target.closest('.outline-toggle') && childBox) {
            const wasHidden = childBox.hidden;
            childBox.hidden = !wasHidden;
            row.querySelector('.outline-toggle').innerHTML = wasHidden
              ? icon('chevronDown', 'ic-sm')
              : icon('chevronRight', 'ic-sm');
            return;
          }
          if (pageNumber) {
            tab.setPage(pageNumber);
            bus.emit('ui:focus-viewer');
          }
        });
        target.append(row);
        if (childBox) target.append(childBox);
      }
    };

    const list = el('div', { class: 'outline-list' });
    await buildInto(list, outline, 0);
    if (this._outlineRequest !== tab) return;
    host.append(list);
    this._outlineNodes = [...list.querySelectorAll('.outline-row')];
    this.markOutlineCurrent(tab.page);
  }
  markOutlineCurrent(page) {
    this._currentOutlinePage = page;
    if (!this._outlineNodes) return;
    let match = null;
    for (const node of this._outlineNodes) {
      const badge = node.querySelector('.outline-page');
      const p = badge ? Number(badge.textContent) : NaN;
      if (Number.isFinite(p) && p <= page) match = node;
    }
    for (const node of this._outlineNodes) node.classList.toggle('current', node === match);
  }

  /* ----------------------------------------------------------- bookmarks */
  /**
   * Bookmarks are created with Ctrl+B or by clicking the hint row, so the pane
   * needs no toolbar of its own — it stays a plain list, like the outline.
   */
  renderBookmarks(tab) {
    const host = clear($('#bookmark-list'));
    if (!tab) {
      host.append(el('div', { class: 'pane-empty', text: t('toast.noDoc') }));
      return;
    }
    const list = el('div', { class: 'bookmark-list' });
    const addRow = el(
      'div',
      { class: 'outline-row', title: t('sidebar.addBookmark') },
      el('span', { class: 'outline-toggle', html: icon('plus', 'ic-sm') }),
      el('span', { class: 'outline-title', text: t('sidebar.addBookmark') }),
    );
    addRow.addEventListener('click', async () => {
      const added = await tab.addBookmark(tab.page);
      bus.emit('ui:toast', {
        title: added ? t('toast.bookmarkAdded') : t('toast.bookmarkExists'),
        kind: added ? 'ok' : 'warn',
        duration: 1600,
      });
      this.renderBookmarks(tab);
    });
    list.append(addRow);
    if (!tab.bookmarks.length) {
      list.append(el('div', { class: 'pane-empty', text: t('sidebar.noBookmarks') }));
      host.append(list);
      return;
    }
    for (const bm of tab.bookmarks) {
      const row = el(
        'div',
        { class: `bookmark-row${bm.page === tab.page ? ' current' : ''}` },
        el('span', { class: 'outline-toggle', html: icon('bookmarkFilled', 'ic-sm') }),
        el('span', { class: 'outline-title', text: bm.label || t('sidebar.bookmarkLabel', bm.page) }),
        el('span', { class: 'outline-page', text: String(bm.page) }),
        el('span', {
          class: 'row-remove',
          title: t('action.removeFromRecent'),
          html: icon('close', 'ic-sm'),
          onclick: async (e) => {
            e.stopPropagation();
            await tab.removeBookmark(bm.id);
            this.renderBookmarks(tab);
          },
        }),
      );
      row.addEventListener('click', () => {
        tab.setPage(bm.page);
        bus.emit('ui:focus-viewer');
      });
      list.append(row);
    }
    host.append(list);
  }

  /* --------------------------------------------------------- annotations */
  renderAnnotations(force = false) {
    const host = clear($('#annot-list'));
    const tab = this.tab;
    if (!tab) {
      host.append(el('div', { class: 'pane-empty', text: t('toast.noDoc') }));
      return;
    }
    const items = tab.listAnnotations();
    if (!items.length) {
      host.append(el('div', { class: 'pane-empty', text: t('sidebar.noAnnotations') }));
      return;
    }
    const list = el('div', { class: 'annot-list' });
    for (const item of items) {
      const row = el(
        'div',
        { class: `annot-row${item.page === tab.page ? ' current' : ''}`, title: item.text || item.kind },
        el('span', { class: 'annot-color-bar', style: { background: item.color } }),
        el('span', { class: 'annot-text', text: item.text || item.kind }),
        el('span', { class: 'annot-kind', text: t('sidebar.bookmarkLabel', item.page) }),
      );
      row.addEventListener('click', () => {
        tab.setPage(item.page);
        tab.flashPage(item.page);
      });
      list.append(row);
    }
    host.append(list);
  }
}
