'use strict';
const api = window.sticky;
const $ = (id) => document.getElementById(id);

const noteEl = $('note');
const titleEl = $('title');
const textEl = $('text');
const canvas = $('ink');
const ctx = canvas.getContext('2d');
const modeLabel = $('modeLabel');
const pinBtn = $('pinBtn');
const palette = $('palette');

const FONT_MAX = 36;
const FONT_MIN = 14;
const FONT_EMPTY = 18;
const TEXT_SAVE_MS = 350;

let note = null;
let isMac = false;
let strokes = [];
let current = null;
let canvasRect = null;
let textTimer = null;
let titleTimer = null;
let redrawQueued = false;
let fitQueued = false;
let resizing = null;
let passthrough = false;

// ---------- persistence ----------

function flushText() {
  if (textTimer === null) return;
  clearTimeout(textTimer);
  textTimer = null;
  api.update({ text: textEl.value });
}

function scheduleTextSave() {
  clearTimeout(textTimer);
  textTimer = setTimeout(flushText, TEXT_SAVE_MS);
}

// ---------- appearance ----------

function applyColor() {
  noteEl.dataset.color = note.color;
  for (const b of palette.querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.color === note.color));
  }
  queueRedraw(); // ink color follows the note color
}

function applyPinned() {
  pinBtn.setAttribute('aria-pressed', String(note.pinned));
  pinBtn.title = note.pinned ? 'Stop keeping on top' : 'Keep on top';
}

function applyMode() {
  noteEl.dataset.mode = note.mode;
  modeLabel.textContent = note.mode === 'draw' ? 'Type' : 'Draw';
  $('modeBtn').title = `Switch to ${modeLabel.textContent.toLowerCase()} mode (${isMac ? '⌘' : 'Ctrl+'}D)`;
  textEl.tabIndex = note.mode === 'draw' ? -1 : 0;
}

// Largest font size (between FONT_MIN and FONT_MAX) at which the text still fits.
function fitText() {
  fitQueued = false;
  if (!textEl.value) { textEl.style.fontSize = `${FONT_EMPTY}px`; return; }
  let lo = FONT_MIN;
  let hi = FONT_MAX;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    textEl.style.fontSize = `${mid}px`;
    if (textEl.scrollHeight <= textEl.clientHeight + 1) lo = mid; else hi = mid - 1;
  }
  textEl.style.fontSize = `${lo}px`;
}

function queueFit() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(fitText);
}

// ---------- drawing ----------

function sizeCanvas() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redraw();
}

function drawStroke(s) {
  const p = s.p;
  if (p.length < 2) return;
  ctx.lineWidth = s.w;
  if (p.length === 2) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], s.w / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
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
}

function queueRedraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(redraw);
}

const round1 = (v) => Math.round(v * 10) / 10;

function addPoint(e) {
  const x = round1(e.clientX - canvasRect.left);
  const y = round1(e.clientY - canvasRect.top);
  const p = current.p;
  if (p.length >= 2 && Math.abs(p[p.length - 2] - x) < 0.8 && Math.abs(p[p.length - 1] - y) < 0.8) return;
  p.push(x, y);
}

canvas.addEventListener('pointerdown', (e) => {
  if (note.mode !== 'draw' || e.button !== 0) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  canvasRect = canvas.getBoundingClientRect();
  current = { w: e.pointerType === 'pen' ? 2.5 : 3, p: [] };
  strokes.push(current);
  addPoint(e);
  queueRedraw();
});

canvas.addEventListener('pointermove', (e) => {
  if (!current) return;
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ce of (events.length ? events : [e])) addPoint(ce);
  queueRedraw();
});

function endStroke() {
  if (!current) return;
  current = null;
  api.update({ strokes });
}
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);

function undoStroke() {
  if (!strokes.length) return;
  strokes.pop();
  queueRedraw();
  api.update({ strokes });
}

// ---------- actions ----------

function setMode(mode) {
  if (note.mode === mode) return;
  note.mode = mode;
  applyMode();
  api.update({ mode });
  if (mode === 'draw') {
    textEl.blur();
  } else {
    textEl.focus();
    textEl.setSelectionRange(textEl.value.length, textEl.value.length);
  }
}

function closeNote() {
  flushText();
  api.close();
}

function togglePalette(open = palette.hidden) {
  palette.hidden = !open;
}

$('modeBtn').addEventListener('click', () => setMode(note.mode === 'draw' ? 'type' : 'draw'));
$('closeBtn').addEventListener('click', closeNote);
$('colorBtn').addEventListener('click', (e) => { e.stopPropagation(); togglePalette(); });

pinBtn.addEventListener('click', () => {
  note.pinned = !note.pinned;
  applyPinned();
  api.update({ pinned: note.pinned });
});

palette.addEventListener('click', (e) => {
  const color = e.target.dataset && e.target.dataset.color;
  if (!color) return;
  note.color = color;
  applyColor();
  api.update({ color });
  togglePalette(false);
});

document.addEventListener('click', (e) => {
  if (!palette.hidden && !palette.contains(e.target)) togglePalette(false);
});

textEl.addEventListener('input', () => {
  note.text = textEl.value;
  scheduleTextSave();
  queueFit();
});
textEl.addEventListener('blur', flushText);

titleEl.addEventListener('input', () => {
  clearTimeout(titleTimer);
  titleTimer = setTimeout(() => {
    if (titleEl.value.trim()) api.update({ title: titleEl.value.trim() });
  }, TEXT_SAVE_MS);
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
    if (!palette.hidden) togglePalette(false);
    else if (document.activeElement) document.activeElement.blur();
    return;
  }
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'n' && !e.shiftKey) { e.preventDefault(); flushText(); api.newNote(); }
  else if (k === 'w') { e.preventDefault(); closeNote(); }
  else if (k === 'd') { e.preventDefault(); setMode(note.mode === 'draw' ? 'type' : 'draw'); }
  else if (k === 'z' && !e.shiftKey && note.mode === 'draw') { e.preventDefault(); undoStroke(); }
});

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

window.addEventListener('resize', () => { sizeCanvas(); queueFit(); });

// ---------- click-through for the transparent shadow gutter ----------

document.addEventListener('mousemove', (e) => {
  if (resizing) return;
  const want = !(e.target instanceof Element && e.target.closest('.note'));
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
  togglePalette(false);
});
window.addEventListener('beforeunload', flushText);

// ---------- messages from main ----------

api.onChanged((patch) => {
  Object.assign(note, patch);
  if ('color' in patch) applyColor();
  if ('pinned' in patch) applyPinned();
  if ('mode' in patch) applyMode();
  if ('strokes' in patch) { strokes = note.strokes; queueRedraw(); }
});

let wantFocus = false;
function focusText() {
  if (!note) { wantFocus = true; return; } // focus request can beat init
  if (note.mode !== 'type') return;
  textEl.focus();
  textEl.setSelectionRange(textEl.value.length, textEl.value.length);
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
  textEl.value = note.text;
  applyColor();
  applyPinned();
  applyMode();
  if (document.hasFocus()) document.body.classList.add('focused');
  sizeCanvas();
  fitText();
  if (wantFocus) focusText();
});
