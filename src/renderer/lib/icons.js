/* =========================================================================
   LeebertyPDF — inline SVG icon set (stroke based, 24x24 grid)
   ========================================================================= */
const S = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';

export const ICONS = {
  file: `<path d="M6 3h7l5 5v13H6z" ${S}/><path d="M13 3v5h5" ${S}/>`,
  folder: `<path d="M3 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2.4h8A1.5 1.5 0 0 1 20 9.4V17a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3 17z" ${S}/>`,
  search: `<circle cx="11" cy="11" r="6.2" ${S}/><path d="M15.6 15.6 21 21" ${S}/>`,
  settings: `<circle cx="12" cy="12" r="3" ${S}/><path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6" ${S}/>`,
  sidebar: `<path d="M3 4h18v16H3z" ${S}/><path d="M9 4v16" ${S}/>`,
  sidebarRight: `<path d="M3 4h18v16H3z" ${S}/><path d="M15 4v16" ${S}/>`,
  zoomIn: `<circle cx="11" cy="11" r="6" ${S}/><path d="M8.4 11h5.2M11 8.4v5.2M15.6 15.6 21 21" ${S}/>`,
  zoomOut: `<circle cx="11" cy="11" r="6" ${S}/><path d="M8.4 11h5.2M15.6 15.6 21 21" ${S}/>`,
  fitWidth: `<path d="M3 12h18" ${S}/><path d="M7 8l-4 4 4 4M17 8l4 4-4 4" ${S}/>`,
  fitPage: `<rect x="4" y="3.5" width="16" height="17" rx="1.4" ${S}/><path d="M8 8h3M8 12h3M8 16h3M14 8h2" ${S}/>`,
  rotateCw: `<path d="M20 10a8 8 0 1 0-2.6 8" ${S}/><path d="M20 5.6V10h-4.4" ${S}/>`,
  rotateCcw: `<path d="M4 10a8 8 0 1 1 2.6 8" ${S}/><path d="M4 5.6V10h4.4" ${S}/>`,
  moon: `<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" ${S}/>`,
  sun: `<circle cx="12" cy="12" r="4.2" ${S}/><path d="M12 2.6v2.2M12 19.2v2.2M21.4 12h-2.2M4.8 12H2.6M18.6 5.4l-1.6 1.6M7 17l-1.6 1.6M18.6 18.6 17 17M7 7 5.4 5.4" ${S}/>`,
  print: `<path d="M7 9V4h10v5" ${S}/><rect x="4" y="9" width="16" height="7" rx="1.4" ${S}/><path d="M7 16h10v4H7z" ${S}/>`,
  save: `<path d="M5 4h9l5 5v11H5z" ${S}/><path d="M9 4v5h5" ${S}/><path d="M8 20v-6h8v6" ${S}/>`,
  copy: `<rect x="9" y="9" width="11" height="11" rx="1.6" ${S}/><path d="M15 9V5.6A1.6 1.6 0 0 0 13.4 4H5.6A1.6 1.6 0 0 0 4 5.6v7.8A1.6 1.6 0 0 0 5.6 15H9" ${S}/>`,
  highlight: `<path d="M5 18h4l10-10-4-4L5 14z" ${S}/><path d="M3 21h18" ${S}/>`,
  pen: `<path d="M4 20l3.4-1 10-10a2.1 2.1 0 0 0-3-3l-10 10z" ${S}/><path d="M14 6.5l3 3" ${S}/>`,
  text: `<path d="M5 6h14" ${S}/><path d="M12 6v13" ${S}/>`,
  stamp: `<path d="M9 4.5A2.5 2.5 0 0 1 11.5 7c0 1.7-1 2.4-1.4 3.4-.2.6-.2 1.2-.2 1.6h4.2c0-.4 0-1-.2-1.6C13.5 9.4 12.5 8.7 12.5 7A2.5 2.5 0 0 1 15 4.5 2.5 2.5 0 0 1 17.5 7c0 2.4-2.2 4.6-2.6 6.4h-5.8C8.7 11.6 6.5 9.4 6.5 7A2.5 2.5 0 0 1 9 4.5z" ${S}/><rect x="5" y="16.5" width="14" height="3.5" rx="1" ${S}/>`,
  signature: `<path d="M4 17c3.5 0 5-9 8.5-9 2 0 2.4 3 .6 4.6-2 1.8-4.2.6-3.2-1.4" ${S}/><path d="M14 18c3 0 4.6-2 6-3" ${S}/>`,
  eraser: `<path d="M8 19h11" ${S}/><path d="M5.5 15.5 12 9l5.5 5.5-4 4H9.2z" ${S}/>`,
  undo: `<path d="M9 7 4 12l5 5" ${S}/><path d="M4 12h9a6 6 0 0 1 0 12h-1" ${S}/>`,
  redo: `<path d="m15 7 5 5-5 5" ${S}/><path d="M20 12h-9a6 6 0 0 0 0 12h1" ${S}/>`,
  bookmark: `<path d="M6 3.5h12v17l-6-4.2-6 4.2z" ${S}/>`,
  bookmarkFilled: `<path d="M6 3.5h12v17l-6-4.2-6 4.2z" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>`,
  outline: `<path d="M4 6h3M4 12h3M4 18h3" ${S}/><path d="M10 6h10M10 12h10M10 18h10" ${S}/>`,
  thumbnails: `<rect x="3.5" y="3.5" width="7" height="7" rx="1" ${S}/><rect x="13.5" y="3.5" width="7" height="7" rx="1" ${S}/><rect x="3.5" y="13.5" width="7" height="7" rx="1" ${S}/><rect x="13.5" y="13.5" width="7" height="7" rx="1" ${S}/>`,
  annotation: `<path d="M4 5h16v11H9l-5 4z" ${S}/><path d="M8 9h8M8 12h5" ${S}/>`,
  select: `<path d="M6 3.5 18.5 12 12.8 13.4 10.6 19.5z" ${S}/>`,
  hand: `<path d="M8 12V6.6a1.3 1.3 0 0 1 2.6 0V11m0 0V5.4a1.3 1.3 0 0 1 2.6 0V11m0 0V6.6a1.3 1.3 0 0 1 2.6 0V13c0 4-2.2 7-5.6 7S7 17.4 7 14.4v-1.9a1.3 1.3 0 0 1 2.6 0" ${S}/>`,
  presentation: `<rect x="3" y="4.5" width="18" height="12" rx="1.4" ${S}/><path d="M12 16.5V21M8.5 21h7" ${S}/>`,
  fullscreen: `<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" ${S}/>`,
  close: `<path d="M6 6l12 12M18 6 6 18" ${S}/>`,
  plus: `<path d="M12 5v14M5 12h14" ${S}/>`,
  minus: `<path d="M5 12h14" ${S}/>`,
  chevronRight: `<path d="m9 5 7 7-7 7" ${S}/>`,
  chevronDown: `<path d="m5 9 7 7 7-7" ${S}/>`,
  chevronLeft: `<path d="m15 5-7 7 7 7" ${S}/>`,
  chevronUp: `<path d="m5 15 7-7 7 7" ${S}/>`,
  arrowUp: `<path d="M12 19V5M6 11l6-6 6 6" ${S}/>`,
  arrowDown: `<path d="M12 5v14M6 13l6 6 6-6" ${S}/>`,
  arrowLeft: `<path d="M19 12H5M11 6l-6 6 6 6" ${S}/>`,
  arrowRight: `<path d="M5 12h14M13 6l6 6-6 6" ${S}/>`,
  page: `<rect x="6" y="3.5" width="12" height="17" rx="1.4" ${S}/><path d="M9 8h6M9 12h6M9 16h3" ${S}/>`,
  layers: `<path d="m12 3 9 5-9 5-9-5z" ${S}/><path d="m3 13 9 5 9-5" ${S}/>`,
  list: `<path d="M4 6h16M4 12h16M4 18h10" ${S}/>`,
  info: `<circle cx="12" cy="12" r="8.4" ${S}/><path d="M12 11v6M12 7.8v.6" ${S}/>`,
  keyboard: `<rect x="2.5" y="6.5" width="19" height="11" rx="2" ${S}/><path d="M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M7 14h10" ${S}/>`,
  palette: `<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.4 0 2-.9 2-1.9 0-1.6-1.4-1.7-1.4-3 0-1 .8-1.8 1.9-1.8h1.6A4.4 4.4 0 0 0 20.5 9C20 5.7 16.5 3.5 12 3.5z" ${S}/><circle cx="8" cy="9" r="1.1" fill="currentColor"/><circle cx="12" cy="7.4" r="1.1" fill="currentColor"/><circle cx="15.6" cy="9.4" r="1.1" fill="currentColor"/>`,
  export: `<path d="M12 3.5v11" ${S}/><path d="M8 7l4-3.5L16 7" ${S}/><path d="M5 14v5.5h14V14" ${S}/>`,
  image: `<rect x="3.5" y="5" width="17" height="14" rx="1.6" ${S}/><circle cx="9" cy="10" r="1.6" ${S}/><path d="m4.5 17 5-5 4 4 2.5-2.5L19.5 17" ${S}/>`,
  textFile: `<path d="M6 3h7l5 5v13H6z" ${S}/><path d="M13 3v5h5" ${S}/><path d="M9 13h6M9 16.5h4" ${S}/>`,
  history: `<path d="M3.5 12a8.5 8.5 0 1 0 2.7-6.2" ${S}/><path d="M3.4 6v4.4h4.3" ${S}/><path d="M12 8v4.4l3 1.8" ${S}/>`,
  pin: `<path d="M12 21v-6" ${S}/><path d="M8.4 3.5h7.2l-1 5.1 2.4 2.6H7l2.4-2.6z" ${S}/>`,
  trash: `<path d="M4.5 6.5h15" ${S}/><path d="M9 6.5V4.5h6v2" ${S}/><path d="M6.5 6.5 7.6 20h8.8l1.1-13.5" ${S}/><path d="M10.5 10v6M13.5 10v6" ${S}/>`,
  check: `<path d="m5 12.5 4.6 4.5L19 7" ${S}/>`,
  refresh: `<path d="M20 12a8 8 0 1 1-2.4-5.7" ${S}/><path d="M20 4.5V10h-5.4" ${S}/>`,
  grid: `<rect x="3.5" y="3.5" width="17" height="17" rx="1.6" ${S}/><path d="M3.5 9.5h17M9.5 3.5v17" ${S}/>`,
  eye: `<path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z" ${S}/><circle cx="12" cy="12" r="2.6" ${S}/>`,
  command: `<path d="M9 6a2.5 2.5 0 1 0-2.5 2.5H18a2.5 2.5 0 1 0-2.5-2.5V18a2.5 2.5 0 1 0 2.5-2.5H6.5A2.5 2.5 0 1 0 9 18z" ${S}/>`,
  external: `<path d="M14 4h6v6" ${S}/><path d="M20 4 11 13" ${S}/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" ${S}/>`,
  warning: `<path d="M12 4 2.8 20h18.4z" ${S}/><path d="M12 10v4.5M12 17.4v.4" ${S}/>`,
  star: `<path d="m12 4 2.5 5.2 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8z" ${S}/>`,
  compare: `<rect x="3.5" y="5" width="7" height="14" rx="1.2" ${S}/><rect x="13.5" y="5" width="7" height="14" rx="1.2" ${S}/>`,
  scroll: `<rect x="6.5" y="3.5" width="11" height="17" rx="1.4" ${S}/><path d="M10 8h4M10 11.5h4M10 15h2" ${S}/>`,
};

export function icon(name, cls = 'ic') {
  return `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true">${ICONS[name] || ICONS.file}</svg>`;
}

/* ------------------------------------------------------------------ colours */
export const HIGHLIGHT_COLORS = [
  { name: '黄', value: '#ffd24a' },
  { name: '绿', value: '#7ee787' },
  { name: '蓝', value: '#7cc7ff' },
  { name: '粉', value: '#ff9ecb' },
  { name: '橙', value: '#ffab6b' },
  { name: '紫', value: '#c1a4ff' },
];

export const INK_COLORS = [
  { name: '红', value: '#e5484d' },
  { name: '橙', value: '#f0883e' },
  { name: '绿', value: '#3fb950' },
  { name: '蓝', value: '#2f81f7' },
  { name: '紫', value: '#a371f7' },
  { name: '黑', value: '#24292f' },
];

export const TEXT_COLORS = [
  { name: '黑', value: '#111111' },
  { name: '红', value: '#c62828' },
  { name: '蓝', value: '#1565c0' },
  { name: '绿', value: '#2e7d32' },
  { name: '橙', value: '#ef6c00' },
  { name: '白', value: '#ffffff' },
];
