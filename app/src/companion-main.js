// BlackFossil Companion — zweite, eigenstaendige Electron-App neben dem Overlay.
//
// Bewusst ein EIGENER Main-Prozess statt eines Mode-Flags in main.js: rund 60 % von
// main.js sind overlay-spezifisch (Spiel-Watcher, Foreground-Prober, uiohook-PTT,
// globalShortcut, setIgnoreMouseEvents, Idle-Shrink). All das in ein normales
// Desktop-Fenster zu schleppen wuerde jede kuenftige Overlay-Aenderung zur
// Zwei-Modi-Denkaufgabe machen.
//
// Die Companion laeuft OHNE Spiel: kein Game-Watch, kein Quit wenn The Isle fehlt.
'use strict';

const { app, BrowserWindow, ipcMain, shell, clipboard, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
// Version direkt aus der package.json statt ueber app.getVersion(): im
// Dev-Start (electron <datei>) kennt Electron kein App-Verzeichnis und meldet
// "0.0". Beide Apps teilen sich diese Datei — die Versionen sind damit
// zwangslaeufig gleich.
const APP_VERSION = require('../package.json').version;
const fs = require('fs');
const http = require('http');

// Eigener App-Name → eigener userData-Pfad → eigene session.json und eigener
// Single-Instance-Lock. Ohne das teilen sich Overlay und Companion die Session
// und wuerden sich gegenseitig ausloggen.
app.setName('BlackFossil Companion Test');

const TOKEN_BASE = 'https://api.blackfossil.de';   // TEMPORÄR: LIVE
const SCHEME = 'blackfossil-companion-test';
// Eigener Loopback-Port: das Overlay haelt 53117. Wichtig — der Backend-Callback
// muss dorthin redirecten, sonst landet unser Token in der Session des Overlays
// (siehe /auth/login?client=companion, backend internal/login/login.go).
const LOGIN_PORT = 53119;   // TEMPORÄR
const SESSION_FILE = path.join(app.getPath('userData'), 'session.json');

let win = null;
let loopbackServer = null;

// ── Session ────────────────────────────────────────────────────────────────
function saveSession(token) { try { fs.writeFileSync(SESSION_FILE, JSON.stringify({ token }), 'utf8'); } catch {} }
function loadSession() { try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).token; } catch { return null; } }
function clearSession() { try { fs.unlinkSync(SESSION_FILE); } catch {} }

function onSessionObtained(token) {
  saveSession(token);
  if (win) win.webContents.send('session-changed');
}

// ── Login-Rueckkanal ───────────────────────────────────────────────────────
function startLoopbackServer() {
  if (loopbackServer) return;
  loopbackServer = http.createServer((req, res) => {
    try {
      const u = new URL(req.url, `http://127.0.0.1:${LOGIN_PORT}`);
      if (u.pathname === '/cb') {
        const token = u.searchParams.get('session');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf8"><body style="font-family:system-ui;background:#0f0a1e;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center"><div><h2 style="color:#8b5cf6">✅ Angemeldet</h2><p style="color:#b3a9cc">Du kannst dieses Fenster schließen und zur Companion-App zurückkehren.</p></div></body>');
        if (token) onSessionObtained(token);
      } else { res.writeHead(404); res.end(); }
    } catch { res.writeHead(400); res.end(); }
  });
  // Anders als im Overlay wird EADDRINUSE hier NICHT verschluckt: laeuft schon
  // etwas auf dem Port, kaeme der Login nie an und die App haenge stumm.
  loopbackServer.on('error', (e) => {
    console.error('Login-Loopback fehlgeschlagen:', e.message);
    loopbackServer = null;
    if (win) win.webContents.send('login-error', e.code === 'EADDRINUSE'
      ? `Port ${LOGIN_PORT} ist belegt — läuft die Companion bereits?`
      : e.message);
  });
  loopbackServer.listen(LOGIN_PORT, '127.0.0.1');
}

// ── Deep-Link (Fallback, wenn der Loopback nicht greift) ───────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => a.startsWith(SCHEME + '://'));
    if (url) handleDeepLink(url);
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(SCHEME, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(SCHEME);
}
app.on('open-url', (_e, url) => handleDeepLink(url));
function handleDeepLink(url) {
  try { const t = new URL(url).searchParams.get('session'); if (t) onSessionObtained(t); }
  catch (err) { console.error('Deep-Link Fehler:', err); }
}

// ── Fenster ────────────────────────────────────────────────────────────────
function appIcon() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'assets', 'logo.png'));
    return img.isEmpty() ? undefined : img;
  } catch { return undefined; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 1024, minHeight: 680,
    title: 'BlackFossil Companion Test',
    backgroundColor: '#0f0a1e', icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'companion-preload.js'),
      contextIsolation: true,
      // Die Karte pollt /positions auch, wenn das Fenster im Hintergrund liegt —
      // sonst drosselt Chromium den Timer und die Overwatch-Ansicht veraltet.
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'companion.html'));
  win.on('closed', () => { win = null; });
}

// ── Auto-Update ────────────────────────────────────────────────────────────
// Der Feed liegt im eigenen Backend (/overlay), NICHT bei GitHub. Der Kanal
// heisst "companion" — dieselbe Ablage wie das Overlay, aber ein eigener Feed
// (companion.yml statt latest.yml). Ohne getrennten Kanal wuerde eine App die
// Builds der anderen als eigenes Update anbieten.
function setupAutoUpdate() {
  if (!app.isPackaged) return;   // im Dev nicht pruefen
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: TOKEN_BASE + '/overlay', channel: 'companion' });
  } catch { /* ohne Feed bleibt der manuelle Weg */ }
  // Test-Builds tragen eine monotone Version 1.9.x-dev.<run> und sollen bei
  // JEDEM dev-Push aktualisieren.
  if (TOKEN_BASE.includes('api-test')) autoUpdater.allowPrerelease = true;
  // Der Default-Logger schreibt auf stdout — im Overlay war genau das eine
  // EPIPE-Absturzquelle. Status geht ohnehin ueber Events an den Renderer.
  autoUpdater.logger = { info() {}, warn() {}, error() {}, debug() {} };

  const send = (ch, v) => { try { win?.webContents.send(ch, v); } catch {} };
  autoUpdater.on('update-available', (i) => send('update-available', i?.version));
  autoUpdater.on('update-not-available', () => send('update-none'));
  autoUpdater.on('download-progress', (p) => send('update-progress', Math.round(p?.percent || 0)));
  autoUpdater.on('update-downloaded', (i) => send('update-ready', i?.version));
  autoUpdater.on('error', (e) => send('update-error', String(e?.message || e)));

  checkForUpdates();
  setInterval(checkForUpdates, 60 * 60 * 1000);
}

function checkForUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.checkForUpdates().catch(() => {});
}

app.whenReady().then(() => {
  startLoopbackServer();
  createWindow();
  setupAutoUpdate();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ── IPC ────────────────────────────────────────────────────────────────────
ipcMain.handle('get-session', () => loadSession());
ipcMain.handle('get-config', () => ({ tokenBase: TOKEN_BASE }));
ipcMain.handle('get-version', () => APP_VERSION);
ipcMain.handle('copy-text', (_e, t) => { clipboard.writeText(String(t || '')); return true; });
ipcMain.on('open-external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
ipcMain.on('logout', () => { clearSession(); if (win) win.webContents.send('session-changed'); });
// ?client=companion ist der Grund fuer die Backend-Aenderung: nur damit redirectet
// der Callback auf unseren Port 53118 statt auf den des Overlays.
ipcMain.on('open-login', () => shell.openExternal(`${TOKEN_BASE}/auth/login?client=companion`));
ipcMain.on('update-check', () => checkForUpdates());
ipcMain.on('update-download', () => { if (app.isPackaged) autoUpdater.downloadUpdate().catch(() => {}); });
ipcMain.on('update-install', () => { if (app.isPackaged) autoUpdater.quitAndInstall(); });
