'use strict';
// Bridge for the custom right-click menu window.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('menu', {
  onShow: (cb) => ipcRenderer.on('menu:show', (_e, spec) => cb(spec)),
  ready: (width, height) => ipcRenderer.send('menu:ready', width, height),
  pick: (id, value) => ipcRenderer.send('menu:pick', id, value),
  close: () => ipcRenderer.send('menu:close'),
});
