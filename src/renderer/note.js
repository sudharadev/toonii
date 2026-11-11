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
const fontsRow = $('fonts');

const GUTTER = 16;
const FONT_MAX = 36;
const FONT_MIN = 14;
const FONT_EMPTY = 18;
const SAVE_MS = 350;
const PEN_WIDTH = 3;
const ERASER_WIDTH = 18;
const SIZES = ['s', 'm', 'l', 'xl'];
const FONTS = ['sans', 'serif', 'mono', 'hand', 'marker'];
const FONT_LABELS = { sans: 'Sans', serif: 'Serif', mono: 'Mono', hand: 'Hand', marker: 'Marker' };

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
    for (const attr of [...child.attributes]) {
      const ok = (attr.name === 'data-size' && SIZES.includes(attr.value))
        || (attr.name === 'data-font' && FONTS.includes(attr.value));
      if (!ok) child.removeAttribute(attr.name);
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
  api.update({ html: editor.innerHTML, text: editorText() });
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
    rotate: `${note ? note.tilt : 0}deg`,
  });
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
  return [lx - ox, ly - oy];
}

// ---------- appearance ----------

function applyColor() {
  noteEl.dataset.color = note.color;
  for (const b of stylePop.querySelectorAll('[data-color]')) {
    b.setAttribute('aria-checked', String(b.dataset.color === note.color));
  }
  queueRedraw(); // ink follows the note color
}

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
function fitText() {
  fitQueued = false;
  if (!editor.textContent) { editor.style.setProperty('--base', `${FONT_EMPTY}px`); return; }
  let lo = FONT_MIN;
  let hi = FONT_MAX;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    editor.style.setProperty('--base', `${mid}px`);
    if (editor.scrollHeight <= editor.clientHeight + 1) lo = mid; else hi = mid - 1;
  }
  editor.style.setProperty('--base', `${lo}px`);
  if (!format.hidden) positionFormat();
}

function queueFit() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(fitText);
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
  const ink = getComputedStyle(noteEl).getPropertyValue('--ink').trim() || '#000';
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
  const n = sel.getRangeAt(0).startContainer;
  return n.nodeType === Node.ELEMENT_NODE ? n : n.parentElement;
}

function currentAttr(name, fallback) {
  const el = anchorElement();
  const hit = el && el.closest(`[data-${name}]`);
  return hit && editor.contains(hit) ? hit.dataset[name] : fallback;
}

// Wrap the selection in <span data-{attr}={value}>. Uses execCommand's <font> output as a
// marker so the browser handles splitting across elements, then swaps <font> for spans.
function applySpanAttr(attr, value) {
  document.execCommand('styleWithCSS', false, false);
  document.execCommand('fontName', false, 'sticky-marker');
  const spans = [];
  for (const f of editor.querySelectorAll('font[face="sticky-marker"]')) {
    const span = document.createElement('span');
    span.dataset[attr] = value;
    span.append(...f.childNodes);
    for (const inner of span.querySelectorAll(`[data-${attr}]`)) delete inner.dataset[attr];
    f.replaceWith(span);
    spans.push(span);
  }
  unwrapBareSpans();
  if (spans.length) {
    const live = spans.filter((s) => s.isConnected);
    if (live.length) {
      const range = document.createRange();
      range.setStartBefore(live[0]);
      range.setEndAfter(live[live.length - 1]);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
  contentChanged();
}

function unwrapBareSpans() {
  for (const s of editor.querySelectorAll('span')) {
    if (!s.attributes.length) s.replaceWith(...s.childNodes);
  }
}

function stepSize(step) {
  const i = SIZES.indexOf(currentAttr('size', 'm'));
  const next = SIZES[Math.max(0, Math.min(SIZES.length - 1, i + step))];
  applySpanAttr('size', next);
}

function clearFormatting() {
  const range = selectionInEditor();
  if (!range) return;
  document.execCommand('removeFormat');
  for (const el of editor.querySelectorAll('[data-size], [data-font]')) {
    if (range.intersectsNode(el)) { delete el.dataset.size; delete el.dataset.font; }
  }
  unwrapBareSpans();
  contentChanged();
}

function refreshFormatState() {
  for (const b of format.querySelectorAll('[data-cmd]')) {
    b.classList.toggle('active', document.queryCommandState(b.dataset.cmd));
  }
  const font = currentAttr('font', 'sans');
  $('fontLabel').textContent = FONT_LABELS[font];
  for (const b of fontsRow.querySelectorAll('[data-font]')) b.classList.toggle('active', b.dataset.font === font);
}

function positionFormat() {
  const range = selectionInEditor();
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
  fontsRow.hidden = true;
  $('fontBtn').classList.remove('open');
}

document.addEventListener('selectionchange', () => {
  if (note && note.mode === 'type' && selectionInEditor()) showFormat();
  else if (!format.contains(document.activeElement)) hideFormat();
});

// Keep the editor selection while clicking toolbar buttons.
format.addEventListener('mousedown', (e) => e.preventDefault());
format.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.cmd) {
    document.execCommand('styleWithCSS', false, false);
    document.execCommand(btn.dataset.cmd);
    contentChanged();
  } else if (btn.dataset.sizeStep) {
    stepSize(Number(btn.dataset.sizeStep));
  } else if (btn.dataset.font) {
    applySpanAttr('font', btn.dataset.font);
  } else if (btn.id === 'fontBtn') {
    fontsRow.hidden = !fontsRow.hidden;
    btn.classList.toggle('open', !fontsRow.hidden);
  } else if (btn.id === 'clearFormat') {
    clearFormatting();
  }
  refreshFormatState();
  positionFormat();
});

editor.addEventListener('input', contentChanged);
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

function closeNote() {
  flushText();
  api.close();
}

function setTilt(tilt) {
  note.tilt = tilt;
  applyTilt();
  api.update({ tilt });
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
  api.update({ pinned: note.pinned });
});

stylePop.addEventListener('click', (e) => {
  e.stopPropagation();
  const color = e.target.dataset && e.target.dataset.color;
  if (color) {
    note.color = color;
    applyColor();
    api.update({ color });
  }
});
tiltInput.addEventListener('input', () => setTilt(Number(tiltInput.value)));
$('tiltReset').addEventListener('click', () => setTilt(0));

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
  dragging = { sx: e.screenX, sy: e.screenY, wx: window.screenX, wy: window.screenY, raf: 0 };
  document.body.classList.add('dragging');
});
bar.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const x = dragging.wx + (e.screenX - dragging.sx);
  const y = dragging.wy + (e.screenY - dragging.sy);
  cancelAnimationFrame(dragging.raf);
  dragging.raf = requestAnimationFrame(() => api.move(x, y));
});
const endDrag = () => { dragging = null; document.body.classList.remove('dragging'); };
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

window.addEventListener('resize', () => {
  if (!note) return;
  layout();
  sizeCanvas();
  queueFit();
});

// ---------- click-through for the transparent gutter ----------

document.addEventListener('mousemove', (e) => {
  if (resizing || dragging) return;
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

// ---------- boot ----------

api.init().then(({ note: n, platform }) => {
  if (!n) return;
  note = n;
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
  if (document.hasFocus()) document.body.classList.add('focused');
  if (wantFocus) focusText();
});
