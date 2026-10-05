'use strict';
/**
 * Tiny persistent JSON store (one file per namespace) with debounced atomic writes.
 * No external dependencies.
 */
const fs = require('fs');
const path = require('path');

class Store {
  /**
   * @param {string} file  absolute path of the json file
   * @param {object} defaults
   */
  constructor(file, defaults = {}) {
    this.file = file;
    this.defaults = defaults;
    this.data = this._read();
    this._timer = null;
  }

  _read() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return { ...this.defaults, ...parsed };
      }
    } catch {
      /* missing / corrupt -> defaults */
    }
    return { ...this.defaults };
  }

  get(key, fallback) {
    if (key === undefined) return this.data;
    const v = this.data[key];
    return v === undefined ? fallback : v;
  }

  set(key, value) {
    this.data[key] = value;
    this._save();
  }

  patch(obj) {
    Object.assign(this.data, obj);
    this._save();
  }

  reset() {
    this.data = { ...this.defaults };
    this._save(true);
  }

  _save(now = false) {
    if (this._timer) clearTimeout(this._timer);
    const write = () => {
      this._timer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
        fs.renameSync(tmp, this.file);
      } catch (err) {
        console.error('[store] write failed', this.file, err);
      }
    };
    if (now) write();
    else this._timer = setTimeout(write, 250);
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[store] flush failed', err);
    }
  }
}

module.exports = { Store };
