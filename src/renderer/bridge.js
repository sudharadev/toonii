'use strict';
// Bridge between the pages and the Tauri main process (src-tauri/src/main.rs).
// Exposes the same small APIs the pages used under Electron: window.sticky for notes and
// window.menu for the right-click menu.
(() => {
  const T = window.__TAURI__;
  const invoke = T.core.invoke;
  const me = T.webviewWindow.getCurrentWebviewWindow();
  const on = (name, cb) => me.listen(name, (e) => cb(e.payload));

  window.sticky = {
    init: () => invoke('note_init'),
    ready: () => invoke('note_ready'),
    update: (patch) => invoke('note_update', { patch }),
    close: () => invoke('note_close'),
    newNote: () => invoke('note_new'),
    resize: (width, height) => invoke('note_resize', { width, height }),
    dragStart: () => invoke('note_drag_start'),
    dragMove: () => invoke('note_drag_move'), // resolves to the sideways step, for the sway
    dragEnd: () => invoke('note_drag_end'),
    resizeCentered: (width, height) => invoke('note_resize_centered', { width, height }),
    setStage: (req) => invoke('note_stage', { req }),
    setPassthrough: (ignore) => invoke('note_passthrough', { ignore }),
    showMenu: (ctx) => invoke('note_menu', { ctx }),
    setTheme: () => invoke('set_theme'),
    onChanged: (cb) => on('note:changed', cb),
    onFocus: (cb) => on('note:focus', () => cb()),
    onTheme: (cb) => on('app:theme', cb),
    // cursor in this window's own coordinates (CSS px), from anywhere on screen
    onCursor: (cb) => on('app:cursor', ([x, y]) => cb(x, y)),
    onMenuEdit: (cb) => on('menu:edit', cb),
  };

  window.menu = {
    onShow: (cb) => {
      on('menu:show', cb);
      invoke('menu_pending').then((spec) => { if (spec) cb(spec); }); // first open
    },
    ready: (width, height) => invoke('menu_ready', { width, height }),
    pick: (id, value) => invoke('menu_pick', { id, value: value === undefined ? null : value }),
    close: () => invoke('menu_close'),
  };
})();
