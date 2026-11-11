'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sticky', {
  init: () => ipcRenderer.invoke('note:init'),
  update: (patch) => ipcRenderer.send('note:update', patch),
  close: () => ipcRenderer.send('note:close'),
  newNote: () => ipcRenderer.send('note:new'),
  resize: (width, height) => ipcRenderer.send('note:resize', width, height),
  move: (x, y) => ipcRenderer.send('note:move', x, y),
  setPassthrough: (ignore) => ipcRenderer.send('note:passthrough', ignore),
  onChanged: (cb) => ipcRenderer.on('note:changed', (_e, patch) => cb(patch)),
  onFocus: (cb) => ipcRenderer.on('note:focus', () => cb()),
  setTheme: (theme) => ipcRenderer.send('app:set-theme', theme),
  onTheme: (cb) => ipcRenderer.on('app:theme', (_e, theme) => cb(theme)),
});
