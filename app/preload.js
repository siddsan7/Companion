const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('companion', Object.fromEntries(['choose-vault', 'configure', 'state', 'capture', 'title', 'open-note', 'codex-state', 'codex-action'].map(name => [name, data => ipcRenderer.invoke(name, data)])));
