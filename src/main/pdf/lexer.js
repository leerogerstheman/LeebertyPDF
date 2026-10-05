'use strict';
/**
 * LeebertyPDF — minimal but complete PDF syntax layer.
 *
 * Tokeniser, object parser and serialiser for the parts of ISO 32000 the page
 * editor needs: numbers, names, strings, arrays, dictionaries, references,
 * streams, object streams and cross-reference streams.
 *
 * Design notes
 * ------------
 *  - Object *graph* surgery only. Content streams are copied byte for byte and
 *    never scanned, so a stream can never be mistaken for document structure.
 *  - Every stream keeps its /Length; stream bytes are delimited by that length
 *    whenever the raw data is available, and by the `endstream` keyword only as
 *    a fallback for the freshly created objects we produce ourselves.
 */

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const REGULAR_END = (b) => WHITESPACE.has(b) || DELIMITERS.has(b);

const isWhite = (b) => WHITESPACE.has(b);
const isDelim = (b) => DELIMITERS.has(b);
const isRegular = (b) => !isWhite(b) && !isDelim(b);

/* ------------------------------------------------------------------ names */
/** Decode a PDF name token (the bytes after '/') into a JS string. */
function decodeName(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (b === 0x23 && i + 2 < bytes.length) {
      const hex = String.fromCharCode(bytes[i + 1], bytes[i + 2]);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out += String.fromCharCode(b);
  }
  return out;
}

/** Encode a JS string as a PDF name body (without the leading slash). */
function encodeName(name) {
  let out = '';
  for (const ch of String(name)) {
    const code = ch.codePointAt(0);
    if (code > 0xff) {
      // names are byte strings; encode as UTF-8 bytes, escaped
      const utf8 = Buffer.from(ch, 'utf8');
      for (const b of utf8) out += `#${b.toString(16).padStart(2, '0').toUpperCase()}`;
      continue;
    }
    if (code < 0x21 || code > 0x7e || isDelim(code)) {
      out += `#${code.toString(16).padStart(2, '0').toUpperCase()}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/* ---------------------------------------------------------------- strings */
function decodeLiteralString(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (b !== 0x5c) {
      out.push(b);
      continue;
    }
    i += 1;
    if (i >= bytes.length) break;
    const e = bytes[i];
    switch (e) {
      case 0x6e:
        out.push(0x0a);
        break;
      case 0x72:
        out.push(0x0d);
        break;
      case 0x74:
        out.push(0x09);
        break;
      case 0x62:
        out.push(0x08);
        break;
      case 0x66:
        out.push(0x0c);
        break;
      case 0x28:
      case 0x29:
      case 0x5c:
        out.push(e);
        break;
      case 0x0d:
        if (bytes[i + 1] === 0x0a) i += 1;
        break;
      case 0x0a:
        break;
      default:
        if (e >= 0x30 && e <= 0x37) {
          let oct = String.fromCharCode(e);
          for (let k = 0; k < 2 && bytes[i + 1] >= 0x30 && bytes[i + 1] <= 0x37; k += 1) {
            i += 1;
            oct += String.fromCharCode(bytes[i]);
          }
          out.push(parseInt(oct, 8) & 0xff);
        } else {
          out.push(e);
        }
        break;
    }
  }
  return Buffer.from(out);
}

function decodeHexString(bytes) {
  let hex = '';
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    if (/[0-9a-fA-F]/.test(ch)) hex += ch;
  }
  if (hex.length % 2) hex += '0';
  return Buffer.from(hex, 'hex');
}

function encodeLiteralString(buf) {
  let out = '(';
  for (const b of buf) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += `\\${String.fromCharCode(b)}`;
    else if (b === 0x0a) out += '\\n';
    else if (b === 0x0d) out += '\\r';
    else if (b < 0x20 || b > 0x7e) out += `\\${b.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(b);
  }
  return `${out})`;
}

/* ----------------------------------------------------------------- lexer */
const enumTok = {
  NUMBER: 1,
  NAME: 2,
  STRING: 3,
  ARRAY_OPEN: 4,
  ARRAY_CLOSE: 5,
  DICT_OPEN: 6,
  DICT_CLOSE: 7,
  KEYWORD: 8,
  COMMENT: 9,
  EOF: 10,
};

/**
 * A PDF dictionary: an insertion-ordered key/value map with the small slice of
 * the Map interface the rest of the engine uses. Keeping this as a class (rather
 * than a bare Map) makes the AST self-describing and lets serialisation preserve
 * key order, which matters for reproducible output.
 */
class Dict {
  constructor(entries) {
    this.__dict = entries instanceof Map ? entries : new Map(entries || []);
  }
  get size() {
    return this.__dict.size;
  }
  get(key) {
    return this.__dict.get(key);
  }
  set(key, value) {
    this.__dict.set(key, value);
    return this;
  }
  has(key) {
    return this.__dict.has(key);
  }
  delete(key) {
    return this.__dict.delete(key);
  }
  keys() {
    return this.__dict.keys();
  }
  values() {
    return this.__dict.values();
  }
  entries() {
    return this.__dict.entries();
  }
  forEach(fn, thisArg) {
    return this.__dict.forEach(fn, thisArg);
  }
  [Symbol.iterator]() {
    return this.__dict[Symbol.iterator]();
  }
}

class Lexer {
  constructor(buf, pos = 0) {
    this.buf = buf;
    this.pos = pos;
    this.len = buf.length;
  }

  skipWs() {
    while (this.pos < this.len) {
      const b = this.buf[this.pos];
      if (isWhite(b)) {
        this.pos += 1;
      } else if (b === 0x25) {
        // comment: runs to EOL
        while (this.pos < this.len && this.buf[this.pos] !== 0x0a && this.buf[this.pos] !== 0x0d) this.pos += 1;
      } else {
        break;
      }
    }
  }

  /** Look at the raw byte without consuming. */
  peek() {
    return this.pos < this.len ? this.buf[this.pos] : -1;
  }

  /** Skip a run of regular characters and return them. */
  readRegular() {
    const start = this.pos;
    while (this.pos < this.len && isRegular(this.buf[this.pos])) this.pos += 1;
    return this.buf.subarray(start, this.pos);
  }
}

/* -------------------------------------------------------------- parser */
class Parser {
  constructor(buf, opts = {}) {
    this.buf = buf;
    this.lex = new Lexer(buf, opts.pos || 0);
    this.end = buf.length;
    this.objStmDepth = 0;
  }

  setEnd(end) {
    this.end = Math.min(end, this.buf.length);
  }

  skipWs() {
    this.lex.skipWs();
  }

  atEnd() {
    return this.lex.pos >= this.end;
  }

  /** Parse one object. Returns a JS value; Refs are `{__ref:true, num, gen}`. */
  parseObject() {
    this.skipWs();
    if (this.atEnd()) return null;
    const b = this.lex.peek();
    if (b === 0x2f) return this.parseName();
    if (b === 0x5b) return this.parseArray();
    if (b === 0x3c) {
      if (this.lex.buf[this.lex.pos + 1] === 0x3c) return this.parseDict();
      return this.parseHexString();
    }
    if (b === 0x28) return this.parseLiteralString();
    if (b === 0x5d) return null;

    const save = this.lex.pos;
    const tok = this.lex.readRegular();
    if (!tok.length) {
      this.lex.pos += 1;
      return this.parseObject();
    }
    const s = tok.toString('latin1');
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null') return null;

    if (/^[+-]?[\d.]+$/.test(s)) {
      // may be `num gen R`
      const after = this.lex.pos;
      this.skipWs();
      const save2 = this.lex.pos;
      const tok2 = this.lex.readRegular();
      const s2 = tok2.toString('latin1');
      if (/^\d+$/.test(s) && /^\d+$/.test(s2)) {
        this.skipWs();
        const save3 = this.lex.pos;
        const tok3 = this.lex.readRegular();
        if (tok3.toString('latin1') === 'R') {
          return { __ref: true, num: Number(s), gen: Number(s2) };
        }
        this.lex.pos = save3;
      }
      this.lex.pos = after;
      const n = Number(s);
      return Number.isFinite(n) ? n : 0;
    }
    return { __keyword: s };
  }

  parseName() {
    this.lex.pos += 1; // '/'
    const bytes = this.lex.readRegular();
    return { __name: decodeName(bytes) };
  }

  parseHexString() {
    this.lex.pos += 1; // '<'
    const start = this.lex.pos;
    while (this.lex.pos < this.end && this.buf[this.lex.pos] !== 0x3e) this.lex.pos += 1;
    const bytes = this.buf.subarray(start, this.lex.pos);
    this.lex.pos += 1;
    return { __str: decodeHexString(bytes) };
  }

  parseLiteralString() {
    this.lex.pos += 1; // '('
    const start = this.lex.pos;
    let depth = 1;
    let escaped = false;
    while (this.lex.pos < this.end) {
      const b = this.buf[this.lex.pos];
      if (escaped) {
        escaped = false;
      } else if (b === 0x5c) {
        escaped = true;
      } else if (b === 0x28) {
        depth += 1;
      } else if (b === 0x29) {
        depth -= 1;
        if (depth === 0) break;
      }
      this.lex.pos += 1;
    }
    const raw = this.buf.subarray(start, this.lex.pos);
    this.lex.pos += 1;
    return { __str: decodeLiteralString(raw) };
  }

  parseArray() {
    this.lex.pos += 1; // '['
    const out = [];
    for (;;) {
      this.skipWs();
      if (this.atEnd()) break;
      if (this.lex.peek() === 0x5d) {
        this.lex.pos += 1;
        break;
      }
      if (this.lex.peek() === 0x3e && this.lex.buf[this.lex.pos + 1] === 0x3e) break;
      const before = this.lex.pos;
      const v = this.parseObject();
      if (this.lex.pos === before) {
        this.lex.pos += 1;
        continue;
      }
      out.push(v);
    }
    return { __array: out };
  }

  parseDict() {
    // Be tolerant about where we start: callers hand us the position right
    // after a keyword, which may sit on whitespace before the '<<'.
    this.skipWs();
    if (this.lex.peek() === 0x3c && this.lex.buf[this.lex.pos + 1] === 0x3c) this.lex.pos += 2;
    const map = new Map();
    for (;;) {
      this.skipWs();
      if (this.atEnd()) break;
      if (this.lex.peek() === 0x3e) {
        this.lex.pos += 2;
        break;
      }
      if (this.lex.peek() !== 0x2f) {
        // malformed; try to skip forward
        const before = this.lex.pos;
        this.parseObject();
        if (this.lex.pos === before) this.lex.pos += 1;
        continue;
      }
      const key = this.parseName().__name;
      const value = this.parseObject();
      map.set(key, value);
    }
    return new Dict(map);
  }

  /**
   * Parse `N G obj … endobj` at the current position.
   * @returns {{num:number, gen:number, value:any, stream:Buffer|null}|null}
   */
  parseIndirectObject() {
    this.skipWs();
    const start = this.lex.pos;
    const tok = this.lex.readRegular();
    if (!/^\d+$/.test(tok.toString('latin1'))) {
      this.lex.pos = start;
      return null;
    }
    const num = Number(tok.toString('latin1'));
    this.skipWs();
    const genTok = this.lex.readRegular();
    if (!/^\d+$/.test(genTok.toString('latin1'))) {
      this.lex.pos = start;
      return null;
    }
    const gen = Number(genTok.toString('latin1'));
    this.skipWs();
    const kw = this.lex.readRegular();
    if (kw.toString('latin1') !== 'obj') {
      this.lex.pos = start;
      return null;
    }
    const value = this.parseObject();
    // stream?
    this.skipWs();
    const save = this.lex.pos;
    const maybe = this.lex.readRegular();
    const word = maybe.toString('latin1');
    let stream = null;
    if (word === 'stream') {
      // the keyword is followed by CRLF or LF
      if (this.buf[this.lex.pos] === 0x0d) this.lex.pos += 1;
      if (this.buf[this.lex.pos] === 0x0a) this.lex.pos += 1;
      const dataStart = this.lex.pos;
      let length = null;
      let lengthRef = null;
      if (value && value.__dict) {
        const declared = value.__dict.get('Length');
        if (typeof declared === 'number') length = declared;
        else if (declared && declared.__ref) {
          lengthRef = declared;
          length = this.resolveLength ? this.resolveLength(declared) : null;
        }
      }
      if (typeof length === 'number' && length >= 0 && dataStart + length <= this.buf.length) {
        stream = this.buf.subarray(dataStart, dataStart + length);
        this.lex.pos = dataStart + length;
        // consume the trailing endstream
        this.skipWs();
        const tail = this.lex.readRegular();
        if (tail.toString('latin1') !== 'endstream') {
          // trust /Length anyway; recover by scanning
          const idx = this.buf.indexOf(Buffer.from('endstream'), dataStart);
          if (idx >= 0) this.lex.pos = idx + 'endstream'.length;
        }
        // resolve the indirect /Length so later readers see a plain number
        if (lengthRef && value.__dict) value.__dict.set('Length', length);
      } else {
        const idx = this.buf.indexOf(Buffer.from('endstream'), dataStart);
        const stop = idx >= 0 ? idx : this.buf.length;
        let realEnd = stop;
        while (realEnd > dataStart && (this.buf[realEnd - 1] === 0x0a || this.buf[realEnd - 1] === 0x0d)) realEnd -= 1;
        stream = this.buf.subarray(dataStart, realEnd);
        this.lex.pos = idx >= 0 ? idx + 'endstream'.length : this.buf.length;
        if (value.__dict) value.__dict.set('Length', stream.length);
      }
    } else {
      this.lex.pos = save;
    }
    return { num, gen, value, stream };
  }
}

/* ----------------------------------------------------------- serializer */
function serializeObject(value, out, refToString) {
  if (value === null || value === undefined) {
    out.push('null');
    return;
  }
  if (typeof value === 'number') {
    out.push(formatNumber(value));
    return;
  }
  if (typeof value === 'boolean') {
    out.push(value ? 'true' : 'false');
    return;
  }
  if (typeof value === 'string') {
    out.push(encodeLiteralString(Buffer.from(value, 'latin1')));
    return;
  }
  if (value.__ref) {
    out.push(refToString(value));
    return;
  }
  if (value.__name !== undefined) {
    out.push(`/${encodeName(value.__name)}`);
    return;
  }
  if (value.__str) {
    // hex form keeps binary strings unambiguous and compact
    out.push(`<${value.__str.toString('hex').toUpperCase()}>`);
    return;
  }
  if (value.__array) {
    out.push('[');
    value.__array.forEach((v, i) => {
      if (i) out.push(' ');
      serializeObject(v, out, refToString);
    });
    out.push(']');
    return;
  }
  if (value.__dict) {
    out.push('<<');
    for (const [k, v] of value.__dict) {
      out.push(`/${encodeName(k)} `);
      serializeObject(v, out, refToString);
      out.push(' ');
    }
    out.push('>>');
    return;
  }
  if (value.__keyword) {
    out.push(String(value.__keyword));
    return;
  }
  out.push('null');
}

function formatNumber(n) {
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/* --------------------------------------------------------------- helpers */
const N = (name) => ({ __name: name });
const S = (str) => ({ __str: Buffer.isBuffer(str) ? str : Buffer.from(String(str), 'latin1') });
const A = (arr) => ({ __array: arr });
const D = (entries) => new Dict(entries);
const R = (num, gen = 0) => ({ __ref: true, num, gen });
const isRef = (v) => !!(v && v.__ref);
const isDict = (v) => !!(v && v.__dict);
const isArray = (v) => !!(v && v.__array);
const isName = (v) => !!(v && v.__name !== undefined);
const isStr = (v) => !!(v && v.__str);
const nameOf = (v) => (isName(v) ? v.__name : null);

module.exports = {
  Dict,
  Lexer,
  Parser,
  decodeName,
  encodeName,
  decodeLiteralString,
  decodeHexString,
  encodeLiteralString,
  serializeObject,
  formatNumber,
  N,
  S,
  A,
  D,
  R,
  isRef,
  isDict,
  isArray,
  isName,
  isStr,
  nameOf,
  enumTok,
  isWhite,
  isDelim,
  isRegular,
  WHITESPACE,
  DELIMITERS,
};

