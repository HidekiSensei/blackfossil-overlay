// Bewusst eine echte TEILMENGE der Overlay-Bridge (src/preload.js).
// Nicht vorhanden und auch nicht nachzuruesten: setInteractive, setOverlayBounds,
// Hotkey-, Voice- und Game-Focus-Bruecken, captureScreen. Geteilte Panel-Module
// duerfen `window.bf` deshalb nie direkt anfassen — alles laeuft ueber ctx.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bf', {
  getSession: () => ipcRenderer.invoke('get-session'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  copyText: (t) => ipcRenderer.invoke('copy-text', t),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  openLogin: () => ipcRenderer.send('open-login'),
  logout: () => ipcRenderer.send('logout'),
  onSessionChanged: (cb) => ipcRenderer.on('session-changed', () => cb()),
  onLoginError: (cb) => ipcRenderer.on('login-error', (_e, msg) => cb(msg)),
});
