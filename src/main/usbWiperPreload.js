const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('usbWiperAPI', {
  startSession: () => ipcRenderer.invoke('usb-wiper:start-session'),
  stopSession: () => ipcRenderer.invoke('usb-wiper:stop-session'),
  getRenameSettings: () => ipcRenderer.invoke('usb-wiper:get-rename-settings'),
  saveRenameSettings: (settings) => ipcRenderer.invoke('usb-wiper:save-rename-settings', settings),
  onStatus: (callback) => {
    ipcRenderer.on('usb-wiper:status', (_event, data) => callback(data));
  },
  onSessionEnded: (callback) => {
    ipcRenderer.on('usb-wiper:session-ended', (_event, data) => callback(data));
  },
});
