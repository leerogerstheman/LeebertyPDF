'use strict';
/**
 * LeebertyPDF — preload bridge. The renderer only ever sees this frozen surface.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

function on(channel, cb) {
  const listener = (_e, payload) => {
    try {
      cb(payload);
    } catch (err) {
      console.error('[lumen] listener error', channel, err);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  info: () => invoke('app:info'),

  settings: {
    all: () => invoke('settings:all'),
    set: (k, v) => invoke('settings:set', k, v),
    patch: (o) => invoke('settings:patch', o),
    reset: () => invoke('settings:reset'),
  },

  session: {
    get: () => invoke('session:get'),
    set: (o) => invoke('session:set', o),
  },

  reading: {
    all: () => invoke('reading:all'),
    get: (k) => invoke('reading:get', k),
    set: (k, v) => invoke('reading:set', k, v),
  },

  bookmarks: {
    all: () => invoke('bookmarks:all'),
    get: (k) => invoke('bookmarks:get', k),
    set: (k, list) => invoke('bookmarks:set', k, list),
  },

  annotations: {
    get: (k) => invoke('annotations:get', k),
    set: (k, v) => invoke('annotations:set', k, v),
    clear: (k) => invoke('annotations:clear', k),
    all: () => invoke('annotations:all'),
  },

  recents: {
    list: () => invoke('recents:list'),
    touch: (item) => invoke('recents:touch', item),
    remove: (p) => invoke('recents:remove', p),
    pin: (p, v) => invoke('recents:pin', p, v),
    clear: () => invoke('recents:clear'),
  },

  library: {
    stats: () => invoke('library:stats'),
  },

  doc: {
    open: (p) => invoke('doc:open', p),
    release: (token) => invoke('doc:release', token),
    urlFor: (token) => invoke('doc:url-for', token),
  },

  dialog: {
    open: (o) => invoke('dialog:open', o || {}),
    openFolder: () => invoke('dialog:open-folder'),
    save: (o) => invoke('dialog:save', o || {}),
  },

  fs: {
    write: (p, data, enc) => invoke('fs:write', p, data, enc),
    read: (p) => invoke('fs:read', p),
    exists: (p) => invoke('fs:exists', p),
    listFolder: (p) => invoke('fs:list-folder', p),
    stat: (p) => invoke('fs:stat', p),
    defaultDir: () => invoke('fs:default-dir'),
  },

  /** Page-level editing: sessions live in the main process. */
  edit: {
    open: (payload) => invoke('edit:open', payload),
    apply: (payload) => invoke('edit:apply', payload),
    save: (payload) => invoke('edit:save', payload),
    split: (payload) => invoke('edit:split', payload),
    inspect: (payload) => invoke('edit:inspect', payload),
    close: (payload) => invoke('edit:close', payload),
  },

  shell: {
    openPath: (p) => invoke('shell:open-path', p),
    showItem: (p) => invoke('shell:show-item', p),
    openExternal: (u) => invoke('shell:open-external', u),
  },

  win: {
    setTitle: (t) => invoke('win:set-title', t),
    toggleFullscreen: () => invoke('win:toggle-fullscreen'),
    isFullscreen: () => invoke('win:is-fullscreen'),
    minimize: () => invoke('win:minimize'),
    maximizeToggle: () => invoke('win:maximize-toggle'),
    close: () => invoke('win:close'),
  },

  theme: {
    set: (s) => invoke('theme:set', s),
  },

  print: {
    document: (payload) => invoke('print:document', payload),
  },

  app: {
    reload: () => invoke('app:reload'),
    relaunch: () => invoke('app:relaunch'),
  },

  /** Resolve the absolute path of a dropped File object (Electron >= 32). */
  pathForFile: (file) => {
    try {
      if (file && typeof file.path === 'string' && file.path) return file.path;
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file);
      }
    } catch {
      /* ignore */
    }
    return null;
  },

  onMenu: (cb) => on('menu', cb),
  onOpenFiles: (cb) => on('open-files', cb),
  onToast: (cb) => on('toast', cb),
  onAppEvent: (cb) => on('app', cb),
  onLibraryChange: (cb) => on('library', cb),
};

contextBridge.exposeInMainWorld('lumen', Object.freeze(api));
