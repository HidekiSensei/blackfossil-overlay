const { app, BrowserWindow, ipcMain, shell, session, globalShortcut, screen, Tray, Menu, nativeImage, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { exec, spawn } = require('node:child_process');
const { autoUpdater } = require('electron-updater');

// ⚡ PERFORMANCE: Overlay auf die dedizierte (High-Performance-)GPU zwingen. Auf Laptops mit zwei
// GPUs liefe das Overlay sonst oft auf der integrierten GPU, während das Spiel auf der dedizierten
// läuft → teures Cross-GPU-Compositing (großer FPS-Verlust). Muss VOR app-ready gesetzt werden;
// auf Single-GPU-Systemen wirkungslos (kein Nachteil, reversibel).
app.commandLine.appendSwitch('force_high_performance_gpu');

// ── Auto-Update (GitHub-Releases) ───────────────────────────────────────────
// Ablauf: Beim Öffnen + stündlich prüfen. Bei verfügbarem Update zeigt das Overlay
// einen Hinweis; der Download/Install wird vom Nutzer über die Einstellungen
// ausgelöst (autoDownload=false). Nach dem Download kann neugestartet werden.
function setupAutoUpdate() {
  if (!app.isPackaged) return; // im Dev nicht prüfen
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true; // Fallback: spätestens beim Beenden
  const send = (ch, v) => { try { overlayWindow?.webContents.send(ch, v); } catch {} };
  let updateRetries = 0;
  autoUpdater.on('update-available', (i) => { updateRetries = 0; send('update-available', i?.version); });
  autoUpdater.on('update-not-available', () => send('update-none'));
  autoUpdater.on('download-progress', (p) => send('update-progress', Math.round(p?.percent || 0)));
  autoUpdater.on('update-downloaded', (i) => { updateRetries = 0; send('update-ready', i?.version); });
  autoUpdater.on('error', (err) => {
    const msg = String(err?.message || err);
    // EPERM/EBUSY/rename beim Finalisieren kommt fast immer daher, dass Antivirus/Defender die
    // frisch geladene .exe scannt und kurz sperrt, während electron-updater sie umbenennt.
    // Darum bis zu 2× automatisch neu versuchen (AV hat dann meist losgelassen); erst danach den
    // Fehler an den Renderer melden (der bietet dann den manuellen Download an).
    if (/EPERM|EBUSY|EACCES|rename/i.test(msg) && updateRetries < 2) {
      updateRetries++;
      send('update-progress', 0);
      setTimeout(() => { autoUpdater.downloadUpdate().catch(() => {}); }, 6000);
      return;
    }
    updateRetries = 0;
    send('update-error', msg);
  });
  setInterval(() => { if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {}); }, 60 * 60 * 1000);
}
function checkForUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.checkForUpdates().catch((e) => console.error('[update] Check fehlgeschlagen:', e?.message || e));
}

// ── Lokaler Rücksprung-Server für den Discord-Login ──────────────────────────
// Discord leitet nach dem Login auf http://127.0.0.1:LOGIN_PORT/cb?session=...
// Das ist zuverlässiger als ein blackfossil://-Deep-Link (Browser blocken den oft).
const LOGIN_PORT = 53117;
let loopbackServer = null;
function startLoopbackServer() {
  if (loopbackServer) return;
  loopbackServer = http.createServer((req, res) => {
    try {
      const u = new URL(req.url, `http://127.0.0.1:${LOGIN_PORT}`);
      if (u.pathname === '/cb') {
        const token = u.searchParams.get('session');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf8"><body style="font-family:system-ui;background:#0f0a1e;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center"><div><h2 style="color:#8b5cf6">✅ Erfolgreich angemeldet</h2><p style="color:#b3a9cc">Du kannst dieses Fenster schließen und zur BlackFossil-App zurückkehren.</p></div></body>');
        if (token) onSessionObtained(token);
      } else { res.writeHead(404); res.end(); }
    } catch { res.writeHead(400); res.end(); }
  });
  loopbackServer.on('error', (e) => { console.error('Login-Loopback fehlgeschlagen:', e.message); loopbackServer = null; });
  loopbackServer.listen(LOGIN_PORT, '127.0.0.1');
}

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
// Vordergrund-Erkennung (Windows): EIN dauerhafter PowerShell-Prozess meldet jede
// Sekunde den Namen des fokussierten Fensters. Kein wiederholtes Spawnen mehr →
// kein Flackern/Fokus-Konflikt. Der Tick liest nur den Cache (synchron).
let FG_PS1 = null;
let fgChild = null;
let fgName = null;        // letzter Vordergrund-Prozessname (lowercase)
let fgUpdatedAt = 0;
let fgEverSawGame = false;
function ensureFgProbe() {
  if (process.platform !== 'win32' || FG_PS1) return;
  FG_PS1 = path.join(app.getPath('temp'), 'bf-foreground.ps1');
  const script =
    'Add-Type @"\n' +
    'using System;using System.Runtime.InteropServices;using System.Diagnostics;\n' +
    'public class BFFg{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();' +
    '[DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out int p);' +
    'public static string Name(){IntPtr h=GetForegroundWindow();int p;GetWindowThreadProcessId(h,out p);' +
    'try{return Process.GetProcessById(p).ProcessName;}catch{return "";}}}\n' +
    '"@\n' +
    'while($true){ try{ [Console]::Out.WriteLine([BFFg]::Name()) }catch{ [Console]::Out.WriteLine("") }; Start-Sleep -Milliseconds 1000 }';
  try { fs.writeFileSync(FG_PS1, script); } catch { FG_PS1 = null; }
}
// Absoluter Pfad zu Windows PowerShell — bloßes 'powershell' scheitert mit
// spawn ENOENT, wenn der PATH des Users eingeschränkt/kaputt ist (verursachte
// den Crash-Dialog beim Dock-Hotkey F5).
const POWERSHELL = (process.platform === 'win32' && process.env.SystemRoot)
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell';
function startForegroundWatch() {
  if (process.platform !== 'win32' || fgChild) return;
  ensureFgProbe();
  if (!FG_PS1) return;
  try {
    fgChild = spawn(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', FG_PS1], { windowsHide: true });
    fgChild.stdout.on('data', (d) => {
      const line = d.toString().split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0).pop();
      if (line !== undefined) { fgName = line.toLowerCase(); fgUpdatedAt = Date.now(); }
    });
    fgChild.on('exit', () => { fgChild = null; });
    fgChild.on('error', () => { fgChild = null; });
  } catch { fgChild = null; }
}
function stopForegroundWatch() { try { fgChild && fgChild.kill(); } catch {} fgChild = null; }

// Holt das Overlay-Fenster HART in den Windows-Vordergrund. app.focus({steal}) wird von
// UE5-Fullscreen-Spielen blockiert (Foreground-Lock); deshalb nativer Win32-Weg:
// ALT-Tap (gaukelt User-Input vor → hebt den Lock) + AttachThreadInput (hängt den Input
// des aktuellen Vordergrund-Threads an unseren Fenster-Thread) + SetForegroundWindow.
// Damit bekommt das Spiel danach KEINE Tastatur-/Maus-Inputs mehr (kein Lenken/Beißen).
let FRONT_PS1 = null;
function bringOverlayToFront() {
  if (process.platform !== 'win32' || !overlayWindow) return;
  let hwnd;
  try { hwnd = overlayWindow.getNativeWindowHandle().readBigUInt64LE(0).toString(); }
  catch { try { hwnd = String(overlayWindow.getNativeWindowHandle().readUInt32LE(0)); } catch { return; } }
  try {
    if (!FRONT_PS1) {
      FRONT_PS1 = path.join(app.getPath('temp'), 'bf-front.ps1');
      const script =
        'param([string]$h)\n' +
        'Add-Type @"\n' +
        'using System;using System.Runtime.InteropServices;\n' +
        'public class BFFront{\n' +
        ' [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);\n' +
        ' [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);\n' +
        ' [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr h);\n' +
        ' [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);\n' +
        ' [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();\n' +
        ' [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h,out int p);\n' +
        ' [DllImport("user32.dll")] public static extern bool AttachThreadInput(int a,int b,bool c);\n' +
        ' [DllImport("user32.dll")] public static extern void keybd_event(byte k,byte s,int f,int e);\n' +
        ' public static void Front(IntPtr h){\n' +
        '  IntPtr fg=GetForegroundWindow(); int fp; int ft=GetWindowThreadProcessId(fg,out fp);\n' +
        '  int wp; int wt=GetWindowThreadProcessId(h,out wp);\n' +
        '  keybd_event(0x12,0,0,0); keybd_event(0x12,0,2,0);\n' +   // ALT down/up → User-Input vortäuschen
        '  AttachThreadInput(ft,wt,true);\n' +
        '  ShowWindow(h,9); BringWindowToTop(h); SetForegroundWindow(h); SetActiveWindow(h);\n' +
        '  AttachThreadInput(ft,wt,false);\n' +
        ' }}\n' +
        '"@\n' +
        '[BFFront]::Front([IntPtr]([int64]$h))';
      fs.writeFileSync(FRONT_PS1, script);
    }
    const ch = spawn(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', FRONT_PS1, hwnd], { windowsHide: true });
    ch.on('error', () => {});   // ENOENT u.a. asynchron abfangen → kein Crash des Main-Prozesses
  } catch (e) { /* Foreground-Steal fehlgeschlagen → Electron-Fallback greift weiter */ }
}
function isGameForeground() {
  if (process.platform !== 'win32') return true;   // Dev: immer aktiv
  if (overlayInteractive) return true;             // Map/Settings offen → Overlay hat Fokus
  // Keine frischen Daten (Prozess tot/zu langsam) → anzeigen statt verstecken
  if (!fgName || Date.now() - fgUpdatedAt > 6000) return true;
  const isGame = fgName.includes('theisle');       // lockerer Treffer
  if (isGame) { fgEverSawGame = true; return true; }
  // Solange das Spiel noch NIE sicher erkannt wurde, niemals ausblenden.
  return !fgEverSawGame;
}

// Hotkeys (globalShortcut + PTT/PTM-Hook) nur aktiv, wenn The Isle im Vordergrund ist.
let hotkeysActive = true;
function setHotkeysActive(active) {
  if (active === hotkeysActive) return;
  hotkeysActive = active;
  if (active) registerHotkeys();
  else unregisterHotkeys();
}

let gameWatchTimer = null;
let gameWasRunning = false; // war The Isle beim letzten Tick schon einmal an?
let gameMissCount = 0;      // aufeinanderfolgende "nicht erkannt"-Ticks (Entprellung)
let fgHideCount = 0;        // aufeinanderfolgende "nicht im Vordergrund"-Ticks (Hysterese)
function startGameWatch() {
  startForegroundWatch();
  if (!overlayWindow) openOverlay();
  const tick = async () => {
    if (!overlayWindow) return;
    const running = await isGameRunning();
    if (!running) {
      // War das Spiel an und ist jetzt aus → App beenden. Erst nach 2 Aussetzern
      // in Folge (ein einzelner tasklist-Hänger soll das Overlay nicht killen).
      if (gameWasRunning && process.platform === 'win32') {
        gameMissCount++;
        if (gameMissCount >= 2) {
          gameWasRunning = false;
          isQuitting = true;
          app.quit();
          return;
        }
        return; // einmaliger Aussetzer → Fenster sichtbar lassen, abwarten
      }
      if (overlayWindow.isVisible()) {
        try { overlayWindow.webContents.send('game-closed'); } catch {}
        overlayWindow.hide();
      }
      setHotkeysActive(false);
      return;
    }
    gameMissCount = 0;
    gameWasRunning = true;
    // Läuft → nur sichtbar UND mit aktiven Hotkeys, wenn The Isle im Vordergrund ist.
    // Hysterese: erst nach 2 "nicht im Vordergrund"-Ticks ausblenden (kein Flackern).
    const fg = isGameForeground();
    if (fg) {
      fgHideCount = 0;
      if (!overlayWindow.isVisible()) overlayWindow.showInactive();
      setHotkeysActive(true);
      try { overlayWindow.webContents.send('game-focus', true); } catch {}
    } else {
      fgHideCount++;
      if (fgHideCount >= 2) {
        if (overlayWindow.isVisible()) overlayWindow.hide();
        setHotkeysActive(false);
        try { overlayWindow.webContents.send('game-focus', false); } catch {}
      }
    }
  };
  tick();
  if (gameWatchTimer) clearInterval(gameWatchTimer);
  gameWatchTimer = setInterval(tick, 2000);
}

// Cutover: Overlay spricht jetzt das Go-Backend an. Unmigrierte Pfade proxyt das Backend
// transparent zum token-service weiter (Live-Daten), Login/Voice/Positions bedient es nativ.
const TOKEN_BASE = 'https://api.blackfossil.de';
const SESSION_FILE = path.join(app.getPath('userData'), 'session.json');
const HOTKEYS_FILE = path.join(app.getPath('userData'), 'hotkeys.json');

// Standard-Hotkeys (vom Nutzer überschreibbar)
// Ziel: standardmäßig nur 2 Tasten nötig — „^" (Overlay-/Nav-Modus, fest im
// uiohook) + Voice. Alle Menü-/Feature-Funktionen sind über das Dock klickbar,
// daher per Default UNBELEGT (''). In den Einstellungen jederzeit rebindbar.
const DEFAULT_HOTKEYS = {
  'dock-toggle':     'F5',   // Overlay-/Dock-Modus (zusätzlich zur „^"-Taste)
  'map-toggle':      '',
  'dino-info':       '',
  'zone-capture':    'F6',   // Zonen-Eckpunkt setzen (im Zonen-Editor)
  'skin-editor':     '',
  'garage':          '',
  'market':          '',
  'group':           '',
  'profile':         '',
  'lexikon':         '',
  'settings-toggle': '',
  'admin-menu':      'Alt+Shift+A',  // Team-Menü (nur sichtbar fürs Team)
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
  let hk;
  try { hk = { ...DEFAULT_HOTKEYS, ...JSON.parse(fs.readFileSync(HOTKEYS_FILE, 'utf8')) }; }
  catch { hk = { ...DEFAULT_HOTKEYS }; }
  // Alt-Configs hatten zone-capture unbelegt ('') → F6 erzwingen (UI verspricht F6).
  if (!hk['zone-capture']) hk['zone-capture'] = 'F6';
  return hk;
}
function saveHotkeys() { try { fs.writeFileSync(HOTKEYS_FILE, JSON.stringify(HOTKEYS)); } catch {} }

let loginWindow = null;
let overlayWindow = null;
let pendingDeepLink = null;
let isQuitting = false;
let tray = null;
let overlayInteractive = false; // Map/Settings offen → Overlay hat Fokus

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

// Nach einem Update alle Spieler ausloggen → sie müssen sich neu anmelden
// (frische Discord-Rollen/Ränge in der Session). Vergleicht die zuletzt gelaufene
// Version mit der aktuellen; bei Änderung wird die gespeicherte Session verworfen.
function onSessionObtained(token) {
  saveSession(token);
  startGameWatch();
  if (loginWindow) { loginWindow.close(); loginWindow = null; }
}

// ── Icon / Tray ──────────────────────────────────────────────────────────
const ICON_PATH = path.join(__dirname, 'renderer', 'assets', 'logo.png');
function appIcon() {
  try { const img = nativeImage.createFromPath(ICON_PATH); return img.isEmpty() ? undefined : img; }
  catch { return undefined; }
}
function createTray() {
  if (tray) return;
  const img = appIcon();
  if (!img) return; // Logo noch nicht im Repo → kein Tray-Icon
  tray = new Tray(img.resize({ width: 32, height: 32 }));
  tray.setToolTip('BlackFossil Overlay');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Einstellungen', click: () => { try { overlayWindow?.webContents.send('hotkey', 'settings-toggle'); } catch {} } },
    { type: 'separator' },
    { label: 'Beenden', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

// ── Login-Fenster ──────────────────────────────────────────────────────────
function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 440, height: 580, resizable: false, title: 'BlackFossil Login',
    backgroundColor: '#0f0a1e', icon: appIcon(),
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
    skipTaskbar: true, hasShadow: false, fullscreenable: false, show: false, icon: appIcon(),
    // backgroundThrottling:false → Poll (/positions) läuft auch weiter, wenn das Fenster
    // beim Raustabben versteckt wird. Sonst drosselt Chromium den Timer → Overlay-Aktivität
    // veraltet → Overlay-Pflicht kickt fälschlich.
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, backgroundThrottling: false },
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
  // Beim Öffnen auf Updates prüfen, damit niemand mit veralteter Version spielt
  checkForUpdates();
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
let pttReleaseTimer = null, ptmReleaseTimer = null; // verzögertes Stummschalten (Auto-Repeat-Schutz)
let pttMouse = null, ptmMouse = null; // Maustasten-Codes (uiohook e.button)

function accelToUiohookCode(accel) {
  if (!accel || !UiohookKey) return null;
  if (/^Mouse\d+$/.test(accel)) return null; // Maustaste → separat (pttMouse)
  const key = accel.split('+').pop(); // Modifier ignorieren, Haupttaste nehmen
  if (/^[A-Z]$/.test(key)) return UiohookKey[key];
  if (/^F\d{1,2}$/.test(key)) return UiohookKey[key];
  if (key === 'Space') return UiohookKey.Space;
  if (/^\d$/.test(key)) return UiohookKey[key];
  return null;
}
function mouseBtnFromHotkey(hk) { const m = /^Mouse(\d+)$/.exec(hk || ''); return m ? parseInt(m[1]) : null; }

function refreshVoiceKeys() {
  pttCode = accelToUiohookCode(HOTKEYS['voice-ptt']);
  ptmCode = accelToUiohookCode(HOTKEYS['voice-ptm']);
  pttMouse = mouseBtnFromHotkey(HOTKEYS['voice-ptt']);
  ptmMouse = mouseBtnFromHotkey(HOTKEYS['voice-ptm']);
}

function startVoiceHook() {
  if (!uiohook) return;
  // PTT/PTM-Release mit kurzer Karenz: manche Tastaturen/OS senden beim Halten
  // Auto-Repeat (keydown→keyup→keydown…). Würde der keyup sofort stummschalten,
  // „cuttet" die Stimme mitten im Reden raus. Daher beim keyup erst nach RELEASE_GRACE
  // stummschalten; kommt vorher ein keydown, wird die Stummschaltung abgebrochen.
  const RELEASE_GRACE_MS = 250;
  uiohook.on('keydown', (e) => {
    if (!hotkeysActive) return; // The Isle nicht im Vordergrund → PTT/PTM blockiert
    if (pttCode && e.keycode === pttCode) {
      if (pttReleaseTimer) { clearTimeout(pttReleaseTimer); pttReleaseTimer = null; } // Auto-Repeat → halten
      if (!pttDown) { pttDown = true; sendVoiceKey('ptt', true); }
    }
    if (ptmCode && e.keycode === ptmCode) {
      if (ptmReleaseTimer) { clearTimeout(ptmReleaseTimer); ptmReleaseTimer = null; }
      if (!ptmDown) { ptmDown = true; sendVoiceKey('ptm', true); }
    }
  });
  uiohook.on('keyup', (e) => {
    if (!hotkeysActive) {
      if (pttReleaseTimer) { clearTimeout(pttReleaseTimer); pttReleaseTimer = null; }
      if (ptmReleaseTimer) { clearTimeout(ptmReleaseTimer); ptmReleaseTimer = null; }
      pttDown = false; ptmDown = false; return;
    }
    if (pttCode && e.keycode === pttCode && pttDown && !pttReleaseTimer) {
      pttReleaseTimer = setTimeout(() => { pttDown = false; pttReleaseTimer = null; sendVoiceKey('ptt', false); }, RELEASE_GRACE_MS);
    }
    if (ptmCode && e.keycode === ptmCode && ptmDown && !ptmReleaseTimer) {
      ptmReleaseTimer = setTimeout(() => { ptmDown = false; ptmReleaseTimer = null; sendVoiceKey('ptm', false); }, RELEASE_GRACE_MS);
    }
  });
  // Maustasten (z.B. Seitentasten) für PTT/PTM
  uiohook.on('mousedown', (e) => {
    if (!hotkeysActive) return;
    if (pttMouse && e.button === pttMouse && !pttDown) { pttDown = true; sendVoiceKey('ptt', true); }
    if (ptmMouse && e.button === ptmMouse && !ptmDown) { ptmDown = true; sendVoiceKey('ptm', true); }
  });
  uiohook.on('mouseup', (e) => {
    if (pttMouse && e.button === pttMouse && pttDown) { pttDown = false; sendVoiceKey('ptt', false); }
    if (ptmMouse && e.button === ptmMouse && ptmDown) { ptmDown = false; sendVoiceKey('ptm', false); }
  });
  try { uiohook.start(); } catch (err) { console.error('uiohook start fehlgeschlagen:', err.message); }
}
function sendVoiceKey(kind, down) {
  if (overlayWindow) overlayWindow.webContents.send('voice-key', { kind, down });
}
function unregisterHotkeys() { globalShortcut.unregisterAll(); }

// ── IPC ──────────────────────────────────────────────────────────────────
ipcMain.handle('get-version', () => app.getVersion());
ipcMain.handle('get-session', () => loadSession());
ipcMain.handle('get-config', () => ({ tokenBase: TOKEN_BASE, hotkeys: HOTKEYS }));
ipcMain.handle('get-hotkeys', () => HOTKEYS);
ipcMain.handle('set-hotkey', (_e, action, key) => {
  // Nur bekannte Actions zulassen (sonst könnte der Renderer beliebige Keys in die Datei schreiben)
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_HOTKEYS, action)) return HOTKEYS;
  if (typeof key !== 'string') return HOTKEYS;
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
// Externen Link im Standard-Browser öffnen (z. B. RaidAtlas-Disclaimer). Nur http(s) zulassen.
ipcMain.on('open-external', (_e, url) => {
  try { const u = new URL(String(url)); if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(u.href); } catch { /* ungültige URL ignorieren */ }
});
ipcMain.on('logout', () => {
  clearSession();
  if (overlayWindow) { overlayWindow.close(); overlayWindow = null; }
  if (!loginWindow) createLoginWindow();
});
// Overlay schaltet Klick-Durchlässigkeit + Fokus.
// interactive = Map/Settings offen → Overlay nimmt Fokus, damit das Spiel
// keine Eingaben mehr bekommt (kein Zubeißen/Drehen). Sonst Maus durchreichen.
// Auto-Update: vom Overlay (Einstellungen) gesteuert
ipcMain.on('update-check', () => checkForUpdates());
ipcMain.on('update-download', () => { if (app.isPackaged) autoUpdater.downloadUpdate().catch((e) => console.error('[update] Download:', e?.message || e)); });
ipcMain.on('update-install', () => { isQuitting = true; try { autoUpdater.quitAndInstall(false, true); } catch (e) { console.error('[update] Install:', e?.message || e); } });

ipcMain.handle('copy-text', (_e, t) => { try { clipboard.writeText(String(t ?? '')); return true; } catch { return false; } });

// ⚡ Idle-Window-Shrink (Performance-Setting): Der Renderer meldet die gewünschte Fenster-
// größe. Im Idle (Dock zu) schrumpft das Fenster auf die Höhe der sichtbaren HUD-Elemente
// (volle Breite, Ursprung oben links) → der große untere Spielbereich ist NICHT mehr von
// einem Overlay-Fenster überlagert → Windows kann dem Spiel eher den schnellen Vollbild-
// Pfad (Independent Flip / Hardware-Multiplane-Overlay) zurückgeben. Bei offenem Dock/Panel
// wächst es zurück auf Vollbild. `full:true` = ganzer Bildschirm, sonst `{height}`.
ipcMain.on('set-overlay-bounds', (_e, b) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try {
    const { bounds } = screen.getPrimaryDisplay();
    if (b && b.full) {
      overlayWindow.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
    } else if (b && typeof b.height === 'number') {
      const h = Math.max(1, Math.min(bounds.height, Math.round(b.height)));
      overlayWindow.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: h });
    }
  } catch { /* Fenster evtl. gerade zerstört */ }
});

ipcMain.on('set-interactive', (_e, interactive) => {
  if (!overlayWindow) return;
  overlayInteractive = !!interactive; // verhindert Ausblenden, während Map/Settings offen sind
  overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
  if (interactive) {
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    // Fokus möglichst hart vom Spiel holen — sonst landen Klicks im Spiel (Kameradrehung/
    // Biss). Windows sperrt den Foreground-Steal teils; app.focus({steal}) + ein kurzes
    // setFocusable-Toggle umgeht das zuverlässiger als focus() allein.
    try { overlayWindow.setFocusable(true); } catch {}
    try { overlayWindow.show(); } catch {}        // aktiviert (anders als showInactive)
    try { overlayWindow.moveTop(); } catch {}
    try { overlayWindow.focus(); } catch {}
    try { app.focus({ steal: true }); } catch {}  // App-Ebene: Foreground hart stehlen
    bringOverlayToFront();                          // nativer Win32-Foreground-Steal (UE5-Lock umgehen)
    // Zweiter Versuch nach einem Tick — manche Fullscreen-Spiele geben den Fokus
    // erst leicht verzögert frei.
    setTimeout(() => { try { if (overlayInteractive && overlayWindow) { overlayWindow.focus(); app.focus({ steal: true }); bringOverlayToFront(); } } catch {} }, 60);
  } else {
    try { overlayWindow.setFocusable(true); } catch {}
    overlayWindow.blur();            // gibt den Fokus zurück ans Spiel
  }
});

// ── App-Start ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  setupAutoUpdate();
  try { createTray(); } catch (err) { console.error('Tray fehlgeschlagen:', err?.message || err); }
  startLoopbackServer();
  refreshVoiceKeys();
  startVoiceHook();
  if (pendingDeepLink) { onSessionObtained(pendingDeepLink); pendingDeepLink = null; return; }
  // Wenn schon eingeloggt → Game-Watcher (zeigt Overlay wenn The Isle läuft), sonst Login
  if (loadSession()) startGameWatch();
  else createLoginWindow();
});

app.on('will-quit', () => { unregisterHotkeys(); stopForegroundWatch(); try { uiohook && uiohook.stop(); } catch {} });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
