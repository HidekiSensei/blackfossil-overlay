// Umstieg auf das neue BlackFossil HUD (Overlay 2.0) — die LETZTE Version des alten Overlays.
//
// Owner-Auftrag 18.08.2026 (Release-Abend): Wer das alte Overlay über sein Auto-Update auf
// diese Version bringt, soll das neue HUD automatisch bekommen und das alte Overlay loswerden,
// ohne selbst etwas herunterladen zu müssen. Ablauf beim Start:
//   1. Fenster „Umstieg auf HUD 2.0" (Fortschritt).
//   2. HUD-Installer vom Backend laden (<TOKEN_BASE>/overlay/BlackFossil-HUD-Setup.exe —
//      derselbe konstante Dateiname, den die HUD-CI hochlaedt).
//   3. Installer still ausfuehren (Tauri-NSIS, currentUser, /S) und auf sein Ende warten.
//   4. Neues HUD starten.
//   5. Eigenen Deinstaller (electron-builder-NSIS: „Uninstall <productName>.exe" neben der
//      exe) verzoegert und still (/S) starten, dann beenden.
// Scheitert 2. oder 3., bleibt das alte Overlay INSTALLIERT (nichts halb kaputt) und zeigt
// den Download-Link — der Nutzer kann dann von Hand umsteigen; das alte Overlay startet
// danach normal weiter, damit niemand ohne Overlay dasteht, falls der Server noch nicht
// abgeschaltet ist.
const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const { spawn } = require('node:child_process');

const HUD_SETUP_NAME = 'BlackFossil-HUD-Setup.exe';
const HUD_TEST_SETUP_NAME = 'BlackFossil-HUD-Test-Setup.exe';

function html(titel) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${titel}</title>
<style>
  body{margin:0;background:#0f1216;color:#e8ecf1;font:14px/1.5 "Segoe UI",system-ui,sans-serif;padding:22px 26px;user-select:none}
  h1{font-size:18px;margin:0 0 6px}
  p{margin:0 0 12px;color:#aab3bf}
  .bar{height:10px;border-radius:999px;background:#1d232b;overflow:hidden;border:1px solid #2a3340}
  .fill{height:100%;width:0;background:linear-gradient(90deg,#8b5cf6,#c084fc);transition:width .2s}
  #st{margin-top:10px;font-size:13px}
  a{color:#c084fc}
  .err{color:#f87171}
</style></head><body>
<h1>🦖 Umstieg auf das neue BlackFossil HUD</h1>
<p>Das alte Overlay geht in Rente. Das neue HUD wird geladen und installiert — dauert nur einen Moment.</p>
<div class="bar"><div class="fill" id="f"></div></div>
<div id="st">Vorbereiten …</div>
<script>
  window.setP = (p) => { document.getElementById('f').style.width = Math.max(0, Math.min(100, p)) + '%'; };
  window.setS = (t, err) => { const el = document.getElementById('st'); el.innerHTML = t; el.className = err ? 'err' : ''; };
</script></body></html>`;
}

function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'BlackFossil-Overlay-Umstieg' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, dest, onProgress).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const total = Number(res.headers['content-length'] || 0);
      let got = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => { got += c.length; if (total) onProgress(Math.round((got / total) * 100)); });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => out.close(() => resolve(dest)));
      res.pipe(out);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(new Error('Timeout')); });
  });
}

function runAndWait(exe, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { windowsHide: true, stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', (code) => resolve(code));
  });
}

/** Installationsordner des neuen HUD (Tauri-NSIS, currentUser). */
function hudDir(test) {
  const base = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  return path.join(base, test ? 'BlackFossil HUD (Test)' : 'BlackFossil HUD');
}

function hudExe(test) {
  const dir = hudDir(test);
  try {
    const kandidaten = fs.readdirSync(dir).filter((f) => /\.exe$/i.test(f) && !/^uninstall/i.test(f));
    // Bevorzugt die Datei mit dem Produktnamen, sonst die erste .exe.
    const bevorzugt = kandidaten.find((f) => /blackfossil/i.test(f));
    const f = bevorzugt || kandidaten[0];
    return f ? path.join(dir, f) : null;
  } catch { return null; }
}

/** Eigener electron-builder-Deinstaller neben der laufenden exe. */
function eigenerUninstaller() {
  try {
    const dir = path.dirname(process.execPath);
    const f = fs.readdirSync(dir).find((n) => /^Uninstall .*\.exe$/i.test(n));
    return f ? path.join(dir, f) : null;
  } catch { return null; }
}

/**
 * Fuehrt den Umstieg aus. Loest `true` auf, wenn das alte Overlay danach beendet werden soll
 * (Umstieg gelungen), `false`, wenn es normal weiterlaufen soll (Umstieg gescheitert).
 */
async function umstiegAusfuehren(tokenBase) {
  if (process.platform !== 'win32') return false; // Linux/AppImage: kein NSIS, kein Umstieg
  const test = tokenBase.includes('api-test');
  const setupName = test ? HUD_TEST_SETUP_NAME : HUD_SETUP_NAME;
  const url = tokenBase.replace(/\/+$/, '') + '/overlay/' + setupName;
  const dest = path.join(app.getPath('temp'), setupName);

  const win = new BrowserWindow({
    width: 560, height: 250, resizable: false, minimizable: false, maximizable: false,
    title: 'BlackFossil HUD 2.0', autoHideMenuBar: true, alwaysOnTop: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // Links im Fenster oeffnen im System-Browser, nie im Fenster selbst.
  win.webContents.on('will-navigate', (ev, u) => { if (/^https?:/i.test(u)) { ev.preventDefault(); shell.openExternal(u); } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html('BlackFossil HUD 2.0')));
  const setP = (p) => { try { win.webContents.executeJavaScript(`window.setP(${p})`).catch(() => {}); } catch {} };
  const setS = (t, err) => { try { win.webContents.executeJavaScript(`window.setS(${JSON.stringify(t)}, ${!!err})`).catch(() => {}); } catch {} };

  try {
    setS('Lade das neue HUD herunter …');
    await download(url, dest, (p) => { setP(p * 0.8); });
    setP(82);
    setS('Installiere das neue HUD …');
    const code = await runAndWait(dest, ['/S']);
    if (code !== 0) throw new Error('Installer-Exitcode ' + code);
    setP(95);
    const exe = hudExe(test);
    if (exe) {
      setS('Starte das neue HUD …');
      try { spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref(); } catch {}
    }
    setP(100);
    setS('Fertig — das alte Overlay wird jetzt entfernt. Bis gleich im neuen HUD! 🦖');
    // Eigenen Deinstaller verzoegert starten (er darf erst laufen, wenn wir weg sind).
    const un = eigenerUninstaller();
    if (un) {
      try {
        spawn('cmd.exe', ['/c', `timeout /t 4 /nobreak >nul & "${un}" /S`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 1800));
    try { win.close(); } catch {}
    return true;
  } catch (e) {
    console.error('[umstieg] fehlgeschlagen:', e && e.message ? e.message : e);
    const link = 'https://blackfossil.de/profil';
    setS(`Automatischer Umstieg fehlgeschlagen (${e && e.message ? e.message : e}). Bitte das HUD von Hand laden: <a href="${link}">${link}</a> — das alte Overlay startet gleich normal.`, true);
    await new Promise((r) => setTimeout(r, 8000));
    try { win.close(); } catch {}
    try { fs.unlinkSync(dest); } catch {}
    return false;
  }
}

module.exports = { umstiegAusfuehren };
