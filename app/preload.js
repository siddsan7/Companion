const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('companion', Object.fromEntries(['choose-vault', 'configure', 'state', 'capture', 'title', 'open-note'].map(name => [name, data => ipcRenderer.invoke(name, data)])));
