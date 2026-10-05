/* =========================================================================
   Development control experiment (activated by tools/selftest.js).
   Builds a bare PDF.js viewer inside the running app, using nothing but the
   stock pdf_viewer.css, to tell layout bugs in Lumen's own CSS apart from
   behaviour that comes from PDF.js itself.
   ========================================================================= */
import { getDocument } from './vendor/pdfjs/pdf.min.mjs';
import { EventBus, PDFLinkService, PDFViewer } from './vendor/pdfjs/pdf_viewer.mjs';

let bareViewer = null;
let bareHost = null;

export function installBareControlProbe() {
  window.__lumenBareControl = async () => {
    const src = (window.__lumenTestState().active || {}).path;
    if (!src) throw new Error('no active document');
    const reg = await window.lumen.doc.open(src);
    if (!reg.ok) throw new Error(reg.error);

    bareHost = document.createElement('div');
    bareHost.id = 'bare-control';
    Object.assign(bareHost.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '9000',
      background: '#3b4046',
      display: 'block',
    });
    document.body.append(bareHost);

    const container = document.createElement('div');
    container.className = 'pdf-container';
    Object.assign(container.style, { position: 'absolute', inset: '0' });
    const viewerEl = document.createElement('div');
    viewerEl.className = 'pdfViewer';
    container.append(viewerEl);
    bareHost.append(container);

    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus });
    const l10n = {
      getLanguage: () => 'zh-CN',
      getDirection: () => 'ltr',
      async get(ids, args, fallback) {
        return typeof ids === 'string' ? (fallback ?? ids) : '';
      },
      async translate() {},
      async translateOnce() {},
      async destroy() {},
      pause() {},
      resume() {},
    };
    bareViewer = new PDFViewer({
      container,
      viewer: viewerEl,
      eventBus,
      linkService,
      l10n,
      annotationMode: 1,
      textLayerMode: 1,
    });
    linkService.setViewer(bareViewer);
    const doc = await getDocument({ url: reg.url, verbosity: 0 }).promise;
    bareViewer.setDocument(doc);
    eventBus.on('pagesinit', () => {
      bareViewer.currentScaleValue = 'page-width';
    });
    window.__lumenBareDoc = doc;
    return true;
  };

  window.__lumenBareProbe = () => {
    if (!bareViewer) return null;
    const pages = [...bareHost.querySelectorAll('.page')];
    return {
      scrollMode: bareViewer.scrollMode,
      spreadMode: bareViewer.spreadMode,
      scale: bareViewer.currentScale,
      scaleValue: bareViewer.currentScaleValue,
      viewerClass: bareHost.querySelector('.pdfViewer').className,
      rects: pages.slice(0, 3).map((p) => {
        const r = p.getBoundingClientRect();
        return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      }),
    };
  };

  window.__lumenBareClose = () => {
    bareHost?.remove();
    bareHost = null;
    bareViewer = null;
  };
}
