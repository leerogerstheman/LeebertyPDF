// LUMEN_VENDOR_SHIMS
// PDF.js 6.x is built against the newest V8 and uses several JavaScript
// features that are missing from the Chromium/Node shipped with some Electron
// releases. This block is injected into the vendored PDF.js bundles (main
// thread, viewer and worker all run in separate V8 contexts) so that Lumen
// works on older runtimes without patching PDF.js sources.
//
// Keep in sync with src/renderer/lib/polyfills.js.
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
if (typeof Map.prototype.getOrInsertComputed !== 'function') {
  Object.defineProperty(Map.prototype, 'getOrInsertComputed', {
    value: function getOrInsertComputed(key, callback) {
      if (this.has(key)) return this.get(key);
      var value = callback(key);
      this.set(key, value);
      return value;
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}
if (typeof WeakMap.prototype.getOrInsertComputed !== 'function') {
  Object.defineProperty(WeakMap.prototype, 'getOrInsertComputed', {
    value: function getOrInsertComputed(key, callback) {
      if (this.has(key)) return this.get(key);
      var value = callback(key);
      this.set(key, value);
      return value;
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    var resolve, reject;
    var promise = new Promise(function (res, rej) {
      resolve = res;
      reject = rej;
    });
    return { promise: promise, resolve: resolve, reject: reject };
  };
}
if (typeof Promise.try !== 'function') {
  Promise.try = function promiseTry(fn) {
    var args = [].slice.call(arguments, 1);
    return new Promise(function (resolve) {
      resolve(fn.apply(null, args));
    });
  };
}
if (typeof Math.sumPrecise !== 'function') {
  Math.sumPrecise = function sumPrecise(values) {
    var sum = 0;
    for (var i = 0; i < values.length; i += 1) sum += Number(values[i]);
    return sum;
  };
}
if (typeof Object.groupBy !== 'function') {
  Object.groupBy = function groupBy(items, fn) {
    var out = Object.create(null);
    for (var i = 0; i < items.length; i += 1) {
      var key = fn(items[i], i + 1);
      (out[key] || (out[key] = [])).push(items[i]);
    }
    return out;
  };
}
if (typeof Map.groupBy !== 'function') {
  Map.groupBy = function groupBy(items, fn) {
    var out = new Map();
    for (var i = 0; i < items.length; i += 1) {
      var key = fn(items[i], i + 1);
      var bucket = out.get(key);
      if (bucket) bucket.push(items[i]);
      else out.set(key, [items[i]]);
    }
    return out;
  };
}
if (typeof Uint8Array.prototype.toBase64 !== 'function') {
  Object.defineProperty(Uint8Array.prototype, 'toBase64', {
    value: function toBase64(options) {
      var binary = '';
      for (var i = 0; i < this.length; i += 1) binary += String.fromCharCode(this[i]);
      var out = btoa(binary);
      if (options && options.alphabet === 'base64url') {
        return out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      }
      return out;
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}
if (typeof Uint8Array.prototype.toHex !== 'function') {
  Object.defineProperty(Uint8Array.prototype, 'toHex', {
    value: function toHex() {
      var out = '';
      for (var i = 0; i < this.length; i += 1) out += this[i].toString(16).padStart(2, '0');
      return out;
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}
// LUMEN_VENDOR_SHIMS_END
