const { app, BrowserWindow, ipcMain, shell, session, globalShortcut, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { exec } = require('node:child_process');

// The-Isle-Client-Prozesse (Overlay erscheint nur wenn das Spiel läuft)
const GAME_PROCESSES = ['TheIsle-Win64-Shipping.exe', 'TheIsle.exe'];
function isGameRunning() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(true); // Dev (Mac/Linux): immer anzeigen
    exec('tasklist /NH', { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(true); // im Zweifel anzeigen
      const lower = stdout.toLowerCase();
      resolve(GAME_PROCESSES.some((p) => lower.includes(p.toLowerCase())));
    });
  });
}
let gameWatchTimer = null;
function startGameWatch() {
  if (!overlayWindow) openOverlay();
  const tick = async () => {
    const running = await isGameRunning();
    if (!overlayWindow) return;
    if (running && !overlayWindow.isVisible()) overlayWindow.showInactive();
    else if (!running && overlayWindow.isVisible()) overlayWindow.hide();
  };
  tick();
  if (gameWatchTimer) clearInterval(gameWatchTimer);
  gameWatchTimer = setInterval(tick, 5000);
}

const TOKEN_BASE = 'https://voice.blackfossil.de';
const SESSION_FILE = path.join(app.getPath('userData'), 'session.json');
const HOTKEYS_FILE = path.join(app.getPath('userData'), 'hotkeys.json');

// Standard-Hotkeys (vom Nutzer überschreibbar)
const DEFAULT_HOTKEYS = {
  'map-toggle':      'M',
  'dino-info':       'F5',
  'zone-capture':    'F6',
  'skin-editor':     'F7',
  'garage':          'F8',
  'market':          'F9',
  'settings-toggle': 'F10',
  'voice-connect':   'F11',
  'mic-toggle':      'F4',
  'range-cycle':     'F3',  // Sprechreichweite durchschalten
  'voice-ptt':       '',   // Push-to-Talk (gedrückt halten) — unbelegt
  'voice-ptm':       '',   // Push-to-Mute (gedrückt halten) — unbelegt
};
// Diese Aktionen werden über den globalen Tasten-Hook (Halten) gesteuert,
// nicht über globalShortcut (das nur Tastendruck kennt).
const HOLD_ACTIONS = ['voice-ptt', 'voice-ptm'];
let HOTKEYS = loadHotkeys();

function loadHotkeys() {
  try { return { ...DEFAULT_HOTKEYS, ...JSON.parse(fs.readFileSync(HOTKEYS_FILE, 'utf8')) }; }
  catch { return { ...DEFAULT_HOTKEYS }; }
}
function saveHotkeys() { try { fs.writeFileSync(HOTKEYS_FILE, JSON.stringify(HOTKEYS)); } catch {} }

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
  startGameWatch();
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
    skipTaskbar: true, hasShadow: false, fullscreenable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Standardmäßig klick-durchlässig — Maus geht an das Spiel
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === 'media' || permission === 'microphone'));

  overlayWindow.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  // Sichtbarkeit steuert der Game-Watcher (zeigt nur wenn The Isle läuft)
  overlayWindow.on('closed', () => {
    overlayWindow = null; unregisterHotkeys();
    if (gameWatchTimer) { clearInterval(gameWatchTimer); gameWatchTimer = null; }
  });

  registerHotkeys();
}

// ── Hotkeys ─────────────────────────────────────────────────────────────────
function registerHotkeys() {
  globalShortcut.unregisterAll();
  for (const [action, key] of Object.entries(HOTKEYS)) {
    if (!key || HOLD_ACTIONS.includes(action)) continue; // unbelegt oder Halten-Aktion
    try {
      globalShortcut.register(key, () => {
        if (overlayWindow) overlayWindow.webContents.send('hotkey', action);
      });
    } catch (err) { console.error(`Hotkey ${key} fehlgeschlagen:`, err); }
  }
  refreshVoiceKeys();
}

// ── Globaler Tasten-Hook für Push-to-Talk / Push-to-Mute ────────────────────
let uiohook = null, UiohookKey = null;
try { const m = require('uiohook-napi'); uiohook = m.uIOhook; UiohookKey = m.UiohookKey; }
catch (err) { console.error('uiohook nicht verfügbar:', err.message); }

let pttCode = null, ptmCode = null, pttDown = false, ptmDown = false;

function accelToUiohookCode(accel) {
  if (!accel || !UiohookKey) return null;
  const key = accel.split('+').pop(); // Modifier ignorieren, Haupttaste nehmen
  if (/^[A-Z]$/.test(key)) return UiohookKey[key];
  if (/^F\d{1,2}$/.test(key)) return UiohookKey[key];
  if (key === 'Space') return UiohookKey.Space;
  if (/^\d$/.test(key)) return UiohookKey[key];
  return null;
}

function refreshVoiceKeys() {
  pttCode = accelToUiohookCode(HOTKEYS['voice-ptt']);
  ptmCode = accelToUiohookCode(HOTKEYS['voice-ptm']);
}

function startVoiceHook() {
  if (!uiohook) return;
  uiohook.on('keydown', (e) => {
    if (pttCode && e.keycode === pttCode && !pttDown) { pttDown = true; sendVoiceKey('ptt', true); }
    if (ptmCode && e.keycode === ptmCode && !ptmDown) { ptmDown = true; sendVoiceKey('ptm', true); }
  });
  uiohook.on('keyup', (e) => {
    if (pttCode && e.keycode === pttCode && pttDown) { pttDown = false; sendVoiceKey('ptt', false); }
    if (ptmCode && e.keycode === ptmCode && ptmDown) { ptmDown = false; sendVoiceKey('ptm', false); }
  });
  try { uiohook.start(); } catch (err) { console.error('uiohook start fehlgeschlagen:', err.message); }
}
function sendVoiceKey(kind, down) {
  if (overlayWindow) overlayWindow.webContents.send('voice-key', { kind, down });
}
function unregisterHotkeys() { globalShortcut.unregisterAll(); }

// ── IPC ──────────────────────────────────────────────────────────────────
ipcMain.handle('get-session', () => loadSession());
ipcMain.handle('get-config', () => ({ tokenBase: TOKEN_BASE, hotkeys: HOTKEYS }));
ipcMain.handle('get-hotkeys', () => HOTKEYS);
ipcMain.handle('set-hotkey', (_e, action, key) => {
  HOTKEYS[action] = key;            // key kann '' sein = unbelegt
  saveHotkeys();
  registerHotkeys();
  return HOTKEYS;
});
ipcMain.handle('reset-hotkeys', () => {
  HOTKEYS = { ...DEFAULT_HOTKEYS };
  saveHotkeys();
  registerHotkeys();
  return HOTKEYS;
});
ipcMain.on('session-ready', (_e, token) => onSessionObtained(token));
ipcMain.on('open-login', () => shell.openExternal(`${TOKEN_BASE}/auth/login`));
ipcMain.on('logout', () => {
  clearSession();
  if (overlayWindow) { overlayWindow.close(); overlayWindow = null; }
  if (!loginWindow) createLoginWindow();
});
// Overlay schaltet Klick-Durchlässigkeit + Fokus.
// interactive = Map/Settings offen → Overlay nimmt Fokus, damit das Spiel
// keine Eingaben mehr bekommt (kein Zubeißen/Drehen). Sonst Maus durchreichen.
ipcMain.on('set-interactive', (_e, interactive) => {
  if (!overlayWindow) return;
  overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
  if (interactive) {
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    overlayWindow.focus();           // Overlay holt Fokus → Spiel bekommt keine Eingaben
  } else {
    overlayWindow.blur();            // gibt den Fokus zurück ans Spiel
  }
});

// ── App-Start ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  refreshVoiceKeys();
  startVoiceHook();
  if (pendingDeepLink) { onSessionObtained(pendingDeepLink); pendingDeepLink = null; return; }
  // Wenn schon eingeloggt → Game-Watcher (zeigt Overlay wenn The Isle läuft), sonst Login
  if (loadSession()) startGameWatch();
  else createLoginWindow();
});

app.on('will-quit', () => { unregisterHotkeys(); try { uiohook && uiohook.stop(); } catch {} });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
