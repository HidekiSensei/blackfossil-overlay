const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bf', {
  getSession: () => ipcRenderer.invoke('get-session'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  sessionReady: (token) => ipcRenderer.send('session-ready', token),
  openLogin: () => ipcRenderer.send('open-login'),
  logout: () => ipcRenderer.send('logout'),
  setInteractive: (v) => ipcRenderer.send('set-interactive', v),
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, action) => cb(action)),
});
