/* =========================================================================
   LeebertyPDF — runtime shims.
   PDF.js 6.x targets very recent V8 builds and uses Map helpers that shipped
   after the Chromium bundled with some Electron releases. Filling the gaps
   here keeps the reader working on older runtimes without patching the
   vendored library.
   ========================================================================= */

/* Map.prototype.getOrInsert — TC39 "Map upsert" proposal. */
if (typeof Map.prototype.getOrInsert !== 'function') {
  Object.defineProperty(Map.prototype, 'getOrInsert', {
    value: function getOrInsert(key, value) {
      if (this.has(key)) return this.get(key);
      this.set(key, value);
      return value;
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

/* Map.prototype.getOrInsertComputed — same proposal, lazy value. */
if (typeof Map.prototype.getOrInsertComputed !== 'function') {
  Object.defineProperty(Map.prototype, 'getOrInsertComputed', {
    value: function getOrInsertComputed(key, callback) {
      if (this.has(key)) return this.get(key);
      if (typeof callback !== 'function') throw new TypeError('callback is not a function');
      const value = callback(key);
      this.set(key, value);
      return value;
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

/* WeakMap.prototype.getOrInsertComputed — same proposal. */
if (typeof WeakMap.prototype.getOrInsertComputed !== 'function') {
  Object.defineProperty(WeakMap.prototype, 'getOrInsertComputed', {
    value: function getOrInsertComputed(key, callback) {
      if (this.has(key)) return this.get(key);
      if (typeof callback !== 'function') throw new TypeError('callback is not a function');
      const value = callback(key);
      this.set(key, value);
      return value;
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

/* Uint8Array.prototype.toBase64 / fromBase64 — Stage 3 helpers used by newer
   PDF.js builds when exporting attachments and images. */
if (typeof Uint8Array.prototype.toBase64 !== 'function') {
  Object.defineProperty(Uint8Array.prototype, 'toBase64', {
    value: function toBase64(opts = {}) {
      const alphabet = opts.alphabet === 'base64url' ? 'base64url' : 'base64';
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < this.length; i += chunk) {
        binary += String.fromCharCode.apply(null, this.subarray(i, i + chunk));
      }
      const b64 = btoa(binary);
      if (alphabet === 'base64url') return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return b64;
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

if (typeof Uint8Array.fromBase64 !== 'function') {
  Object.defineProperty(Uint8Array, 'fromBase64', {
    value: function fromBase64(input, opts = {}) {
      let s = String(input).replace(/[\r\n\s]/g, '');
      if (opts.alphabet === 'base64url' || /[-_]/.test(s)) s = s.replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      const binary = atob(s);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
      return out;
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

/* Promise.withResolvers — used by the viewer's loading helpers. */
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

/* Promise.try — TC39 proposal, used by PDF.js 6.x. */
if (typeof Promise.try !== 'function') {
  Promise.try = function promiseTry(fn, ...args) {
    return new Promise((resolve) => resolve(fn(...args)));
  };
}

/* Math.sumPrecise — ES2025, used for PDF checksum computation. The naive
   summation is enough here: the result feeds a hash, not a money ledger. */
if (typeof Math.sumPrecise !== 'function') {
  Math.sumPrecise = function sumPrecise(values) {
    let sum = 0;
    for (const v of values) sum += Number(v);
    return sum;
  };
}

/* Object.groupBy / Map.groupBy — used by newer PDF.js data passes. */
if (typeof Object.groupBy !== 'function') {
  Object.groupBy = function groupBy(items, fn) {
    const out = Object.create(null);
    let i = 0;
    for (const item of items) {
      const key = fn(item, i += 1);
      (out[key] ||= []).push(item);
    }
    return out;
  };
}

if (typeof Map.groupBy !== 'function') {
  Map.groupBy = function groupBy(items, fn) {
    const out = new Map();
    let i = 0;
    for (const item of items) {
      const key = fn(item, i += 1);
      const bucket = out.get(key);
      if (bucket) bucket.push(item);
      else out.set(key, [item]);
    }
    return out;
  };
}

/* Uint8Array.prototype.toHex / setFromBase64 — Stage 3 helpers. */
if (typeof Uint8Array.prototype.toHex !== 'function') {
  Object.defineProperty(Uint8Array.prototype, 'toHex', {
    value: function toHex() {
      let out = '';
      for (let i = 0; i < this.length; i += 1) out += this[i].toString(16).padStart(2, '0');
      return out;
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

/* Array.prototype.at / String.prototype.at fallbacks (very old runtimes). */
if (typeof Array.prototype.at !== 'function') {
  // eslint-disable-next-line no-extend-native
  Array.prototype.at = function at(n) {
    const i = Math.trunc(n) || 0;
    return this[i < 0 ? this.length + i : i];
  };
}

export const SHIMS_APPLIED = true;
