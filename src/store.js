'use strict';
// JSON-file persistence for notes. Writes are debounced and atomic (tmp + rename).
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const TRASH_LIMIT = 20;
const SAVE_DELAY_MS = 250;

let file = null;
let timer = null;
let data = { version: 1, nextNumber: 1, notes: [], trash: [], settings: {} };

function normalize(n) {
  return {
    id: n.id || randomUUID(),
    title: typeof n.title === 'string' ? n.title : 'Note',
    color: n.color || 'yellow',
    mode: n.mode === 'draw' ? 'draw' : 'type',
    text: typeof n.text === 'string' ? n.text : '',
    html: typeof n.html === 'string' ? n.html : null, // null = legacy plain-text note
    tilt: Number.isFinite(n.tilt) ? n.tilt : 0,
    strokes: Array.isArray(n.strokes) ? n.strokes : [],
    pinned: !!n.pinned,
    bounds: n.bounds || null,
    createdAt: n.createdAt || Date.now(),
    updatedAt: n.updatedAt || Date.now(),
  };
}

function load(dir) {
  file = path.join(dir, 'notes.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = {
      version: 1,
      nextNumber: Number(parsed.nextNumber) || 1,
      notes: (parsed.notes || []).map(normalize),
      trash: (parsed.trash || []).map(normalize),
      settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {},
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Keep the unreadable file so nothing is silently lost.
      try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
    }
  }
}

function saveNow() {
  clearTimeout(timer);
  timer = null;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function save() {
  clearTimeout(timer);
  timer = setTimeout(saveNow, SAVE_DELAY_MS);
}

function flush() {
  if (timer) saveNow();
}

const all = () => data.notes;
const get = (id) => data.notes.find((n) => n.id === id) || null;
const trash = () => data.trash;
const hasContent = (n) => n.text.trim().length > 0 || n.strokes.length > 0;

function create(fields) {
  const note = normalize({ title: `Note ${data.nextNumber++}`, ...fields });
  data.notes.push(note);
  save();
  return note;
}

function update(id, patch, { touch = true } = {}) {
  const note = get(id);
  if (!note) return null;
  Object.assign(note, patch);
  if (touch) note.updatedAt = Date.now();
  save();
  return note;
}

// Remove a note. Notes with content go to "Recently closed"; empty ones vanish.
function discard(id) {
  const i = data.notes.findIndex((n) => n.id === id);
  if (i < 0) return;
  const [note] = data.notes.splice(i, 1);
  if (hasContent(note)) {
    data.trash.unshift({ ...note, closedAt: Date.now() });
    data.trash.length = Math.min(data.trash.length, TRASH_LIMIT);
  }
  save();
}

function restore(id) {
  const i = data.trash.findIndex((n) => n.id === id);
  if (i < 0) return null;
  const [raw] = data.trash.splice(i, 1);
  const note = normalize(raw);
  data.notes.push(note);
  save();
  return note;
}

function emptyTrash() {
  data.trash = [];
  save();
}

const getSetting = (key, fallback) => (key in data.settings ? data.settings[key] : fallback);

function setSetting(key, value) {
  data.settings[key] = value;
  save();
}

module.exports = {
  load, flush, all, get, trash, create, update, discard, restore, emptyTrash, getSetting, setSetting,
};
