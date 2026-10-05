/* =========================================================================
   LeebertyPDF — reflowed (text) view.

   Turns a fixed-layout PDF page into a single readable column: text is
   extracted with its positions, grouped into visual lines and paragraphs, and
   the non-text areas of the page (anything that actually has ink but no text)
   are cropped out of a low-resolution render and inserted in place.

   Everything here works in PDF user units with the origin at the bottom-left,
   matching `page.getViewport({ scale: 1 })`.
   ========================================================================= */
import { OPS } from './vendor/pdfjs/pdf.min.mjs';
import { clamp, el, store } from './lib/core.js';

/** Vertical overlap ratio above which two runs belong to the same line. */
const LINE_TOLERANCE = 0.55;
/** A gap larger than this multiple of the line height ends a paragraph. */
const PARAGRAPH_GAP = 1.35;
/** Words closer than this multiple of the font size are joined without a space. */
const WORD_GAP = 0.26;

/**
 * Extracts a page as an ordered list of blocks.
 *
 * @returns {Promise<{width:number,height:number,blocks:Array}>}
 */
export async function extractPageBlocks(page, opts = {}) {
  const viewport = page.getViewport({ scale: 1 });
  const width = viewport.width;
  const height = viewport.height;
  const text = await page.getTextContent({ includeMarkedContent: false });

  const items = [];
  for (const item of text.items) {
    if (typeof item.str !== 'string') continue;
    // transform is [a, b, c, d, e, f] in PDF space with a bottom-left origin
    const [a, , , d, e, f] = item.transform;
    const size = Math.abs(d) || Math.abs(a) || 10;
    const str = item.str;
    if (!str.length) continue;
    items.push({
      str,
      size,
      x: e,
      // convert the baseline to a top-down coordinate
      y: height - f,
      w: item.width ?? str.length * size * 0.5,
      h: item.height || size,
      eol: !!item.hasEOL,
    });
  }

  const lines = groupIntoLines(items);
  const paragraphs = groupIntoParagraphs(lines);
  const blocks = paragraphs.map((p) => ({
    kind: 'text',
    text: p.text,
    size: p.size,
    top: p.top,
    bottom: p.bottom,
    left: p.left,
    lines: p.lines,
  }));

  if (opts.keepImages !== false) {
    const figures = await extractFigures(page, viewport, blocks, opts);
    for (const fig of figures) blocks.push(fig);
  }

  blocks.sort((a, b) => a.top - b.top);
  return { width, height, blocks };
}

/** Groups positioned text runs into visual lines. */
function groupIntoLines(items) {
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const item of sorted) {
    const height = Math.max(item.h, item.size);
    let line = lines[lines.length - 1];
    // a new line when the baseline moves more than half a line height
    if (!line || Math.abs(item.y - line.baseline) > Math.max(line.height, height) * LINE_TOLERANCE) {
      line = { baseline: item.y, height, runs: [] };
      lines.push(line);
    }
    line.runs.push(item);
    line.height = Math.max(line.height, height);
    // track the widest baseline drift so a slightly tilted scan still joins
    line.baseline = (line.baseline * (line.runs.length - 1) + item.y) / line.runs.length;
  }
  return lines
    .map((line) => {
      const runs = line.runs.sort((a, b) => a.x - b.x);
      let text = '';
      let prev = null;
      for (const run of runs) {
        if (prev) {
          const gap = run.x - (prev.x + prev.w);
          const needsSpace =
            gap > Math.max(prev.size, run.size) * WORD_GAP &&
            !/\s$/.test(text) &&
            !/^\s/.test(run.str) &&
            // CJK text does not use spaces between characters
            !isCjkEdge(text, run.str);
          if (needsSpace) text += ' ';
        }
        text += run.str;
        prev = run;
      }
      const size = median(runs.map((r) => r.size)) || 10;
      return {
        text: text.replace(/\s+/g, ' ').trim(),
        size,
        top: Math.min(...runs.map((r) => r.y - r.size * 0.85)),
        bottom: Math.max(...runs.map((r) => r.y + r.size * 0.25)),
        left: Math.min(...runs.map((r) => r.x)),
        right: Math.max(...runs.map((r) => r.x + r.w)),
      };
    })
    .filter((line) => line.text.length > 0);
}

/** True when either side of the join is a CJK character (no space wanted). */
function isCjkEdge(left, right) {
  const cjk = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;
  return cjk.test(left.slice(-1)) || cjk.test(right.slice(0, 1));
}

/** Groups consecutive lines into paragraphs by vertical rhythm. */
function groupIntoParagraphs(lines) {
  if (!lines.length) return [];
  const bodySize = median(lines.map((l) => l.size)) || 10;
  const paragraphs = [];
  let current = null;
  for (const line of lines) {
    if (!current) {
      current = { lines: [line] };
      continue;
    }
    const prev = current.lines[current.lines.length - 1];
    const gap = line.top - prev.bottom;
    const trailingBreak = /[.。!！?？:：;；]$/.test(prev.text);
    const headingChange = line.size > prev.size * 1.25 || line.size < prev.size * 0.8;
    const sizeChange = line.size > bodySize * 1.15 && prev.size <= bodySize * 1.15;
    if (gap > bodySize * PARAGRAPH_GAP || headingChange || sizeChange || (gap > bodySize && trailingBreak)) {
      paragraphs.push(current);
      current = { lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current) paragraphs.push(current);

  return paragraphs.map((p) => {
    const text = p.lines
      .map((l) => l.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      text,
      size: median(p.lines.map((l) => l.size)) || bodySize,
      top: Math.min(...p.lines.map((l) => l.top)),
      bottom: Math.max(...p.lines.map((l) => l.bottom)),
      left: Math.min(...p.lines.map((l) => l.left)),
      lines: p.lines.length,
    };
  });
}

/**
 * Figures on a page.
 *
 * Two sources are combined, because neither is complete on its own:
 *   1. the operator list, which knows exactly where every image and image mask
 *      is painted — exact, but blind to vector drawings;
 *   2. an ink scan of a low-resolution render, which catches vector diagrams but
 *      cannot tell where one figure ends and the next begins.
 * Placed images win, and ink runs overlapping them are dropped.
 */
async function extractFigures(page, viewport, textBlocks, opts = {}) {
  const placed = await placedImageRects(page, viewport);
  const { figures: ink, canvas, scanScale } = await inkFigures(page, viewport, textBlocks, opts, placed);
  // the scan render doubles as the crop source for the exact image rectangles
  const scan = canvas && scanScale ? { canvas, scanScale } : null;
  const prepared = placed.map((rect) => {
    if (!scan) return { ...rect, canvas: null, crop: null };
    // An image XObject is often painted larger than its visible content (the
    // operator box includes the picture's margin), so the crop is tightened to
    // the ink actually present inside that box.
    const box = {
      from: Math.max(0, Math.round(rect.top * scan.scanScale)),
      to: Math.min(scan.canvas.height, Math.round(rect.bottom * scan.scanScale)),
      minX: Math.max(0, Math.round(rect.left * scan.scanScale)),
      maxX: Math.min(scan.canvas.width, Math.round(rect.right * scan.scanScale)),
    };
    const tight = tightInkBox(scan.canvas, box) || box;
    return {
      ...rect,
      top: tight.from / scan.scanScale,
      bottom: tight.to / scan.scanScale,
      left: tight.minX / scan.scanScale,
      right: tight.maxX / scan.scanScale,
      canvas: scan.canvas,
      crop: { w: scan.canvas.width, h: scan.canvas.height, ...tight },
    };
  });
  return mergeFigures([...prepared, ...ink], viewport.height);
}

/** Shrinks a scan-pixel box to the ink it actually contains. */
function tightInkBox(canvas, box) {
  let ctx;
  try {
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  } catch {
    return null;
  }
  const from = Math.max(0, box.from);
  const to = Math.min(canvas.height, box.to);
  const minX = Math.max(0, box.minX);
  const maxX = Math.min(canvas.width, box.maxX);
  if (to <= from || maxX <= minX) return null;
  const { data } = ctx.getImageData(minX, from, maxX - minX, to - from);
  const w = maxX - minX;
  const h = to - from;
  let top = -1;
  let bottom = -1;
  let left = w;
  let right = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) {
        if (top < 0) top = y;
        bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (top < 0 || right < left) return null;
  return { from: from + top, to: from + bottom + 1, minX: minX + left, maxX: minX + right + 1 };
}

/** Exact rectangles of painted images and masks, from the operator list. */
async function placedImageRects(page, viewport) {
  let ops;
  try {
    ops = await page.getOperatorList();
  } catch (err) {
    console.warn('[lumen] reflow: operator list unavailable', err);
    return [];
  }
  const lib = OPS || {};
  const names = [
    'paintImageXObject',
    'paintInlineImageXObject',
    'paintImageMaskXObject',
    'paintImageXObjectRepeat',
    'paintSolidColorImageMask',
  ];
  const paintOps = new Set(names.map((n) => lib[n]).filter((v) => typeof v === 'number'));
  if (!paintOps.size) return [];

  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const rects = [];
  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i];
    if (fn === lib.save) {
      stack.push(ctm);
      continue;
    }
    if (fn === lib.restore) {
      ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      continue;
    }
    if (fn === lib.transform) {
      const m = ops.argsArray[i];
      if (Array.isArray(m) && m.length === 6) ctm = multiply(m, ctm);
      continue;
    }
    if (!paintOps.has(fn)) continue;
    const args = ops.argsArray[i] || [];
    let w = Number(args[1]);
    let h = Number(args[2]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      const last = args[args.length - 1];
      if (Array.isArray(last) && last.length === 6) {
        w = Math.hypot(last[0], last[1]) || 0;
        h = Math.hypot(last[2], last[3]) || 0;
      }
    }
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue;
    // the image is drawn into a unit square scaled by (w, h) and mapped by the CTM
    const cx = [ctm[0] * w, ctm[1] * w];
    const cy = [ctm[2] * h, ctm[3] * h];
    const origin = [ctm[4], ctm[5]];
    const xs = [origin[0], origin[0] + cx[0], origin[0] + cy[0], origin[0] + cx[0] + cy[0]];
    const ys = [origin[1], origin[1] + cx[1], origin[1] + cy[1], origin[1] + cx[1] + cy[1]];
    const rect = pdfRectToPage(viewport, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
    if (rect.right - rect.left > 6 && rect.bottom - rect.top > 6) {
      rects.push({ ...rect, kind: 'figure', source: 'image' });
    }
  }
  return rects;
}

/** PDF user space (origin bottom-left) to top-down page coordinates. */
function pdfRectToPage(viewport, x0, y0, x1, y1) {
  const a = viewport.convertToViewportPoint(x0, y0);
  const b = viewport.convertToViewportPoint(x1, y1);
  return {
    left: Math.min(a[0], b[0]),
    top: Math.min(a[1], b[1]),
    right: Math.max(a[0], b[0]),
    bottom: Math.max(a[1], b[1]),
  };
}

/** `m` applied after `n`, matching the PDF `cm` operator. */
function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** Combines both sources: dedupe, prefer exact rectangles, stitch slices. */
function mergeFigures(rects, pageHeight) {
  const sorted = [...rects].sort((a, b) => a.top - b.top);
  const out = [];
  for (const rect of sorted) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push({ ...rect });
      continue;
    }
    if (overlapRatio(prev, rect) > 0.5) {
      if (prev.source === 'ink' && rect.source === 'image') out[out.length - 1] = { ...rect };
      continue;
    }
    const stacked =
      rect.top - prev.bottom < pageHeight * 0.02 && horizontalOverlap(prev, rect) > 0.25;
    if (stacked) {
      prev.bottom = Math.max(prev.bottom, rect.bottom);
      prev.left = Math.min(prev.left, rect.left);
      prev.right = Math.max(prev.right, rect.right);
      continue;
    }
    out.push({ ...rect });
  }
  return out.filter((r) => r.right - r.left > 6 && r.bottom - r.top > 6);
}

function horizontalOverlap(a, b) {
  const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const smaller = Math.min(a.right - a.left, b.right - b.left);
  return smaller > 0 ? overlap / smaller : 0;
}

function overlapRatio(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (w <= 0 || h <= 0) return 0;
  const smaller = Math.min((a.right - a.left) * (a.bottom - a.top), (b.right - b.left) * (b.bottom - b.top));
  return smaller > 0 ? (w * h) / smaller : 0;
}

/**
 * Ink scan: rows that carry ink but no text, with the placed images masked out.
 * This is what catches vector diagrams, charts and rules.
 */
async function inkFigures(page, viewport, textBlocks, opts = {}, placed = []) {
  const scanScale = opts.scanScale || 0.35;
  const renderViewport = page.getViewport({ scale: scanScale });
  const w = Math.max(1, Math.floor(renderViewport.width));
  const h = Math.max(1, Math.floor(renderViewport.height));

  let canvas;
  try {
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    await page.render({ canvasContext: ctx, canvas, viewport: renderViewport }).promise;
  } catch (err) {
    console.warn('[lumen] reflow: could not scan page for figures', err);
    return { figures: [], canvas: null, scanScale };
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, w, h);

  const threshold = Math.max(2, Math.round(w * 0.004));
  const inkRows = new Uint8Array(h);
  for (let y = 0; y < h; y += 1) {
    let ink = 0;
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      if (data[i] < 236 || data[i + 1] < 236 || data[i + 2] < 236) {
        ink += 1;
        if (ink > threshold) break;
      }
    }
    inkRows[y] = ink > threshold ? 1 : 0;
  }

  // anything already accounted for: extracted text, and placed images
  const known = new Uint8Array(h);
  const markRows = (top, bottom) => {
    const from = Math.max(0, Math.round(top * scanScale));
    const to = Math.min(h - 1, Math.round(bottom * scanScale));
    for (let y = from; y <= to; y += 1) known[y] = 1;
  };
  for (const block of textBlocks) markRows(block.top - 2, block.bottom + 2);
  for (const rect of placed) markRows(rect.top - 2, rect.bottom + 2);

  const runs = [];
  let run = null;
  for (let y = 0; y < h; y += 1) {
    const isInk = inkRows[y] && !known[y];
    if (isInk && !run) run = { from: y, to: y };
    else if (isInk) run.to = y;
    else if (run) {
      runs.push(run);
      run = null;
    }
  }
  if (run) runs.push(run);

  /** Horizontal ink extent of a row band. */
  const bandExtent = (from, to) => {
    let minX = w;
    let maxX = -1;
    for (let y = from; y <= to; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 4;
        if (data[i] < 236 || data[i + 1] < 236 || data[i + 2] < 236) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    return maxX < minX ? null : { minX, maxX };
  };

  const minHeight = Math.max(8, h * 0.012);
  const bands = [];
  for (const r of runs) {
    const extent = bandExtent(r.from, r.to);
    if (!extent) continue;
    bands.push({ from: r.from, to: r.to, ...extent, thin: r.to - r.from < minHeight });
  }

  // stitch vertically adjacent bands that overlap horizontally
  const merged = [];
  const maxGap = Math.max(2, Math.round(h * 0.02));
  for (const band of bands) {
    const prev = merged[merged.length - 1];
    const gap = prev ? band.from - prev.to : Infinity;
    const overlap = prev ? Math.min(prev.maxX, band.maxX) - Math.max(prev.minX, band.minX) : 0;
    const ratio = prev ? overlap / Math.max(1, Math.min(prev.maxX - prev.minX, band.maxX - band.minX)) : 0;
    const joinable = prev && gap <= maxGap && (ratio > 0.2 || band.thin || prev.thin);
    if (joinable) {
      prev.to = band.to;
      prev.minX = Math.min(prev.minX, band.minX);
      prev.maxX = Math.max(prev.maxX, band.maxX);
      prev.thin = false;
    } else {
      merged.push({ ...band });
    }
  }

  const figures = [];
  for (const band of merged) {
    if (band.thin || band.to - band.from < minHeight) continue;
    figures.push({
      kind: 'figure',
      source: 'ink',
      top: band.from / scanScale,
      bottom: (band.to + 1) / scanScale,
      left: band.minX / scanScale,
      right: (band.maxX + 1) / scanScale,
      canvas,
      crop: { w, h, from: band.from, to: band.to + 1, minX: band.minX, maxX: band.maxX + 1 },
    });
  }
  return { figures, canvas, scanScale };
}

function median(values) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}


/* =========================================================================
   The reflow pane: a scrollable column of reflowed pages.
   ========================================================================= */

/** Type scale for a block, relative to the page's body text size. */
function scaleFor(size, bodySize) {
  if (!bodySize) return 1;
  return clamp(size / bodySize, 0.75, 2.4);
}

/**
 * Crops a figure out of the page scan and encodes it.
 *
 * Returning a data URL rather than a canvas keeps a long reflow from holding
 * one bitmap per figure: a page scan of a photo page is ~4 MB of backing store,
 * while its cropped PNG is tens of kilobytes. The bitmap is only materialised
 * while the figure is actually on screen (see `observeFigures`).
 */
function figureDataUrl(figure) {
  const canvas = figure.canvas;
  const out = document.createElement('canvas');
  if (!canvas) return out;
  const pad = 1;
  // placed images carry exact page rectangles; ink bands carry scan rows
  const scanScale = figure.crop ? null : canvas.width / (figure.pageWidth || canvas.width);
  const crop = figure.crop || {
    w: canvas.width,
    h: canvas.height,
    from: Math.round(figure.top * scanScale),
    to: Math.round(figure.bottom * scanScale),
    minX: Math.round(figure.left * scanScale),
    maxX: Math.round(figure.right * scanScale),
  };
  const source = crop;
  const sx = Math.max(0, source.minX - pad);
  const sy = Math.max(0, source.from - pad);
  const sw = Math.min(canvas.width - sx, source.maxX - source.minX + pad * 2);
  const sh = Math.min(canvas.height - sy, source.to - source.from + pad * 2);
  out.width = Math.max(1, Math.round(sw));
  out.height = Math.max(1, Math.round(sh));
  const ctx = out.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return { url: out.toDataURL('image/png'), width: out.width, height: out.height };
}

export class ReflowPane {
  constructor(tab) {
    this.tab = tab;
    this.rendered = new Set();
    this.busy = false;
    this.cancelled = false;

    this.host = el('div', { class: 'reflow-pane', hidden: true });
    this.articleHost = el('div', { class: 'reflow-articles' });
    this.status = el('div', { class: 'reflow-status' });
    const wrap = el('div', { class: 'reflow-scroll' }, this.articleHost);
    this.host.append(wrap, this.status);
    this.applyTypography();
  }

  /** Font size, line height and column width, all persisted. */
  applyTypography() {
    const size = clamp(Number(store.get('reflowFontSize', 16)) || 16, 12, 30);
    const line = clamp(Number(store.get('reflowLineHeight', 1.7)) || 1.7, 1.2, 2.6);
    const width = clamp(Number(store.get('reflowWidth', 760)) || 760, 380, 1400);
    this.host.style.setProperty('--reflow-font-size', `${size}px`);
    this.host.style.setProperty('--reflow-line-height', String(line));
    this.host.style.setProperty('--reflow-width', `${width}px`);
  }

  setVisible(on) {
    this.visible = !!on;
    this.host.hidden = !this.visible;
    this.tab.containerEl.hidden = this.visible;
    if (!this.visible) this.releaseFigures();
  }

  destroy() {
    this.cancelled = true;
    this.releaseFigures();
    this.figureObserver?.disconnect();
    this.figureObserver = null;
    this.articleHost.replaceChildren();
    this.host.remove();
  }

  /**
   * Figures hold a data URL until they scroll near the viewport, and drop the
   * decoded bitmap again once they leave. A phone-book sized reflow therefore
   * keeps a handful of bitmaps alive instead of one per figure.
   */
  observeFigures() {
    this.figureObserver?.disconnect();
    if (typeof IntersectionObserver !== 'function') {
      // no observer: fall back to materialising everything
      for (const img of this.articleHost.querySelectorAll('img[data-src]')) this.mountFigure(img);
      return;
    }
    this.figureObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const img = entry.target;
          if (entry.isIntersecting) this.mountFigure(img);
          else if (entry.intersectionRatio === 0) this.unmountFigure(img);
        }
      },
      { root: this.host.querySelector('.reflow-scroll'), rootMargin: '600px 0px' },
    );
    for (const img of this.articleHost.querySelectorAll('img[data-src]')) this.figureObserver.observe(img);
  }

  mountFigure(img) {
    if (img.dataset.mounted === '1') return;
    img.src = img.dataset.src;
    img.dataset.mounted = '1';
  }

  unmountFigure(img) {
    if (img.dataset.mounted !== '1') return;
    // dropping src releases the decoded bitmap; the data URL stays in the DOM
    img.removeAttribute('src');
    img.dataset.mounted = '0';
  }

  /** Frees every figure bitmap without losing the content. */
  releaseFigures() {
    for (const img of this.articleHost.querySelectorAll('img[data-mounted="1"]')) this.unmountFigure(img);
  }

  /**
   * Renders every page into the column.
   *
   * Pages are processed in order and appended as they finish, so the first
   * screenful appears quickly and the rest streams in behind it.
   */
  async render() {
    if (this.busy) return;
    this.busy = true;
    this.cancelled = false;
    this.figureObserver?.disconnect();
    this.releaseFigures();
    this.articleHost.replaceChildren();
    this.rendered.clear();
    this.status.textContent = '正在重排…';

    const total = this.tab.pageCount || 0;
    for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
      if (this.cancelled) break;
      this.status.textContent = `正在重排… ${pageNumber}/${total}`;
      try {
        const page = await this.tab.doc.getPage(pageNumber);
        const { blocks } = await extractPageBlocks(page, {
          keepImages: store.get('reflowKeepImages', true) !== false,
        });
        if (this.cancelled) break;
        this.articleHost.append(this.renderPage(pageNumber, blocks));
        // yield so scrolling stays responsive while a long document reflows
        await new Promise((r) => setTimeout(r, 0));
      } catch (err) {
        console.warn('[lumen] reflow failed for page', pageNumber, err);
        this.articleHost.append(
          el('article', { class: 'reflow-page' },
            el('div', { class: 'reflow-page-head', text: `第 ${pageNumber} 页` }),
            el('div', { class: 'reflow-empty', text: '这一页无法重排' })),
        );
      }
    }
    this.status.textContent = this.cancelled ? '' : `已重排 ${total} 页 · Ctrl+Shift+E 返回原版式`;
    this.observeFigures();
    this.busy = false;
  }

  renderPage(pageNumber, blocks) {
    const article = el('article', { class: 'reflow-page', dataset: { page: String(pageNumber) } });
    article.append(el('div', { class: 'reflow-page-head', text: `第 ${pageNumber} 页` }));

    const textBlocks = blocks.filter((b) => b.kind === 'text');
    const bodySize = textBlocks.length ? median(textBlocks.map((b) => b.size)) : 12;

    if (!blocks.length) {
      article.append(el('div', { class: 'reflow-empty', text: '这一页没有可提取的文字或图形' }));
      return article;
    }

    const keepImages = store.get('reflowKeepImages', true) !== false;
    for (const block of blocks) {
      if (block.kind === 'figure') {
        if (!keepImages) continue;
        const shot = figureDataUrl(block);
        if (!shot.url) continue;
        const img = el('img', {
          class: 'reflow-figure-canvas',
          alt: '',
          width: String(shot.width),
          height: String(shot.height),
        });
        img.dataset.src = shot.url;
        article.append(el('figure', { class: 'reflow-figure' }, img));
        continue;
      }
      const scale = scaleFor(block.size, bodySize);
      const cls = scale > 1.18 ? 'reflow-h' : 'reflow-p';
      article.append(
        el('p', {
          class: cls,
          text: block.text,
          style: { '--reflow-scale': scale.toFixed(2) },
        }),
      );
    }
    return article;
  }
}

/** One pane per tab, created on demand. */
const panes = new WeakMap();

export function reflowFor(tab) {
  let pane = panes.get(tab);
  if (!pane) {
    pane = new ReflowPane(tab);
    panes.set(tab, pane);
    tab.containerEl.parentElement.append(pane.host);
  }
  return pane;
}

export function disposeReflow(tab) {
  const pane = panes.get(tab);
  if (!pane) return;
  panes.delete(tab);
  pane.destroy();
}
