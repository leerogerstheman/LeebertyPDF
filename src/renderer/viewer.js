/* =========================================================================
   LeebertyPDF — document tab: pdf.js viewer wiring, search, thumbnails,
   annotation editing, persistence and export helpers.
   ========================================================================= */
import {
  getDocument,
  AnnotationEditorType,
  AnnotationEditorParamsType,
  AnnotationMode,
} from './vendor/pdfjs/pdf.min.mjs';
import {
  EventBus,
  PDFFindController,
  PDFHistory,
  PDFLinkService,
  PDFViewer,
  ScrollMode,
  SpreadMode,
} from './vendor/pdfjs/pdf_viewer.mjs';
import {
  baseName,
  bus,
  clamp,
  el,
  getLanguage,
  store,
  t,
  uid,
} from './lib/core.js';

/* --------------------------------------------------------------- l10n stub */
/**
 * pdf.js expects a Fluent-style localization component. Lumen ships its own
 * translated chrome, so this stub simply echoes the requested identifier —
 * every user-visible string inside the viewer is either browser generated or
 * supplied by Lumen itself.
 */
class FlatL10n {
  constructor(lang = 'zh-CN') {
    this.lang = lang;
    this.dir = 'ltr';
  }
  getLanguage() {
    return this.lang;
  }
  getDirection() {
    return this.dir;
  }
  async get(ids, args, fallback) {
    if (Array.isArray(ids)) return ids.map((id) => (typeof id === 'string' ? id : id?.id) ?? '');
    if (typeof ids === 'string' && fallback !== undefined) return fallback;
    return typeof ids === 'string' ? ids : '';
  }
  async translate() {}
  async translateOnce() {}
  async destroy() {}
  pause() {}
  resume() {}
}

/* ------------------------------------------------------------ scroll modes */
const SCROLL = {
  vertical: ScrollMode.VERTICAL,
  horizontal: ScrollMode.HORIZONTAL,
  wrapped: ScrollMode.WRAPPED,
  page: ScrollMode.PAGE,
};
const SPREAD = {
  single: SpreadMode.NONE,
  'spread-odd': SpreadMode.ODD,
  'spread-even': SpreadMode.EVEN,
};

const MODE_TO_UI = {
  [ScrollMode.VERTICAL]: 'vertical',
  [ScrollMode.HORIZONTAL]: 'horizontal',
  [ScrollMode.WRAPPED]: 'wrapped',
  [ScrollMode.PAGE]: 'page',
};

export const ZOOM_PRESETS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** pdf.js highlight palette format: "DisplayName=#RRGGBB". */
export const HIGHLIGHT_PAIRS = 'Yellow=#FFD24A,Green=#7EE787,Blue=#7CC7FF,Pink=#FF9ECB,Orange=#FFAB6B,Purple=#C1A4FF';

/* ------------------------------------------------------------------- tab */
/**
 * Canvas budget for the renderer.
 *
 * PDF.js caps `canvas.width * canvas.height` and quietly lowers the DPR when a
 * page would exceed it, which makes zoomed-in photos look soft. The budget is
 * therefore a user choice: bigger means sharper images at high zoom, at the
 * cost of more backing-store memory per painted page.
 */
export const QUALITY_PRESETS = {
  standard: { area: 0, dim: -1, hwa: false },
  high: { area: 150, dim: -1, hwa: false },
  ultra: { area: 400, dim: -1, hwa: true },
  max: { area: 900, dim: -1, hwa: true },
};

/**
 * PDF.js never paints more than `screen area x DPR^2` pixels unless
 * `capCanvasAreaFactor` says otherwise, so a page can never carry more detail
 * than the screen itself — which is exactly what makes zoomed-in photos soft.
 * Raising the factor lets a page keep real pixels beyond the screen budget;
 * when the budget is exceeded PDF.js renders an extra detail canvas for the
 * visible region, so sharpness is spent where the user is actually looking.
 */
export function renderQualityOptions() {
  const preset = QUALITY_PRESETS[store.get('renderQuality', 'ultra')] || QUALITY_PRESETS.ultra;
  return {
    maxCanvasPixels: 200 * 1024 * 1024,
    capCanvasAreaFactor: preset.area,
    maxCanvasDim: preset.dim,
    enableHWA: preset.hwa,
  };
}

export class DocTab {
  /**
   * @param {object} opts
   * @param {string} opts.path        absolute path on disk
   * @param {HTMLElement} opts.host   element that will contain the viewer
   */
  constructor({ path, host }) {
    this.id = uid('tab');
    this.path = path;
    this.host = host;
    this.title = baseName(path);
    this.token = null;
    this.url = null;
    this.doc = null;
    this.loadingTask = null;
    this.pageCount = 0;
    this.page = 1;
    this.scale = 1;
    this.scaleValue = 'auto';
    this.rotation = 0;
    this.scrollModeKey = 'vertical';
    this.pageModeKey = 'single';
    this.dirty = false;
    this.destroyed = false;
    this.loaded = false;
    this.error = null;
    this.bookmarks = [];
    this.outline = null;
    this.metadata = null;
    this._annotationsSaveTimer = null;
    this._thumbTasks = new Map();
    this._thumbCache = new Map();
    this._textPromises = new Map();
    this._pendingSearch = null;
    this._findQuery = '';
    this._findTotal = 0;
    this._findPages = 0;
    this._restoreState = null;

    // viewer container -----------------------------------------------------
    // PDF.js reads the scroll position of `container` to decide which pages are
    // visible, while `viewer` is the element the pages are laid out in. They
    // must be *different* elements: if the page host is also the scroller, the
    // container never scrolls, the visible range stays pinned to the first
    // screenful, and every page past it renders blank forever.
    this.containerEl = el('div', { class: 'pdf-container', id: `pc-${this.id}` });
    this.viewerEl = el('div', { class: 'pdfViewer' });
    this.containerEl.append(this.viewerEl);
    host.append(this.containerEl);

    this.eventBus = new EventBus();
    this.l10n = new FlatL10n(store.get('language', 'zh-CN'));

    this.linkService = new PDFLinkService({
      eventBus: this.eventBus,
      externalLinkTarget: 2,
      externalLinkRel: 'noopener noreferrer',
      ignoreDestinationZoom: false,
    });

    this.findController = new PDFFindController({ eventBus: this.eventBus, linkService: this.linkService });
    this.findController.onUpdateResultsCount = () => this._onFindResultsCount();
    this.findController.onUpdateState = (state) => this._onFindState(state);

    this.viewer = new PDFViewer({
      container: this.containerEl,
      viewer: this.viewerEl,
      eventBus: this.eventBus,
      linkService: this.linkService,
      findController: this.findController,
      l10n: this.l10n,
      removePageBorders: false,
      textLayerMode: 1,
      annotationMode: AnnotationMode.ENABLE_FORMS,
      annotationEditorMode: AnnotationEditorType.NONE,
      // pdf.js expects "Name=#RRGGBB" pairs; a bare list leaves its internal
      // colour picker without a current colour.
      annotationEditorHighlightColors: HIGHLIGHT_PAIRS,
      enableHighlightFloatingButton: false,
      imageResourcesPath: new URL('./vendor/pdfjs/images/', import.meta.url).href,
      enablePrintAutoRotate: true,
      enableDetailCanvas: true,
      supportsPinchToZoom: true,
      enableAutoLinking: true,
      enableHWA: true,
      ...renderQualityOptions(),
    });

    this.linkService.setViewer(this.viewer);
    this.history = new PDFHistory({ linkService: this.linkService, eventBus: this.eventBus });

    // Report how much of the ideal pixel resolution the last paint achieved;
    // PDF.js spends extra pixels on the visible region via its detail canvas.
    this._lastQuality = 1;

    // The annotation editor UI manager is created while the viewer loads a
    // document and announces itself on the event bus; keep the handle so undo
    // and delete can drive it directly.
    this.editorUiManager = null;
    this.hasSelectedAnnotation = false;
    bus.emit('tab:created', { tab: this });

    this._bindEvents();
  }

  /* ------------------------------------------------------------- loading */
  async load(restoreState = null) {
    this._restoreState = restoreState;
    const reg = await window.lumen.doc.open(this.path);
    if (!reg || !reg.ok) {
      this.error = (reg && reg.error) || 'unable to read file';
      this._renderError();
      throw new Error(this.error);
    }
    this.token = reg.token;
    this.url = reg.url;
    this.size = reg.size;
    this.mtime = reg.mtime;

    this.loadingTask = getDocument({
      url: this.url,
      cMapUrl: new URL('./vendor/pdfjs/cmaps/', import.meta.url).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('./vendor/pdfjs/standard_fonts/', import.meta.url).href,
      wasmUrl: new URL('./vendor/pdfjs/wasm/', import.meta.url).href,
      iccUrl: new URL('./vendor/pdfjs/icc/', import.meta.url).href,
      imageResourcesPath: new URL('./vendor/pdfjs/images/', import.meta.url).href,
      enableXfa: true,
      useSystemFonts: true,
      isEvalSupported: false,
      useWasm: true,
      verbosity: 0,
    });

    this.loadingTask.onProgress = ({ loaded, total }) => {
      bus.emit('tab:progress', { tab: this, loaded, total });
    };
    this.loadingTask.onPassword = (updateCallback, reason) => {
      bus.emit('tab:password', { tab: this, updateCallback, reason });
    };
    const doc = await this.loadingTask.promise;
    if (this.destroyed) {
      doc.destroy();
      return this;
    }
    this.doc = doc;
    this.pageCount = doc.numPages;

    // cached annotations ---------------------------------------------------
    const key = this.docKey();
    this._docKey = key;
    if (store.get('annotationStorage', true)) {
      try {
        const saved = await window.lumen.annotations.get(key);
        if (saved && saved.serialized) {
          const parsed = JSON.parse(saved.serialized);
          for (const [id, value] of Object.entries(parsed)) {
            doc.annotationStorage.setValue(id, value);
          }
        }
      } catch (err) {
        console.warn('[lumen] could not restore annotations', err);
      }
    }
    doc.annotationStorage.onSetModified = () => {
      this._markDirty(true);
    };
    doc.annotationStorage.onResetModified = () => {
      this._markDirty(false);
    };

    this.metadata = await doc.getMetadata().catch(() => null);
    this.bookmarks = (await window.lumen.bookmarks.get(key)) || [];

    this.viewer.setDocument(doc);
    this.linkService.setDocument(doc, null);
    try {
      // NOTE: PDFHistory only records positions when it is allowed to write the
      // location hash — with `updateUrl: false` the back/forward buttons have
      // nothing to walk, which made them look broken.
      this.history.initialize({ fingerprint: doc.fingerprint || this.path, resetHistory: true, updateUrl: true });
    } catch (err) {
      console.warn('[lumen] history init failed', err);
    }
    if (doc.getOutline) {
      this.outline = await doc.getOutline().catch(() => null);
    }
    return this;
  }

  _renderError() {
    this.containerEl.append(
      el(
        'div',
        { class: 'pane-empty', style: { position: 'absolute', inset: '0', display: 'grid', placeItems: 'center' } },
        el('div', {}, el('div', { text: t('toast.loadFailed') }), el('div', { class: 'muted', text: String(this.error) })),
      ),
    );
  }

  /* -------------------------------------------------------------- events */
  _bindEvents() {
    const eb = this.eventBus;
    eb.on('pagesinit', () => {
      const st = this._restoreState || {};
      this.scaleValue = st.scaleValue || store.get('zoomMode', 'auto');
      this.viewer.currentScaleValue = this.scaleValue;
      this.setScrollMode(st.scrollMode || store.get('scrollMode', 'vertical'));
      this.setPageMode(st.pageMode || store.get('pageMode', 'single'));
      const startPage = clamp(st.page || 1, 1, this.pageCount || 1);
      this.viewer.currentPageNumber = startPage;
      if (st.scrollTop) {
        requestAnimationFrame(() => {
          const v = this.viewerEl;
          if (v) v.scrollTop = st.scrollTop;
        });
      }
      this.scale = this.viewer.currentScale;
      this.loaded = true;
      // The pages are on screen now; anything slower (outline, metadata) must
      // not keep the loading veil up.
      bus.emit('tab:visible', { tab: this });
      bus.emit('tab:ready', { tab: this });
    });
    eb.on('pagechanging', (evt) => {
      // Feed the in-document history so back/forward can walk real positions.
      // PDFHistory throttles and coalesces these internally.
      if (this.history && this.history._initialized) {
        try {
          this.history.pushPage(evt.pageNumber);
        } catch {
          /* history is best effort */
        }
      }
      if (evt.pageNumber === this.page) return;
      this.page = evt.pageNumber;
      bus.emit('tab:page', { tab: this, page: this.page, label: evt.pageLabel });
    });

    eb.on('scalechanging', (evt) => {
      this.scale = evt.scale;
      bus.emit('tab:scale', { tab: this, scale: evt.scale, preset: evt.preset });
    });

    eb.on('rotationchanging', (evt) => {
      this.rotation = evt.pagesRotation;
      bus.emit('tab:rotation', { tab: this, rotation: this.rotation });
    });

    eb.on('updatefindmatchescount', (evt) => {
      this._findTotal = evt.matchesCount?.total ?? 0;
      this._findPages = evt.matchesCount?.page ?? 0;
      bus.emit('tab:find-results', {
        tab: this,
        total: this._findTotal,
        pages: this._findPages,
        matches: this._collectMatches(),
      });
    });

    eb.on('updatefindcontrolstate', (evt) => {
      bus.emit('tab:find-state', { tab: this, state: evt.state, previous: evt.previous, entireWord: evt.entireWord });
    });

    let saveTick = null;
    eb.on('pagerendered', () => {
      if (saveTick) return;
      saveTick = setTimeout(() => {
        saveTick = null;
      }, 600);
    });

    eb.on('documentloaded', () => {
      bus.emit('tab:document-loaded', { tab: this });
    });

    eb.on('annotationeditorstateschanged', () => {
      bus.emit('tab:editors', { tab: this });
    });

    eb.on('annotationeditoruimanager', (evt) => {
      this.editorUiManager = evt?.uiManager || null;
      // the editor exists now — re-apply whatever tool was requested earlier
      this._retryEditorMode();
    });

    // Selection state drives the delete affordances in the UI. The manager
    // reports it as `editingstateschanged` on the same event bus.
    eb.on('editingstateschanged', (evt) => {
      const has = !!(evt?.details && evt.details.hasSelectedEditor);
      if (has === this.hasSelectedAnnotation) return;
      this.hasSelectedAnnotation = has;
      bus.emit('tab:selection', { tab: this, hasSelection: has });
    });

    eb.on('annotationeditormodechanged', (evt) => {
      bus.emit('tab:editors', { tab: this, mode: evt?.mode });
    });
  }

  _markDirty(on) {
    const next = on !== false ? true : this.doc?.annotationStorage.size > 0;
    if (next === this.dirty) return;
    this.dirty = next;
    bus.emit('tab:dirty', { tab: this, dirty: this.dirty });
    this._scheduleAnnotationSave();
  }

  _scheduleAnnotationSave() {
    if (!store.get('annotationStorage', true)) return;
    if (this._annotationsSaveTimer) clearTimeout(this._annotationsSaveTimer);
    this._annotationsSaveTimer = setTimeout(() => this.persistAnnotations(), 700);
  }

  async persistAnnotations() {
    if (!this.doc || !this._docKey) return;
    try {
      // NOTE: serializable.map is a Map, and JSON.stringify(new Map()) is "{}",
      // so it must be converted through Object.fromEntries first.
      const serializable = this.doc.annotationStorage.serializable;
      const map = serializable?.map;
      const plain = map instanceof Map ? Object.fromEntries(map) : { ...(map || {}) };
      await window.lumen.annotations.set(this._docKey, {
        serialized: JSON.stringify(plain),
        hash: serializable?.hash || null,
        count: Object.keys(plain).length,
        path: this.path,
        title: this.docTitle(),
      });
      bus.emit('tab:annotations-saved', { tab: this });
    } catch (err) {
      console.warn('[lumen] annotation save failed', err);
    }
  }

  /* ------------------------------------------------------------ document */
  docKey() {
    const base = String(this.path || '').toLowerCase();
    const size = this.size || 0;
    const mtime = this.mtime ? Math.round(this.mtime) : 0;
    return `${base}::${size}::${mtime}`;
  }

  docTitle() {
    const info = this.metadata?.info || {};
    const title = (info.Title || '').trim();
    if (title) return title;
    return baseName(this.path).replace(/\.pdf$/i, '');
  }

  /* ---------------------------------------------------------------- view */
  setZoom(value) {
    this.scaleValue = value;
    if (this.viewer) this.viewer.currentScaleValue = value;
  }

  setZoomPreset(preset) {
    this.setZoom(preset);
  }

  zoomIn() {
    this.viewer?.increaseScale({ steps: 1 });
    this.scaleValue = String(this.viewer?.currentScale ?? this.scale);
  }

  zoomOut() {
    this.viewer?.decreaseScale({ steps: 1 });
    this.scaleValue = String(this.viewer?.currentScale ?? this.scale);
  }

  /** 0-1: how much of the ideal pixel resolution the last paint achieved. */
  get renderQuality() {
    return this._lastQuality;
  }

  /**
   * Rebuilds the PDF.js viewer so renderer options that are only read at
   * construction time (the canvas budget, hardware acceleration) pick up a new
   * value. The current page, zoom and rotation are preserved.
   */
  async reloadViewer() {
    if (!this.doc || this.destroyed) return;
    const keep = { page: this.page, scale: this.scaleValue, rotation: this.rotation };
    const el = this.viewerEl;
    const old = this.viewer;
    try {
      this.editorUiManager = null;
      this.hasSelectedAnnotation = false;
      old?.setDocument(null);
      el.replaceChildren();
      const { PDFViewer: Viewer } = await import('./vendor/pdfjs/pdf_viewer.mjs');
      this.viewer = new Viewer({
        container: this.containerEl,
        viewer: el,
        eventBus: this.eventBus,
        linkService: this.linkService,
        findController: this.findController,
        l10n: this.l10n,
        removePageBorders: false,
        textLayerMode: 1,
        annotationMode: AnnotationMode.ENABLE_FORMS,
        annotationEditorMode: AnnotationEditorType.NONE,
        annotationEditorHighlightColors: HIGHLIGHT_PAIRS,
        enableHighlightFloatingButton: false,
        imageResourcesPath: new URL('./vendor/pdfjs/images/', import.meta.url).href,
        enablePrintAutoRotate: true,
        enableDetailCanvas: true,
        supportsPinchToZoom: true,
        enableAutoLinking: true,
        ...renderQualityOptions(),
      });
      this.viewer.setDocument(this.doc);
      await this.viewer.firstPagePromise;
      this.viewer.pagesRotation = keep.rotation;
      this.setZoom(typeof keep.scale === 'string' || Number.isNaN(Number(keep.scale)) ? keep.scale : Number(keep.scale));
      this.setPage(keep.page, { center: false });
      this.setTool(this.tool || 'select');
    } catch (err) {
      console.warn('[lumen] viewer reload failed', err);
      this.error = String((err && err.message) || err);
      this._renderError();
    }
  }

  /** True while this tab's pages are actually laid out (its container is shown). */
  get visible() {
    return !!this.containerEl && !this.containerEl.hidden;
  }

  setPage(pageNumber, opts = {}) {
    const p = clamp(Math.round(pageNumber), 1, this.pageCount || 1);
    if (!this.viewer) return;
    // Scrolling a page that is inside a hidden tab container makes PDF.js log
    // "offsetParent is not set -- cannot scroll"; record the page and move the
    // viewer without a scroll in that case.
    if (opts.center === false || !this.visible) this.viewer.currentPageNumber = p;
    else this.viewer.scrollPageIntoView({ pageNumber: p, center: null });
    this.page = p;
  }

  nextPage() {
    this.viewer?.nextPage();
  }
  prevPage() {
    this.viewer?.previousPage();
  }

  /** Rotates the view by ±90° (or any multiple of 90). */
  rotateBy(delta) {
    if (!this.viewer) return;
    const step = Number(delta) || 0;
    if (step % 90 !== 0) return;
    const next = (((this.viewer.pagesRotation + step) % 360) + 360) % 360;
    this._applyRotation(next);
  }

  /**
   * Sets an absolute rotation.
   *
   * NOTE: `setRotation(0)` used to be a no-op because 0 is also the neutral
   * delta, which made "reset the view" impossible to express.
   */
  setRotation(absolute) {
    const value = ((Number(absolute) % 360) + 360) % 360;
    this._applyRotation(value);
  }

  _applyRotation(value) {
    if (!this.viewer) return;
    if (this.viewer.pagesRotation === value) return;
    this.viewer.pagesRotation = value;
    this.rotation = value;
    bus.emit('tab:rotation', { tab: this, rotation: value });
  }

  setScrollMode(key) {
    this.scrollModeKey = SCROLL[key] === undefined ? 'vertical' : key;
    if (this.viewer) this.viewer.scrollMode = SCROLL[this.scrollModeKey];
    bus.emit('tab:scrollmode', { tab: this, mode: this.scrollModeKey });
  }

  setPageMode(key) {
    this.pageModeKey = SPREAD[key] === undefined ? 'single' : key;
    if (this.viewer) this.viewer.spreadMode = SPREAD[this.pageModeKey];
    bus.emit('tab:pagemode', { tab: this, mode: this.pageModeKey });
  }

  get scrollMode() {
    return MODE_TO_UI[this.viewer?.scrollMode] || this.scrollModeKey;
  }

  /** The element PDF.js actually scrolls. */
  get scroller() {
    return this.containerEl;
  }

  scrollBy(dx, dy) {
    if (!this.viewerEl) return;
    this.containerEl.scrollBy({ left: dx, top: dy, behavior: 'auto' });
  }

  flashPage(pageNumber) {
    const pv = this.viewer?.getPageView((pageNumber || 1) - 1);
    const node = pv?.div;
    if (!node) return;
    node.classList.add('lumen-flash');
    setTimeout(() => node.classList.remove('lumen-flash'), 1600);
  }

  /* --------------------------------------------------------------- find */
  search(query, opts = {}) {
    const findbar = store.get('findbar', {});
    this._findQuery = query;
    this.eventBus.dispatch('find', {
      source: this,
      type: opts.type || 'find',
      query,
      caseSensitive: opts.caseSensitive ?? findbar.caseSensitive ?? false,
      entireWord: opts.entireWord ?? findbar.entireWord ?? false,
      highlightAll: opts.highlightAll ?? findbar.highlightAll ?? true,
      findPrevious: !!opts.findPrevious,
      matchDiacritics: opts.matchDiacritics ?? findbar.diacritics ?? false,
      previous: false,
    });
  }

  findAgain(forward = true) {
    if (!this._findQuery) return;
    this.search(this._findQuery, { type: 'again', findPrevious: !forward });
  }

  clearFind() {
    this._findQuery = '';
    this.eventBus.dispatch('findbarclose', { source: this });
  }

  _onFindResultsCount() {}
  _onFindState(state) {
    bus.emit('tab:find-state', { tab: this, state });
  }

  /** Build a lightweight result list out of the find controller's internals. */
  _collectMatches(limit = 400) {
    const fc = this.findController;
    const out = [];
    try {
      const perPage = fc._pageMatches || [];
      const perPageLen = fc._pageMatchesLength || [];
      for (let i = 0; i < perPage.length && out.length < limit; i += 1) {
        const matches = perPage[i] || [];
        const lens = perPageLen[i] || [];
        for (let j = 0; j < matches.length && out.length < limit; j += 1) {
          out.push({ page: i + 1, index: matches[j], length: lens[j] || this._findQuery.length, offset: j });
        }
      }
    } catch {
      /* internals changed — the counter still works */
    }
    return out;
  }

  /* -------------------------------------------------------- text helpers */
  /** Lazily extract (and cache) the text of a page. */
  pageText(pageNumber) {
    const key = pageNumber;
    if (this._textPromises.has(key)) return this._textPromises.get(key);
    const p = (async () => {
      try {
        const page = await this.doc.getPage(pageNumber);
        const tc = await page.getTextContent();
        return tc.items.map((it) => it.str).join(' ');
      } catch {
        return '';
      }
    })();
    this._textPromises.set(key, p);
    return p;
  }

  async pageTextSnippet(pageNumber, index, length, radius = 60) {
    const text = await this.pageText(pageNumber);
    if (!text) return '';
    const start = Math.max(0, index - radius);
    const end = Math.min(text.length, index + length + radius);
    return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
  }

  async allText(onProgress) {
    const parts = [];
    for (let i = 1; i <= this.pageCount; i += 1) {
      parts.push(await this.pageText(i));
      if (onProgress && (i % 5 === 0 || i === this.pageCount)) onProgress(i / this.pageCount);
    }
    return parts;
  }

  /* -------------------------------------------------------- annotations */
  setTool(tool) {
    const map = {
      select: AnnotationEditorType.NONE,
      hand: AnnotationEditorType.NONE,
      highlight: AnnotationEditorType.HIGHLIGHT,
      ink: AnnotationEditorType.INK,
      freeText: AnnotationEditorType.FREETEXT,
      stamp: AnnotationEditorType.STAMP,
      signature: AnnotationEditorType.SIGNATURE,
      // PDF.js (6.3) has no eraser, so `erase` means "editing off": the tab's
      // EraserOverlay (see eraser.js) captures the pointer and removes whatever
      // annotation is under it, straight from the annotation storage.
      erase: AnnotationEditorType.NONE,
    };
    const mode = map[tool] ?? AnnotationEditorType.NONE;
    this.tool = tool;
    this.wantedEditorMode = mode;
    this._applyEditorMode(mode, true);
    bus.emit('tab:tool', { tab: this, tool });
  }

  /**
   * Applies an annotation editor mode, remembering it when the editor is not
   * ready yet.
   *
   * PDF.js builds its annotation editor while the first page renders and the
   * setter throws "The AnnotationEditor is not enabled." until then. Retrying
   * when the UI manager announces itself keeps a tool selected during load from
   * silently doing nothing (which also made `canEdit` report a false positive).
   */
  _applyEditorMode(mode, notify = false) {
    if (!this.viewer) return;
    try {
      this.viewer.annotationEditorMode = { mode };
      this.editorError = null;
      this.editorReady = true;
    } catch (err) {
      this.editorError = String((err && err.message) || err);
      this.editorReady = false;
      console.warn('[lumen] annotation editing unavailable:', this.editorError);
      if (notify && mode !== AnnotationEditorType.NONE) {
        bus.emit('ui:toast', {
          title: t('toast.failed'),
          kind: 'warn',
          sub: getLanguage() === 'zh-CN'
            ? '此文档不允许添加批注（权限受限）'
            : 'This document does not allow annotations',
        });
      }
    }
  }

  /**
   * True when annotations can really be added. A document can permit
   * modification while its editor is still being built, so this reports the
   * outcome of the last attempt rather than reading back a stale mode.
   */
  get canEdit() {
    if (!this.viewer) return false;
    try {
      if (this.viewer.annotationEditorMode === AnnotationEditorType.DISABLE) return false;
    } catch {
      return false;
    }
    return this.editorReady !== false;
  }

  setEditorParam(type, value) {
    this.eventBus.dispatch('annotationeditorparamschanged', { source: this, type, value });
  }

  /** Re-applies a tool that was chosen before the editor finished loading. */
  _retryEditorMode() {
    if (this.wantedEditorMode === undefined) return;
    this._applyEditorMode(this.wantedEditorMode, false);
  }

  setHighlightColor(color) {
    this.setEditorParam(AnnotationEditorParamsType.HIGHLIGHT_COLOR, colorToRgb(color));
  }

  setInkColor(color) {
    this.setEditorParam(AnnotationEditorParamsType.INK_COLOR, colorToRgb(color));
  }

  setInkThickness(px) {
    this.setEditorParam(AnnotationEditorParamsType.INK_THICKNESS, px);
  }

  setFreeTextColor(color) {
    this.setEditorParam(AnnotationEditorParamsType.FREETEXT_COLOR, colorToRgb(color));
  }

  setFreeTextSize(px) {
    this.setEditorParam(AnnotationEditorParamsType.FREETEXT_SIZE, px);
  }

  /** Synthetic key events mirror what the built-in viewer toolbar does; they
   *  drive the editor UI manager's own key handling. */
  _sendKey(key, mods = {}) {
    const node = this.containerEl;
    if (!node) return;
    node.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        bubbles: true,
        cancelable: true,
        ...mods,
      }),
    );
  }

  /**
   * Drives the annotation editor UI manager. `EditorUndoBar`-style undo/redo is
   * not part of the public viewer API, but the manager is announced on the
   * event bus and its `undo`/`redo` methods are stable.
   */
  undo() {
    const manager = this.editorUiManager;
    if (manager && typeof manager.undo === 'function') {
      try {
        manager.undo();
        return true;
      } catch (err) {
        console.warn('[lumen] undo failed', err);
      }
    }
    return false;
  }

  redo() {
    const manager = this.editorUiManager;
    if (manager && typeof manager.redo === 'function') {
      try {
        manager.redo();
        return true;
      } catch (err) {
        console.warn('[lumen] redo failed', err);
      }
    }
    return false;
  }

  /** True when the annotation editor currently has a selection. */
  get annotationSelected() {
    if (this.hasSelectedAnnotation) return true;
    const manager = this.editorUiManager;
    try {
      return !!(manager && typeof manager.hasSelection === 'function' && manager.hasSelection());
    } catch {
      return false;
    }
  }

  /**
   * Deletes whatever the annotation editor has selected.
   *
   * Returns true only when something was actually removed — the manager's
   * `delete()` is a no-op without a selection, so it must not be reported as a
   * successful deletion.
   */
  deleteSelectedAnnotation() {
    const manager = this.editorUiManager;
    if (!manager || typeof manager.delete !== 'function') return false;
    let hasSelection = this.hasSelectedAnnotation;
    try {
      if (typeof manager.hasSelection === 'function') hasSelection = manager.hasSelection();
    } catch {
      /* fall back to the flag we track from editingstateschanged */
    }
    if (!hasSelection) return false;
    try {
      manager.delete();
      this.hasSelectedAnnotation = false;
      return true;
    } catch (err) {
      console.warn('[lumen] delete failed', err);
      return false;
    }
  }

  hasEditableAnnotations() {
    try {
      const pages = this.viewer?._pages || [];
      return pages.some((p) => p?.hasEditableAnnotations?.());
    } catch {
      return false;
    }
  }

  /** List the annotations currently stored for the document. */
  listAnnotations() {
    const out = [];
    try {
      // serializable.map is a Map (see persistAnnotations)
      const map = this.doc?.annotationStorage?.serializable?.map;
      const entries = map instanceof Map ? [...map.entries()] : Object.entries(map || {});
      for (const [id, value] of entries) {
        const kind = value?.annotationType ?? value?.type ?? 0;
        out.push({
          id,
          pageIndex: value?.pageIndex ?? 0,
          page: (value?.pageIndex ?? 0) + 1,
          kind: annotKindName(kind),
          color: rgbToCss(value?.color) || 'var(--accent)',
          text: value?.richText
            ? stripHtml(value.richText)
            : value?.value
              ? stripHtml(String(value.value))
              : value?.content?.text || value?.title || '',
          raw: value,
        });
      }
    } catch (err) {
      console.warn('[lumen] listAnnotations failed', err);
    }
    out.sort((a, b) => a.page - b.page);
    return out;
  }

  /* ----------------------------------------------------------- bookmarks */
  getPageLabel(pageNumber) {
    try {
      return this.viewer?.getPageView(pageNumber - 1)?.pageLabel || '';
    } catch {
      return '';
    }
  }

  async addBookmark(pageNumber = this.page) {
    if (this.bookmarks.some((b) => b.page === pageNumber)) return false;
    const label = this.getPageLabel(pageNumber) || '';
    this.bookmarks.push({
      id: uid('bm'),
      page: pageNumber,
      label,
      createdAt: Date.now(),
    });
    this.bookmarks.sort((a, b) => a.page - b.page);
    await window.lumen.bookmarks.set(this._docKey || this.docKey(), this.bookmarks);
    bus.emit('tab:bookmarks', { tab: this, bookmarks: this.bookmarks });
    return true;
  }

  async removeBookmark(id) {
    this.bookmarks = this.bookmarks.filter((b) => b.id !== id);
    await window.lumen.bookmarks.set(this._docKey || this.docKey(), this.bookmarks);
    bus.emit('tab:bookmarks', { tab: this, bookmarks: this.bookmarks });
  }

  /* ---------------------------------------------------------- thumbnails */
  getThumbElement(pageNumber) {
    if (this._thumbCache.has(pageNumber)) return this._thumbCache.get(pageNumber);
    const scale = store.get('thumbnailZoom', 120) / 100;
    const wrap = el('div', { class: 'thumb', dataset: { page: String(pageNumber) } });
    const canvasWrap = el('div', { class: 'thumb-canvas-wrap' });
    const skeleton = el('div', { class: 'thumb-skeleton' });
    canvasWrap.append(skeleton);
    const label = el('div', { class: 'thumb-label', text: this.getPageLabel(pageNumber) || String(pageNumber) });
    wrap.append(canvasWrap, label);
    wrap.addEventListener('click', () => {
      this.setPage(pageNumber);
      bus.emit('tab:thumb-click', { tab: this, page: pageNumber });
    });
    this._thumbCache.set(pageNumber, wrap);
    this._trimThumbCache(pageNumber);
    this._renderThumb(pageNumber, canvasWrap, skeleton, scale);
    return wrap;
  }

  async _renderThumb(pageNumber, canvasWrap, skeleton, scale) {
    try {
      const page = await this.doc.getPage(pageNumber);
      if (this.destroyed) return;
      const viewport = page.getViewport({ scale: 1 });
      const targetW = clamp(viewport.width * scale * 0.36, 70, 260);
      const s = targetW / viewport.width;
      const vp = page.getViewport({ scale: s * (window.devicePixelRatio || 1) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
      const ctx = canvas.getContext('2d', { alpha: false });
      await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
      if (this.destroyed) return;
      skeleton.remove();
      canvasWrap.append(canvas);
    } catch (err) {
      skeleton?.remove();
    }
  }

  /**
   * Keeps the thumbnail cache proportional to what the sidebar can show.
   *
   * Every cached thumbnail holds a small canvas, so caching all 500 pages of a
   * manual costs several megabytes for content nobody is looking at. Nodes near
   * the current page are kept; the rest are dropped and rebuilt on demand from
   * PDF.js's own page cache.
   */
  _trimThumbCache(aroundPage, keep = 60) {
    if (this._thumbCache.size <= keep) return;
    const centre = aroundPage || this.page || 1;
    const entries = [...this._thumbCache.keys()].sort(
      (a, b) => Math.abs(a - centre) - Math.abs(b - centre),
    );
    for (const pageNumber of entries.slice(keep)) {
      const node = this._thumbCache.get(pageNumber);
      node?.remove();
      this._thumbCache.delete(pageNumber);
    }
  }

  invalidateThumbs() {
    for (const [, node] of this._thumbCache) node.remove();
    this._thumbCache.clear();
  }

  /* -------------------------------------------------------------- saving */
  /** Returns the bytes of the document with all stored annotations applied. */
  async exportBytes() {
    if (!this.doc) return null;
    try {
      const bytes = await this.doc.saveDocument();
      this.saveError = null;
      return bytes;
    } catch (err) {
      this.saveError = String((err && err.message) || err);
      throw err;
    }
  }

  async saveCopy(targetPath) {
    let bytes;
    try {
      bytes = await this.exportBytes();
    } catch (err) {
      return { ok: false, error: describeSaveError(err, this) };
    }
    if (!bytes) return { ok: false, error: 'no document' };
    const res = await window.lumen.fs.write(targetPath, bytes);
    if (res.ok) {
      this._markDirty(false);
      try {
        this.doc.annotationStorage.resetModified();
      } catch {
        /* ignore */
      }
    }
    return res;
  }

  async exportPageImages({ from = 1, to = this.pageCount, scale = 2, mime = 'image/png', onProgress } = {}) {
    const out = [];
    const ext = mime === 'image/jpeg' ? 'jpg' : 'png';
    for (let i = from; i <= to; i += 1) {
      const page = await this.doc.getPage(i);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
      const blob = await new Promise((r) => canvas.toBlob(r, mime, 0.92));
      const buf = new Uint8Array(await blob.arrayBuffer());
      out.push({ index: i, ext, data: buf });
      onProgress?.(i, to);
    }
    return out;
  }

  /* -------------------------------------------------------------- state */
  captureState() {
    return {
      page: this.page,
      scaleValue: this.scaleValue,
      scale: this.scale,
      scrollMode: this.scrollModeKey,
      pageMode: this.pageModeKey,
      rotation: this.rotation,
      scrollTop: this.containerEl?.scrollTop || 0,
      scrollLeft: this.viewerEl?.scrollLeft || 0,
      updatedAt: Date.now(),
      total: this.pageCount,
      title: this.docTitle(),
      path: this.path,
    };
  }

  async persistState() {
    if (!this.loaded) return;
    try {
      await window.lumen.reading.set(this._docKey || this.docKey(), this.captureState());
    } catch {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------- destroy */
  async destroy() {
    this.destroyed = true;
    try {
      await this.persistState();
      await this.persistAnnotations();
    } catch {
      /* ignore */
    }
    try {
      this.findController?.setDocument(null);
    } catch {
      /* ignore */
    }
    try {
      this.viewer?.cleanup();
    } catch {
      /* ignore */
    }
    try {
      await this.loadingTask?.destroy();
    } catch {
      /* ignore */
    }
    try {
      this.history?.destroy?.();
    } catch {
      /* ignore */
    }
    if (this.token) window.lumen.doc.release(this.token).catch(() => {});
    this.containerEl.remove();
    this._thumbCache.clear();
    this._textPromises.clear();
  }
}

/* ------------------------------------------------------------- utilities */
function describeSaveError(err, tab) {
  const raw = String((err && err.message) || err || 'unknown error');
  if (/encrypt|password|permission/i.test(raw)) {
    return getLanguage() === 'zh-CN'
      ? `此文档受保护，无法写回 PDF（${raw}）。可改用“导出页面为图片”或“打印”。`
      : `This document is protected and cannot be written back (${raw}). Use image export or printing instead.`;
  }
  if (/ArrayBuffer|out of memory|Invalid string length/i.test(raw)) {
    return getLanguage() === 'zh-CN'
      ? '文档过大，生成 PDF 时内存不足。可先关闭其他标签页再试。'
      : 'The document is too large to serialise in memory. Try closing other tabs.';
  }
  return raw;
}

export function colorToRgb(css) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(css).trim());
  if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  const m2 = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(String(css).trim());
  if (m2) return [parseInt(m2[1] + m2[1], 16), parseInt(m2[2] + m2[2], 16), parseInt(m2[3] + m2[3], 16)];
  return [255, 210, 74];
}

export function rgbToCss(rgb) {
  if (!Array.isArray(rgb) || rgb.length < 3) return null;
  return `rgb(${rgb.map((v) => clamp(Math.round(v), 0, 255)).join(',')})`;
}

function stripHtml(html) {
  const d = document.createElement('div');
  d.innerHTML = String(html);
  return (d.textContent || '').trim();
}

export function annotKindName(kind) {
  // matches pdf.js AnnotationType values
  const map = {
    1: '文本',
    2: '链接',
    3: '自由文本',
    4: '线条',
    5: '方形',
    6: '圆形',
    7: '多边形',
    8: '折线',
    9: '高亮',
    10: '下划线',
    11: '删除线',
    12: '图章',
    13: '插入符',
    14: '墨迹',
    15: '弹窗',
    16: '文件附件',
    17: '声音',
    18: '电影',
    19: '控件',
    20: '屏幕',
    21: '打印机标记',
    22: '陷阱网络',
    23: '水印',
    24: '3D',
    25: '红框',
    26: '签名',
  };
  return map[kind] || '批注';
}

export { SCROLL, SPREAD };
