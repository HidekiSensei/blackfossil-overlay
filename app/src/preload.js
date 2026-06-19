const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bf', {
  getSession: () => ipcRenderer.invoke('get-session'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveSession: (token) => ipcRenderer.invoke('save-session', token),
  logout: () => ipcRenderer.invoke('logout'),
  openLogin: () => ipcRenderer.send('open-login'),
  onSession: (cb) => ipcRenderer.on('session', (_e, token) => cb(token)),
});
