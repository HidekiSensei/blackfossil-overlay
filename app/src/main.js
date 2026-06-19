const { app, BrowserWindow, ipcMain, shell, session, globalShortcut, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const TOKEN_BASE = 'https://voice.blackfossil.de';
const SESSION_FILE = path.join(app.getPath('userData'), 'session.json');

// Standard-Hotkeys (später konfigurierbar)
const HOTKEYS = {
  'connect-toggle': 'F8',
  'mic-toggle':     'F9',
  'settings-toggle':'F10',
  'map-toggle':     'F7',
};

let loginWindow = null;
let overlayWindow = null;
let pendingDeepLink = null;

// ── Single-Instance ─────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => a.startsWith('blackfossil://'));
    if (url) handleDeepLink(url);
  });
}

if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient('blackfossil', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('blackfossil');
}
app.on('open-url', (_e, url) => handleDeepLink(url));

function handleDeepLink(url) {
  try {
    const token = new URL(url).searchParams.get('session');
    if (token) onSessionObtained(token);
  } catch (err) { console.error('Deep-Link Fehler:', err); }
}

// ── Session ──────────────────────────────────────────────────────────────
function saveSession(token) { try { fs.writeFileSync(SESSION_FILE, JSON.stringify({ token }), 'utf8'); } catch {} }
function loadSession() { try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).token; } catch { return null; } }
function clearSession() { try { fs.unlinkSync(SESSION_FILE); } catch {} }

function onSessionObtained(token) {
  saveSession(token);
  openOverlay();
  if (loginWindow) { loginWindow.close(); loginWindow = null; }
}

// ── Login-Fenster ──────────────────────────────────────────────────────────
function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 440, height: 580, resizable: false, title: 'BlackFossil Login',
    backgroundColor: '#0f0a1e',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  loginWindow.loadFile(path.join(__dirname, 'renderer', 'login.html'));
  loginWindow.on('closed', () => { loginWindow = null; });
}

// ── Overlay-Fenster (transparent, Vollbild, immer oben) ──────────────────────
function openOverlay() {
  if (overlayWindow) { overlayWindow.focus(); return; }
  const { bounds } = screen.getPrimaryDisplay();
  overlayWindow = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    transparent: true, frame: false, resizable: false, movable: false,
    skipTaskbar: true, hasShadow: false, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Standardmäßig klick-durchlässig — Maus geht an das Spiel
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === 'media' || permission === 'microphone'));

  overlayWindow.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlayWindow.on('closed', () => { overlayWindow = null; unregisterHotkeys(); });

  registerHotkeys();
}

// ── Hotkeys ─────────────────────────────────────────────────────────────────
function registerHotkeys() {
  for (const [action, key] of Object.entries(HOTKEYS)) {
    try {
      globalShortcut.register(key, () => {
        if (overlayWindow) overlayWindow.webContents.send('hotkey', action);
      });
    } catch (err) { console.error(`Hotkey ${key} fehlgeschlagen:`, err); }
  }
}
function unregisterHotkeys() { globalShortcut.unregisterAll(); }

// ── IPC ──────────────────────────────────────────────────────────────────
ipcMain.handle('get-session', () => loadSession());
ipcMain.handle('get-config', () => ({ tokenBase: TOKEN_BASE, hotkeys: HOTKEYS }));
ipcMain.on('session-ready', (_e, token) => onSessionObtained(token));
ipcMain.on('open-login', () => shell.openExternal(`${TOKEN_BASE}/auth/login`));
ipcMain.on('logout', () => {
  clearSession();
  if (overlayWindow) { overlayWindow.close(); overlayWindow = null; }
  if (!loginWindow) createLoginWindow();
});
// Overlay schaltet Klick-Durchlässigkeit (z.B. wenn Map/Settings offen)
ipcMain.on('set-interactive', (_e, interactive) => {
  if (overlayWindow) overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
});

// ── App-Start ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  if (pendingDeepLink) { onSessionObtained(pendingDeepLink); pendingDeepLink = null; return; }
  // Wenn schon eingeloggt → direkt Overlay, sonst Login
  if (loadSession()) openOverlay();
  else createLoginWindow();
});

app.on('will-quit', unregisterHotkeys);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
