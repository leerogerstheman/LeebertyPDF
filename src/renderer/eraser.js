/* =========================================================================
   LeebertyPDF — independent eraser.

   This build of PDF.js has no eraser of its own, so this module implements one:
   it maps pointer positions onto the annotations that PDF.js has rendered, and
   removes the hit one from the annotation storage.

   How the mapping works
   --------------------
   Rendered editors carry no annotation id, but `annotationStorage` keeps a
   `Map` of id → data in insertion order and PDF.js renders editors in that same
   order per page. The map is therefore walked in order and paired with the
   rendered `.annotationEditorLayer > *` / `.annotationLayer > *` nodes of the
   matching page. Both sides are only ever read, so the pairing cannot drift.
   ========================================================================= */
import { $, bus, el } from './lib/core.js';

/** Nodes that represent a user-created or existing annotation on a page. */
const ANNOTATION_SELECTOR = [
  '.annotationEditorLayer .highlightEditor',
  '.annotationEditorLayer .inkEditor',
  '.annotationEditorLayer .freeTextEditor',
  '.annotationEditorLayer .stampEditor',
  '.annotationEditorLayer .signatureEditor',
  '.annotationLayer .highlightAnnotation',
  '.annotationLayer .inkAnnotation',
  '.annotationLayer .textAnnotation',
  '.annotationLayer .squareAnnotation',
  '.annotationLayer .stampAnnotation',
].join(',');

/**
 * Builds a list of the annotations currently drawn on a page.
 *
 * Storage entries and DOM nodes are paired by geometry rather than by order:
 * the stored `rect` is projected through the page viewport and matched to the
 * rendered node whose box it describes. Order-based pairing would silently
 * mis-attribute ids as soon as PDF.js renders a different number of nodes than
 * the page has storage entries (it does for some annotation kinds).
 */
export function collectPageAnnotations(tab, pageIndex) {
  const out = [];
  const view = tab.viewer?.getPageView(pageIndex);
  if (!view || !view.div) return out;

  const serial = tab.doc?.annotationStorage?.serializable;
  const entries = [];
  if (serial && serial.map) {
    for (const [id, value] of serial.map) {
      if ((value?.pageIndex ?? 0) !== pageIndex) continue;
      entries.push({ id: String(id), value, expected: storedScreenRect(view, value) });
    }
  }

  const nodes = [...view.div.querySelectorAll(ANNOTATION_SELECTOR)];
  const used = new Set();
  nodes.forEach((node, index) => {
    const rect = node.getBoundingClientRect();
    let best = null;
    let bestScore = Infinity;
    for (const entry of entries) {
      if (used.has(entry)) continue;
      const score = entry.expected ? rectDistance(entry.expected, rect) : 0;
      if (score < bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    // a match must be plausible; otherwise leave the node unattributed
    const storage = best && bestScore < 120 ? best : null;
    if (storage) used.add(storage);
    out.push({ node, index, storage, rect, pageIndex });
  });
  return out;
}

/** The screen box a stored annotation rect should occupy, if it has one. */
function storedScreenRect(view, value) {
  const rect = value?.rect;
  if (!Array.isArray(rect) || rect.length < 4) return null;
  try {
    const vp = view.viewport;
    const [x0, y0, x1, y1] = rect;
    // PDF user space is bottom-up; convert both corners and normalise
    const a = vp.convertToViewportPoint(Math.min(x0, x1), Math.min(y0, y1));
    const b = vp.convertToViewportPoint(Math.max(x0, x1), Math.max(y0, y1));
    const box = view.div.getBoundingClientRect();
    const left = box.left + Math.min(a[0], b[0]);
    const top = box.top + Math.min(a[1], b[1]);
    return {
      left,
      top,
      right: box.left + Math.max(a[0], b[0]),
      bottom: box.top + Math.max(a[1], b[1]),
    };
  } catch {
    return null;
  }
}

/** Distance between the centres of two boxes, plus their size mismatch. */
function rectDistance(a, b) {
  const ca = { x: (a.left + a.right) / 2, y: (a.top + a.bottom) / 2 };
  const cb = { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
  const d = Math.hypot(ca.x - cb.x, ca.y - cb.y);
  const sa = Math.hypot(a.right - a.left, a.bottom - a.top);
  const sb = Math.hypot(b.right - b.left, b.bottom - b.top);
  return d + Math.abs(sa - sb) * 0.5;
}

/** All annotations drawn across the visible pages, with screen rectangles. */
export function collectVisibleAnnotations(tab) {
  const pages = tab.viewer?._pages || [];
  const out = [];
  for (const view of pages) {
    if (!view || !view.div || view.div.hidden) continue;
    const index = (view.id || 1) - 1;
    for (const item of collectPageAnnotations(tab, index)) out.push(item);
  }
  return out;
}

/**
 * The eraser overlay: one transparent layer per tab that captures the pointer
 * while the erase tool is active, highlights what would be removed and deletes
 * it on click.
 */
export class EraserOverlay {
  constructor(tab) {
    this.tab = tab;
    this.active = false;
    this.hovered = null;
    this.removed = 0;
    this.host = el('div', { class: 'eraser-layer', hidden: true });
    this.marker = el('div', { class: 'eraser-marker', hidden: true });
    this.host.append(this.marker);
    tab.containerEl.append(this.host);
    this._onMove = (e) => this._hitTest(e.clientX, e.clientY);
    this._onLeave = () => this._clearHover();
    this._onDown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const hit = this._hitTest(e.clientX, e.clientY);
      if (hit) this.erase(hit);
    };
    this.host.addEventListener('pointermove', this._onMove);
    this.host.addEventListener('pointerleave', this._onLeave);
    this.host.addEventListener('pointerdown', this._onDown);
  }

  setActive(on) {
    this.active = !!on;
    this.host.hidden = !this.active;
    if (!this.active) this._clearHover();
    this.tab.containerEl.classList.toggle('erasing', this.active);
  }

  destroy() {
    this.host.remove();
    this.tab.containerEl.classList.remove('erasing');
  }

  _clearHover() {
    if (!this.hovered) return;
    this.hovered = null;
    this.marker.hidden = true;
  }

  /** Finds the topmost annotation under a screen point, with a small tolerance. */
  _hitTest(clientX, clientY, tolerance = 4) {
    if (!this.active) return null;
    const items = collectVisibleAnnotations(this.tab);
    let best = null;
    for (const item of items) {
      const r = item.rect;
      if (
        clientX >= r.left - tolerance &&
        clientX <= r.right + tolerance &&
        clientY >= r.top - tolerance &&
        clientY <= r.bottom + tolerance
      ) {
        // prefer the smallest hit so a small note inside a big highlight wins
        const area = r.width * r.height;
        if (!best || area < best.area) best = { ...item, area };
      }
    }
    if (!best) {
      this._clearHover();
      return null;
    }
    this.hovered = best;
    const pad = 3;
    const hostRect = this.tab.containerEl.getBoundingClientRect();
    this.marker.hidden = false;
    this.marker.style.left = `${best.rect.left - hostRect.left - pad}px`;
    this.marker.style.top = `${best.rect.top - hostRect.top - pad}px`;
    this.marker.style.width = `${best.rect.width + pad * 2}px`;
    this.marker.style.height = `${best.rect.height + pad * 2}px`;
    return best;
  }

  /**
   * Removes the annotation behind `hit`.
   *
   * Deleting through `annotationStorage.remove` is what makes this independent:
   * it works for annotations that were never opened as an editor, and for ones
   * created by another reader.
   */
  erase(hit) {
    const tab = this.tab;
    const pageIndex = hit.pageIndex;
    if (!hit.storage) {
      bus.emit('ui:toast', {
        title: this._t('找不到该批注对应的数据', 'This annotation has no stored data'),
        kind: 'warn',
        duration: 2000,
      });
      return false;
    }
    const id = hit.storage.id;
    try {
      tab.doc.annotationStorage.remove(id);
    } catch (err) {
      console.warn('[lumen] erase failed', err);
      bus.emit('ui:toast', { title: this._t('擦除失败', 'Could not erase'), kind: 'error', sub: String(err.message || err) });
      return false;
    }
    this.removed += 1;
    tab.dirty = true;
    this._clearHover();
    // repaint the page so the removed annotation disappears immediately
    this._repaint(pageIndex);
    bus.emit('tab:annotations-changed', { tab });
    bus.emit('ui:toast', {
      title: this._t(`已擦除 ${this.removed} 处批注`, `Erased ${this.removed} annotation(s)`),
      kind: 'ok',
      duration: 1400,
    });
    return true;
  }

  _repaint(pageIndex) {
    const view = this.tab.viewer?.getPageView(pageIndex);
    try {
      view?.update({});
    } catch (err) {
      console.warn('[lumen] repaint after erase failed', err);
    }
  }

  _t(zh, en) {
    return document.documentElement.lang === 'en-US' ? en : zh;
  }
}

/** One overlay per tab, created on demand. */
const overlays = new WeakMap();

export function eraserFor(tab) {
  let overlay = overlays.get(tab);
  if (!overlay) {
    overlay = new EraserOverlay(tab);
    overlays.set(tab, overlay);
  }
  return overlay;
}

export function setEraserActive(tab, active) {
  if (!tab) return;
  eraserFor(tab).setActive(active);
}

export function disposeEraser(tab) {
  const overlay = overlays.get(tab);
  if (!overlay) return;
  overlays.delete(tab);
  overlay.destroy();
}
