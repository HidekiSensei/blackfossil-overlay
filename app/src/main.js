const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const TOKEN_BASE = 'https://voice.blackfossil.de';
const SESSION_FILE = path.join(app.getPath('userData'), 'session.json');

let mainWindow = null;
let pendingDeepLink = null;

// ── Single-Instance (nötig für Deep-Link unter Windows) ───────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => a.startsWith('blackfossil://'));
    if (url) handleDeepLink(url);
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
}

// blackfossil:// als Protokoll registrieren
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient('blackfossil', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('blackfossil');
}

// macOS Deep-Link
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

function handleDeepLink(url) {
  try {
    const u = new URL(url);
    const sessionToken = u.searchParams.get('session');
    if (sessionToken) {
      saveSession(sessionToken);
      if (mainWindow) mainWindow.webContents.send('session', sessionToken);
      else pendingDeepLink = sessionToken;
    }
  } catch (err) {
    console.error('Deep-Link Fehler:', err);
  }
}

function saveSession(token) {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify({ token }), 'utf8'); } catch {}
}
function loadSession() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).token; } catch { return null; }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 600,
    title: 'BlackFossil Overlay',
    backgroundColor: '#0f0a1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Mikrofon-Zugriff im Renderer erlauben
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media' || permission === 'microphone');
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingDeepLink) { mainWindow.webContents.send('session', pendingDeepLink); pendingDeepLink = null; }
  });
}

// ── IPC ──────────────────────────────────────────────────────────────────
ipcMain.handle('get-session', () => loadSession());
ipcMain.handle('get-config', () => ({ tokenBase: TOKEN_BASE }));
ipcMain.handle('save-session', (_e, token) => { saveSession(token); return true; });
ipcMain.handle('logout', () => { try { fs.unlinkSync(SESSION_FILE); } catch {} return true; });
ipcMain.on('open-login', () => shell.openExternal(`${TOKEN_BASE}/auth/login`));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
