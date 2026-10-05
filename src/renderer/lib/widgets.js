/* =========================================================================
   LeebertyPDF — reusable widgets: modal, prompt, toast, context menu, palette
   ========================================================================= */
import { $, clear, el, escapeHtml, fuzzyScore, isTextInput, t } from './core.js';

/* ------------------------------------------------------------------ toasts */
export function toast(title, opts = {}) {
  const host = $('#toasts');
  if (!host) return () => {};
  const kind = opts.kind || '';
  const node = el(
    'div',
    { class: `toast ${kind}` },
    el(
      'div',
      { class: 'toast-body' },
      el('div', { class: 'toast-title', text: title }),
      opts.sub ? el('div', { class: 'toast-sub', text: opts.sub }) : null,
      opts.action
        ? el('div', {
            class: 'toast-action',
            text: opts.action,
            onclick: () => {
              try {
                opts.onAction && opts.onAction();
              } finally {
                remove();
              }
            },
          })
        : null,
    ),
  );
  const remove = () => {
    node.style.opacity = '0';
    node.style.transform = 'translateX(18px)';
    node.style.transition = 'opacity 140ms, transform 140ms';
    setTimeout(() => node.remove(), 150);
  };
  host.append(node);
  const ms = opts.duration ?? (kind === 'error' ? 6500 : 3200);
  if (ms > 0) setTimeout(remove, ms);
  node.addEventListener('click', (e) => {
    if (e.target === node) remove();
  });
  return remove;
}

/* ------------------------------------------------------------------ modals */
let modalStack = 0;

/**
 * @param {{title?:string, body?:Node|string, buttons?:Array, narrow?:boolean,
 *          wide?:boolean, onOpen?:(modal:HTMLElement, close:Function)=>void,
 *          onClose?:Function, closable?:boolean}} cfg
 */
export function openModal(cfg = {}) {
  const root = $('#modal-root');
  const buttons = cfg.buttons || [{ label: t('modal.close'), kind: 'ghost' }];
  let closed = false;

  const modal = el('div', { class: `modal${cfg.narrow ? ' narrow' : ''}${cfg.wide ? ' wide' : ''}` });
  const head = el(
    'div',
    { class: 'modal-head' },
    el('div', { class: 'modal-title', text: cfg.title || '' }),
    cfg.closable === false
      ? null
      : el('button', {
          class: 'icon-btn sm',
          title: t('modal.close'),
          html: '<svg viewBox="0 0 24 24" class="ic"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
          onclick: () => close(null),
        }),
  );
  const body = el('div', { class: 'modal-body' });
  if (typeof cfg.body === 'string') body.innerHTML = cfg.body;
  else if (cfg.body instanceof Node) body.append(cfg.body);

  const foot = el('div', { class: 'modal-foot' });
  for (const b of buttons) {
    foot.append(
      el('button', {
        class: `btn ${b.kind || ''}`,
        text: b.label,
        onclick: async (e) => {
          if (b.handler) {
            const r = await b.handler(close, e);
            if (r === false) return;
          }
          if (b.close !== false) close(b.value === undefined ? b.label : b.value);
        },
      }),
    );
  }

  modal.append(head, body, buttons.length ? foot : el('div'));
  root.append(modal);
  root.hidden = false;
  modalStack += 1;

  let resolveFn = null;
  const done = new Promise((r) => {
    resolveFn = r;
  });

  function close(value) {
    if (closed) return;
    closed = true;
    modalStack = Math.max(0, modalStack - 1);
    try {
      cfg.onClose && cfg.onClose(value);
    } catch (err) {
      console.error(err);
    }
    modal.style.animation = 'pop 120ms reverse';
    setTimeout(() => {
      modal.remove();
      if (!root.querySelector('.modal')) root.hidden = true;
    }, 110);
    resolveFn(value);
  }

  const onKey = (e) => {
    if (e.key === 'Escape' && cfg.closable !== false) {
      e.stopPropagation();
      close(null);
    }
  };
  modal.addEventListener('keydown', onKey);
  root.addEventListener('mousedown', (e) => {
    if (e.target === root && cfg.closable !== false) close(null);
  });

  if (cfg.onOpen) cfg.onOpen(modal, close, body);
  queueMicrotask(() => {
    const focusable = modal.querySelector('input, textarea, select, button.primary, button');
    focusable?.focus();
  });

  return { modal, body, close, done };
}

export function confirmDialog(title, message, { okLabel, danger } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    openModal({
      title,
      narrow: true,
      body: el('div', { text: message || '' }),
      buttons: [
        { label: t('modal.cancel'), kind: 'ghost', handler: () => finish(false), close: true },
        { label: okLabel || t('modal.ok'), kind: danger ? 'primary' : 'primary', handler: () => finish(true) },
      ],
      onClose: () => finish(false),
    });
  });
}

/** Text prompt modal. */
export function promptDialog(title, { value = '', placeholder = '', okLabel, select = true } = {}) {
  return new Promise((resolve) => {
    const input = el('input', {
      class: 'find-input',
      style: { width: '100%', maxWidth: 'none', height: '32px', fontSize: '13px' },
      value,
      placeholder,
    });
    let settled = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    openModal({
      title,
      narrow: true,
      body: el('div', {}, input),
      buttons: [
        { label: t('modal.cancel'), kind: 'ghost', handler: () => finish(null) },
        { label: okLabel || t('modal.ok'), kind: 'primary', handler: () => finish(input.value) },
      ],
      onOpen: () => {
        input.focus();
        if (select) input.select();
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(input.value);
            $('#modal-root').querySelectorAll('.modal').forEach((m) => m.remove());
            $('#modal-root').hidden = true;
            settled = true;
          }
        });
      },
      onClose: () => finish(null),
    });
  });
}

/* ------------------------------------------------------------ context menu */
let activeContext = null;

export function closeContextMenu() {
  const node = $('#context-menu');
  if (!node) return;
  node.hidden = true;
  clear(node);
  if (activeContext?.onClose) activeContext.onClose();
  activeContext = null;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {Array<{label?:string, accel?:string, icon?:string, checked?:boolean,
 *                disabled?:boolean, onClick?:Function, separator?:boolean, header?:string}>} items
 */
export function openContextMenu(x, y, items) {
  const node = $('#context-menu');
  closeContextMenu();
  clear(node);
  for (const it of items) {
    if (!it) continue;
    if (it.separator) {
      node.append(el('div', { class: 'menu-sep' }));
      continue;
    }
    if (it.header) {
      node.append(el('div', { class: 'menu-group-label', text: it.header }));
      continue;
    }
    node.append(
      el(
        'div',
        {
          class: `menu-item${it.checked ? ' checked' : ''}${it.disabled ? ' hidden' : ''}`,
          onclick: () => {
            if (it.disabled) return;
            closeContextMenu();
            it.onClick && it.onClick();
          },
        },
        el('span', { class: 'menu-label', text: it.label }),
        it.accel ? el('span', { class: 'menu-key', text: it.accel }) : null,
      ),
    );
  }
  node.hidden = false;
  node.style.left = '0px';
  node.style.top = '0px';
  const rect = node.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 6;
  const maxY = window.innerHeight - rect.height - 6;
  node.style.left = `${Math.max(6, Math.min(x, maxX))}px`;
  node.style.top = `${Math.max(6, Math.min(y, maxY))}px`;
  activeContext = { items };
  const onDocDown = (e) => {
    if (!node.contains(e.target)) closeContextMenu();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') closeContextMenu();
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('wheel', closeContextMenu, { passive: true, once: true });
  }, 0);
  activeContext.onClose = () => {
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
  };
  return node;
}

/* --------------------------------------------------------------- popovers */
let popoverCleanup = null;

export function closePopover() {
  const node = $('#main-menu');
  if (node) {
    node.hidden = true;
    clear(node);
  }
  popoverCleanup?.();
  popoverCleanup = null;
}

export function openPopover(anchorEl, build) {
  const node = $('#main-menu');
  const wasOpen = !node.hidden;
  closePopover();
  if (wasOpen && anchorEl?._lumenLastOpen) {
    anchorEl._lumenLastOpen = false;
    return;
  }
  if (anchorEl) anchorEl._lumenLastOpen = true;
  build(node);
  node.hidden = false;
  const a = anchorEl?.getBoundingClientRect?.() || { left: 10, bottom: 60, top: 0 };
  node.style.left = '0px';
  node.style.top = '0px';
  const rect = node.getBoundingClientRect();
  let x = a.left;
  let y = a.bottom + 6;
  if (y + rect.height > window.innerHeight - 8) y = Math.max(8, a.top - rect.height - 6);
  x = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  const onDown = (e) => {
    if (!node.contains(e.target) && e.target !== anchorEl) closePopover();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') closePopover();
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  popoverCleanup = () => {
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    if (anchorEl) anchorEl._lumenLastOpen = false;
  };
}

/* -------------------------------------------------------- command palette */
let paletteState = null;

export function isPaletteOpen() {
  return paletteState !== null;
}

/**
 * @param {() => Array<{id:string,title:string,subtitle?:string,group?:string,
 *                      keys?:string,icon?:string,run:Function}>} provider
 */
export function openPalette(provider) {
  const root = $('#palette');
  const input = $('#palette-input');
  const list = $('#palette-list');
  if (paletteState) closePalette();
  input.placeholder = t('palette.placeholder');
  input.value = '';
  root.hidden = false;
  paletteState = { provider, items: [], index: 0, filtered: [] };
  input.focus();

  const render = () => {
    const q = input.value.trim().toLowerCase();
    const items = paletteState.items;
    let filtered;
    if (!q) {
      filtered = items.slice(0, 80);
    } else {
      filtered = [];
      for (const it of items) {
        // the title carries the most weight; a hit in the group or the keywords
        // only counts when the title does not match at all
        const titleScore = fuzzyScore(it.title, q);
        const metaScore = titleScore < 0 ? fuzzyScore(`${it.subtitle || ''} ${it.group || ''} ${it.keywords || ''}`, q) : -1;
        const score = titleScore >= 0 ? titleScore : metaScore >= 0 ? metaScore + 6 : -1;
        if (score >= 0) filtered.push({ ...it, _score: score });
      }
      filtered.sort((a, b) => a._score - b._score || a.title.length - b.title.length);
      filtered = filtered.slice(0, 80);
    }
    paletteState.filtered = filtered;
    paletteState.index = Math.min(paletteState.index, Math.max(0, filtered.length - 1));
    clear(list);
    if (!filtered.length) {
      list.append(el('div', { class: 'palette-empty', text: t('palette.empty') }));
      return;
    }
    let lastGroup = null;
    filtered.forEach((it, i) => {
      if (it.group && it.group !== lastGroup) {
        lastGroup = it.group;
        list.append(el('div', { class: 'menu-group-label', text: it.group }));
      }
      const row = el(
        'div',
        {
          class: `palette-item${i === paletteState.index ? ' active' : ''}`,
          onclick: () => run(i),
          onmouseenter: () => {
            paletteState.index = i;
            [...list.querySelectorAll('.palette-item')].forEach((n, j) => n.classList.toggle('active', j === i));
          },
        },
        el('span', { class: 'pi-icon', html: it.icon || '' }),
        el('span', { class: 'pi-title', html: highlight(it.title, input.value.trim()) }),
        it.subtitle ? el('span', { class: 'pi-sub', text: it.subtitle }) : null,
        it.keys ? el('span', { class: 'pi-key', text: it.keys }) : null,
      );
      list.append(row);
    });
    const active = list.querySelectorAll('.palette-item')[paletteState.index];
    active?.scrollIntoView({ block: 'nearest' });
  };

  const run = (i) => {
    const it = paletteState?.filtered[i];
    closePalette();
    if (it) setTimeout(() => it.run(), 0);
  };

  const onInput = () => render();
  const onKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      paletteState.index = Math.min(paletteState.filtered.length - 1, paletteState.index + 1);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      paletteState.index = Math.max(0, paletteState.index - 1);
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(paletteState.index);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
    }
  };
  const onBackdrop = (e) => {
    if (e.target === root) closePalette();
  };

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKey);
  root.addEventListener('mousedown', onBackdrop);

  paletteState.cleanup = () => {
    input.removeEventListener('input', onInput);
    input.removeEventListener('keydown', onKey);
    root.removeEventListener('mousedown', onBackdrop);
  };

  Promise.resolve(provider())
    .then((items) => {
      if (!paletteState) return;
      paletteState.items = items || [];
      render();
    })
    .catch((err) => console.error('[palette] provider failed', err));
  render();
}

export function closePalette() {
  const root = $('#palette');
  if (!root || !paletteState) return;
  paletteState.cleanup?.();
  root.hidden = true;
  paletteState = null;
}

/**
 * Wraps the matched part of a palette title in <b>.
 *
 * A contiguous hit is highlighted as one run; otherwise the fuzzy subsequence
 * is highlighted character by character, so the user can see *why* a result
 * matched instead of wondering what the search did.
 */
function highlight(text, q) {
  const raw = String(text ?? '');
  const query = String(q || '').trim().toLowerCase();
  if (!query) return escapeHtml(raw);
  const lower = raw.toLowerCase();
  const idx = lower.indexOf(query);
  if (idx >= 0) {
    return (
      escapeHtml(raw.slice(0, idx)) +
      '<b>' +
      escapeHtml(raw.slice(idx, idx + query.length)) +
      '</b>' +
      escapeHtml(raw.slice(idx + query.length))
    );
  }
  // Subsequence: bold each matched character and skip the gaps. Bounded the same
  // way as the scorer so the highlight always agrees with the ranking.
  const spans = [];
  let cursor = 0;
  for (const ch of query) {
    const found = lower.indexOf(ch, cursor);
    if (found < 0) return escapeHtml(raw);
    spans.push(found);
    cursor = found + 1;
  }
  const spanLength = spans[spans.length - 1] - spans[0] + 1;
  if (spanLength > query.length * 1.5 + 2) return escapeHtml(raw);
  const bold = new Set(spans);
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    out += bold.has(i) ? '<b>' + escapeHtml(raw[i]) + '</b>' : escapeHtml(raw[i]);
  }
  return out;
}

/* -------------------------------------------------------------- misc hints */
export function flashElement(node, cls = 'lumen-flash', ms = 1400) {
  if (!node) return;
  node.classList.add(cls);
  setTimeout(() => node.classList.remove(cls), ms);
}

export { isTextInput };
