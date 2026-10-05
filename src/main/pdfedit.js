'use strict';
/**
 * LeebertyPDF — page editor sessions.
 *
 * The renderer never sees PDF structures: it sends compact page operations
 * (reorder / remove / rotate / insert / extract) and gets back a descriptor list
 * it can draw thumbnails from. The object graph surgery happens here, in the
 * main process, using the engine in ./pdf/.
 */
const fsp = require('fs/promises');
const path = require('path');
const { PageEditor, PdfError } = require('./pdf/editor');

/** @type {Map<string, {editor: PageEditor, sources: Map<string,{token:string,path:string,name:string,pageCount:number}>}>} */
const sessions = new Map();
let seq = 0;

function newId() {
  seq += 1;
  return `edit-${Date.now().toString(36)}-${seq.toString(36)}`;
}

function fail(err) {
  const message = err && err.message ? err.message : String(err);
  return { ok: false, error: message, code: (err && err.code) || 'EDIT_ERROR' };
}

/** Describes the working set for the UI. */
async function stateOf(record) {
  const { editor, sources } = record;
  await editor.settle();
  const pages = editor.pages.map((p, index) => ({
    index,
    label: p.label,
    rotate: p.rotate,
    width: Math.round(p.width * 100) / 100,
    height: Math.round(p.height * 100) / 100,
    landscape: p.width > p.height,
    srcId: p.src.id,
    srcPage: p.src.doc.getPages().findIndex((q) => q.num === p.num),
  }));
  return {
    ok: true,
    sessionId: record.id,
    count: pages.length,
    pages,
    sources: [...sources.entries()].map(([id, s]) => ({
      id,
      token: s.token,
      name: s.name,
      path: s.path,
      pageCount: s.pageCount,
    })),
  };
}

async function registerSource(record, filePath, pages, at) {
  const editor = record.editor;
  const buf = await fsp.readFile(filePath);
  const before = new Set(editor.sources.keys());
  const added = editor.addBuffer(buf, { pages, at, path: filePath });
  // the engine creates exactly one Source per addBuffer call
  let srcId = null;
  for (const id of editor.sources.keys()) {
    if (!before.has(id)) srcId = id;
  }
  const src = editor.sources.get(srcId);
  const token = newId();
  record.sources.set(srcId, {
    token,
    path: filePath,
    name: path.basename(filePath),
    pageCount: src.doc.pageCount,
  });
  return { srcId, added: added.length, token };
}

const handlers = {
  /** Starts a session on a file already registered with doc:open. */
  async open({ path: filePath, pages = null }) {
    try {
      const editor = new PageEditor();
      const record = { id: newId(), editor, sources: new Map() };
      await registerSource(record, filePath, pages, null);
      sessions.set(record.id, record);
      return stateOf(record);
    } catch (err) {
      return fail(err);
    }
  },

  /** Applies a batch of operations and returns the new state. */
  async apply({ sessionId, ops = [] }) {
    const record = sessions.get(sessionId);
    if (!record) return { ok: false, error: '编辑会话已过期', code: 'NO_SESSION' };
    const { editor } = record;
    try {
      await editor.settle();
      for (const op of ops) {
        switch (op.type) {
          case 'reorder':
            editor.reorder(op.order || []);
            break;
          case 'remove':
            editor.removePages(op.indices || []);
            break;
          case 'rotate':
            editor.rotatePages(op.indices || [], Number(op.delta) || 0);
            break;
          case 'setRotation':
            editor.setRotation(op.indices || [], Number(op.value) || 0);
            break;
          case 'duplicate':
            for (const i of [...(op.indices || [])].sort((a, b) => b - a)) editor.duplicatePage(i);
            break;
          case 'reverse':
            editor.reverse();
            break;
          case 'keep':
            editor.keepOnly(op.indices || []);
            break;
          case 'insert': {
            const at = op.at === null || op.at === undefined ? null : Number(op.at);
            await registerSource(record, op.path, op.pages || null, at);
            break;
          }
          default:
            return { ok: false, error: `未知操作 ${op.type}` };
        }
      }
      return await stateOf(record);
    } catch (err) {
      return fail(err);
    }
  },

  /** Writes the working set to disk. */
  async save({ sessionId, target, overwrite = false, keepOutline = true, title = null }) {
    const record = sessions.get(sessionId);
    if (!record) return { ok: false, error: '编辑会话已过期', code: 'NO_SESSION' };
    try {
      await record.editor.settle();
      if (!record.editor.pages.length) return { ok: false, error: '页面为空，无法保存' };
      if (overwrite) {
        // write next to the file first, then replace, so a failure never
        // destroys the original document
        const dir = path.dirname(target);
        const tmp = path.join(dir, `.lumen-${Date.now().toString(36)}.pdf`);
        const result = await record.editor.save(tmp, { keepOutline, title });
        await fsp.copyFile(target, `${target}.lumen-backup`).catch(() => {});
        await fsp.rename(tmp, target);
        await fsp.unlink(`${target}.lumen-backup`).catch(() => {});
        return { ok: true, path: target, bytes: result.buffer.length, pages: result.pageCount };
      }
      const result = await record.editor.save(target, { keepOutline, title });
      return { ok: true, path: target, bytes: result.buffer.length, pages: result.pageCount };
    } catch (err) {
      return fail(err);
    }
  },

  /** Writes one file per chunk (the "split" action). */
  async split({ sessionId, dir, size = 1, prefix = 'part' }) {
    const record = sessions.get(sessionId);
    if (!record) return { ok: false, error: '编辑会话已过期', code: 'NO_SESSION' };
    try {
      await record.editor.settle();
      const chunks = record.editor.splitEvery(Math.max(1, Number(size) || 1));
      // the dialog hands back a path that may not exist yet
      await fsp.mkdir(dir, { recursive: true });
      const written = [];
      for (let i = 0; i < chunks.length; i += 1) {
        const name = `${prefix}-${String(i + 1).padStart(3, '0')}.pdf`;
        const target = path.join(dir, name);
        const result = await chunks[i].save(target);
        written.push({ path: target, pages: result.pageCount, bytes: result.buffer.length });
      }
      return { ok: true, files: written, dir };
    } catch (err) {
      return fail(err);
    }
  },

  /** Opens a PDF just to read its page list (for the insert dialog). */
  async inspect({ path: filePath }) {
    try {
      const buf = await fsp.readFile(filePath);
      const { PdfDocument } = require('./pdf/document');
      const doc = new PdfDocument(buf, filePath);
      return {
        ok: true,
        path: filePath,
        name: path.basename(filePath),
        pageCount: doc.pageCount,
        encrypted: doc.encrypted,
        labels: doc.getPageLabels().slice(0, 64),
      };
    } catch (err) {
      return fail(err);
    }
  },

  close({ sessionId }) {
    sessions.delete(sessionId);
    return { ok: true };
  },
};

module.exports = { handlers, PdfError };
