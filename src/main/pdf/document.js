'use strict';
/**
 * LeebertyPDF — PDF reader.
 *
 * Reads an existing PDF into a navigable object store:
 *   - classic cross-reference tables and cross-reference streams (with /Prev),
 *   - objects packed inside /ObjStm object streams,
 *   - hybrid /XRefStm references,
 *   - a raw `N G obj` scan as a safety net for damaged files.
 *
 * The store is intentionally read-only: the page editor copies the object graph
 * it needs into a fresh document instead of mutating in place, which keeps a
 * single, well tested write path.
 */
const zlib = require('zlib');
const { Parser, isRef, isDict, isArray, isName, isStr, nameOf, N, A, D, R, S } = require('./lexer');

const MAX_OBJ = 8_000_000;

class PdfError extends Error {
  constructor(message, code = 'PDF_ERROR') {
    super(message);
    this.code = code;
  }
}

function decodeStream(stream, dict, resolveFn) {
  if (!stream) return Buffer.alloc(0);
  let data = stream;
  let filters = dict ? dict.get('Filter') : null;
  let parms = dict ? dict.get('DecodeParms') : null;
  if (isRef(filters) && resolveFn) filters = resolveFn(filters);
  if (isRef(parms) && resolveFn) parms = resolveFn(parms);
  const list = isArray(filters) ? filters.__array : filters ? [filters] : [];
  const parmList = isArray(parms) ? parms.__array : parms ? [parms] : [];
  for (let i = 0; i < list.length; i += 1) {
    let f = list[i];
    if (isRef(f) && resolveFn) f = resolveFn(f);
    const name = nameOf(f);
    let parm = parmList[i];
    if (isRef(parm) && resolveFn) parm = resolveFn(parm);
    try {
      if (name === 'FlateDecode' || name === 'Fl') {
        data = zlib.inflateSync(data);
        // predictors
        const predictor = isDict(parm) ? num(parm.get('Predictor'), resolveFn) : 1;
        if (predictor && predictor > 1) {
          data = applyPredictor(data, parm, resolveFn);
        }
      } else if (name === 'ASCIIHexDecode' || name === 'AHx') {
        data = asciiHexDecode(data);
      } else if (name === 'ASCII85Decode' || name === 'A85') {
        data = ascii85Decode(data);
      } else if (name === 'LZWDecode' || name === 'LZW') {
        data = lzwDecode(data);
        const predictor = isDict(parm) ? num(parm.get('Predictor'), resolveFn) : 1;
        if (predictor && predictor > 1) data = applyPredictor(data, parm, resolveFn);
      } else if (name === 'RunLengthDecode' || name === 'RL') {
        data = runLengthDecode(data);
      } else if (name === 'DCTDecode' || name === 'JPXDecode' || name === 'CCITTFaxDecode' || name === 'JBIG2Decode') {
        // image codecs: leave untouched, only the page editor copies these
        return data;
      } else if (!name) {
        break;
      } else {
        throw new PdfError(`不支持的流过滤器 /${name}`, 'UNSUPPORTED_FILTER');
      }
    } catch (err) {
      if (err instanceof PdfError) throw err;
      throw new PdfError(`流解码失败 (/${name}): ${err.message}`, 'DECODE_FAILED');
    }
  }
  return data;
}

function num(v, resolveFn) {
  if (typeof v === 'number') return v;
  if (isRef(v) && resolveFn) {
    const r = resolveFn(v);
    return typeof r === 'number' ? r : 0;
  }
  return 0;
}

function applyPredictor(data, parm, resolveFn) {
  const pred = num(parm.get('Predictor'), resolveFn) || 1;
  const colors = num(parm.get('Colors'), resolveFn) || 1;
  const bpc = num(parm.get('BitsPerComponent'), resolveFn) || 8;
  const columns = num(parm.get('Columns'), resolveFn) || 1;
  const bpp = Math.ceil((colors * bpc) / 8);
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (pred === 2) {
    // TIFF predictor
    const rows = Math.floor(data.length / rowLen);
    for (let r = 0; r < rows; r += 1) {
      const off = r * rowLen;
      for (let i = bpp; i < rowLen; i += 1) {
        data[off + i] = (data[off + i] + data[off + i - bpp]) & 0xff;
      }
    }
    return data;
  }
  // PNG predictors
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = Buffer.alloc(rows * rowLen);
  let prev = Buffer.alloc(rowLen);
  for (let r = 0; r < rows; r += 1) {
    const ft = data[r * (rowLen + 1)];
    const src = data.subarray(r * (rowLen + 1) + 1, r * (rowLen + 1) + 1 + rowLen);
    const cur = Buffer.from(src);
    for (let i = 0; i < rowLen; i += 1) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = cur[i];
      switch (ft) {
        case 0:
          break;
        case 1:
          v = v + a;
          break;
        case 2:
          v = v + b;
          break;
        case 3:
          v = v + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          break;
      }
      cur[i] = v & 0xff;
    }
    cur.copy(out, r * rowLen);
    prev = cur;
  }
  return out;
}

function asciiHexDecode(data) {
  const s = data.toString('latin1');
  const clean = s.split('>')[0].replace(/[^0-9a-fA-F]/g, '');
  const padded = clean.length % 2 ? `${clean}0` : clean;
  return Buffer.from(padded, 'hex');
}

function ascii85Decode(data) {
  const s = data.toString('latin1').replace(/\s/g, '');
  const out = [];
  let tuple = 0;
  let count = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '~') break;
    if (ch === 'z' && count === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const code = ch.charCodeAt(0) - 33;
    if (code < 0 || code > 84) continue;
    tuple = tuple * 85 + code;
    count += 1;
    if (count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0;
      count = 0;
    }
  }
  if (count > 0) {
    for (let i = count; i < 5; i += 1) tuple = tuple * 85 + 84;
    const bytes = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
    out.push(...bytes.slice(0, count - 1));
  }
  return Buffer.from(out);
}

function lzwDecode(data) {
  // EarlyChange = 1 (PDF default)
  const out = [];
  let dict = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < 256; i += 1) dict.push(Buffer.from([i]));
    dict.push(Buffer.alloc(0), Buffer.alloc(0));
  };
  reset();
  let bitPos = 0;
  let codeLen = 9;
  let prev = null;
  const total = data.length * 8;
  const readCode = () => {
    let code = 0;
    for (let i = 0; i < codeLen; i += 1) {
      const byte = data[(bitPos >> 3) + 0] || 0;
      const bit = (byte >> (7 - (bitPos & 7))) & 1;
      code = (code << 1) | bit;
      bitPos += 1;
    }
    return code;
  };
  while (bitPos + codeLen <= total) {
    const code = readCode();
    if (code === 256) {
      reset();
      codeLen = 9;
      prev = null;
      continue;
    }
    if (code === 257) break;
    let entry;
    if (code < dict.length) {
      entry = dict[code];
    } else if (prev) {
      entry = Buffer.concat([prev, prev.subarray(0, 1)]);
    } else {
      break;
    }
    out.push(entry);
    if (prev) {
      dict.push(Buffer.concat([prev, entry.subarray(0, 1)]));
      if (dict.length + 1 >= 1 << codeLen && codeLen < 12) codeLen += 1;
    }
    prev = entry;
  }
  return Buffer.concat(out);
}

function runLengthDecode(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const l = data[i];
    i += 1;
    if (l === 128) break;
    if (l < 128) {
      out.push(data.subarray(i, i + l + 1));
      i += l + 1;
    } else {
      const b = data[i];
      i += 1;
      out.push(Buffer.alloc(257 - l, b));
    }
  }
  return Buffer.concat(out);
}

/* ------------------------------------------------------------------ doc */
class PdfDocument {
  /**
   * @param {Buffer} buf
   * @param {string} [filePath]
   */
  constructor(buf, filePath = '') {
    this.buf = buf;
    this.path = filePath;
    this.objects = new Map(); // num -> {num, gen, value, stream} | {__objstm:true}
    this.offsets = new Map();
    this.trailer = new Map();
    this.xrefStreams = [];
    this.pageList = null;
    this._objStmCache = new Map();
    this._lenCache = new Map();
    this.headerVersion = '1.4';
    this.encrypted = false;
    this._parse();
  }

  /* ------------------------------------------------------------ parsing */
  _parse() {
    const header = this.buf.subarray(0, 1024).toString('latin1');
    const m = /%PDF-(\d\.\d)/.exec(header);
    if (!m) throw new PdfError('不是有效的 PDF 文件（缺少 %PDF 头）', 'NOT_PDF');
    this.headerVersion = m[1];

    this.scanIndex = this._scanObjectIndex();

    const sx = this._findStartXref();
    if (sx !== null) {
      try {
        this._readXrefChain(sx);
      } catch (err) {
        // fall through to the scan index
        this.xrefError = err.message;
      }
    }

    if (!this.trailer.size) {
      this._recoverTrailer();
    }
    if (!this.trailer.size) {
      throw new PdfError(
        `无法恢复 PDF 交叉引用表（扫描到 ${this.scanIndex.size} 个对象，解析到 ${this.offsets.size} 条 xref，错误：${this.xrefError || '无'}）`,
        'XREF_BROKEN',
      );
    }
    if (this.trailer.get('Encrypt')) this.encrypted = true;

    // make sure the catalog is reachable
    const root = this.resolve(this.trailer.get('Root'));
    if (!isDict(root)) {
      throw new PdfError(
        `无法定位 PDF 目录对象 (/Root)：trailer 键 [${[...this.trailer.keys()].join(',')}]`,
        'NO_ROOT',
      );
    }
  }

  _findStartXref() {
    const tailStart = Math.max(0, this.buf.length - 4096 - 64);
    const tail = this.buf.subarray(tailStart).toString('latin1');
    const idx = tail.lastIndexOf('startxref');
    if (idx < 0) return null;
    const after = tail.slice(idx + 9);
    const mm = /^\s*(\d+)/.exec(after);
    if (!mm) return null;
    const off = Number(mm[1]);
    if (off < 0 || off >= this.buf.length) return null;
    return off;
  }

  /** Raw scan: every `N G obj` in the file, used for /Length and recovery. */
  _scanObjectIndex() {
    const index = new Map();
    const buf = this.buf;
    const needle = Buffer.from('obj');
    let from = 0;
    for (;;) {
      const at = buf.indexOf(needle, from);
      if (at < 0) break;
      from = at + 3;
      // must be followed by delimiter or whitespace
      const after = buf[at + 3];
      if (after !== undefined && !(after === 0x0d || after === 0x0a || after === 0x20 || after === 0x09 || after === 0x3c)) {
        continue;
      }
      // walk back over "gen ws num ws"
      let i = at - 1;
      while (i >= 0 && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0d || buf[i] === 0x0a)) i -= 1;
      const genEnd = i + 1;
      while (i >= 0 && buf[i] >= 0x30 && buf[i] <= 0x39) i -= 1;
      const genStart = i + 1;
      if (genStart === genEnd) continue;
      while (i >= 0 && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0d || buf[i] === 0x0a)) i -= 1;
      const numEnd = i + 1;
      while (i >= 0 && buf[i] >= 0x30 && buf[i] <= 0x39) i -= 1;
      const numStart = i + 1;
      if (numStart === numEnd) continue;
      if (numStart > 0) {
        const prev = buf[numStart - 1];
        // must not be part of a longer token
        if (prev >= 0x30 && prev <= 0x39) continue;
      }
      const num = Number(buf.subarray(numStart, numEnd).toString('latin1'));
      const gen = Number(buf.subarray(genStart, genEnd).toString('latin1'));
      if (!Number.isFinite(num) || num <= 0 || num > MAX_OBJ) continue;
      const existing = index.get(num);
      // later definitions win (incremental updates)
      if (!existing || existing.offset <= numStart) {
        index.set(num, { offset: numStart, gen });
      }
    }
    return index;
  }

  _readXrefChain(startOffset) {
    let offset = startOffset;
    const seen = new Set();
    let guard = 0;
    while (offset !== null && offset !== undefined && guard < 64) {
      guard += 1;
      if (seen.has(offset)) break;
      seen.add(offset);
      const next = this._readXrefSection(offset);
      offset = next;
    }
  }

  _readXrefSection(offset) {
    const buf = this.buf;
    if (offset < 0 || offset >= buf.length) return null;
    // skip leading whitespace, then decide between a table and a stream
    let p = offset;
    while (p < buf.length && (buf[p] === 0x20 || buf[p] === 0x09 || buf[p] === 0x0d || buf[p] === 0x0a)) p += 1;
    if (buf.subarray(p, p + 4).toString('latin1') === 'xref') {
      return this._readClassicXref(p);
    }
    // xref stream
    const obj = this._parseIndirectAt(p);
    if (!obj || !isDict(obj.value)) return null;
    const type = nameOf(obj.value.get('Type'));
    if (type !== 'XRef') return null;
    this.xrefStreams.push(obj.num);
    const data = decodeStream(obj.stream, obj.value, (r) => this.resolve(r, { allowScan: true }));
    const index = this._parseXrefStreamData(obj.value, data);
    Object.assign(this.offsets, {});
    for (const [num, entry] of index) {
      this.offsets.set(num, entry);
      if (entry.type === 1) {
        this.objects.set(num, null);
      }
    }
    const xrefStm = obj.value.get('XRefStm');
    if (typeof xrefStm === 'number') {
      try {
        this._readClassicXref(xrefStm);
      } catch {
        /* ignore hybrid failures */
      }
    }
    // merge trailer entries
    for (const [k, v] of obj.value) {
      if (k === 'Length' || k === 'Filter' || k === 'Type' || k === 'W' || k === 'Index' || k === 'Prev' || k === 'DecodeParms') continue;
      if (!this.trailer.has(k)) this.trailer.set(k, v);
    }
    const prev = obj.value.get('Prev');
    return typeof prev === 'number' ? prev : null;
  }

  _readClassicXref(offset) {
    const buf = this.buf;
    let pos = offset + 4; // skip 'xref'
    const skipWs = () => {
      while (pos < buf.length && (buf[pos] === 0x20 || buf[pos] === 0x09 || buf[pos] === 0x0d || buf[pos] === 0x0a)) {
        pos += 1;
      }
    };
    for (;;) {
      skipWs();
      if (buf.subarray(pos, pos + 7).toString('latin1') === 'trailer') break;
      const lineEnd = buf.indexOf(0x0a, pos);
      if (lineEnd < 0) break;
      const header = buf.subarray(pos, lineEnd).toString('latin1').trim();
      const hm = /^(\d+)\s+(\d+)$/.exec(header);
      if (!hm) break;
      const start = Number(hm[1]);
      const count = Number(hm[2]);
      pos = lineEnd + 1;
      for (let i = 0; i < count; i += 1) {
        const entryEnd = buf.indexOf(0x0a, pos);
        const stop = entryEnd < 0 ? buf.length : entryEnd;
        const line = buf.subarray(pos, stop).toString('latin1');
        const em = /^(\d{1,10})\s+(\d{1,5})\s+([nf])/.exec(line);
        if (em) {
          const num = start + i;
          const type = em[3] === 'n' ? 1 : 0;
          const off = Number(em[1]);
          const gen = Number(em[2]);
          if (!this.offsets.has(num)) this.offsets.set(num, { type, offset: off, gen });
          if (type === 1 && !this.objects.has(num)) this.objects.set(num, null);
        }
        pos = entryEnd < 0 ? buf.length : entryEnd + 1;
      }
    }
    // trailer dictionary
    const tail = this.buf.subarray(pos).toString('latin1');
    if (tail.startsWith('trailer')) {
      const parser = new Parser(this.buf, { pos: pos + 'trailer'.length });
      const dict = parser.parseDict();
      if (isDict(dict)) {
        for (const [k, v] of dict.__dict) {
          if (!this.trailer.has(k)) this.trailer.set(k, v);
        }
        const prev = dict.__dict.get('Prev');
        if (typeof prev === 'number') return prev;
      }
    }
    return null;
  }

  _parseXrefStreamData(dict, data) {
    const w = isArray(dict.get('W')) ? dict.get('W').__array.map((x) => Number(x) || 0) : [1, 2, 1];
    const size = Number(dict.get('Size')) || 0;
    let index = isArray(dict.get('Index')) ? dict.get('Index').__array.map((x) => Number(x) || 0) : [0, size];
    if (!index.length) index = [0, size];
    const entryLen = w[0] + w[1] + w[2];
    const out = new Map();
    if (!entryLen) return out;
    let p = 0;
    for (let s = 0; s + 1 < index.length; s += 2) {
      const start = index[s];
      const count = index[s + 1];
      for (let i = 0; i < count; i += 1) {
        if (p + entryLen > data.length) return out;
        let type = w[0] === 0 ? 1 : 0;
        for (let k = 0; k < w[0]; k += 1) type = type * 256 + data[p + k];
        let f2 = 0;
        for (let k = 0; k < w[1]; k += 1) f2 = f2 * 256 + data[p + w[0] + k];
        let f3 = 0;
        for (let k = 0; k < w[2]; k += 1) f3 = f3 * 256 + data[p + w[0] + w[1] + k];
        p += entryLen;
        const num = start + i;
        if (type === 1) out.set(num, { type: 1, offset: f2, gen: f3 });
        else if (type === 2) out.set(num, { type: 2, objStm: f2, index: f3 });
        // type 0 = free
      }
    }
    return out;
  }

  _recoverTrailer() {
    // no usable xref: find every catalog-looking object
    for (const [num] of this.scanIndex) {
      try {
        const obj = this.getObject(num);
        if (isDict(obj) && nameOf(obj.get('Type')) === 'Catalog') {
          this.trailer.set('Root', R(num, this.scanIndex.get(num).gen || 0));
          break;
        }
      } catch {
        /* keep looking */
      }
    }
    if (!this.trailer.size) throw new PdfError('无法恢复 PDF 交叉引用表', 'XREF_BROKEN');
  }

  _parseIndirectAt(offset) {
    if (offset == null || offset < 0 || offset >= this.buf.length) return null;
    const parser = new Parser(this.buf, { pos: offset });
    parser.resolveLength = (ref) => this._quickLength(ref.num);
    return parser.parseIndirectObject();
  }

  _quickLength(num) {
    if (this._lenCache.has(num)) return this._lenCache.get(num);
    const at = this.scanIndex.get(num);
    let value = null;
    if (at) {
      const parser = new Parser(this.buf, { pos: at.offset });
      const obj = parser.parseIndirectObject();
      value = typeof (obj && obj.value) === 'number' ? obj.value : null;
    }
    this._lenCache.set(num, value);
    return value;
  }

  /* ------------------------------------------------------------- access */
  getObject(num, gen = 0) {
    if (!Number.isFinite(num) || num <= 0 || num > MAX_OBJ) return null;
    const cached = this.objects.get(num);
    if (cached !== undefined && cached !== null) return cached.value;

    // classic / xref-stream entry
    const entry = this.offsets.get(num);
    if (entry && entry.type === 1) {
      const obj = this._parseIndirectAt(entry.offset);
      if (obj && obj.num === num) {
        this.objects.set(num, obj);
        return obj.value;
      }
    }
    if (entry && entry.type === 2) {
      const obj = this._fromObjectStream(entry.objStm, entry.index, num);
      if (obj) return obj.value;
    }
    // fall back to the raw scan
    const at = this.scanIndex.get(num);
    if (at) {
      const obj = this._parseIndirectAt(at.offset);
      if (obj && obj.num === num) {
        this.objects.set(num, obj);
        return obj.value;
      }
    }
    return null;
  }

  getObjectEntry(num) {
    const cached = this.objects.get(num);
    if (cached) return cached;
    this.getObject(num);
    return this.objects.get(num) || null;
  }

  resolve(value, opts = {}) {
    let guard = 0;
    let v = value;
    while (isRef(v) && guard < 64) {
      v = this.getObject(v.num, v.gen);
      guard += 1;
    }
    return v;
  }

  /** Stream bytes of object `num` (decoded). */
  getStreamData(num) {
    const entry = this.getObjectEntry(num);
    if (!entry || !entry.stream) return null;
    const dict = isDict(entry.value) ? entry.value : null;
    return decodeStream(entry.stream, dict, (r) => this.resolve(r));
  }

  /** Raw (still encoded) stream bytes plus its dictionary. */
  getRawStream(num) {
    const entry = this.getObjectEntry(num);
    if (!entry) return null;
    return { data: entry.stream || Buffer.alloc(0), dict: isDict(entry.value) ? entry.value : null };
  }

  _fromObjectStream(stmNum, index, wantNum) {
    const cacheKey = stmNum;
    if (!this._objStmCache.has(cacheKey)) {
      const data = this.getStreamData(stmNum);
      if (!data) {
        this._objStmCache.set(cacheKey, null);
        return null;
      }
      const entry = this.getObjectEntry(stmNum);
      const dict = entry && isDict(entry.value) ? entry.value : null;
      const count = dict ? Number(this.resolve(dict.get('N'))) || 0 : 0;
      const first = dict ? Number(this.resolve(dict.get('First'))) || 0 : 0;
      const headerText = data.subarray(0, first).toString('latin1');
      const nums = headerText.trim().split(/\s+/).map(Number).filter((x) => Number.isFinite(x));
      const pairs = [];
      for (let i = 0; i + 1 < nums.length; i += 2) pairs.push([nums[i], nums[i + 1]]);
      this._objStmCache.set(cacheKey, { data, pairs, first, count });
    }
    const cache = this._objStmCache.get(cacheKey);
    if (!cache) return null;
    let pair = null;
    if (Number.isFinite(index) && cache.pairs[index] && cache.pairs[index][0] === wantNum) {
      pair = cache.pairs[index];
    } else {
      pair = cache.pairs.find((p) => p[0] === wantNum) || null;
    }
    if (!pair) return null;
    const start = cache.first + pair[1];
    const parser = new Parser(cache.data, { pos: start });
    parser.setEnd(cache.data.length);
    const value = parser.parseObject();
    const stored = { num: wantNum, gen: 0, value, stream: null, objStm: stmNum };
    this.objects.set(wantNum, stored);
    return stored;
  }

  /* --------------------------------------------------------------- pages */
  get catalog() {
    return this.resolve(this.trailer.get('Root'));
  }

  getPages() {
    if (this.pageList) return this.pageList;
    const out = [];
    const catalog = this.catalog;
    const rootRef = this.trailer.get('Root');
    const rootNum = isRef(rootRef) ? rootRef.num : 0;
    const pagesRef = catalog && isDict(catalog) ? catalog.get('Pages') : null;
    const visit = (ref, inherited, depth, seen) => {
      if (depth > 64) return;
      const num = isRef(ref) ? ref.num : null;
      const dict = this.resolve(ref);
      if (!isDict(dict)) return;
      const key = num === null ? null : `${num}`;
      if (key && seen.has(key)) return;
      if (key) seen.add(key);

      const mediaBox = dict.has('MediaBox') ? dict.get('MediaBox') : inherited.mediaBox;
      const cropBox = dict.has('CropBox') ? dict.get('CropBox') : inherited.cropBox;
      const rotate = dict.has('Rotate') ? dict.get('Rotate') : inherited.rotate;
      const resources = dict.has('Resources') ? dict.get('Resources') : inherited.resources;
      const next = { mediaBox, cropBox, rotate, resources };

      const type = nameOf(dict.get('Type'));
      const kids = dict.get('Kids');
      // A node is a page unless it is explicitly a /Pages node or obviously a
      // branch. Plenty of real files omit /Type on page objects, so the
      // presence of /Kids — not the absence of /Type /Page — decides.
      const isBranch = type === 'Pages' || (isArray(kids) && type !== 'Page');
      if (isBranch) {
        if (isArray(kids)) {
          for (const kid of kids.__array) visit(kid, next, depth + 1, seen);
        }
        return;
      }
      out.push({
        ref: isRef(ref) ? ref : R(num || 0),
        num: num || 0,
        dict,
        inherit: next,
        mediaBox: this.resolve(mediaBox) || null,
        rotate: (Number(this.resolve(rotate)) || 0) % 360,
        index: out.length,
      });
    };
    visit(pagesRef, {}, 0, new Set());
    this.pageList = out;
    this.catalogNum = rootNum;
    return out;
  }

  get pageCount() {
    return this.getPages().length;
  }

  /** Page labels (1-based array of strings), falling back to decimal numbers. */
  getPageLabels() {
    const pages = this.getPages();
    const labels = pages.map((_, i) => String(i + 1));
    try {
      const tree = this._findNameTree('PageLabels');
      if (!tree) return labels;
      const nums = [];
      const vals = [];
      const walk = (nodeRef, depth) => {
        if (depth > 32) return;
        const node = this.resolve(nodeRef);
        if (!isDict(node)) return;
        const kids = node.get('Kids');
        if (isArray(kids)) {
          for (const k of kids.__array) walk(k, depth + 1);
          return;
        }
        const ns = node.get('Nums');
        if (isArray(ns)) {
          const arr = ns.__array;
          for (let i = 0; i + 1 < arr.length; i += 2) {
            nums.push(Number(this.resolve(arr[i])));
            vals.push(this.resolve(arr[i + 1]));
          }
        }
      };
      walk(tree, 0);
      const order = nums.map((n, i) => [n, vals[i]]).sort((a, b) => a[0] - b[0]);
      for (let k = 0; k < order.length; k += 1) {
        const [start, style] = order[k];
        if (!isDict(style) || !Number.isFinite(start)) continue;
        const prefix = isStr(style.get('P')) ? style.get('P').__str.toString('latin1') : '';
        const st = nameOf(style.get('S')) || '';
        const first = Number(this.resolve(style.get('St'))) || 1;
        const end = k + 1 < order.length ? order[k + 1][0] : pages.length;
        for (let i = start; i < Math.min(end, pages.length); i += 1) {
          const n = first + (i - start);
          labels[i] = prefix + formatLabel(st, n);
        }
      }
    } catch {
      /* labels are cosmetic */
    }
    return labels;
  }

  _findNameTree(which) {
    const catalog = this.catalog;
    if (!isDict(catalog)) return null;
    const names = this.resolve(catalog.get('Names'));
    if (!isDict(names)) return null;
    return names.get(which) || null;
  }
}

function formatLabel(style, n) {
  switch (style) {
    case 'D':
      return String(n);
    case 'R':
      return toRoman(n);
    case 'r':
      return toRoman(n).toLowerCase();
    case 'A':
      return toAlpha(n);
    case 'a':
      return toAlpha(n).toLowerCase();
    default:
      return String(n);
  }
}

function toRoman(n) {
  const table = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '';
  let v = n;
  for (const [val, sym] of table) {
    while (v >= val) {
      out += sym;
      v -= val;
    }
  }
  return out;
}

function toAlpha(n) {
  let out = '';
  let v = n;
  while (v > 0) {
    const rem = (v - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    v = Math.floor((v - 1) / 26);
  }
  return out;
}

module.exports = { PdfDocument, PdfError, decodeStream, applyPredictor };
