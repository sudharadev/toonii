'use strict';
const {
  app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, nativeImage, screen, shell,
} = require('electron');
const path = require('path');
const store = require('./store');

const isMac = process.platform === 'darwin';
// Window sizes include an 18px transparent gutter on each side for the drop shadow.
const DEFAULT_SIZE = { width: 316, height: 256 };
const MIN_SIZE = { width: 216, height: 150 };
const COLORS = [
  ['yellow', 'Yellow'], ['blue', 'Blue'], ['green', 'Green'],
  ['pink', 'Pink'], ['purple', 'Purple'], ['gray', 'Gray'],
];
const COLOR_IDS = COLORS.map(([id]) => id);
const SHORTCUTS = { newNote: 'CommandOrControl+Alt+N', toggleAll: 'CommandOrControl+Alt+H' };

const windows = new Map(); // note id -> BrowserWindow
let tray = null;
let notesHidden = false;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------- placement ----------

function ensureOnScreen(bounds) {
  const b = { ...DEFAULT_SIZE, ...(bounds || {}) };
  const cx = b.x + b.width / 2;
  const cy = b.y + 24;
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    cx >= a.x && cx <= a.x + a.width && cy >= a.y && cy <= a.y + a.height);
  if (b.x !== undefined && visible) return b;
  return { ...b, ...placeNew() };
}

function placeNew(nearWin) {
  let x; let y; let area;
  if (nearWin && !nearWin.isDestroyed()) {
    const b = nearWin.getBounds();
    area = screen.getDisplayMatching(b).workArea;
    x = b.x + 32;
    y = b.y + 32;
  } else {
    area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    x = Math.round(area.x + area.width / 2 - DEFAULT_SIZE.width / 2);
    y = Math.round(area.y + area.height / 3 - DEFAULT_SIZE.height / 2);
  }
  const taken = () => store.all().some((n) =>
    n.bounds && Math.abs(n.bounds.x - x) < 10 && Math.abs(n.bounds.y - y) < 10);
  for (let i = 0; i < 30 && taken(); i++) { x += 32; y += 32; }
  return {
    x: clamp(x, area.x, area.x + area.width - DEFAULT_SIZE.width),
    y: clamp(y, area.y, area.y + area.height - DEFAULT_SIZE.height),
  };
}

// ---------- windows ----------

function setOnTop(win, pinned) {
  win.setAlwaysOnTop(pinned, 'floating');
}

function raise(win, note) {
  // Toggling topmost brings a window to the front without stealing focus (Windows).
  win.setAlwaysOnTop(true, 'floating');
  setOnTop(win, note.pinned);
  win.moveTop();
}

function openWindow(note, { focus = false } = {}) {
  const bounds = ensureOnScreen(note.bounds);
  if (!note.bounds || bounds.x !== note.bounds.x || bounds.y !== note.bounds.y) {
    store.update(note.id, { bounds }, { touch: false });
  }

  const win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false, // custom grip; transparent windows can't use native resize on Windows
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    title: note.title,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  win.noteId = note.id;
  windows.set(note.id, win);
  setOnTop(win, note.pinned);

  win.loadFile(path.join(__dirname, 'renderer', 'note.html'));

  win.once('ready-to-show', () => {
    if (focus) {
      win.show();
      raise(win, note);
      win.focus();
      win.webContents.send('note:focus');
    } else if (!notesHidden) {
      win.showInactive();
    }
  });

  const saveBounds = debounce(() => {
    if (!win.isDestroyed()) store.update(note.id, { bounds: win.getBounds() }, { touch: false });
  }, 300);
  win.on('move', saveBounds);
  win.on('resize', saveBounds);
  win.on('closed', () => {
    if (windows.get(note.id) === win) windows.delete(note.id);
    refreshTray();
  });

  if (!app.isPackaged) {
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning') console.log(`[note] ${e.message}`);
    });
  }
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('context-menu', (_e, params) => showContextMenu(win, params));
  return win;
}

function createNote({ near, text = '' } = {}) {
  const color = COLOR_IDS[(store.all().length + store.trash().length) % COLOR_IDS.length];
  const note = store.create({ bounds: { ...DEFAULT_SIZE, ...placeNew(near) }, text, color });
  notesHidden = false;
  openWindow(note, { focus: true });
  refreshTray();
  return note;
}

function closeNote(id) {
  const win = windows.get(id);
  store.discard(id);
  windows.delete(id);
  if (win && !win.isDestroyed()) win.destroy();
  refreshTray();
}

function restoreNote(id) {
  const note = store.restore(id);
  if (!note) return;
  notesHidden = false;
  openWindow(note, { focus: true });
  refreshTray();
}

// Apply a property change coming from main-process UI (menus) and tell the renderer.
function setNoteProps(id, patch) {
  const note = store.update(id, patch);
  const win = windows.get(id);
  if (!note || !win || win.isDestroyed()) return;
  if ('pinned' in patch) setOnTop(win, note.pinned);
  win.webContents.send('note:changed', patch);
}

function anyVisible() {
  return [...windows.values()].some((w) => !w.isDestroyed() && w.isVisible());
}

function showAll() {
  notesHidden = false;
  let last = null;
  for (const note of store.all()) {
    let win = windows.get(note.id);
    if (!win || win.isDestroyed()) {
      win = openWindow(note);
    } else {
      win.showInactive();
      raise(win, note);
    }
    last = win;
  }
  if (last && last.isVisible()) last.focus();
  refreshTray();
}

function hideAll() {
  notesHidden = true;
  windows.forEach((w) => { if (!w.isDestroyed()) w.hide(); });
  refreshTray();
}

function toggleAll() {
  if (anyVisible()) hideAll(); else showAll();
}

// ---------- menus ----------

function noteMenuItems(win) {
  const note = store.get(win.noteId);
  if (!note) return [];
  return [
    {
      label: 'Color',
      submenu: COLORS.map(([id, label]) => ({
        label, type: 'radio', checked: note.color === id,
        click: () => setNoteProps(note.id, { color: id }),
      })),
    },
    {
      label: 'Keep on top', type: 'checkbox', checked: note.pinned,
      click: () => setNoteProps(note.id, { pinned: !note.pinned }),
    },
    {
      label: 'Clear drawing', enabled: note.strokes.length > 0,
      click: () => setNoteProps(note.id, { strokes: [] }),
    },
    { type: 'separator' },
    { label: 'New note', click: () => createNote({ near: win }) },
    { label: 'Close note', click: () => closeNote(note.id) },
  ];
}

function showContextMenu(win, params) {
  const items = [];
  if (params.misspelledWord) {
    const suggestions = params.dictionarySuggestions.slice(0, 5);
    if (suggestions.length === 0) items.push({ label: 'No suggestions', enabled: false });
    for (const s of suggestions) {
      items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) });
    }
    items.push({ type: 'separator' });
  }
  if (params.isEditable) {
    items.push(
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { role: 'selectAll' },
      { type: 'separator' },
    );
  } else if (params.selectionText) {
    items.push({ role: 'copy' }, { type: 'separator' });
  }
  items.push(...noteMenuItems(win));
  Menu.buildFromTemplate(items).popup({ window: win });
}

function describe(note) {
  const snippet = note.text.trim().replace(/\s+/g, ' ');
  const body = snippet ? (snippet.length > 32 ? `${snippet.slice(0, 32)}…` : snippet) : '(drawing)';
  return `${note.title} — ${body}`;
}

function refreshTray() {
  if (!tray) return;
  const trash = store.trash();
  const recent = trash.length
    ? [
      ...trash.slice(0, 10).map((n) => ({ label: describe(n), click: () => restoreNote(n.id) })),
      { type: 'separator' },
      { label: 'Clear list', click: () => { store.emptyTrash(); refreshTray(); } },
    ]
    : [{ label: 'Nothing here', enabled: false }];

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'New note', accelerator: SHORTCUTS.newNote, registerAccelerator: false, click: () => createNote() },
    {
      label: anyVisible() ? 'Hide all notes' : 'Show all notes',
      accelerator: SHORTCUTS.toggleAll, registerAccelerator: false, click: toggleAll,
    },
    { type: 'separator' },
    { label: 'Recently closed', submenu: recent },
    { type: 'separator' },
    {
      label: 'Open at login', type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { label: 'Quit Stickynotee', click: () => app.quit() },
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('Stickynotee');
  if (!isMac) tray.on('click', showAll);
  refreshTray();
}

function createAppMenu() {
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }
  // macOS needs an Edit menu for ⌘C/⌘V. Note shortcuts are handled in the renderer,
  // so these accelerators are display-only.
  const focusedNote = () => {
    const w = BrowserWindow.getFocusedWindow();
    return w && w.noteId ? w : null;
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'New Note', accelerator: 'Cmd+N', registerAccelerator: false, click: () => createNote({ near: focusedNote() }) },
        {
          label: 'Close Note', accelerator: 'Cmd+W', registerAccelerator: false,
          click: () => { const w = focusedNote(); if (w) closeNote(w.noteId); },
        },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Window',
      submenu: [
        { label: 'Show All Notes', click: showAll },
        { label: 'Hide All Notes', click: hideAll },
      ],
    },
  ]));
}

function registerShortcuts() {
  for (const [accel, fn] of [[SHORTCUTS.newNote, () => createNote()], [SHORTCUTS.toggleAll, toggleAll]]) {
    if (!globalShortcut.register(accel, fn)) console.warn(`Shortcut ${accel} is taken by another app`);
  }
}

// ---------- IPC ----------

const noteFor = (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win && win.noteId ? { win, note: store.get(win.noteId) } : { win, note: null };
};

function sanitize(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  if (typeof patch.title === 'string') out.title = patch.title.slice(0, 80);
  if (typeof patch.text === 'string') out.text = patch.text.slice(0, 200000);
  if (Array.isArray(patch.strokes)) out.strokes = patch.strokes.slice(0, 5000);
  if (patch.mode === 'type' || patch.mode === 'draw') out.mode = patch.mode;
  if (COLOR_IDS.includes(patch.color)) out.color = patch.color;
  if (typeof patch.pinned === 'boolean') out.pinned = patch.pinned;
  return out;
}

ipcMain.handle('note:init', (event) => {
  const { note } = noteFor(event);
  return { note, platform: process.platform };
});

ipcMain.on('note:update', (event, patch) => {
  const { win, note } = noteFor(event);
  if (!note) return;
  const clean = sanitize(patch);
  store.update(note.id, clean);
  if ('pinned' in clean) setOnTop(win, clean.pinned);
  if ('title' in clean) win.setTitle(clean.title);
});

ipcMain.on('note:close', (event) => {
  const { note } = noteFor(event);
  if (note) closeNote(note.id);
});

ipcMain.on('note:new', (event) => {
  const { win } = noteFor(event);
  createNote({ near: win });
});

ipcMain.on('note:resize', (event, width, height) => {
  const { win } = noteFor(event);
  if (!win || !Number.isFinite(width) || !Number.isFinite(height)) return;
  const b = win.getBounds();
  win.setBounds({
    x: b.x, y: b.y,
    width: Math.max(MIN_SIZE.width, Math.round(width)),
    height: Math.max(MIN_SIZE.height, Math.round(height)),
  });
});

ipcMain.on('note:passthrough', (event, ignore) => {
  const { win } = noteFor(event);
  if (win) win.setIgnoreMouseEvents(!!ignore, { forward: true });
});

// ---------- lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showAll);

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.stickynotee.app');
    store.load(app.getPath('userData'));
    createAppMenu();
    createTray();
    registerShortcuts();

    const notes = store.all();
    if (notes.length === 0) {
      createNote({ text: 'Hi! Drag me by the top bar.\nCtrl+Alt+N makes a new note.' });
    } else {
      notes.forEach((n) => openWindow(n));
    }
  });

  app.on('activate', showAll); // macOS dock click
  app.on('window-all-closed', () => { /* stay alive in the tray */ });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    store.flush();
  });
}
