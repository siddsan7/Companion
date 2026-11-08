const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('companion', Object.fromEntries(['choose-vault', 'configure', 'state', 'capture', 'title', 'open-note', 'connect-drafts', 'check-intake', 'inspect-source', 'brief-select', 'brief-state', 'brief-propose', 'brief-approve', 'brief-pin'].map(name => [name, data => ipcRenderer.invoke(name, data)])));
