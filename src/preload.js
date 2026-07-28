'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Sichere Brücke zwischen Renderer und Hauptprozess.
contextBridge.exposeInMainWorld('losteria', {
  loadMenu: () => ipcRenderer.invoke('menu:load'),
});
