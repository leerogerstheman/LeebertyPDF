'use strict';
/**
 * LeebertyPDF — page editor.
 *
 * A multi-document object-graph editor: pages are collected from one or more
 * source PDFs, rearranged, then written out as a brand new PDF. Content streams
 * are copied byte for byte, so nothing in the page content is reinterpreted —
 * only the structural objects (page tree, annotations' /P links, outline and
 * named destinations, page labels, metadata) are rebuilt.
 *
 * Structural notes
 * ----------------
 *  - Every referenced object is deep-copied through a per-source memo map, which
 *    makes self-referential graphs (kids/parents, outlines) safe.
 *  - `/Parent` keys are skipped while copying and re-established afterwards, so
 *    a merged/cut document can never keep a pointer into its old page tree.
 *  - `getOrInsertComputed`-era PDF.js is irrelevant here, but the same
 *    discipline applies: never look for structure inside stream bytes.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const { PdfDocument, PdfError } = require('./document');
const { N, S, A, D, R, isRef, isDict, isArray, isName, isStr, nameOf, serializeObject } = require('./lexer');

const COLLECTION_KEYS = [
  'AcroForm',
  'OCProperties',
  'StructTreeRoot',
  'MarkInfo',
  'OutputIntents',
  'PieceInfo',
  'Perms',
  'Legal',
  'Requirements',
];
const PAGE_SKIP_KEYS = new Set(['Parent', 'Annots', 'BleedBox', 'TrimBox', 'ArtBox']);
const TREE_COPY_SKIP = new Set(['Parent', 'Prev', 'Next', 'First', 'Last', 'Count', 'Kids', 'Names', 'Limits']);

class Source {
  constructor(doc, id) {
    this.doc = doc;
    this.id = id;
    this.memo = new Map(); // old num -> new num
  }
}

class PageEditor {
  constructor() {
    /** @type {Array<{src:Source, num:number, rotate:number, label:string, width:number, height:number}>} */
    this.pages = [];
    this.sources = new Map(); // id -> Source
    this.nextObj = 1;
    this.pending = []; // in-flight addFile() promises
    this.warnings = [];
  }

  /* --------------------------------------------------------------- input */
  /**
   * Opens a PDF from disk and adds all (or a range of) its pages.
   *
   * Asynchronous because it reads the file, but the returned promise is also
   * tracked so a later synchronous `build()` still sees the pages — callers may
   * simply `await editor.settle()` instead of awaiting every call.
   */
  async addFile(filePath, { pages = null, at = null } = {}) {
    const buf = await fsp.readFile(filePath);
    return this.addBuffer(buf, { pages, at, path: filePath });
  }

  /** Waits for every pending addFile() to finish. */
  async settle() {
    while (this.pending.length) {
      const batch = this.pending;
      this.pending = [];
      await Promise.all(batch);
    }
    return this;
  }

  /** Number of pages, waiting for pending loads first (for UIs). */
  async count() {
    await this.settle();
    return this.pages.length;
  }

  addBuffer(buf, { pages = null, at = null, path = '' } = {}) {
    const doc = new PdfDocument(buf, path);
    if (doc.encrypted) {
      throw new PdfError('加密 PDF 暂不支持页面编辑，请先解除保护', 'ENCRYPTED');
    }
    const src = new Source(doc, `${this.sources.size}-${path || 'mem'}`);
    this.sources.set(src.id, src);
    const all = doc.getPages();
    let labels = [];
    try {
      labels = doc.getPageLabels();
    } catch {
      labels = all.map((_, i) => String(i + 1));
    }
    const wanted = [];
    if (!pages || !pages.length) {
      all.forEach((p, i) => wanted.push(i));
    } else {
      for (const spec of pages) {
        if (typeof spec === 'number') {
          if (spec >= 0 && spec < all.length) wanted.push(spec);
        } else if (spec && typeof spec === 'object') {
          const from = Number.isFinite(spec.from) ? spec.from : 0;
          const to = Number.isFinite(spec.to) ? spec.to : from;
          for (let i = Math.max(0, from); i <= Math.min(to, all.length - 1); i += 1) wanted.push(i);
        }
      }
    }
    const added = wanted.map((i) => {
      const p = all[i];
      const box = p.mediaBox;
      const boxArr = isArray(box) ? box.__array.map(Number) : [0, 0, 612, 792];
      const width = Math.abs((boxArr[2] ?? 612) - (boxArr[0] ?? 0));
      const height = Math.abs((boxArr[3] ?? 792) - (boxArr[1] ?? 0));
      const entry = {
        src,
        num: p.num,
        dict: p.dict,
        rotate: ((p.rotate || 0) % 360 + 360) % 360,
        label: labels[i] || String(i + 1),
        width,
        height,
      };
      this._copyStructTree(entry);
      return entry;
    });
    if (at === null || at === undefined) this.pages.push(...added);
    else this.pages.splice(Math.max(0, Math.min(at, this.pages.length)), 0, ...added);
    return added;
  }

  /* ------------------------------------------------------------ mutation */
  /** Deletes by index (0-based) or by page object identity. */
  removePages(indices) {
    const set = new Set(indices.map(Number));
    this.pages = this.pages.filter((_, i) => !set.has(i));
    return this;
  }

  /** Moves page `from` so that it sits at index `to` (both 0-based). */
  movePage(from, to) {
    const n = this.pages.length;
    if (n < 2) return this;
    const f = ((from % n) + n) % n;
    let t = ((to % n) + n) % n;
    const [page] = this.pages.splice(f, 1);
    if (t > this.pages.length) t = this.pages.length;
    this.pages.splice(t, 0, page);
    return this;
  }

  /** Replaces the whole order with an explicit permutation of old indices. */
  reorder(newOrder) {
    const next = [];
    for (const i of newOrder) {
      const p = this.pages[i];
      if (p) next.push(p);
    }
    if (next.length === this.pages.length) this.pages = next;
    return this;
  }

  /** Adds / subtracts rotation from the pages at `indices` (0-based). */
  rotatePages(indices, delta) {
    const set = new Set((indices && indices.length ? indices : this.pages.map((_, i) => i)).map(Number));
    for (let i = 0; i < this.pages.length; i += 1) {
      if (!set.has(i)) continue;
      const p = this.pages[i];
      p.rotate = (((p.rotate + delta) % 360) + 360) % 360;
    }
    return this;
  }

  setRotation(indices, absolute) {
    const set = new Set(indices.map(Number));
    for (let i = 0; i < this.pages.length; i += 1) {
      if (set.has(i)) this.pages[i].rotate = (((absolute % 360) + 360) % 360);
    }
    return this;
  }

  reverse() {
    this.pages.reverse();
    return this;
  }

  /** Keeps only the given indices (0-based), preserving their order. */
  keepOnly(indices) {
    const set = new Set(indices.map(Number));
    this.pages = this.pages.filter((_, i) => set.has(i));
    return this;
  }

  duplicatePage(index) {
    const p = this.pages[index];
    if (!p) return this;
    this.pages.splice(index + 1, 0, { ...p });
    return this;
  }

  /** Splits into chunks of `size` pages; returns editors for each chunk. */
  splitEvery(size) {
    const chunks = [];
    for (let i = 0; i < this.pages.length; i += size) {
      const editor = new PageEditor();
      editor.sources = this.sources;
      editor.pages = this.pages.slice(i, i + size).map((p) => ({ ...p }));
      chunks.push(editor);
    }
    return chunks;
  }

  /* ------------------------------------------------------------- output */
  /**
   * Serialises the current page set.
   * @returns {{buffer: Buffer, pageCount: number, warnings: string[], stats: object}}
   */
  build({ title = null, keepOutline = true, keepMetadata = true } = {}) {
    const writer = new Writer(this);
    writer.writeCatalog({ title, keepOutline, keepMetadata });
    return writer.finish();
  }

  async save(targetPath, opts) {
    const result = this.build(opts);
    await fsp.writeFile(targetPath, result.buffer);
    return { ...result, path: targetPath };
  }

  /* ------------------------------------------------------------ internals */
  alloc() {
    return this.nextObj++;
  }

  _copyStructTree(page) {
    // Structure trees are shared; they are copied lazily with the catalog.
    void page;
  }

  /** Metadata of the page set, used by the UI before/after an edit. */
  describe() {
    return this.pages.map((p, i) => ({
      index: i,
      label: p.label,
      width: p.width,
      height: p.height,
      rotate: p.rotate,
      source: p.src.id,
      landscape: p.width > p.height,
    }));
  }
}

/* ----------------------------------------------------------------- writer */
class Writer {
  constructor(editor) {
    this.editor = editor;
    this.objects = new Map(); // num -> {value, stream}
    this.reserved = [];
    this.warnings = [];
    this.acroFormFields = [];
    this.usedDests = false;
  }

  reserve() {
    const num = this.editor.alloc();
    this.objects.set(num, null);
    return num;
  }

  put(num, value, stream = null) {
    this.objects.set(num, { value, stream });
    return num;
  }

  /** Deep-copies an object from a source document into this writer. */
  copy(src, value, opts = {}) {
    return this._copyValue(src, value, opts);
  }

  _copyValue(src, value, opts = {}) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (value.__name !== undefined || value.__str) return value;
    if (isRef(value)) {
      if (opts.remap && opts.remap.has(value.num)) return opts.remap.get(value.num);
      if (src.memo.has(value.num)) return R(src.memo.get(value.num));
      const target = this.reserve();
      src.memo.set(value.num, target);
      const entry = src.doc.getObjectEntry(value.num);
      if (!entry) {
        this.objects.delete(target);
        src.memo.delete(value.num);
        return null;
      }
      if (entry.stream) {
        const dict = new Map();
        const skip = opts.skipKeys;
        for (const [k, v] of entry.value && entry.value.__dict ? entry.value.__dict : []) {
          if (skip && skip.has(k)) continue;
          dict.set(k, this._copyValue(src, v, opts.childOpts || {}));
        }
        dict.set('Length', entry.stream.length);
        this.put(target, D(dict), entry.stream);
      } else {
        this.put(target, this._copyValue(src, entry.value, opts));
      }
      return R(target);
    }
    if (isArray(value)) {
      const items = [];
      for (const v of value.__array) {
        const copied = this._copyValue(src, v, opts);
        if (copied !== null || v === null) items.push(copied);
      }
      return A(items);
    }
    if (isDict(value)) {
      const dict = new Map();
      const skip = opts.skipKeys;
      for (const [k, v] of value.__dict) {
        if (skip && skip.has(k)) continue;
        if (opts.remap && opts.remap.has(k)) {
          dict.set(k, opts.remap.get(k));
          continue;
        }
        dict.set(k, this._copyValue(src, v, opts.childOpts || {}));
      }
      return D(dict);
    }
    return null;
  }

  /**
   * Copies a dictionary and overrides specific keys with freshly built values.
   * Used for annotations (/P) and form fields (/P) that must point at the new
   * page object instead of the source document's page object.
   */
  copyWithRemap(src, dictValue, remap, opts = {}) {
    return this._copyValue(src, dictValue, { ...opts, remap });
  }

  /* ------------------------------------------------------------ assembly */
  writeCatalog({ title = null, keepOutline = true, keepMetadata = true } = {}) {
    const editor = this.editor;
    const pages = editor.pages;
    if (!pages.length) throw new PdfError('页面为空，无法生成 PDF', 'NO_PAGES');

    // 1. pages ------------------------------------------------------------
    const pageRefs = [];
    this.pageInfoBySrcPage = new Map();
    const pageInfo = pages.map((p, index) => {
      const target = this.reserve();
      const srcIndex = p.src.doc.getPages().findIndex((q) => q.num === p.num);
      if (srcIndex >= 0) this.pageInfoBySrcPage.set(`${p.src.id}:${srcIndex}`, { target, index, page: p });
      return { page: p, target };
    });

    // page-level remap tables are needed before the dicts are copied
    for (const info of pageInfo) {
      const { page } = info;
      const src = page.src;

      // annotations: /P must point at the new page object
      let annots = null;
      const annotsRaw = page.dict.get('Annots');
      const annotsResolved = src.doc.resolve(annotsRaw);
      if (isArray(annotsResolved)) {
        const items = [];
        for (const a of annotsResolved.__array) {
          const aDict = src.doc.resolve(a);
          if (!isDict(aDict)) continue;
          const remap = new Map();
          remap.set('P', R(info.target));
          const copied = this.copyWithRemap(src, aDict, remap, {
            skipKeys: new Set(['Parent']),
          });
          if (copied) items.push(copied);
        }
        if (items.length) annots = A(items);
      }

      // page dictionary: copy everything except the tree/annotation plumbing.
      // /Parent is skipped so the copy can never drag in the old page tree.
      const dict = new Map();
      const skip = new Set(['Parent']);
      for (const [k, v] of page.dict) {
        if (PAGE_SKIP_KEYS.has(k)) continue;
        if (k === 'Type') continue;
        dict.set(k, this._copyValue(src, v, { skipKeys: skip }));
      }
      dict.set('Type', N('Page'));

      // flatten inherited attributes onto the page
      if (!dict.has('MediaBox') && page.inherit?.mediaBox) {
        dict.set('MediaBox', this._copyValue(src, src.doc.resolve(page.inherit.mediaBox), {}));
      }
      if (!dict.has('Resources') && page.inherit?.resources) {
        dict.set('Resources', this._copyValue(src, src.doc.resolve(page.inherit.resources), {}));
      }
      if (!dict.has('CropBox') && page.inherit?.cropBox) {
        dict.set('CropBox', this._copyValue(src, src.doc.resolve(page.inherit.cropBox), {}));
      }
      if (page.rotate) dict.set('Rotate', page.rotate);
      else dict.delete('Rotate');
      if (annots) dict.set('Annots', annots);

      // form fields that point back at this page
      const acroSrc = src.doc.catalog && src.doc.catalog.get ? src.doc.catalog.get('AcroForm') : null;
      if (acroSrc) this._collectFields(src, acroSrc, info.target);

      this.put(info.target, D(dict));
      pageRefs.push(R(info.target));
    }

    // 2. page tree --------------------------------------------------------
    const pagesNum = this.reserve();
    const pagesDict = D(
      new Map([
        ['Type', N('Pages')],
        ['Kids', A(pageRefs)],
        ['Count', pageRefs.length],
      ]),
    );
    if (pages.length) {
      const first = pages[0];
      if (first.inherit?.mediaBox) {
        // the tree needs a MediaBox for readers that rely on inheritance
        const box = this._copyValue(first.src, first.src.doc.resolve(first.inherit.mediaBox), {});
        if (box) pagesDict.__dict.set('MediaBox', box);
      }
    }
    this.put(pagesNum, pagesDict);
    for (const info of pageInfo) {
      const dict = this.objects.get(info.target);
      if (dict && isDict(dict.value)) dict.value.__dict.set('Parent', R(pagesNum));
    }

    // 3. catalog ----------------------------------------------------------
    const catalogNum = this.reserve();
    const catalog = new Map();
    catalog.set('Type', N('Catalog'));
    catalog.set('Pages', R(pagesNum));

    const primarySrc = pages[0].src;
    const primaryCatalog = primarySrc.doc.catalog;
    if (isDict(primaryCatalog)) {
      for (const key of COLLECTION_KEYS) {
        const raw = primaryCatalog.get(key);
        if (raw === undefined) continue;
        const copied = this.copy(primarySrc, raw, {});
        if (copied) catalog.set(key, copied);
      }
      // viewer preferences are safe to carry over
      const vp = primaryCatalog.get('ViewerPreferences');
      if (vp) {
        const copied = this.copy(primarySrc, vp, {});
        if (copied) catalog.set('ViewerPreferences', copied);
      }
    }

    // 3a. named destinations ---------------------------------------------
    const dests = this._buildDests();
    if (dests) {
      const namesNum = this.reserve();
      const namesDict = D(new Map([['Dests', dests]]));
      catalog.set('Names', R(namesNum));
      this.put(namesNum, namesDict);
    }

    // 3b. outline ---------------------------------------------------------
    if (keepOutline) {
      const outline = this._buildOutline();
      if (outline) catalog.set('Outlines', outline);
    }

    // 3c. page labels ------------------------------------------------------
    const labels = this._buildPageLabels();
    if (labels) catalog.set('PageLabels', labels);

    // 4. metadata ---------------------------------------------------------
    const infoNum = this.reserve();
    const infoDict = new Map();
    const srcInfo = primarySrc.doc.resolve(primarySrc.doc.trailer.get('Info'));
    if (isDict(srcInfo)) {
      for (const [k, v] of srcInfo) {
        if (['ModDate', 'Producer', 'Creator'].includes(k) && !keepMetadata) continue;
        const copied = this.copy(primarySrc, v, {});
        if (copied !== null) infoDict.set(k, copied);
      }
    }
    const now = pdfDate(new Date());
    if (title) infoDict.set('Title', S(title));
    if (!infoDict.has('Producer')) infoDict.set('Producer', S('LeebertyPDF'));
    infoDict.set('ModDate', S(now));
    this.put(infoNum, D(infoDict));

    catalog.set('_lumen', null);
    catalog.delete('_lumen');
    this.put(catalogNum, D(catalog));
    this.rootNum = catalogNum;
    this.infoNum = infoNum;
    this.pageCount = pageRefs.length;

    // 5. form fields -------------------------------------------------------
    if (this.acroFormFields.length) {
      const fieldNums = this.acroFormFields;
      const fieldsNum = this.reserve();
      this.put(
        fieldsNum,
        D(
          new Map([
            ['Fields', A(fieldNums.map((n) => R(n)))],
            ['NeedAppearances', true],
          ]),
        ),
      );
      const existing = catalog.get('AcroForm');
      if (existing && isRef(existing)) {
        const obj = this.objects.get(existing.num);
        if (obj && isDict(obj.value) && !obj.value.__dict.has('Fields')) {
          obj.value.__dict.set('Fields', A(fieldNums.map((n) => R(n))));
        }
      } else {
        catalog.set('AcroForm', R(fieldsNum));
      }
    }
    return this;
  }

  _collectFields(src, acroRef, newPageNum) {
    try {
      const acro = src.doc.resolve(acroRef);
      if (!isDict(acro)) return;
      const fields = src.doc.resolve(acro.get('Fields'));
      if (!isArray(fields)) return;
      const walk = (ref, depth) => {
        if (depth > 16) return;
        const dict = src.doc.resolve(ref);
        if (!isDict(dict)) return;
        const kids = src.doc.resolve(dict.get('Kids'));
        if (isArray(kids)) {
          for (const k of kids.__array) walk(k, depth + 1);
          return;
        }
        const remap = new Map();
        remap.set('P', R(newPageNum));
        const copied = this.copyWithRemap(src, dict, remap, {});
        if (copied && isRef(copied)) this.acroFormFields.push(copied.num);
      };
      for (const f of fields.__array) walk(f, 0);
    } catch {
      /* forms are best effort */
    }
  }

  /* ------------------------------------------------------- destinations */
  _resolveDest(src, dest) {
    const doc = src.doc;
    let explicit = doc.resolve(dest);
    if (typeof dest === 'string') explicit = doc.resolve(dest);
    if (isStr(explicit)) {
      // named destination
      const named = this._lookupNamedDest(src, explicit.__str.toString('latin1'));
      if (named) explicit = doc.resolve(named);
    }
    if (isArray(explicit)) return explicit.__array;
    return null;
  }

  _pageIndexForDest(src, destArray) {
    if (!isArray(destArray) || !destArray.__array.length) return null;
    const first = destArray.__array[0];
    const pages = src.doc.getPages();
    if (isRef(first)) {
      const idx = pages.findIndex((p) => p.num === first.num);
      return idx >= 0 ? idx : null;
    }
    if (typeof first === 'number') return first;
    return null;
  }

  /** Named destinations that point at pages kept in the output. */
  _lookupNamedDestMap(src) {
    if (!src._namedDests) {
      const map = new Map();
      try {
        const catalog = src.doc.catalog;
        const names = src.doc.resolve(catalog && catalog.get('Names'));
        const destsRef = names && isDict(names) ? names.get('Dests') : null;
        const walk = (nodeRef, depth) => {
          if (depth > 24) return;
          const node = src.doc.resolve(nodeRef);
          if (!isDict(node)) return;
          const kids = node.get('Kids');
          if (isArray(kids)) {
            for (const k of kids.__array) walk(k, depth + 1);
            return;
          }
          const namesArr = node.get('Names');
          if (isArray(namesArr)) {
            const arr = namesArr.__array;
            for (let i = 0; i + 1 < arr.length; i += 2) {
              const key = arr[i];
              const val = arr[i + 1];
              if (isStr(key)) map.set(key.__str.toString('latin1'), val);
            }
          }
        };
        walk(destsRef, 0);
      } catch {
        /* ignore */
      }
      // legacy /Dests dictionary in the catalog
      try {
        const legacy = src.doc.resolve(src.doc.catalog.get('Dests'));
        if (isDict(legacy)) {
          for (const [k, v] of legacy) map.set(k, v);
        }
      } catch {
        /* ignore */
      }
      src._namedDests = map;
    }
    return src._namedDests;
  }

  _lookupNamedDest(src, name) {
    const map = this._lookupNamedDestMap(src);
    return map.get(name) || null;
  }

  /** Number of descendants under an outline item (for the /Count entry). */
  _countDescendants(src, firstChildNum, depth) {
    if (depth > 16 || !firstChildNum) return 0;
    let total = 0;
    let ref = R(firstChildNum);
    let guard = 0;
    while (ref && guard < 20000) {
      guard += 1;
      const dict = src.doc.resolve(ref);
      if (!isDict(dict)) break;
      total += 1;
      const kidsFirst = dict.get('First');
      if (kidsFirst) {
        const kidsCount = Number(src.doc.resolve(dict.get('Count')));
        if (Number.isFinite(kidsCount) && kidsCount !== 0) total += Math.abs(kidsCount);
        else total += this._countDescendants(src, src.doc.resolve(kidsFirst)?.num ?? null, depth + 1);
      }
      ref = dict.get('Next');
    }
    return total;
  }

  _destToArray(src, destArray) {
    // [pageRef /XYZ left top zoom] -> keep everything but remap the page
    const items = destArray.__array;
    const idx = this._pageIndexForDest(src, destArray);
    if (idx === null) return null;
    const info = this.pageInfoBySrcPage.get(`${src.id}:${idx}`);
    if (!info) return null;
    const out = [R(info.target)];
    for (let i = 1; i < items.length; i += 1) out.push(this._copyValue(src, items[i], {}));
    return A(out);
  }

  _buildDests() {
    const out = [];
    for (const [, src] of this.editor.sources) {
      const map = this._lookupNamedDestMap(src);
      if (!map.size) continue;
      for (const [name, dest] of map) {
        const arr = this._resolveDest(src, dest);
        if (!arr) continue;
        const mapped = this._destToArray(src, arr);
        if (!mapped) continue;
        out.push(S(name), mapped);
      }
    }
    if (!out.length) return null;
    return D(new Map([['Names', A(out)]]));
  }

  _buildOutline() {
    const src = this.editor.pages[0]?.src;
    if (!src) return null;
    const outlineRef = src.doc.catalog && src.doc.catalog.get('Outlines');
    const outline = src.doc.resolve(outlineRef);
    if (!isDict(outline)) return null;
    const firstRef = outline.get('First');
    if (!firstRef) return null;

    const rootNum = this.reserve();
    let count = 0;
    const copiedItems = [];

    const walk = (ref, parentNum, prevNum) => {
      const item = src.doc.resolve(ref);
      if (!isDict(item)) return null;
      const num = this.reserve();
      const dict = new Map();
      const title = item.get('Title');
      dict.set('Title', title !== undefined ? this._copyValue(src, title, {}) : S(''));
      dict.set('Parent', R(parentNum));
      if (prevNum) dict.set('Prev', R(prevNum));

      const dest = item.get('Dest');
      const action = src.doc.resolve(item.get('A'));
      if (dest !== undefined) {
        const arr = this._resolveDest(src, dest);
        const mapped = arr ? this._destToArray(src, arr) : null;
        if (mapped) dict.set('Dest', mapped);
      } else if (isDict(action) && nameOf(action.get('S')) === 'GoTo') {
        const arr = this._resolveDest(src, action.get('D'));
        const mappedArr = arr ? this._destToArray(src, arr) : null;
        const newAction = new Map([['S', N('GoTo')]]);
        if (mappedArr) newAction.set('D', mappedArr);
        const copiedAction = this.reserve();
        this.put(copiedAction, D(newAction));
        dict.set('A', R(copiedAction));
      }

      // children
      let childCount = 0;
      let firstChild = null;
      let lastChild = null;
      let prevChild = null;
      let childRef = item.get('First');
      let guard = 0;
      while (childRef && guard < 20000) {
        guard += 1;
        const childDict = src.doc.resolve(childRef);
        if (!isDict(childDict)) break;
        const childNum = walk(childRef, num, prevChild);
        if (childNum) {
          if (!firstChild) firstChild = childNum;
          lastChild = childNum;
          prevChild = childNum;
          childCount += 1;
        }
        childRef = childDict.get('Next');
      }
      if (firstChild) {
        dict.set('First', R(firstChild));
        dict.set('Last', R(lastChild));
        // Count is the number of *visible* descendants; an open item is
        // positive, a collapsed one negative. Mirror the source's sign.
        const declared = Number(src.doc.resolve(item.get('Count')));
        const negative = Number.isFinite(declared) && declared < 0;
        const total = childCount + this._countDescendants(src, firstChild, 0);
        dict.set('Count', negative ? -total : total);
      }
      const color = item.get('C');
      if (color !== undefined) dict.set('C', this._copyValue(src, color, {}));
      const style = item.get('F');
      if (style !== undefined) dict.set('F', Number(src.doc.resolve(style)) || 0);
      this.put(num, D(dict));
      count += 1;
      copiedItems.push(num);
      return num;
    };

    let firstTop = null;
    let lastTop = null;
    let prevTop = null;
    let ref = firstRef;
    let guard = 0;
    while (ref && guard < 20000) {
      guard += 1;
      const dict = src.doc.resolve(ref);
      if (!isDict(dict)) break;
      const num = walk(ref, rootNum, prevTop);
      if (num) {
        if (!firstTop) firstTop = num;
        lastTop = num;
        prevTop = num;
      }
      ref = dict.get('Next');
    }
    if (!firstTop) {
      this.objects.delete(rootNum);
      return null;
    }
    this.put(
      rootNum,
      D(
        new Map([
          ['Type', N('Outlines')],
          ['First', R(firstTop)],
          ['Last', R(lastTop)],
          ['Count', count],
        ]),
      ),
    );
    return R(rootNum);
  }

  _buildPageLabels() {
    // Preserve the original numbering style of a single source document.
    const pages = this.editor.pages;
    if (!pages.length) return null;
    const src = pages[0].src;
    const sameSource = pages.every((p) => p.src === src);
    if (!sameSource) return null;
    let labels;
    try {
      labels = src.doc.getPageLabels();
    } catch {
      return null;
    }
    const significant = labels.some((l, i) => l !== String(i + 1));
    if (!significant) return null;

    const items = [];
    let current = null;
    for (let i = 0; i < pages.length; i += 1) {
      const originalIndex = src.doc.getPages().findIndex((p) => p.num === pages[i].num);
      const label = labels[originalIndex] ?? String(i + 1);
      if (current && label === current.next) {
        current = { start: current.start, next: incrementLabel(current.next), style: current.style };
        continue;
      }
      if (current) items.push(S(String(current.start)), D(new Map([['S', N(current.style)]])));
      current = { start: i, next: incrementLabel(label), style: guessStyle(label) };
    }
    if (current) items.push(S(String(current.start)), D(new Map([['S', N(current.style)]])));
    if (!items.length) return null;
    return D(new Map([['Nums', A(items)]]));
  }

  /* --------------------------------------------------------------- output */
  finish() {
    const buf = serialize(this.objects, this.rootNum, this.infoNum);
    return {
      buffer: buf,
      pageCount: this.pageCount,
      warnings: this.warnings,
      stats: { objects: this.objects.size, bytes: buf.length },
    };
  }
}

function guessStyle(label) {
  if (/^\d+$/.test(label)) return 'D';
  if (/^[ivxlcdm]+$/i.test(label)) return /[ivxlcdm]/.test(label) ? 'r' : 'R';
  if (/^[a-z]+$/.test(label)) return 'a';
  if (/^[A-Z]+$/.test(label)) return 'A';
  return 'D';
}

function incrementLabel(label) {
  if (/^\d+$/.test(label)) return String(Number(label) + 1);
  return label;
}

function pdfDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  return `D:${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(
    d.getSeconds(),
  )}${sign}${pad(Math.floor(Math.abs(tz) / 60))}'${pad(Math.abs(tz) % 60)}'`;
}

/* -------------------------------------------------------------- serialiser */
function serialize(objects, rootNum, infoNum) {
  const chunks = [];
  const offsets = new Map();
  let pos = 0;
  const push = (str) => {
    const b = Buffer.from(str, 'latin1');
    chunks.push(b);
    pos += b.length;
  };
  const pushBuf = (b) => {
    chunks.push(b);
    pos += b.length;
  };

  push(`%PDF-1.7\n%\xe2\xe3\xcf\xd3\n`);

  const nums = [...objects.keys()].sort((a, b) => a - b);
  let maxNum = 0;
  for (const num of nums) {
    const entry = objects.get(num);
    if (!entry) continue;
    maxNum = Math.max(maxNum, num);
    offsets.set(num, pos);
    push(`${num} 0 obj\n`);
    const parts = [];
    serializeObject(entry.value, parts, (ref) => `${ref.num} ${ref.gen || 0} R`);
    push(parts.join(''));
    if (entry.stream) {
      push('\nstream\n');
      pushBuf(entry.stream);
      push('\nendstream');
    }
    push('\nendobj\n');
  }

  const xrefPos = pos;
  const count = maxNum + 1;
  push(`xref\n0 ${count}\n`);
  push('0000000000 65535 f \n');
  for (let i = 1; i < count; i += 1) {
    const off = offsets.get(i);
    if (off === undefined) push('0000000000 65535 f \n');
    else push(`${String(off).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${count} /Root ${rootNum} 0 R`);
  if (infoNum) push(` /Info ${infoNum} 0 R`);
  push(' >>\n');
  push(`startxref\n${xrefPos}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

module.exports = { PageEditor, PdfError, pdfDate };
