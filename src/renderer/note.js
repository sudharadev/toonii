'use strict';
const api = window.sticky;
const $ = (id) => document.getElementById(id);

const noteEl = $('note');
const bar = $('bar');
const titleEl = $('title');
const editor = $('editor');
const canvas = $('ink');
const ctx = canvas.getContext('2d');
const modeLabel = $('modeLabel');
const modeIcon = $('modeIcon').querySelector('use');
const pinBtn = $('pinBtn');
const styleBtn = $('styleBtn');
const stylePop = $('stylePop');
const tiltInput = $('tilt');
const format = $('format');
const moreRow = $('more');
const moreBtn = $('moreBtn');
const sizeInput = $('sizeInput');

const GUTTER = 16;
const FONT_MAX = 36;
const FONT_MIN = 14;
const FONT_EMPTY = 18;
const SAVE_MS = 350;
const PEN_WIDTH = 3;
const ERASER_WIDTH = 18;
const SIZES = ['s', 'm', 'l', 'xl'];
const FONTS = ['sans', 'serif', 'mono', 'hand', 'marker'];
const TEXT_COLORS = ['accent', 'red', 'orange', 'green', 'blue', 'purple'];
const SIZE_MIN = 8;
const SIZE_MAX = 96;

let note = null;
let isMac = false;
let strokes = [];
let current = null;
let tool = 'pen';
let textTimer = null;
let titleTimer = null;
let redrawQueued = false;
let fitQueued = false;
let resizing = null;
let dragging = null;
let passthrough = false;
let wantFocus = false;

// ---------- rich-text sanitizing ----------

const ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SPAN', 'DIV', 'P', 'BR', 'UL', 'OL', 'LI']);
const ALLOWED_STYLES = ['font-weight', 'font-style', 'text-decoration-line'];

function allowedAttr(tag, name, value) {
  switch (name) {
    case 'data-size': return SIZES.includes(value);
    case 'data-font': return FONTS.includes(value);
    case 'data-tc': return TEXT_COLORS.includes(value);
    case 'data-check': return tag === 'UL';
    case 'data-checked': return tag === 'LI' && (value === 'true' || value === 'false');
    default: return false;
  }
}

function cleanNode(root) {
  for (const child of [...root.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); continue; }
    if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE') { child.remove(); continue; }
    cleanNode(child);
    if (!ALLOWED_TAGS.has(child.tagName)) { child.replaceWith(...child.childNodes); continue; }
    const kept = ALLOWED_STYLES
      .map((p) => [p, child.style.getPropertyValue(p)])
      .filter(([, v]) => v);
    const fs = child.style.getPropertyValue('font-size');
    if (/^\d{1,2}(\.\d+)?px$/.test(fs)) kept.push(['font-size', fs]);
    for (const attr of [...child.attributes]) {
      if (!allowedAttr(child.tagName, attr.name, attr.value)) child.removeAttribute(attr.name);
    }
    for (const [p, v] of kept) child.style.setProperty(p, v);
  }
}

function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  cleanNode(doc.body);
  return doc.body.innerHTML;
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- persistence ----------

function editorText() {
  return editor.innerText.replace(/\n$/, '');
}

function flushText() {
  if (textTimer === null) return;
  clearTimeout(textTimer);
  textTimer = null;
  api.update({ html: editorHtml(), text: editorText() });
}

// Saved HTML without runtime-only bits: the synced item font sizes and animation classes.
function editorHtml() {
  const clone = editor.cloneNode(true);
  for (const li of clone.querySelectorAll('li[data-checked]')) {
    li.style.removeProperty('font-size');
    if (!li.getAttribute('style')) li.removeAttribute('style');
  }
  for (const el of clone.querySelectorAll('[class]')) el.removeAttribute('class');
  return clone.innerHTML;
}

// Give each checklist item the font size of its first sized text. The checkbox is drawn in
// em/lh units of the item, so it then matches that text and centers on its first line.
function syncCheckboxes() {
  for (const li of editor.querySelectorAll('ul[data-check] > li')) {
    li.style.removeProperty('font-size'); // measure against the inherited size
    const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    const text = walker.nextNode();
    const sized = text && text.parentElement !== li
      && text.parentElement.closest('[style*="font-size"], [data-size]');
    if (sized && li.contains(sized)) {
      li.style.fontSize = getComputedStyle(text.parentElement).fontSize;
    }
  }
}

function scheduleTextSave() {
  clearTimeout(textTimer);
  textTimer = setTimeout(flushText, SAVE_MS);
}

function contentChanged() {
  // Chromium leaves a lone <br> behind when everything is deleted; drop it so the placeholder shows.
  if (!editor.textContent && !editor.querySelector('li')) editor.innerHTML = '';
  scheduleTextSave();
  queueFit();
}

// ---------- layout: fit (possibly rotated) note inside the window ----------

function layout() {
  const W = window.innerWidth - GUTTER * 2;
  const H = window.innerHeight - GUTTER * 2;
  const t = Math.abs((note ? note.tilt : 0) * Math.PI / 180);
  const c = Math.cos(t);
  const s = Math.sin(t);
  const d = c * c - s * s;
  // Largest w×h whose rotated bounding box fits W×H.
  let w = (W * c - H * s) / d;
  let h = (H * c - W * s) / d;
  w = Math.max(160, Math.min(W, w));
  h = Math.max(110, Math.min(H, h));
  Object.assign(noteEl.style, {
    inset: 'auto',
    left: `${GUTTER + (W - w) / 2}px`,
    top: `${GUTTER + (H - h) / 2}px`,
    width: `${w}px`,
    height: `${h}px`,
  });
  noteEl.style.setProperty('--tilt', `${note ? note.tilt : 0}deg`);
}

// Client point -> point in the note's own (unrotated) coordinate space, relative to `el`.
function toLocal(clientX, clientY, el) {
  const r = noteEl.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const t = -(note.tilt * Math.PI) / 180;
  const dx = clientX - cx;
  const dy = clientY - cy;
  const lx = dx * Math.cos(t) - dy * Math.sin(t) + noteEl.offsetWidth / 2;
  const ly = dx * Math.sin(t) + dy * Math.cos(t) + noteEl.offsetHeight / 2;
  let ox = 0;
  let oy = 0;
  for (let n = el; n && n !== noteEl; n = n.offsetParent) { ox += n.offsetLeft; oy += n.offsetTop; }
  for (let p = el.parentElement; p && p !== noteEl; p = p.parentElement) { ox -= p.scrollLeft; oy -= p.scrollTop; }
  return [lx - ox, ly - oy];
}

// ---------- appearance ----------

function applyColor() {
  noteEl.dataset.color = note.color;
  document.documentElement.dataset.color = note.color; // tints popovers + format toolbar
  for (const b of stylePop.querySelectorAll('[data-color]')) {
    b.setAttribute('aria-checked', String(b.dataset.color === note.color));
  }
  queueRedraw(); // ink follows the note color
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  for (const b of $('themes').querySelectorAll('[data-theme-id]')) {
    b.setAttribute('aria-checked', String(b.dataset.themeId === theme));
  }
  queueRedraw(); // pen color depends on the style
  if (note) queueFit();
}

$('themes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-theme-id]');
  if (!b) return;
  applyTheme(b.dataset.themeId);
  api.setTheme(b.dataset.themeId);
});
api.onTheme(applyTheme);
// Minimal follows system dark mode; redraw ink when it flips.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', queueRedraw);

function applyPinned() {
  pinBtn.setAttribute('aria-pressed', String(note.pinned));
  pinBtn.title = note.pinned ? 'Stop keeping on top' : 'Keep on top';
}

function applyTilt() {
  tiltInput.value = String(note.tilt);
  $('tiltReset').textContent = `${note.tilt > 0 ? '+' : ''}${note.tilt}°`;
  layout();
  sizeCanvas();
  queueFit();
}

function applyMode() {
  noteEl.dataset.mode = note.mode;
  const toDraw = note.mode !== 'draw';
  modeLabel.textContent = toDraw ? 'Draw' : 'Type';
  modeIcon.setAttribute('href', toDraw ? '#i-pencil' : '#i-type');
  $('modeBtn').title = `Switch to ${modeLabel.textContent.toLowerCase()} mode (${isMac ? '⌘' : 'Ctrl+'}D)`;
  editor.contentEditable = String(toDraw);
  if (note.mode === 'draw') hideFormat();
}

function setTool(t) {
  tool = t;
  noteEl.dataset.tool = t;
  $('penBtn').setAttribute('aria-pressed', String(t === 'pen'));
  $('eraserBtn').setAttribute('aria-pressed', String(t === 'eraser'));
}

// Largest base font size at which the text still fits without scrolling.
const hasManualSizes = () => !!editor.querySelector('[style*="font-size"]:not(li), [data-size]');

function fitText() {
  fitQueued = false;
  // Once the user sizes text themselves, auto-fit stops: otherwise sizing one line would
  // make every other line jump. The base is frozen at the last auto value (note.fontBase).
  if (hasManualSizes()) {
    if (!note.fontBase) {
      note.fontBase = parseFloat(editor.style.getPropertyValue('--base')) || FONT_EMPTY;
      api.update({ fontBase: note.fontBase });
    }
    editor.style.setProperty('--base', `${note.fontBase}px`);
    syncCheckboxes();
    if (!format.hidden) positionFormat();
    return;
  }
  if (note.fontBase) {
    note.fontBase = null; // all manual sizes cleared: back to auto-fit
    api.update({ fontBase: null });
  }
  if (!editor.textContent) {
    editor.style.setProperty('--base', `${FONT_EMPTY}px`);
    syncCheckboxes();
    return;
  }
  let lo = FONT_MIN;
  let hi = FONT_MAX;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    editor.style.setProperty('--base', `${mid}px`);
    if (editor.scrollHeight <= editor.clientHeight) lo = mid; else hi = mid - 1;
  }
  editor.style.setProperty('--base', `${lo}px`);
  syncCheckboxes();
  if (!format.hidden) positionFormat();
}

function queueFit() {
  if (fitQueued) return;
  fitQueued = true;
  // A timer, not rAF: rAF is paused while the window is still hidden at startup.
  setTimeout(fitText, 0);
}

// ---------- drawing ----------

function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redraw();
}

function drawStroke(s) {
  const p = s.p;
  if (p.length < 2) return;
  ctx.globalCompositeOperation = s.e ? 'destination-out' : 'source-over';
  ctx.lineWidth = s.w;
  ctx.beginPath();
  if (p.length === 2) {
    ctx.arc(p[0], p[1], s.w / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.moveTo(p[0], p[1]);
  // Quadratic curves through midpoints give smooth lines from sparse samples.
  for (let i = 2; i < p.length - 2; i += 2) {
    ctx.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
  }
  ctx.lineTo(p[p.length - 2], p[p.length - 1]);
  ctx.stroke();
}

function redraw() {
  redrawQueued = false;
  const ink = getComputedStyle(noteEl).getPropertyValue('--pen').trim() || '#000';
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  strokes.forEach(drawStroke);
  ctx.globalCompositeOperation = 'source-over';
}

function queueRedraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(redraw);
}

const round1 = (v) => Math.round(v * 10) / 10;

function addPoint(e) {
  const [lx, ly] = toLocal(e.clientX, e.clientY, canvas);
  const x = round1(lx);
  const y = round1(ly);
  const p = current.p;
  if (p.length >= 2 && Math.abs(p[p.length - 2] - x) < 0.8 && Math.abs(p[p.length - 1] - y) < 0.8) return;
  p.push(x, y);
}

canvas.addEventListener('pointerdown', (e) => {
  if (note.mode !== 'draw' || e.button !== 0 && e.button !== 5) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  // Pen tail / eraser button erases regardless of the selected tool.
  const erase = tool === 'eraser' || e.button === 5 || (e.buttons & 32) !== 0;
  current = erase
    ? { w: ERASER_WIDTH, e: 1, p: [] }
    : { w: e.pointerType === 'pen' ? 2.5 : PEN_WIDTH, p: [] };
  strokes.push(current);
  addPoint(e);
  queueRedraw();
});

canvas.addEventListener('pointermove', (e) => {
  if (!current) return;
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  for (const ce of (events.length ? events : [e])) addPoint(ce);
  queueRedraw();
});

function endStroke() {
  if (!current) return;
  current = null;
  // An eraser stroke over an empty canvas is noise; drop trailing erasers if nothing is left to erase.
  if (strokes.every((s) => s.e)) strokes = [];
  saveStrokes();
}
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);

function saveStrokes() {
  note.strokes = strokes;
  api.update({ strokes });
}

function undoStroke() {
  if (!strokes.length) return;
  strokes.pop();
  queueRedraw();
  saveStrokes();
}

function clearDrawing() {
  if (!strokes.length) return;
  strokes = [];
  queueRedraw();
  saveStrokes();
}

$('penBtn').addEventListener('click', () => setTool('pen'));
$('eraserBtn').addEventListener('click', () => setTool('eraser'));
$('undoBtn').addEventListener('click', undoStroke);
$('clearBtn').addEventListener('click', clearDrawing);

// ---------- text formatting ----------

function selectionInEditor() {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  return editor.contains(range.commonAncestorContainer) ? range : null;
}

function anchorElement() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  let n = r.startContainer;
  // Caret can sit "between children" of an element (e.g. editor > ul right after a list is
  // made); resolve to the node at that offset so closest() finds the real block.
  if (n.nodeType === Node.ELEMENT_NODE && n.childNodes.length) {
    n = n.childNodes[Math.min(r.startOffset, n.childNodes.length - 1)];
    while (n.nodeType === Node.ELEMENT_NODE && n.firstChild && n.tagName !== 'BR') n = n.firstChild;
  }
  return n.nodeType === Node.ELEMENT_NODE ? n : n.parentElement;
}

function currentAttr(name, fallback) {
  const el = anchorElement();
  const hit = el && el.closest(`[data-${name}]`);
  return hit && editor.contains(hit) ? hit.dataset[name] : fallback;
}

// Wrap the selection in a <span> and let `decorate` style it; `clean` strips the same
// property from nested elements so the new value wins. Uses execCommand's <font> output as
// a marker so the browser handles splitting across elements, then swaps <font> for spans.
function wrapSelection(decorate, clean) {
  restoreSelection();
  if (!selectionInEditor()) return;
  document.execCommand('styleWithCSS', false, false);
  document.execCommand('fontName', false, 'sticky-marker');
  const spans = [];
  for (const f of editor.querySelectorAll('font[face="sticky-marker"]')) {
    const span = document.createElement('span');
    decorate(span);
    span.append(...f.childNodes);
    span.querySelectorAll('*').forEach(clean);
    f.replaceWith(span);
    spans.push(span);
    // Ancestors that wrap exactly this text would otherwise pile up (31px > 30px > 29px…):
    // strip the same property from them so the new span is the only one that sets it.
    for (let p = span.parentElement; p && p !== editor && p.textContent === span.textContent; p = p.parentElement) {
      if (p.tagName === 'SPAN') clean(p);
    }
  }
  unwrapBareSpans();
  const live = spans.filter((s) => s.isConnected);
  if (live.length) {
    const range = document.createRange();
    range.setStart(live[0], 0);
    range.setEnd(live[live.length - 1], live[live.length - 1].childNodes.length);
    setSelection(range);
  }
  contentChanged();
}

function unwrapBareSpans() {
  for (const s of editor.querySelectorAll('span')) {
    if (s.getAttribute('style') === '') s.removeAttribute('style');
    if (!s.attributes.length) s.replaceWith(...s.childNodes);
  }
}

function setSelection(range) {
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  savedRange = range.cloneRange();
}

// Typing in the size box moves focus out of the editor; put the selection back first.
let savedRange = null;
function restoreSelection() {
  // Only needed when focus left the editor (e.g. the size box); otherwise keep the live caret.
  if (document.activeElement === editor || !savedRange) return;
  editor.focus({ preventScroll: true });
  setSelection(savedRange);
}

function currentSize() {
  const el = anchorElement();
  return el && editor.contains(el) ? Math.round(parseFloat(getComputedStyle(el).fontSize)) : 16;
}

function setSize(px) {
  const size = Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.round(px)));
  // Freeze the auto-fit base at what the user sees right now, before the first manual size.
  if (!hasManualSizes() && !note.fontBase) {
    note.fontBase = parseFloat(editor.style.getPropertyValue('--base')) || FONT_EMPTY;
    api.update({ fontBase: note.fontBase });
  }
  wrapSelection(
    (s) => { s.style.fontSize = `${size}px`; },
    (el) => { el.style.removeProperty('font-size'); delete el.dataset.size; },
  );
  sizeInput.value = String(size);
}

function setFont(font) {
  wrapSelection((s) => { s.dataset.font = font; }, (el) => { delete el.dataset.font; });
}

function setTextColor(tc) {
  wrapSelection((s) => { if (tc) s.dataset.tc = tc; }, (el) => { delete el.dataset.tc; });
}

function clearFormatting() {
  restoreSelection();
  const range = selectionInEditor();
  if (!range) return;
  document.execCommand('removeFormat');
  for (const el of editor.querySelectorAll('[data-size], [data-font], [data-tc], span[style]')) {
    if (range.intersectsNode(el)) {
      delete el.dataset.size;
      delete el.dataset.font;
      delete el.dataset.tc;
      el.removeAttribute('style');
    }
  }
  unwrapBareSpans();
  contentChanged();
}

// ---------- lists & checklists ----------

function blockList() {
  const el = anchorElement();
  const ul = el && el.closest('ul');
  return ul && editor.contains(ul) ? ul : null;
}

function toggleBullets() {
  restoreSelection();
  const ul = blockList();
  if (ul && ul.hasAttribute('data-check')) {
    ul.removeAttribute('data-check');
    ul.querySelectorAll('li').forEach((li) => li.removeAttribute('data-checked'));
  } else {
    document.execCommand('insertUnorderedList');
  }
  contentChanged();
}

function toggleChecklist() {
  restoreSelection();
  let ul = blockList();
  if (ul && ul.hasAttribute('data-check')) {
    document.execCommand('insertUnorderedList'); // back to plain text
  } else {
    if (!ul) document.execCommand('insertUnorderedList');
    ul = blockList();
    if (ul) {
      ul.setAttribute('data-check', '');
      ul.querySelectorAll(':scope > li').forEach((li) => {
        if (!li.dataset.checked) li.dataset.checked = 'false';
      });
      const sel = window.getSelection();
      if (sel.isCollapsed && !ul.contains(sel.anchorNode) && ul.lastElementChild) {
        const range = document.createRange();
        range.setStart(ul.lastElementChild, 0);
        range.collapse(true);
        setSelection(range);
      }
    }
  }
  contentChanged();
}

// Click on the box (left gutter of a checklist item) toggles it.
editor.addEventListener('mousedown', (e) => {
  const li = e.target instanceof Element && e.target.closest('ul[data-check] > li');
  if (!li || note.mode !== 'type') return;
  const [lx] = toLocal(e.clientX, e.clientY, li);
  // The box is .9em wide in the item's own font size; accept the whole gutter left of the text.
  const em = parseFloat(getComputedStyle(li).fontSize);
  if (lx > Math.max(em * 1.45, 18)) return;
  e.preventDefault();
  li.dataset.checked = li.dataset.checked === 'true' ? 'false' : 'true';
  replay(li, 'tick-pop'); // not "pop": that is the popover class
  if (li.dataset.checked === 'true') {
    const [x, y] = [e.clientX, e.clientY];
    confetti(x, y);
    react('surprised', 500);
  }
  contentChanged();
});

// New items start unchecked; "[] " and "- " at line start become lists (markdown-style).
function onEditorInput(e) {
  if (e.inputType === 'insertParagraph') {
    const el = anchorElement();
    const li = el && el.closest('ul[data-check] > li');
    if (li) li.dataset.checked = 'false';
  } else if (e.inputType === 'insertText' && e.data === ' ') {
    const sel = window.getSelection();
    const node = sel.anchorNode;
    if (node && node.nodeType === Node.TEXT_NODE && !node.previousSibling && !blockList()) {
      const before = node.data.slice(0, sel.anchorOffset);
      const check = /^\[ ?\][\s ]$/.test(before);
      const bullet = /^[-*][\s ]$/.test(before);
      if (check || bullet) {
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, sel.anchorOffset);
        setSelection(range);
        document.execCommand('delete');
        if (check) toggleChecklist(); else toggleBullets();
      }
    }
  }
  contentChanged();
}

// ---------- toolbar ----------

function refreshFormatState() {
  for (const b of format.querySelectorAll('[data-cmd]')) {
    b.classList.toggle('active', document.queryCommandState(b.dataset.cmd));
  }
  const ul = blockList();
  $('bulletBtn').classList.toggle('active', !!ul && !ul.hasAttribute('data-check'));
  $('checkBtn').classList.toggle('active', !!ul && ul.hasAttribute('data-check'));
  if (document.activeElement !== sizeInput) sizeInput.value = String(currentSize());
  const font = currentAttr('font', 'sans');
  const tc = currentAttr('tc', '');
  for (const b of moreRow.querySelectorAll('[data-font]')) b.classList.toggle('active', b.dataset.font === font);
  for (const b of moreRow.querySelectorAll('[data-tc]')) b.classList.toggle('active', b.dataset.tc === tc);
}

function positionFormat() {
  const range = selectionInEditor() || savedRange;
  if (!range) return;
  const r = range.getBoundingClientRect();
  const fw = format.offsetWidth;
  const fh = format.offsetHeight;
  let top = r.top - fh - 8;
  if (top < 4) top = Math.min(r.bottom + 8, window.innerHeight - fh - 4);
  const left = Math.max(4, Math.min(window.innerWidth - fw - 4, r.left + r.width / 2 - fw / 2));
  format.style.left = `${left}px`;
  format.style.top = `${Math.max(4, top)}px`;
}

function showFormat() {
  format.hidden = false;
  refreshFormatState();
  positionFormat();
}

function hideFormat() {
  format.hidden = true;
  moreRow.hidden = true;
  moreBtn.setAttribute('aria-expanded', 'false');
}

document.addEventListener('selectionchange', () => {
  const range = note && note.mode === 'type' ? selectionInEditor() : null;
  if (range) {
    savedRange = range.cloneRange();
    showFormat();
  } else if (!format.contains(document.activeElement)) {
    hideFormat();
  }
});

// Keep the editor selection while clicking toolbar buttons (but let the size box take focus).
format.addEventListener('mousedown', (e) => { if (e.target !== sizeInput) e.preventDefault(); });
format.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.cmd) {
    restoreSelection();
    document.execCommand('styleWithCSS', false, false);
    document.execCommand(btn.dataset.cmd);
    contentChanged();
  } else if (btn.dataset.sizeStep) {
    setSize(currentSize() + Number(btn.dataset.sizeStep));
  } else if (btn.dataset.font) {
    setFont(btn.dataset.font);
  } else if ('tc' in btn.dataset) {
    setTextColor(btn.dataset.tc);
  } else if (btn === moreBtn) {
    moreRow.hidden = !moreRow.hidden;
    moreBtn.setAttribute('aria-expanded', String(!moreRow.hidden));
  } else if (btn.id === 'bulletBtn') {
    toggleBullets();
  } else if (btn.id === 'checkBtn') {
    toggleChecklist();
  } else if (btn.id === 'clearFormat') {
    clearFormatting();
  }
  refreshFormatState();
  positionFormat();
});

sizeInput.addEventListener('focus', () => sizeInput.select());
sizeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const v = parseInt(sizeInput.value, 10);
    if (Number.isFinite(v)) setSize(v); else restoreSelection();
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const v = (parseInt(sizeInput.value, 10) || currentSize()) + (e.key === 'ArrowUp' ? 1 : -1);
    setSize(v);
    sizeInput.focus();
    sizeInput.select();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    restoreSelection();
  }
});
sizeInput.addEventListener('input', () => { sizeInput.value = sizeInput.value.replace(/\D/g, ''); });

editor.addEventListener('input', onEditorInput);
editor.addEventListener('blur', flushText);
// Paste and drop as plain text: keeps notes clean and blocks remote content.
editor.addEventListener('paste', (e) => {
  e.preventDefault();
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
});
editor.addEventListener('drop', (e) => e.preventDefault());
editor.addEventListener('scroll', () => { if (!format.hidden) positionFormat(); });

// ---------- header actions ----------

function setMode(mode) {
  if (note.mode === mode) return;
  note.mode = mode;
  applyMode();
  replay($('modeBtn'), 'flip');
  api.update({ mode });
  if (mode === 'draw') editor.blur(); else focusEnd();
}

function focusEnd() {
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

let closing = false;
function closeNote() {
  if (closing) return;
  closing = true;
  flushText();
  if (reduceMotion.matches) { api.close(); return; }
  poof();
  setTimeout(() => api.close(), 340);
}

// ---------- rotation: slider, menu, or hold the top bar (or Alt) and scroll ----------

const MAX_TILT = 15;
const WIN_MIN = { width: 300, height: 170 }; // mirrors MIN_SIZE in main.js
let tiltGesture = null;
let tiltSaveTimer = null;
let badgeTimer = null;
let wheelAcc = 0;

// Rotate while keeping the card's size: the window grows/shrinks around its center to fit
// the rotated card instead of the card shrinking inside a fixed window.
function rotateTo(target, { save = true } = {}) {
  const t = Math.max(-MAX_TILT, Math.min(MAX_TILT, Math.round(target)));
  if (t === note.tilt) return;
  if (!tiltGesture) tiltGesture = { w: noteEl.offsetWidth, h: noteEl.offsetHeight };
  clearTimeout(tiltGesture.timer);
  tiltGesture.timer = setTimeout(() => { tiltGesture = null; }, 600);
  const { w, h } = tiltGesture;
  const r = (Math.abs(t) * Math.PI) / 180;
  const W = Math.max(WIN_MIN.width, Math.ceil(w * Math.cos(r) + h * Math.sin(r) + GUTTER * 2));
  const H = Math.max(WIN_MIN.height, Math.ceil(w * Math.sin(r) + h * Math.cos(r) + GUTTER * 2));
  const dW = W - window.innerWidth;
  const dH = H - window.innerHeight;
  if (dragging) { dragging.wx -= dW / 2; dragging.wy -= dH / 2; }
  note.tilt = t;
  tiltInput.value = String(t);
  $('tiltReset').textContent = `${t > 0 ? '+' : ''}${t}°`;
  noteEl.style.setProperty('--tilt', `${t}deg`);
  if (dW || dH) api.resizeCentered(W, H); else layout(); // resize event re-runs layout
  showTiltBadge(t);
  if (save) {
    clearTimeout(tiltSaveTimer);
    tiltSaveTimer = setTimeout(() => api.update({ tilt: note.tilt }), 250);
  }
}

function showTiltBadge(t) {
  const badge = $('tiltBadge');
  badge.textContent = `${t > 0 ? '+' : ''}${t}°`;
  badge.hidden = false;
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => { badge.hidden = true; }, 700);
}

let rotatedWhileHeld = false;
let pressedOnCard = false;
noteEl.addEventListener('pointerdown', () => { pressedOnCard = true; });
window.addEventListener('pointerup', () => { pressedOnCard = false; });
window.addEventListener('blur', () => { pressedOnCard = false; });
// Listen on the whole window: as the card turns, the held pointer can end up just outside it.
window.addEventListener('wheel', (e) => {
  // Hold the mouse button anywhere on the card (or hold Alt over it) and scroll to rotate.
  const held = !!dragging || (pressedOnCard && (e.buttons & 1) === 1);
  const overCard = e.target instanceof Element && noteEl.contains(e.target);
  if (!held && !(e.altKey && overCard)) return;
  e.preventDefault();
  if (held) rotatedWhileHeld = true;
  wheelAcc += e.deltaY || e.deltaX;
  const steps = Math.trunc(wheelAcc / 50); // one mouse-wheel notch ≈ 2°
  if (!steps) return;
  wheelAcc -= steps * 50;
  rotateTo(note.tilt + steps);
}, { passive: false });

// Releasing the button after a hold-and-scroll rotate must not also "click" what was under it.
document.addEventListener('click', (e) => {
  if (!rotatedWhileHeld) return;
  rotatedWhileHeld = false;
  e.preventDefault();
  e.stopPropagation();
}, true);
document.addEventListener('pointerdown', () => { rotatedWhileHeld = false; }, true);

// ---------- line spacing ----------

function applyLineHeight() {
  if (note.lineHeight) editor.style.setProperty('--lh', String(note.lineHeight));
  else editor.style.removeProperty('--lh');
  for (const b of document.querySelectorAll('.spacing [data-lh]')) {
    b.setAttribute('aria-checked', String((Number(b.dataset.lh) || null) === (note.lineHeight || null)));
  }
  queueFit();
}

for (const group of document.querySelectorAll('.spacing')) {
  group.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lh]');
    if (!b) return;
    e.stopPropagation();
    note.lineHeight = Number(b.dataset.lh) || null;
    applyLineHeight();
    api.update({ lineHeight: note.lineHeight });
    if (!format.hidden) positionFormat();
  });
}

function toggleStylePop(open = stylePop.hidden) {
  stylePop.hidden = !open;
  styleBtn.classList.toggle('open', open);
}

$('modeBtn').addEventListener('click', () => setMode(note.mode === 'draw' ? 'type' : 'draw'));
$('closeBtn').addEventListener('click', closeNote);
styleBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleStylePop(); });

pinBtn.addEventListener('click', () => {
  note.pinned = !note.pinned;
  applyPinned();
  if (note.pinned) replay(pinBtn, 'bump');
  api.update({ pinned: note.pinned });
});

stylePop.addEventListener('click', (e) => {
  e.stopPropagation();
  const color = e.target.dataset && e.target.dataset.color;
  if (color && color !== note.color) {
    note.color = color;
    applyColor();
    replay(noteEl, 'jelly');
    api.update({ color });
  }
});
tiltInput.addEventListener('input', () => rotateTo(Number(tiltInput.value)));
$('tiltReset').addEventListener('click', () => rotateTo(0));

document.addEventListener('click', (e) => {
  if (!stylePop.hidden && !stylePop.contains(e.target)) toggleStylePop(false);
});

titleEl.addEventListener('input', () => {
  clearTimeout(titleTimer);
  titleTimer = setTimeout(() => {
    if (titleEl.value.trim()) api.update({ title: titleEl.value.trim() });
  }, SAVE_MS);
});
titleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); titleEl.blur(); }
});
titleEl.addEventListener('blur', () => {
  clearTimeout(titleTimer);
  const t = titleEl.value.trim();
  if (!t) { titleEl.value = note.title; return; }
  if (t !== note.title) { note.title = t; api.update({ title: t }); }
  titleEl.scrollLeft = 0;
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!stylePop.hidden) toggleStylePop(false);
    else if (!format.hidden) { window.getSelection().collapseToEnd(); hideFormat(); }
    else if (document.activeElement) document.activeElement.blur();
    return;
  }
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (note && note.mode === 'draw' && !mod && !e.altKey && document.activeElement !== titleEl) {
    if (e.key === 'e' || e.key === 'E') { setTool('eraser'); return; }
    if (e.key === 'p' || e.key === 'P') { setTool('pen'); return; }
  }
  if (!mod || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'n' && !e.shiftKey) { e.preventDefault(); flushText(); api.newNote(); }
  else if (k === 'w') { e.preventDefault(); closeNote(); }
  else if (k === 'd') { e.preventDefault(); setMode(note.mode === 'draw' ? 'type' : 'draw'); }
  else if (k === 'z' && !e.shiftKey && note.mode === 'draw') { e.preventDefault(); undoStroke(); }
  else if ((k === 'b' || k === 'i' || k === 'u') && note.mode === 'type') {
    // Native shortcut runs; refresh toolbar state after it.
    setTimeout(() => { contentChanged(); if (!format.hidden) refreshFormatState(); }, 0);
  }
});

// ---------- window drag (manual, so it works on rotated notes) ----------

bar.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('button, input')) return;
  e.preventDefault();
  bar.setPointerCapture(e.pointerId);
  dragging = {
    sx: e.screenX, sy: e.screenY, wx: window.screenX, wy: window.screenY, raf: 0, lastX: e.screenX, settle: 0,
  };
  document.body.classList.add('dragging');
  react('surprised', 350);
});
bar.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const x = dragging.wx + (e.screenX - dragging.sx);
  const y = dragging.wy + (e.screenY - dragging.sy);
  cancelAnimationFrame(dragging.raf);
  dragging.raf = requestAnimationFrame(() => api.move(x, y));
  // Sway like paper held at the top: lean into the direction of travel, settle when still.
  const vx = e.screenX - dragging.lastX;
  dragging.lastX = e.screenX;
  setSwing(Math.max(-6, Math.min(6, swingNow * 0.6 + vx * 0.5)));
  clearTimeout(dragging.settle);
  dragging.settle = setTimeout(() => setSwing(0), 90);
});
const endDrag = () => {
  if (dragging) clearTimeout(dragging.settle);
  dragging = null;
  document.body.classList.remove('dragging');
  setSwing(0); // the rotate transition overshoots, so it wobbles to rest
};
bar.addEventListener('pointerup', endDrag);
bar.addEventListener('pointercancel', endDrag);

// ---------- custom resize (transparent windows can't use native resize on Windows) ----------

const grip = $('grip');
grip.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  resizing = { sx: e.screenX, sy: e.screenY, w: window.outerWidth, h: window.outerHeight, raf: 0 };
});
grip.addEventListener('pointermove', (e) => {
  if (!resizing) return;
  const { sx, sy, w, h } = resizing;
  const nw = w + (e.screenX - sx);
  const nh = h + (e.screenY - sy);
  cancelAnimationFrame(resizing.raf);
  resizing.raf = requestAnimationFrame(() => api.resize(nw, nh));
});
const endResize = () => { resizing = null; };
grip.addEventListener('pointerup', endResize);
grip.addEventListener('pointercancel', endResize);

// Fonts like Marker load lazily and change text metrics; refit when they arrive.
document.fonts.addEventListener('loadingdone', () => { if (note) queueFit(); });
// Any change to the editor's box (window size, tilt, header height per style) needs a refit.
new ResizeObserver(() => { if (note) queueFit(); }).observe(editor);

window.addEventListener('resize', () => {
  if (!note) return;
  layout();
  sizeCanvas();
  queueFit();
});

// ---------- click-through for the transparent gutter ----------

document.addEventListener('mousemove', (e) => {
  lookAt(e.clientX, e.clientY);
  if (resizing || dragging) return;
  const overNote = e.target instanceof Element && e.target.closest('.note');
  if (overNote && !current) sparkleTrail(e.clientX, e.clientY);
  const want = !(e.target instanceof Element && e.target.closest('.note, .format'));
  if (want !== passthrough) {
    passthrough = want;
    api.setPassthrough(want);
  }
});

// ---------- focus styling ----------

window.addEventListener('focus', () => document.body.classList.add('focused'));
window.addEventListener('blur', () => {
  document.body.classList.remove('focused');
  flushText();
  toggleStylePop(false);
  hideFormat();
});
window.addEventListener('beforeunload', flushText);

// ---------- messages from main ----------

api.onChanged((patch) => {
  if ('tilt' in patch) { // context menu tilt: rotate keeping the card size
    rotateTo(patch.tilt, { save: false });
    delete patch.tilt;
  }
  Object.assign(note, patch);
  if ('color' in patch) applyColor();
  if ('pinned' in patch) applyPinned();
  if ('mode' in patch) applyMode();
  if ('tilt' in patch) applyTilt();
  if ('strokes' in patch) { strokes = note.strokes; queueRedraw(); }
});

function focusText() {
  if (!note) { wantFocus = true; return; } // focus request can beat init
  if (note.mode === 'type') focusEnd();
}
api.onFocus(focusText);

// ---------- fun: particles, eyes, reactions ----------

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const PARTY = ['#FFD84D', '#FF8FAB', '#6CC8FF', '#7DE38D', '#B79CFF', '#FF9F43'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const isToon = () => document.documentElement.dataset.theme === 'toon';

// Restart a CSS animation class on an element.
function replay(el, cls) {
  if (reduceMotion.matches) return;
  el.classList.remove(cls);
  void el.offsetWidth; // reflow so the animation starts over
  el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}

function particle(cls, x, y, vars) {
  if (reduceMotion.matches) return null;
  const el = document.createElement('i');
  el.className = `fx ${cls}`;
  el.style.setProperty('--x0', `${x}px`);
  el.style.setProperty('--y0', `${y}px`);
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
  document.body.append(el);
  const done = () => el.remove();
  el.addEventListener('animationend', done, { once: true });
  setTimeout(done, 1500);
  return el;
}

function confetti(x, y) {
  for (let i = 0; i < 16; i++) {
    const a = -Math.PI / 2 + rand(-1.25, 1.25);
    const sp = rand(28, 70);
    particle('confetti', x, y, {
      '--dx': `${Math.cos(a) * sp}px`,
      '--dy': `${Math.sin(a) * sp}px`,
      '--rot': `${rand(-540, 540)}deg`,
      '--col': pick(PARTY),
    });
  }
}

function poof() {
  react('surprised', 400);
  hideFormat();
  noteEl.classList.add('poof');
  const r = noteEl.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const toon = isToon();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + rand(-0.2, 0.2);
    const d = rand(30, 70);
    particle('puff', cx, cy, {
      '--dx': `${Math.cos(a) * d}px`,
      '--dy': `${Math.sin(a) * d}px`,
      '--s': `${rand(16, 32)}px`,
      '--col': toon ? '#fff' : 'rgb(255 255 255 / .85)',
      '--line': toon ? '#17171c' : 'transparent',
    });
  }
}

let lastSpark = 0;
let lastSparkPos = [0, 0];
function sparkleTrail(x, y) {
  if (!isToon() || reduceMotion.matches) return;
  const now = performance.now();
  if (now - lastSpark < 45 || Math.hypot(x - lastSparkPos[0], y - lastSparkPos[1]) < 8) return;
  if (document.querySelectorAll('.spark').length > 24) return;
  lastSpark = now;
  lastSparkPos = [x, y];
  particle('spark', x + rand(-4, 4), y + rand(-4, 4), { '--dx': `${rand(-14, 14)}px`, '--col': pick(PARTY) });
}

let swingNow = 0;
function setSwing(deg) {
  swingNow = deg;
  noteEl.style.setProperty('--swing', `${deg.toFixed(2)}deg`);
}

// Googly eyes: pupils point at the cursor anywhere on screen (main streams its position).
const eyesEl = $('eyes');
const pupils = [...eyesEl.querySelectorAll('b')];
let lookHoldUntil = 0;
function lookAt(clientX, clientY, hold = false) {
  if (!isToon() || !note) return;
  if (!hold && Date.now() < lookHoldUntil) return;
  const t = -((note.tilt + swingNow) * Math.PI) / 180; // undo the note's rotation
  for (const p of pupils) {
    const e = p.parentElement.getBoundingClientRect();
    const dx = clientX - (e.left + e.width / 2);
    const dy = clientY - (e.top + e.height / 2);
    const dist = Math.hypot(dx, dy) || 1;
    const reach = Math.min(3.6, dist / 10);
    const ux = dx / dist;
    const uy = dy / dist;
    p.style.setProperty('--px', `${(ux * Math.cos(t) - uy * Math.sin(t)) * reach}px`);
    p.style.setProperty('--py', `${(ux * Math.sin(t) + uy * Math.cos(t)) * reach}px`);
  }
}
api.onCursor((sx, sy) => lookAt(sx - window.screenX, sy - window.screenY));

// While typing, the eyes glance at the caret.
editor.addEventListener('input', () => {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const rects = sel.getRangeAt(0).getClientRects();
  const r = rects[rects.length - 1];
  if (!r) return;
  lookHoldUntil = Date.now() + 900;
  lookAt(r.right, r.top + r.height / 2, true);
});

function react(cls, ms) {
  if (!isToon()) return;
  eyesEl.classList.add(cls);
  setTimeout(() => eyesEl.classList.remove(cls), ms);
}

(function blinkLoop() {
  setTimeout(() => {
    if (isToon() && !document.hidden) {
      react('blink', 120);
      if (Math.random() < 0.2) setTimeout(() => react('blink', 110), 230);
    }
    blinkLoop();
  }, rand(2500, 6000));
}());

const PLACEHOLDERS = [
  'Scribble something…', 'Brain dump zone ✨', "What's cooking?", 'Psst… write here',
  'Big idea goes here 💡', 'Before you forget…', 'Type it, ship it 🚀',
];

function playEnter() {
  if (document.visibilityState === 'visible') replay(noteEl, 'enter');
  else document.addEventListener('visibilitychange', playEnter, { once: true });
}

// ---------- boot ----------

api.init().then(({ note: n, platform, theme }) => {
  if (!n) return;
  note = n;
  applyTheme(theme);
  isMac = platform === 'darwin';
  document.documentElement.dataset.platform = platform;
  strokes = note.strokes;
  titleEl.value = note.title;
  editor.innerHTML = note.html !== null
    ? sanitize(note.html)
    : escapeHtml(note.text).replace(/\n/g, '<br>');
  setTool('pen');
  applyColor();
  applyPinned();
  applyMode();
  applyTilt();
  if (note.fontBase) editor.style.setProperty('--base', `${note.fontBase}px`);
  applyLineHeight();
  editor.dataset.placeholder = pick(PLACEHOLDERS);
  if (document.hasFocus()) document.body.classList.add('focused');
  playEnter();
  if (wantFocus) focusText();
});
