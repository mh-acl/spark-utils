'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('utilityAPI', {
  listTools: () => ipcRenderer.invoke('tools:list'),
  invokeTool: (id) => ipcRenderer.invoke('tools:invoke', id),
});
