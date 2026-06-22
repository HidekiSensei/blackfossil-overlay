import { Room, RoomEvent, Track, ParticipantEvent } from 'livekit-client';
import { loadMapImage, drawFullMap, drawMinimap, drawHeatmap, normToWorld, worldToNorm, zoneAt, resetCal, solveAffine, getCal, setCalAffine, setZones, ZONES } from './map.js';

const el = (id) => document.getElementById(id);

// ── Karten-/Positions-State ─────────────────────────────────────────────────
let players = [];
let me = null;
let waypoints = [];
let calibMode = false;
let heatmapMode = false;
// Auto-Kalibrierung: 6 feste Punkte (Anzeige-Einheiten × Faktor = Welt-Einheiten).
const CALIB_FACTOR = 1000;
const CALIB_TARGETS = [
  { x: -140, y: -140 }, { x: 100, y: -210 }, { x: -140, y: 210 },
  { x: -205, y: 110 }, { x: 205, y: -110 }, { x: 205, y: 60 },
].map((p) => ({ x: p.x * CALIB_FACTOR, y: p.y * CALIB_FACTOR }));
let autoCalib = null; // { startPos, pairs, resolveClick }
let sessionToken = null;
let calibPairs = [];
let armedRef = null;
let isAdmin = false;
let zoneEditMode = false;
let activeZone = null; // 'pvp' | 'pve'
let pttHeld = false, ptmHeld = false;

let voiceConnected = false; // im LiveKit-Raum verbunden?

// Update-Status: 'none' | 'available' | 'downloading' | 'ready'
let updateState = 'none';
let updateVersion = '';
function renderUpdateUI() {
  const hint = el('updateHint'), box = el('updateBox'), btn = el('updateBtn'), info = el('updateInfo');
  if (!hint || !box || !btn) return;
  if (updateState === 'none') { hint.style.display = 'none'; box.style.display = 'none'; return; }
  box.style.display = 'block';
  const v = updateVersion ? 'v' + updateVersion : '';
  if (updateState === 'available') {
    hint.style.display = 'block'; hint.textContent = `⬆️ Update ${v} verfügbar`;
    if (info) info.textContent = `Version ${v} ist verfügbar. Jetzt herunterladen?`;
    btn.textContent = `Update ${v} herunterladen`.trim(); btn.disabled = false;
  } else if (updateState === 'downloading') {
    hint.style.display = 'block'; hint.textContent = `⬇️ Update ${v} wird geladen…`;
    if (info) info.textContent = 'Update wird heruntergeladen…';
    btn.disabled = true;
  } else if (updateState === 'ready') {
    hint.style.display = 'block'; hint.textContent = `✅ Update ${v} bereit — neustarten`;
    if (info) info.textContent = `Version ${v} ist bereit. Overlay neustarten zum Installieren.`;
    btn.textContent = 'Neustarten & installieren'; btn.disabled = false;
  }
}

// Proximity: Sprechreichweiten in Metern (1 m = 100 Welt-Einheiten/cm).
// Maßgeblich ist die Reichweite des SPRECHERS — andere hören dich so weit.
const RANGE_STEPS = [2, 5, 10, 15, 25];
let myRange = parseFloat(localStorage.getItem('bf-range') || '10');
const remoteRanges = {};      // identity -> Reichweite des anderen (m)
const DEFAULT_RANGE = 10;     // bis Reichweite empfangen wird
// Pro-User-Grundlautstärke (0..2, 1 = normal) — gleicht unterschiedlich laute
// Mikros aus. Lokal pro Hörer gespeichert, unabhängig vom Distanz-Verhalten.
let userGain = {};            // identity(steamId) -> Faktor
try { userGain = JSON.parse(localStorage.getItem('bf-user-gain') || '{}'); } catch { userGain = {}; }
// Welt-Einheiten pro angezeigtem Meter. The Isle skaliert kürzer als erwartet,
// daher 200 statt 100 — so klingt "25 m" auch wirklich nach 25 m.
const UNITS_PER_M = 200;

// Karten-Ansicht (Zoom/Pan)
let mapZoom = 1, mapPanX = 0, mapPanY = 0;
let dragging = false, dragMoved = false, lastDragX = 0, lastDragY = 0;

// ── Mikro-Status-Icons ──────────────────────────────────────────────────────
const ICONS = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
  disconnected: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 12.55a10.94 10.94 0 0 1 5.17-2.39M10.71 5.05A16 16 0 0 1 22.58 9M1.42 9a15.91 15.91 0 0 1 4.7-2.88M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/></svg>',
};

// state: 'connecting' | 'disconnected' | 'muted' | 'idle' | 'speaking'
function setMicState(state, text) {
  const icon = el('micIcon');
  const labels = { connecting: 'Verbinde…', disconnected: 'Verbindung getrennt', muted: 'Stumm', idle: 'Verbunden', speaking: 'Spricht' };
  const glyph = state === 'disconnected' ? ICONS.disconnected
    : state === 'muted' ? ICONS.micOff
    : ICONS.mic;
  icon.innerHTML = glyph;
  icon.className = `mic-${state}`;
  el('micText').textContent = text ?? labels[state];
  const dotColor = { speaking: '#22c55e', idle: '#22c55e', muted: '#ef4444', disconnected: '#666', connecting: '#f59e0b' };
  const hv = document.getElementById('hudVoice'); if (hv) hv.style.background = dotColor[state] || '#666';
}

// ── Toast-System ─────────────────────────────────────────────────────────────
function showToast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast' + (type ? ' ' + type : '');
  t.textContent = msg;
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => { t.classList.add('fade'); setTimeout(() => t.remove(), 300); }, 3600);
}

// ── Top-HUD (Name / Tier / Punkte) ───────────────────────────────────────────
let myTier = 'Fossil';
function setTier(tier) {
  myTier = tier || 'Fossil';
  const b = document.getElementById('hudTier');
  if (b) { b.textContent = myTier; b.className = 'tier-badge tier-' + myTier; }
}
function setStaff(staff) {
  const b = document.getElementById('hudStaff'); if (!b) return;
  if (staff) { b.style.display = ''; b.textContent = staff; b.className = 'staff-badge staff-' + staff; }
  else b.style.display = 'none';
}
function updateHud(d) {
  if (!d) return;
  if (d.name) document.getElementById('hudName').textContent = d.name;
  if (typeof d.points === 'number') document.getElementById('hudPoints').textContent = `${d.points.toLocaleString('de-DE')} Pkt.`;
  if (d.tier) setTier(d.tier);
  if (d.primes) checkPrimes(d.primes);
}
async function pollHud() {
  if (!sessionToken) return;
  try {
    const res = await fetch(`${config.tokenBase}/me`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (res.ok) updateHud(await res.json());
  } catch {}
}

let config = { tokenBase: 'https://voice.blackfossil.de', hotkeys: {} };
let room = null;
let micEnabled = false;
let settingsOpen = false;
let mapOpen = false;

async function init() {
  config = await window.bf.getConfig();

  el('connBtn').onclick = () => toggleConnect();
  el('voiceWarn').onclick = () => toggleConnect();
  el('micBtn').onclick = () => toggleMic();
  el('logoutBtn').onclick = () => window.bf.logout();
  el('closeBtn').onclick = () => toggleSettings(false);
  el('heatBtn').onclick = () => {
    heatmapMode = !heatmapMode;
    el('heatBtn').style.background = heatmapMode ? '#8b5cf6' : 'var(--panel)';
    renderBigMap();
  };
  el('calibrateBtn').onclick = () => startAutoCalibration();
  el('calibCancelBtn').onclick = () => abortAutoCalib();
  el('calibBtn').onclick = () => toggleCalib();
  el('calibSolve').onclick = () => solveCalibration();
  el('calibReset').onclick = () => { resetCal(); calibPairs = []; saveCalibPairs(); armedRef = null; renderCalibList(); renderBigMap(); };

  // Zonen-Aufnahme
  el('zoneBtn').onclick = () => toggleZonePanel();
  el('zonePvpBtn').onclick = () => selectZone('pvp');
  el('zonePveBtn').onclick = () => selectZone('pve');
  el('zoneAddBtn').onclick = () => captureZonePoint();
  el('zoneUndoBtn').onclick = () => { if (activeZone) { ZONES[activeZone].points.pop(); updateZoneInfo(); renderBigMap(); } };
  el('zoneClearBtn').onclick = () => { if (activeZone) { ZONES[activeZone].points = []; updateZoneInfo(); renderBigMap(); } };
  el('zoneSaveBtn').onclick = () => saveZones();

  window.bf.onHotkey(handleHotkey);

  // Lokaler Tasten-Fallback: Wenn das Overlay den Fokus hat (Map/Settings offen),
  // erreicht der globalShortcut die Aktion nicht mehr zuverlässig — das Spiel hat
  // keinen Fokus, aber das fokussierte Overlay schluckt den Tastendruck. Darum hier
  // die zugewiesenen Tasten zusätzlich im Fenster abfangen, damit z. B. M die Karte
  // auch wieder schließt.
  window.addEventListener('keydown', onLocalHotkey);

  // Auto-Update: Hinweis + Download/Install über die Einstellungen
  el('updateHint').onclick = () => toggleSettings(true);
  el('updateBtn').onclick = () => {
    if (updateState === 'available') { updateState = 'downloading'; window.bf.updateDownload?.(); renderUpdateUI(); }
    else if (updateState === 'ready') { window.bf.updateInstall?.(); }
  };
  window.bf.onUpdateAvailable?.((version) => {
    updateVersion = version || ''; updateState = 'available'; renderUpdateUI();
    showToast(`⬆️ Update ${updateVersion ? 'v' + updateVersion + ' ' : ''}verfügbar — in den Einstellungen aktualisieren`, 'success');
  });
  window.bf.onUpdateProgress?.((percent) => {
    if (updateState === 'downloading') { const b = el('updateBtn'); if (b) b.textContent = `Lädt… ${percent}%`; }
  });
  window.bf.onUpdateReady?.((version) => {
    updateVersion = version || updateVersion; updateState = 'ready'; renderUpdateUI();
    showToast('✅ Update bereit — Overlay neustarten zum Installieren', 'success');
  });
  window.bf.onUpdateError?.((msg) => {
    if (updateState === 'downloading') { updateState = 'available'; renderUpdateUI(); }
    showToast(`Update-Fehler: ${msg}`, 'error');
  });
  // Raustabben → offene Overlay-Fenster schließen (Main blendet das Fenster ohnehin aus)
  window.bf.onGameFocus?.((focused) => {
    if (!focused) { toggleSettings(false); toggleMap(false); closeAllFeatures(); }
  });

  // The Isle wurde geschlossen → Voice trennen (Overlay blendet das Main-Prozess aus)
  window.bf.onGameClosed?.(() => {
    if (room) { try { room.disconnect(); } catch {} room = null; micEnabled = false; }
    setMicState('disconnected');
  });

  // Push-to-Talk / Push-to-Mute (globaler Tasten-Hook)
  window.bf.onVoiceKey(({ kind, down }) => {
    if (kind === 'ptt') { pttHeld = down; if (voiceMode === 'ptt') applyMic(); }
    else if (kind === 'ptm') { ptmHeld = down; if (voiceMode === 'ptm') applyMic(); }
  });

  // Gespeicherte Kalibrier-Punkte laden (überleben App-Neustart)
  try { calibPairs = JSON.parse(localStorage.getItem('bf-calib-pairs') || '[]'); } catch { calibPairs = []; }

  // Kartenbild laden + zentrale Kalibrierung & Zonen vom Server holen
  await loadMapImage('assets/map.jpg');
  await loadServerCalibration();
  await loadServerZones();

  // Karten-Interaktion
  const cv = el('bigMapCanvas');
  cv.addEventListener('click', onMapClick);
  cv.addEventListener('wheel', onMapWheel, { passive: false });
  cv.addEventListener('mousedown', onMapMouseDown);
  window.addEventListener('mousemove', onMapMouseMove);
  window.addEventListener('mouseup', () => { dragging = false; });
  el('centerBtn').onclick = () => centerOnMe();
  el('zoomInBtn').onclick = () => zoomBy(1.3);
  el('zoomOutBtn').onclick = () => zoomBy(1 / 1.3);
  el('resetViewBtn').onclick = () => { mapZoom = 1; mapPanX = 0; mapPanY = 0; renderBigMap(); };

  // Sprechreichweiten-Buttons
  const rbWrap = el('rangeBtns');
  rbWrap.innerHTML = '';
  for (const r of RANGE_STEPS) {
    const b = document.createElement('button');
    b.dataset.range = String(r); b.textContent = `${r} m`; b.style.flex = '1';
    b.onclick = () => setRange(r, false);
    rbWrap.appendChild(b);
  }
  updateRangeDisplay();

  // Voice-Modus
  el('vmodeVoice').onclick = () => setVoiceMode('voice');
  el('vmodePtt').onclick = () => setVoiceMode('ptt');
  el('vmodePtm').onclick = () => setVoiceMode('ptm');
  setVoiceMode(localStorage.getItem('bf-voice-mode') || 'voice', true);

  // Feature-Panels schließen
  document.querySelectorAll('.closeFeature').forEach((b) => { b.onclick = () => closeAllFeatures(); });

  // Tastenbelegung
  await renderHotkeys();
  el('resetHkBtn').onclick = async () => { await window.bf.resetHotkeys(); await renderHotkeys(); };
  window.addEventListener('keydown', onRebindKey);

  // Render-Loops
  setInterval(renderMinimap, 200);

  // Auto-Connect + Positions-Polling
  const session = await window.bf.getSession();
  // Voice verbindet NICHT sofort — erst wenn man laut Positions-Poll auf dem
  // BlackFossil-Server ist (siehe applyServerState). Off-Server kein Voice.
  if (session) { sessionToken = session; startPositionPolling(); }
  else setMicState('disconnected', 'Keine Session');
}

// ── Server-Gating ────────────────────────────────────────────────────────────
// Nur wenn man wirklich auf dem BlackFossil-Server ist (taucht im Positions-Poll
// als "isYou" auf), sind Karte/Minimap/HUD sichtbar und Voice + Hotkeys aktiv.
// Sonst nur der "Nicht auf dem Server"-Hinweis.
let wasOnServer = false;
function applyServerState() {
  const onServer = !!me;
  el('serverBanner').style.display = onServer ? 'none' : 'block';
  const mw = el('minimapWrap'); if (mw) mw.style.display = onServer ? '' : 'none';
  const hud = el('hud'); if (hud) hud.style.display = onServer ? '' : 'none';
  updateVoiceWarn();
  if (onServer === wasOnServer) return;
  wasOnServer = onServer;
  if (onServer) {
    // Auf dem Server → Voice verbinden (nur hier erlaubt)
    if (!room && sessionToken) connectWithSession(sessionToken);
  } else {
    // Server verlassen → Voice trennen + alle Overlay-Fenster schließen
    if (room) { try { room.disconnect(); } catch {} room = null; micEnabled = false; voiceConnected = false; setMicState('disconnected'); }
    closeAllFeatures();
    toggleMap(false);
    toggleSettings(false);
    updateVoiceWarn();
  }
}

// Penetrante Warnung: auf dem Server, aber nicht im Voice verbunden
function updateVoiceWarn() {
  const w = el('voiceWarn');
  if (w) w.style.display = (!!me && !voiceConnected) ? 'block' : 'none';
}

// ── Positionen pollen ───────────────────────────────────────────────────────
function startPositionPolling() {
  const poll = async () => {
    if (!sessionToken) return;
    try {
      const res = await fetch(`${config.tokenBase}/positions`, { headers: { Authorization: `Bearer ${sessionToken}` } });
      if (res.ok) {
        const data = await res.json();
        players = data.players || [];
        me = players.find((p) => p.isYou) || null;
        applyServerState();
        updateZoneBox();
        checkZoneChange();
        updateProximityVolumes();
        if (mapOpen) renderBigMap();
      }
    } catch {}
  };
  poll();
  setInterval(poll, 1500);
}

// ── Proximity: Lautstärke pro Spieler nach Distanz ──────────────────────────
// Volle Lautstärke bis zur halben Reichweite, dann linear auf 0 bei voller Reichweite.
// R = Reichweite des Sprechers (m). Rw = R*100 Welt-Einheiten. vol = clamp(2*(1 - d/Rw)).
function updateProximityVolumes() {
  if (!room) return;
  for (const p of room.remoteParticipants.values()) {
    const pos = players.find((pl) => pl.steamId === p.identity);
    let vol = 1;
    if (me && pos) {
      const Rw = (remoteRanges[p.identity] ?? DEFAULT_RANGE) * UNITS_PER_M;
      const d = Math.hypot(pos.x - me.x, pos.y - me.y);
      vol = Math.max(0, Math.min(1, 2 * (1 - d / Rw)));
    }
    // Pro-User-Grundlautstärke obendrauf (gleicht laute/leise Mikros aus)
    const g = userGain[p.identity] ?? 1;
    try { p.setVolume(vol * g); } catch {}
  }
}

// ── Pro-User-Lautstärke (Regler im Settings-Menü) ────────────────────────────
function setUserGain(identity, factor) {
  userGain[identity] = factor;
  try { localStorage.setItem('bf-user-gain', JSON.stringify(userGain)); } catch {}
  updateProximityVolumes();
}

function renderVoiceUsers() {
  const box = el('voiceUsers');
  if (!box) return;
  const parts = room ? [...room.remoteParticipants.values()] : [];
  if (!parts.length) {
    box.innerHTML = '<div style="color:var(--muted);font-size:12px">Keine anderen Spieler im Voice.</div>';
    return;
  }
  box.innerHTML = '';
  for (const p of parts) {
    const pos = players.find((pl) => pl.steamId === p.identity);
    const name = pos?.name || p.name || p.identity;
    const g = userGain[p.identity] ?? 1;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px';
    row.innerHTML =
      `<span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">👤 ${name}</span>` +
      `<input type="range" min="0" max="200" step="5" value="${Math.round(g * 100)}" style="flex:1;accent-color:var(--accent)">` +
      `<span style="width:42px;text-align:right;font-size:12px;color:var(--muted)">${Math.round(g * 100)}%</span>`;
    const slider = row.querySelector('input');
    const label = row.querySelector('span:last-child');
    slider.addEventListener('input', () => {
      label.textContent = `${slider.value}%`;
      setUserGain(p.identity, parseInt(slider.value) / 100);
    });
    box.appendChild(row);
  }
}

// ── Sprechreichweite ─────────────────────────────────────────────────────────
function updateRangeDisplay() {
  const rb = document.getElementById('rangeBox'); if (rb) rb.textContent = `🔊 Reichweite: ${myRange} m`;
  document.querySelectorAll('#rangeBtns [data-range]').forEach((b) => { b.className = parseFloat(b.dataset.range) === myRange ? '' : 'secondary'; });
}
function setRange(r, announce) {
  myRange = r;
  localStorage.setItem('bf-range', String(r));
  updateRangeDisplay();
  broadcastRange();
  if (announce) showToast(`🔊 Sprechreichweite: ${r} m`, 'success');
}
function cycleRange() {
  const i = RANGE_STEPS.indexOf(myRange);
  setRange(RANGE_STEPS[(i + 1) % RANGE_STEPS.length], true);
}
function broadcastRange() {
  if (!room) return;
  try { room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ t: 'range', r: myRange })), { reliable: true }); } catch {}
}

function updateZoneBox() {
  if (!me) { el('zoneBox').textContent = 'Zone: —'; el('zoneBox').style.color = '#b3a9cc'; return; }
  const z = zoneAt(me.x, me.y) || 'Realismus';
  const coords = `X ${(me.x / 1000) | 0}k  Y ${(me.y / 1000) | 0}k`;
  el('zoneBox').innerHTML = `Zone: ${z}<br><span style="font-size:11px;opacity:0.7">${coords}</span>`;
  el('zoneBox').style.color = z === 'PVP' ? '#ef4444' : z === 'PVE' ? '#22c55e' : '#b3a9cc';
}

// Toast beim Betreten einer anderen Zone (PVP/PVE/Realismus)
let currentZone;
function checkZoneChange() {
  if (!me) return;
  const z = zoneAt(me.x, me.y) || 'Realismus';
  if (currentZone !== undefined && z !== currentZone) {
    const type = z === 'PVP' ? 'error' : z === 'PVE' ? 'success' : 'elder';
    const icon = z === 'PVP' ? '⚔️' : z === 'PVE' ? '🛡️' : '🌿';
    showToast(`${icon} Du betrittst die ${z}-Zone`, type);
  }
  currentZone = z;
}


// ── Rendering ────────────────────────────────────────────────────────────────
// Canvas-Auflösung an die angezeigte CSS-Größe × Pixeldichte angleichen, damit
// die Karte nicht verschwimmt (z. B. Minimap kleiner als ihr Default-Backing oder
// HiDPI-Bildschirme). Gibt die LOGISCHE (CSS-)Größe zurück; der Kontext wird so
// skaliert, dass weiter in CSS-Pixeln gezeichnet werden kann.
function fitCanvasDPR(cv, ctx) {
  const dpr = window.devicePixelRatio || 1;
  const rect = cv.getBoundingClientRect();
  const cssW = rect.width || cv.clientWidth || cv.width;
  const cssH = rect.height || cv.clientHeight || cv.height;
  const bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
  if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w: cssW, h: cssH };
}

function renderMinimap() {
  const cv = el('minimap');
  const ctx = cv.getContext('2d');
  const { w, h } = fitCanvasDPR(cv, ctx);
  drawMinimap({ ctx, w, h }, players, me, myRange * UNITS_PER_M);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
function renderBigMap() {
  const cv = el('bigMapCanvas');
  const ctx = cv.getContext('2d');
  // Komplett löschen (Bildschirm-Koordinaten), dann Zoom/Pan anwenden
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.setTransform(mapZoom, 0, 0, mapZoom, mapPanX, mapPanY);
  const view = { ctx, w: cv.width, h: cv.height };
  if (heatmapMode) drawHeatmap(view, players, me);
  else drawFullMap(view, players, waypoints);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (calibMode) drawCalibOverlay(ctx, cv.width, cv.height);
}

// Bildschirm-Event → normalisierte Kartenkoordinate (berücksichtigt Zoom/Pan)
function eventToNorm(e) {
  const cv = el('bigMapCanvas');
  const rect = cv.getBoundingClientRect();
  const cxp = ((e.clientX - rect.left) / rect.width) * cv.width;
  const cyp = ((e.clientY - rect.top) / rect.height) * cv.height;
  return { nx: (cxp - mapPanX) / mapZoom / cv.width, ny: (cyp - mapPanY) / mapZoom / cv.height };
}

function onMapClick(e) {
  if (dragMoved) { dragMoved = false; return; } // war ein Ziehen, kein Klick
  const { nx, ny } = eventToNorm(e);

  // Auto-Kalibrierung: Klick = "hier stehe ich" für den aktuellen Punkt
  if (autoCalib && autoCalib.resolveClick) {
    const r = autoCalib.resolveClick; autoCalib.resolveClick = null;
    r({ nx, ny });
    return;
  }

  if (calibMode) {
    if (!armedRef) return; // erst einen Referenzpunkt wählen
    calibPairs.push({ world: { x: armedRef.x, y: armedRef.y }, norm: { nx, ny }, label: armedRef.label });
    saveCalibPairs();
    armedRef = null;
    renderCalibList();
    renderBigMap();
    return;
  }
  const w = normToWorld(nx, ny);
  waypoints = [{ x: w.x, y: w.y }];
  renderBigMap();
}

// ── Zoom / Pan ───────────────────────────────────────────────────────────────
function clampPan() {
  const cv = el('bigMapCanvas');
  const minX = cv.width - cv.width * mapZoom;
  const minY = cv.height - cv.height * mapZoom;
  mapPanX = Math.min(0, Math.max(minX, mapPanX));
  mapPanY = Math.min(0, Math.max(minY, mapPanY));
}

function onMapWheel(e) {
  e.preventDefault();
  const cv = el('bigMapCanvas');
  const rect = cv.getBoundingClientRect();
  const cxp = ((e.clientX - rect.left) / rect.width) * cv.width;
  const cyp = ((e.clientY - rect.top) / rect.height) * cv.height;
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const newZoom = Math.min(8, Math.max(1, mapZoom * factor));
  // Punkt unter dem Cursor stabil halten
  mapPanX = cxp - (cxp - mapPanX) / mapZoom * newZoom;
  mapPanY = cyp - (cyp - mapPanY) / mapZoom * newZoom;
  mapZoom = newZoom;
  clampPan();
  renderBigMap();
}

function zoomBy(factor) {
  const cv = el('bigMapCanvas');
  const cx = cv.width / 2, cy = cv.height / 2;
  const newZoom = Math.min(8, Math.max(1, mapZoom * factor));
  mapPanX = cx - (cx - mapPanX) / mapZoom * newZoom;
  mapPanY = cy - (cy - mapPanY) / mapZoom * newZoom;
  mapZoom = newZoom;
  clampPan();
  renderBigMap();
}

function onMapMouseDown(e) {
  dragging = true; dragMoved = false;
  lastDragX = e.clientX; lastDragY = e.clientY;
}
function onMapMouseMove(e) {
  if (!dragging) return;
  const cv = el('bigMapCanvas');
  const rect = cv.getBoundingClientRect();
  const sx = cv.width / rect.width, sy = cv.height / rect.height;
  const dx = (e.clientX - lastDragX) * sx, dy = (e.clientY - lastDragY) * sy;
  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragMoved = true;
  mapPanX += dx; mapPanY += dy;
  lastDragX = e.clientX; lastDragY = e.clientY;
  clampPan();
  renderBigMap();
}

function centerOnMe() {
  if (!me) return;
  const cv = el('bigMapCanvas');
  const { nx, ny } = worldToNorm(me.x, me.y);
  mapZoom = Math.max(mapZoom, 3);
  mapPanX = cv.width / 2 - nx * cv.width * mapZoom;
  mapPanY = cv.height / 2 - ny * cv.height * mapZoom;
  clampPan();
  renderBigMap();
}

// ── Auto-Kalibrierung (Teleport zu 6 Punkten + Klick auf die Karte) ──────────
async function calibTeleport(x, y, z) {
  const res = await fetch(`${config.tokenBase}/player/teleport`, {
    method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ x, y, z }),
  });
  const d = await res.json(); if (!res.ok) throw new Error(d.error || 'Fehler');
  await new Promise((r) => setTimeout(r, 700)); // kurz warten, bis die Position ankommt
  return { x: d.x, y: d.y };
}
function calibPrompt(text, showCancel) {
  const p = el('calibPrompt'); if (!p) return;
  p.style.display = 'block';
  el('calibPromptText').textContent = text;
  el('calibCancelBtn').style.display = showCancel ? 'inline-block' : 'none';
}
function endAutoCalib() { autoCalib = null; const p = el('calibPrompt'); if (p) p.style.display = 'none'; }
function waitForCalibClick() { return new Promise((resolve) => { autoCalib.resolveClick = resolve; }); }

async function startAutoCalibration() {
  if (autoCalib) return;
  if (!me) { showToast('Kalibrierung nur auf dem Server möglich', 'error'); return; }
  autoCalib = { startPos: { x: me.x, y: me.y, z: me.z }, pairs: [], resolveClick: null };
  toggleSettings(false);
  toggleMap(true);
  for (let i = 0; i < CALIB_TARGETS.length; i++) {
    const t = CALIB_TARGETS[i];
    calibPrompt(`Punkt ${i + 1}/6 — du wirst teleportiert…`, false);
    let actual;
    try { actual = await calibTeleport(t.x, t.y, autoCalib.startPos.z); }
    catch (e) { showToast('Teleport fehlgeschlagen: ' + e.message, 'error'); await abortAutoCalib(); return; }
    if (!autoCalib) return; // abgebrochen
    calibPrompt(`Punkt ${i + 1}/6 — klicke auf der Karte, wo du JETZT stehst.`, true);
    const norm = await waitForCalibClick();
    if (!norm || !autoCalib) { await abortAutoCalib(); return; }
    autoCalib.pairs.push({ world: { x: actual.x, y: actual.y }, norm });
  }
  calibPrompt('Kalibrierung wird berechnet…', false);
  try { await calibTeleport(autoCalib.startPos.x, autoCalib.startPos.y, autoCalib.startPos.z); } catch {}
  const ok = solveAffine(autoCalib.pairs);
  if (ok) localStorage.setItem('bf-cal-personal', '1');
  showToast(ok ? '✅ Karte kalibriert!' : 'Kalibrierung fehlgeschlagen (zu wenige Punkte)', ok ? 'success' : 'error');
  endAutoCalib();
  renderBigMap();
}
async function abortAutoCalib() {
  if (!autoCalib) return;
  const sp = autoCalib.startPos;
  if (autoCalib.resolveClick) { const r = autoCalib.resolveClick; autoCalib.resolveClick = null; r(null); }
  endAutoCalib();
  try { await calibTeleport(sp.x, sp.y, sp.z); } catch {}
  showToast('Kalibrierung abgebrochen', '');
}

// ── Kalibrierung (3-Punkt-Klick, affin) ──────────────────────────────────────
function toggleCalib(force) {
  if (!isAdmin) { calibMode = false; el('calibPanel').style.display = 'none'; return; }
  calibMode = force !== undefined ? force : !calibMode;
  el('calibPanel').style.display = calibMode ? 'block' : 'none';
  el('calibBtn').style.background = calibMode ? '#8b5cf6' : 'var(--panel)';
  // Punkte NICHT zurücksetzen — bleiben erhalten auch wenn man die Karte
  // zwischendurch schließt (zum Fliegen). Nur der Reset-Button löscht.
  if (calibMode) renderCalibList();
  renderBigMap();
}

function refCandidates() {
  // NUR eigene/Live-Spieler-Positionen (Zonen-Ecken sind als Referenz unbrauchbar,
  // weil man ihre Kartenposition nicht kennt)
  const list = [];
  for (const p of players) if (!p.isDead) list.push({ label: `👤 ${p.name}${p.isYou ? ' (du)' : ''}`, x: p.x, y: p.y });
  return list;
}

function renderCalibList() {
  el('calibRefs').innerHTML = '';
  for (const ref of refCandidates()) {
    const b = document.createElement('button');
    const isArmed = armedRef && armedRef.label === ref.label;
    b.textContent = (isArmed ? '➤ ' : '') + ref.label;
    b.style.cssText = `padding:6px 8px;font-size:12px;border-radius:6px;text-align:left;cursor:pointer;
      border:1px solid ${isArmed ? '#8b5cf6' : 'var(--border)'};
      background:${isArmed ? 'rgba(139,92,246,0.2)' : 'transparent'};color:#eee`;
    b.onclick = () => { armedRef = ref; renderCalibList(); };
    el('calibRefs').appendChild(b);
  }
  el('calibCount').textContent = `${calibPairs.length} Punkt(e) gesetzt` + (armedRef ? ` · jetzt auf der Karte klicken wo du stehst` : '');

  // Liste der gesetzten Punkte mit Einzel-Löschen
  const list = el('calibSetList');
  list.innerHTML = '';
  calibPairs.forEach((p, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-size:11px;background:rgba(255,255,255,0.04);border-radius:5px;padding:3px 7px';
    row.innerHTML = `<span>#${i + 1} ${p.label} · X${(p.world.x / 1000) | 0}k Y${(p.world.y / 1000) | 0}k</span>`;
    const x = document.createElement('button');
    x.textContent = '✕';
    x.style.cssText = 'width:auto;padding:0 6px;background:transparent;border:0;color:#ef4444;cursor:pointer;font-size:13px';
    x.onclick = () => removeCalibPair(i);
    row.appendChild(x);
    list.appendChild(row);
  });
}

function saveCalibPairs() {
  try { localStorage.setItem('bf-calib-pairs', JSON.stringify(calibPairs)); } catch {}
}
function removeCalibPair(i) {
  calibPairs.splice(i, 1);
  saveCalibPairs();
  renderCalibList();
}

function solveCalibration() {
  if (calibPairs.length < 3) { el('calibCount').textContent = 'Mindestens 3 Punkte nötig!'; return; }
  if (!solveAffine(calibPairs)) { el('calibCount').textContent = 'Punkte zu nah beieinander — andere wählen.'; return; }

  // Genauigkeit prüfen: wie weit liegen die geklickten Punkte vom berechneten Ergebnis?
  let err = 0;
  for (const p of calibPairs) {
    const got = worldToNorm(p.world.x, p.world.y);
    err += Math.hypot(got.nx - p.norm.nx, got.ny - p.norm.ny);
  }
  const px = Math.round((err / calibPairs.length) * el('bigMapCanvas').width);
  renderBigMap();
  if (px <= 20) {
    el('calibCount').innerHTML = `<span style="color:#22c55e">✅ Kalibriert! Ø ~${px}px — sehr gut. Wird für alle gespeichert…</span>`;
    shareCalibration();
  } else if (px <= 50) {
    el('calibCount').innerHTML = `<span style="color:#f59e0b">⚠️ ~${px}px Abweichung. Mehr Punkte für mehr Genauigkeit. (Noch nicht geteilt)</span>`;
  } else {
    el('calibCount').innerHTML = `<span style="color:#ef4444">❌ ~${px}px — ein Punkt falsch geklickt. Reset und neu, weit verteilt.</span>`;
  }
}

// ── Zonen-Aufnahme ───────────────────────────────────────────────────────────
function toggleZonePanel(force) {
  if (!isAdmin) return;
  zoneEditMode = force !== undefined ? force : !zoneEditMode;
  el('zonePanel').style.display = zoneEditMode ? 'block' : 'none';
  el('zoneBtn').style.background = zoneEditMode ? '#8b5cf6' : 'var(--panel)';
  if (zoneEditMode) updateZoneInfo();
}

function selectZone(which) {
  activeZone = which;
  el('zonePvpBtn').style.background = which === 'pvp' ? 'rgba(239,68,68,0.25)' : 'transparent';
  el('zonePveBtn').style.background = which === 'pve' ? 'rgba(34,197,94,0.25)' : 'transparent';
  updateZoneInfo();
}

function updateZoneInfo() {
  if (!activeZone) { el('zoneInfo').textContent = 'Keine Zone gewählt'; return; }
  const n = ZONES[activeZone].points.length;
  el('zoneInfo').innerHTML = `<b style="color:${activeZone === 'pvp' ? '#ef4444' : '#22c55e'}">${ZONES[activeZone].label}</b> · ${n} Punkt(e) — F6 an jeder Ecke`;
}

// Aktuelle Live-Position als Zonen-Eckpunkt aufnehmen (frische Abfrage für Präzision)
async function captureZonePoint() {
  if (!zoneEditMode || !activeZone) return;
  try {
    const res = await fetch(`${config.tokenBase}/positions`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!res.ok) return;
    const data = await res.json();
    const meNow = (data.players || []).find((p) => p.isYou);
    if (!meNow) return;
    ZONES[activeZone].points.push({ x: meNow.x, y: meNow.y });
    updateZoneInfo();
    if (mapOpen) renderBigMap();
  } catch {}
}

async function saveZones() {
  try {
    const res = await fetch(`${config.tokenBase}/zones`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pvp: ZONES.pvp.points, pve: ZONES.pve.points }),
    });
    el('zoneInfo').innerHTML = res.ok
      ? '<span style="color:#22c55e">✅ Zonen für alle gespeichert!</span>'
      : '<span style="color:#ef4444">❌ Speichern fehlgeschlagen</span>';
  } catch {
    el('zoneInfo').innerHTML = '<span style="color:#ef4444">❌ Server nicht erreichbar</span>';
  }
}

async function loadServerZones() {
  try {
    const res = await fetch(`${config.tokenBase}/zones`);
    if (res.ok) { const d = await res.json(); if (d.pvp || d.pve) setZones(d); }
  } catch {}
}

// Zentrale Kalibrierung vom Server laden (alle Clients beim Start)
async function loadServerCalibration() {
  try {
    const res = await fetch(`${config.tokenBase}/calibration`);
    if (res.ok) {
      const data = await res.json();
      if (data.affine && typeof data.affine.a === 'number') setCalAffine(data.affine);
    }
  } catch {}
}

// Gute Kalibrierung auf den Server hochladen (gilt dann für alle)
function shareCalibration() {
  fetch(`${config.tokenBase}/calibration`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ affine: getCal() }),
  })
    .then((r) => { if (r.ok) el('calibCount').innerHTML = `<span style="color:#22c55e">✅ Kalibriert & für alle Spieler gespeichert!</span>`; })
    .catch(() => {});
}

// ── Hotkeys ─────────────────────────────────────────────────────────────────
function handleHotkey(action) {
  if (!me) return; // Off-Server: alle Hotkeys blockiert (nur Hinweis sichtbar)
  if (action === 'voice-connect') toggleConnect();
  else if (action === 'mic-toggle') toggleMic();
  else if (action === 'settings-toggle') toggleSettings();
  else if (action === 'map-toggle') toggleMap();
  else if (action === 'zone-capture') captureZonePoint();
  else if (action === 'dino-info') toggleFeature('dinoInfo');
  else if (action === 'skin-editor') toggleFeature('skinEditor');
  else if (action === 'garage') toggleFeature('garage');
  else if (action === 'market') toggleFeature('market');
  else if (action === 'range-cycle') cycleRange();
}

// Lokaler Tasten-Fallback (nur wenn Overlay den Fokus hat). Wandelt das Event in
// ein Accelerator-Kürzel und feuert die passende Aktion — so schließt M die Karte
// auch dann, wenn der globalShortcut vom fokussierten Overlay verschluckt wird.
function onLocalHotkey(e) {
  if (listeningAction) return;                       // gerade beim Neubelegen → ignorieren
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const accel = accelFromEvent(e);
  if (!accel) return;
  for (const [action, key] of Object.entries(config.hotkeys || {})) {
    if (key && key === accel && !HOLD_ACTIONS.includes(action)) {
      e.preventDefault();
      handleHotkey(action);
      return;
    }
  }
}
const HOLD_ACTIONS = ['voice-ptt', 'voice-ptm'];

// ── Tastenbelegung (rebindbar) ───────────────────────────────────────────────
const HK_LABELS = {
  'map-toggle': 'Große Karte',
  'dino-info': 'Dino-Info',
  'skin-editor': 'Skin Editor',
  'garage': 'Garage',
  'market': 'Dino-Markt',
  'settings-toggle': 'Einstellungen',
  'voice-connect': 'Voice verbinden/trennen',
  'mic-toggle': 'Mikro an/aus',
  'range-cycle': 'Sprechreichweite wechseln',
  'voice-ptt': 'Push-to-Talk (halten)',
  'voice-ptm': 'Push-to-Mute (halten)',
  'zone-capture': 'Zonen-Punkt (Owner)',
};
let listeningAction = null;

// Accelerator-String ⇄ {ctrl,alt,shift,key}
const HK_MODS = [['ctrl', 'Strg'], ['alt', 'Alt'], ['shift', 'Shift']];
function parseAccel(accel) {
  const out = { ctrl: false, alt: false, shift: false, key: '' };
  for (const p of (accel || '').split('+').filter(Boolean)) {
    const lp = p.toLowerCase();
    if (lp === 'commandorcontrol' || lp === 'control' || lp === 'ctrl') out.ctrl = true;
    else if (lp === 'alt') out.alt = true;
    else if (lp === 'shift') out.shift = true;
    else out.key = p;
  }
  return out;
}
function buildAccel({ ctrl, alt, shift, key }) {
  if (!key) return '';
  const parts = [];
  if (ctrl) parts.push('CommandOrControl');
  if (alt) parts.push('Alt');
  if (shift) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

async function renderHotkeys() {
  const hk = await window.bf.getHotkeys();
  config.hotkeys = hk;   // lokalen Tasten-Fallback aktuell halten
  const list = el('hotkeyList');
  list.innerHTML = '';
  for (const [action, label] of Object.entries(HK_LABELS)) {
    if (action === 'zone-capture') continue; // Admin-Tool ausgeblendet
    const cur = parseAccel(hk[action] || '');
    const row = document.createElement('div');
    row.className = 'hk-row';
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:5px;flex-wrap:wrap';
    const span = document.createElement('span');
    span.textContent = label;
    span.style.cssText = 'flex:1;min-width:110px;font-size:13px';
    row.appendChild(span);
    for (const [mod, mlabel] of HK_MODS) {
      const lbl = document.createElement('label');
      lbl.style.cssText = 'display:flex;align-items:center;gap:2px;font-size:11px;color:var(--muted);cursor:pointer';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = cur[mod];
      cb.onchange = async () => {
        const next = parseAccel((await window.bf.getHotkeys())[action] || '');
        next[mod] = cb.checked;
        await window.bf.setHotkey(action, buildAccel(next));
        await renderHotkeys();
      };
      lbl.append(cb, document.createTextNode(mlabel));
      row.appendChild(lbl);
    }
    const btn = document.createElement('button');
    btn.textContent = cur.key || '—';
    btn.dataset.action = action;
    btn.style.cssText = 'min-width:64px';
    btn.onclick = () => startRebind(action, btn);
    row.appendChild(btn);
    list.appendChild(row);
  }
}

function startRebind(action, btn) {
  listeningAction = action;
  document.querySelectorAll('#hotkeyList button').forEach((b) => b.classList.remove('listening'));
  btn.classList.add('listening');
  btn.textContent = '… Taste';
}

function accelFromEvent(e) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return undefined;
  const parts = [];
  if (e.ctrlKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (/^[a-z]$/i.test(k)) k = k.toUpperCase();
  else if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.join('+');
}

async function onRebindKey(e) {
  if (!listeningAction) return;
  e.preventDefault();
  if (e.key === 'Escape') { listeningAction = null; await renderHotkeys(); return; }
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return; // nur Modifier → echte Taste abwarten
  let key;
  if (e.key === 'Backspace' || e.key === 'Delete') key = '';       // Taste entfernen
  else if (e.key === ' ') key = 'Space';
  else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  // Modifier kommen aus den Checkboxen (nicht aus dem Tastendruck)
  const cur = parseAccel((await window.bf.getHotkeys())[listeningAction] || '');
  await window.bf.setHotkey(listeningAction, buildAccel({ ctrl: cur.ctrl, alt: cur.alt, shift: cur.shift, key }));
  listeningAction = null;
  await renderHotkeys();
}

// ── Voice-Modus ──────────────────────────────────────────────────────────────
let voiceMode = 'voice';
function setVoiceMode(mode, silent) {
  voiceMode = mode;
  localStorage.setItem('bf-voice-mode', mode);
  for (const m of ['voice', 'ptt', 'ptm']) {
    const b = el('vmode' + (m === 'voice' ? 'Voice' : m === 'ptt' ? 'Ptt' : 'Ptm'));
    b.classList.toggle('active', m === mode);
    b.classList.toggle('secondary', m !== mode);
  }
  applyVoiceMode();
  if (!silent && (mode === 'ptt' || mode === 'ptm')) {
    // PTT/Push-to-Mute brauchen einen globalen Tasten-Hook (kommt in Phase 3)
  }
}
function applyVoiceMode() {
  applyMic();
}

// ── Feature-Panels ───────────────────────────────────────────────────────────
let featureOpen = null;
function toggleFeature(id) {
  if (featureOpen === id) { closeAllFeatures(); return; }
  closeAllFeatures(true);
  featureOpen = id;
  if (id === 'dinoInfo') renderDinoInfo();
  else if (id === 'garage') renderGarage();
  else if (id === 'market') renderMarket();
  else if (id === 'skinEditor') renderSkinEditor();
  el(id).style.display = 'block';
  updateInteractive();
}
function closeAllFeatures(skipInteractive) {
  ['dinoInfo', 'skinEditor', 'garage', 'market'].forEach((id) => { el(id).style.display = 'none'; });
  if (featureOpen === 'dinoInfo') stopDinoInfo();
  featureOpen = null;
  if (!skipInteractive) updateInteractive();
}

// ── Elder / Prime-Bedingungen ────────────────────────────────────────────────
const PRIME_LABELS = [
  'Sanctuary als Juvenile besucht',
  'Genested (Get Nested In)',
  'Perfekte Ernährung (1% je Makro)',
  'Mass-Migration-Zone besucht',
  '2 Migrations-Zonen besucht',
  '4 Patrol-Zonen besucht',
  'Nie unfruchtbar (auto)',
  'Keine Muskelkrämpfe (auto)',
  'Kinder zu Subadult großgezogen',
  'Spezies-Bonus (auto)',
];
let prevPrimes = null;
function checkPrimes(primes) {
  if (!Array.isArray(primes)) return;
  if (prevPrimes) primes.forEach((v, i) => { if (v && !prevPrimes[i]) showToast(`✅ Elder-Bedingung erfüllt: ${PRIME_LABELS[i]}`, 'elder'); });
  prevPrimes = primes.slice();
}
function elderHTML(primes) {
  const p = primes || [];
  const met = p.filter(Boolean).length;
  const head = `<div style="font-size:12px;color:${met >= 5 ? '#22c55e' : 'var(--muted)'};margin-bottom:6px">${met}/5 Bedingungen für Prime${met >= 5 ? ' — erreicht! 👑' : ` (noch ${5 - met})`}</div>`;
  return head + p.map((v, i) => `<div style="display:flex;align-items:center;gap:7px;font-size:12px;padding:2px 0;${v ? '' : 'opacity:0.55'}"><span>${v ? '✅' : '⬜'}</span><span>${PRIME_LABELS[i]}</span></div>`).join('');
}

// ── Dino-Info (animierte Vital-Balken + Elder-Checker) ──────────────────────
let dinoTimer = null;
const DI_STATS = [
  { key: 'health',  label: 'Gesundheit', color: '#22c55e' },
  { key: 'blood',   label: 'Blut',       color: '#dc2626' },
  { key: 'stamina', label: 'Ausdauer',   color: '#eab308' },
  { key: 'hunger',  label: 'Hunger',     color: '#f97316' },
  { key: 'thirst',  label: 'Durst',      color: '#3b82f6' },
  { key: 'carbs',   label: 'Kohlenhydrate', color: '#a3e635' },
  { key: 'protein', label: 'Protein',    color: '#f472b6' },
  { key: 'lipid',   label: 'Fett',       color: '#fbbf24' },
];

function renderDinoInfo() {
  const bars = DI_STATS.map((s) => `
    <div class="stat">
      <div class="stat-top"><span>${s.label}</span><span class="val" id="di-${s.key}-v">—</span></div>
      <div class="stat-track"><div class="stat-fill" id="di-${s.key}-f" style="background:${s.color}"></div></div>
    </div>`).join('');
  el('dinoInfo').innerHTML = `
    <div class="di-head"><span class="di-dino" id="di-dino">Dino</span><span class="di-sub" id="di-grow"></span></div>
    <div class="di-sub" id="di-name"></div>
    <div class="di-badges" id="di-badges"></div>
    <div class="sec-title">⏳ Elder-Fortschritt</div>
    <div id="di-elder" style="margin:6px 0 14px"></div>
    <div class="sec-title">Vitals</div>
    ${bars}
    <button class="closeFeature secondary" style="margin-top:8px">Schließen (F5)</button>`;
  el('dinoInfo').querySelector('.closeFeature').onclick = () => closeAllFeatures();
  updateDinoInfo();
  if (dinoTimer) clearInterval(dinoTimer);
  dinoTimer = setInterval(updateDinoInfo, 2000);
}

function stopDinoInfo() { if (dinoTimer) { clearInterval(dinoTimer); dinoTimer = null; } }

// ── Garage (Ein-/Ausparken) ─────────────────────────────────────────────────
// ── Geteilte Dino-Karten (Garage & Markt) ──────────────────────────────────
function gc(v) { return Math.max(0, Math.min(255, Math.round(255 * Math.pow(Math.max(0, v || 0), 1 / 2.2)))); }
function colorCss(rgb) { return rgb ? `rgb(${gc(rgb[0])},${gc(rgb[1])},${gc(rgb[2])})` : '#555'; }
function shade(rgb, f) { return rgb ? `rgb(${Math.round(gc(rgb[0]) * f)},${Math.round(gc(rgb[1]) * f)},${Math.round(gc(rgb[2]) * f)})` : '#444'; }
const DINO_SIL = 'M3 30 C7 24 11 22 17 23 L21 13 C23 9 27 9 28 13 L27 23 C33 22 43 21 50 25 C55 27 60 26 62 30 C58 31 55 30 51 31 L50 37 L46 37 L45 31 C40 32 34 32 30 31 L30 37 L26 37 L25 31 C18 32 9 33 3 30 Z';
let svgId = 0;
function dinoPreviewSVG(card) {
  const c = card.colors || {}; const gid = 'g' + (svgId++);
  return `<svg class="prev" viewBox="0 0 64 40" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${colorCss(c.body)}"/><stop offset="1" stop-color="${shade(c.body, 0.55)}"/></linearGradient></defs>
    <rect width="64" height="40" fill="url(#${gid})"/>
    <path d="${DINO_SIL}" fill="${shade(c.body, 0.82)}" stroke="${colorCss(c.markings)}" stroke-width="0.6"/>
    <circle cx="25" cy="15.5" r="1.3" fill="${colorCss(c.eyes)}"/></svg>`;
}
function paletteHTML(c) { const k = ['body', 'markings', 'underbelly', 'flank', 'detail', 'eyes']; return `<div class="pal">${k.map((x) => `<span style="background:${colorCss((c || {})[x])}"></span>`).join('')}</div>`; }
function dinoCardEl(card, onClick) {
  const d = document.createElement('div'); d.className = 'dino-card';
  d.innerHTML = dinoPreviewSVG(card) + `<div class="body"><div class="nm">${card.dino}${card.isElder ? ' 👑' : ''}</div><div class="mt">${card.gender || ''} · ${Math.round((card.grow || 0) * 100)}%</div></div>` + paletteHTML(card.colors);
  d.onclick = onClick; return d;
}
function vitalsHTML(card) {
  const v = [['Gesundheit', 'health', '#22c55e'], ['Blut', 'blood', '#dc2626'], ['Ausdauer', 'stamina', '#eab308'], ['Hunger', 'hunger', '#f97316'], ['Durst', 'thirst', '#3b82f6']];
  return v.map(([l, k, c]) => { const p = Math.round((card[k] || 0) * 100); return `<div style="margin:6px 0"><div style="display:flex;justify-content:space-between;font-size:11px"><span>${l}</span><span style="color:var(--muted)">${p}%</span></div><div class="stat-track"><div class="stat-fill" style="width:${p}%;background:${c}"></div></div></div>`; }).join('');
}
function mutHTML(m) { const a = [...(m?.base || []), ...(m?.parent || []), ...(m?.elder || [])].filter(Boolean); return a.length ? a.map((x) => `<span class="mut-chip">${x}</span>`).join('') : '<span style="color:var(--muted);font-size:12px">Keine Mutationen</span>'; }
function closeDinoDetail() { el('dinoDetail').style.display = 'none'; }
function showDinoDetail(card, ctx) {
  const box = el('dinoDetail').querySelector('.box');
  let action = '';
  if (ctx.mode === 'garage') action = `<button id="ddUnpark" style="width:100%;margin-top:14px">⬆️ Ausparken</button>`;
  else if (ctx.mode === 'market') action = ctx.mine ? `<div class="price-tag" style="margin-top:14px">Dein Angebot · ${(ctx.price || 0).toLocaleString('de-DE')} Pkt.</div>` : `<button id="ddBuy" style="width:100%;margin-top:14px">🦖 Kaufen — ${(ctx.price || 0).toLocaleString('de-DE')} Pkt.</button>`;
  box.innerHTML = `<div style="display:flex;gap:14px;align-items:center;margin-bottom:14px"><div style="width:100px;height:62px;border-radius:10px;overflow:hidden;flex:none">${dinoPreviewSVG(card)}</div><div><div style="font-size:18px;font-weight:700">${card.dino}${card.isElder ? ' 👑' : ''}</div><div style="font-size:12px;color:var(--muted)">${card.gender || ''} · ${Math.round((card.grow || 0) * 100)}% Wachstum${card.isPrime ? ' · ⭐ Prime' : ''}</div></div></div><div class="sec-title">Vitals</div>${vitalsHTML(card)}<div class="sec-title" style="margin-top:12px">Mutationen</div><div style="margin-top:6px">${mutHTML(card.mutations)}</div>${action}<button class="secondary" id="ddClose" style="width:100%;margin-top:8px">Schließen</button>`;
  el('dinoDetail').style.display = 'flex';
  box.querySelector('#ddClose').onclick = closeDinoDetail;
  const u = box.querySelector('#ddUnpark'); if (u) u.onclick = () => { closeDinoDetail(); unparkById(card.id); };
  const b = box.querySelector('#ddBuy'); if (b) b.onclick = () => { closeDinoDetail(); buyOfferId(card.id); };
}

// Gemeinsame POST-Aktion mit Toast-Feedback
async function apiAction(path, body, okMsg, reload) {
  try {
    const res = await fetch(`${config.tokenBase}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const d = await res.json(); if (!res.ok) throw new Error(d.error || 'Fehler');
    showToast(okMsg.replace('{dino}', d.dino || ''), 'success'); pollHud(); if (reload) await reload();
  } catch (err) { showToast(err.message, 'error'); }
}
const unparkById = (id) => apiAction('/garage/unpark', { slotId: id }, '⬆️ {dino} ausgeparkt', loadGarage);
const buyOfferId = (id) => apiAction('/market/buy', { offerId: id }, '🦖 {dino} gekauft!', loadMarket);

// ── Garage (Karten-Grid) ─────────────────────────────────────────────────────
async function renderGarage() {
  el('garage').innerHTML = `<h2>🚗 Garage <span id="garageCount" style="font-size:13px;color:var(--muted);font-weight:400"></span></h2>
    <div id="garageCd" style="font-size:12px;color:#f59e0b;margin-bottom:6px;display:none"></div>
    <button id="parkBtn" style="width:100%;margin:6px 0 14px">⬇️ Aktuellen Dino einparken</button>
    <div id="garageGrid" class="dino-grid"></div>
    <button class="closeFeature secondary" style="margin-top:8px">Schließen (F8)</button>`;
  el('garage').querySelector('.closeFeature').onclick = () => closeAllFeatures();
  el('parkBtn').onclick = () => apiAction('/garage/park', {}, '🚗 {dino} eingeparkt', loadGarage);
  await loadGarage();
}
function fmtCd(ms) {
  const t = Math.ceil(ms / 1000), m = Math.floor(t / 60), s = t % 60;
  return m > 0 ? `${m} Min ${String(s).padStart(2, '0')} Sek` : `${s} Sek`;
}
async function loadGarage() {
  const grid = el('garageGrid'); if (!grid) return;
  grid.innerHTML = '<div style="color:var(--muted);font-size:13px">Lade…</div>';
  try {
    const res = await fetch(`${config.tokenBase}/garage`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    const data = await res.json();
    const slots = data.slots || [];
    // X/Limit-Anzeige
    const cnt = el('garageCount');
    if (cnt && data.limit != null) cnt.textContent = `· ${data.count ?? slots.length}/${data.limit} Tokens`;
    // Cooldown-Hinweise + Park-Button sperren
    const cd = data.cooldowns || {};
    const cdBox = el('garageCd');
    const parts = [];
    if (cd.park > 0) parts.push(`⏳ Einparken in ${fmtCd(cd.park)} wieder möglich`);
    if (cd.unpark > 0) parts.push(`⏳ Ausparken in ${fmtCd(cd.unpark)} wieder möglich`);
    if (cdBox) { cdBox.style.display = parts.length ? 'block' : 'none'; cdBox.innerHTML = parts.join('<br>'); }
    const parkBtn = el('parkBtn');
    if (parkBtn) {
      const full = data.limit != null && (data.count ?? slots.length) >= data.limit;
      parkBtn.disabled = cd.park > 0 || full;
      parkBtn.style.opacity = parkBtn.disabled ? '0.5' : '1';
    }
    grid.innerHTML = slots.length ? '' : '<div style="color:var(--muted);font-size:13px">Garage leer.</div>';
    for (const s of slots) grid.appendChild(dinoCardEl(s, () => showDinoDetail(s, { mode: 'garage' })));
  } catch { grid.innerHTML = '<div style="color:#ef4444;font-size:13px">Garage konnte nicht geladen werden.</div>'; }
}

// ── Skin-Editor ──────────────────────────────────────────────────────────────
const SKIN_GROUPS = [
  ['bodyColor', 'Körper'], ['markingsColor', 'Musterung'], ['underbellyColor', 'Bauch'],
  ['flankColor', 'Flanke'], ['detailColor', 'Details'], ['eyesColor', 'Augen'],
  ['maleDisplayColor', 'Display (♂)'], ['teethColor', 'Zähne'], ['mouthColor', 'Maul'], ['clawsColor', 'Krallen'],
];
let skinState = null;
function linToHex(rgb) { if (!rgb) return '#888888'; const h = (v) => ('0' + gc(v).toString(16)).slice(-2); return '#' + h(rgb[0]) + h(rgb[1]) + h(rgb[2]); }
function hexToLin(hex) { const n = parseInt(hex.slice(1), 16); const f = (v) => Math.pow(v / 255, 2.2); return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)]; }

async function renderSkinEditor() {
  const panel = el('skinEditor');
  panel.innerHTML = '<h2>🎨 Skin Editor</h2><p>Lade aktuellen Dino…</p>';
  let me = null;
  try { me = await (await fetch(`${config.tokenBase}/me`, { headers: { Authorization: `Bearer ${sessionToken}` } })).json(); } catch {}
  if (!me || !me.online) {
    panel.innerHTML = '<h2>🎨 Skin Editor</h2><p>Du musst im Spiel sein (auf einem Dino), um den Skin zu ändern.</p><button class="closeFeature secondary" style="width:100%">Schließen</button>';
    panel.querySelector('.closeFeature').onclick = closeAllFeatures; return;
  }
  const sk = me.skin || {};
  skinState = { skinVariation: sk.skinVariation || 0, patternIndex: sk.patternIndex || 0, themeIndex: sk.themeIndex || 0, colors: {} };
  for (const [k] of SKIN_GROUPS) skinState.colors[k] = (sk.colors && sk.colors[k]) ? sk.colors[k] : [0.5, 0.5, 0.5];

  const rows = SKIN_GROUPS.map(([k, l]) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0"><span style="font-size:13px">${l}</span><input type="color" data-col="${k}" value="${linToHex(skinState.colors[k])}" style="width:46px;height:28px;border:0;background:none;cursor:pointer"></div>`).join('');
  panel.innerHTML = `<h2>🎨 Skin Editor — ${me.dino}</h2>
    <div id="skPreview" style="height:90px;border-radius:12px;overflow:hidden;margin-bottom:14px"></div>
    <div class="sec-title">Muster</div>
    <div style="display:flex;gap:6px;margin:6px 0 12px">${[0, 1, 2].map((i) => `<button data-pat="${i}" style="flex:1" class="${skinState.patternIndex === i ? '' : 'secondary'}">Muster ${i + 1}</button>`).join('')}</div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><span style="font-size:13px">Skin-Variation</span><input id="skVar" type="number" min="0" value="${skinState.skinVariation}" style="width:80px;padding:6px;border-radius:6px;border:1px solid var(--border);background:#120d24;color:#eee"></div>
    <div class="sec-title">Farben</div>${rows}
    <button id="skApply" style="width:100%;margin-top:14px">✅ Skin anwenden</button>
    <button class="closeFeature secondary" style="width:100%;margin-top:8px">Schließen (F7)</button>`;
  panel.querySelector('.closeFeature').onclick = closeAllFeatures;
  updateSkinPreview();
  panel.querySelectorAll('[data-col]').forEach((inp) => inp.oninput = () => { skinState.colors[inp.dataset.col] = hexToLin(inp.value); updateSkinPreview(); });
  panel.querySelectorAll('[data-pat]').forEach((b) => b.onclick = () => { skinState.patternIndex = parseInt(b.dataset.pat); panel.querySelectorAll('[data-pat]').forEach((x) => x.className = x === b ? '' : 'secondary'); });
  el('skVar').oninput = () => { skinState.skinVariation = parseInt(el('skVar').value) || 0; };
  el('skApply').onclick = applySkin;
}
function updateSkinPreview() {
  const c = skinState.colors;
  el('skPreview').innerHTML = dinoPreviewSVG({ id: 'sk', colors: { body: c.bodyColor, markings: c.markingsColor, underbelly: c.underbellyColor, flank: c.flankColor, detail: c.detailColor, eyes: c.eyesColor } });
}
async function applySkin() {
  const btn = el('skApply'); btn.disabled = true; btn.textContent = 'Wird angewendet…';
  try {
    const body = { skinVariation: skinState.skinVariation, patternIndex: skinState.patternIndex, themeIndex: skinState.themeIndex, ...skinState.colors };
    const send = () => fetch(`${config.tokenBase}/skin`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let res = await send();
    if (res.status === 502) { await new Promise((r) => setTimeout(r, 1200)); res = await send(); } // ein Retry bei Server-Hänger
    const d = await res.json(); if (!res.ok) throw new Error(d.error || 'Fehler');
    showToast('🎨 Skin angewendet!', 'success');
  } catch (err) { showToast(err.message, 'error'); }
  btn.disabled = false; btn.textContent = '✅ Skin anwenden';
}

// ── Dino-Markt (Karten-Grid + Angebot erstellen) ───────────────────────────
let marketView = 'offers'; // 'offers' | 'create'
async function renderMarket() {
  el('market').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h2 style="margin:0">🦖 Dino-Markt</h2>
      <span id="mkPoints" class="price-tag">… Pkt.</span>
    </div>
    <div style="display:flex;gap:6px;margin-bottom:12px">
      <button id="mkTabOffers" style="flex:1">Angebote</button>
      <button id="mkTabCreate" class="secondary" style="flex:1">➕ Angebot erstellen</button>
    </div>
    <div id="mkBody"></div>
    <button class="closeFeature secondary" style="margin-top:14px">Schließen (F9)</button>`;
  el('market').querySelector('.closeFeature').onclick = () => closeAllFeatures();
  el('mkTabOffers').onclick = () => { marketView = 'offers'; loadMarket(); };
  el('mkTabCreate').onclick = () => { marketView = 'create'; loadMarket(); };
  marketView = 'offers';
  await loadMarket();
}
async function loadMarket() {
  const tabO = el('mkTabOffers'), tabC = el('mkTabCreate'); if (!tabO) return;
  tabO.className = marketView === 'offers' ? '' : 'secondary';
  tabC.className = marketView === 'create' ? '' : 'secondary';
  const body = el('mkBody'); body.innerHTML = '<div style="color:var(--muted);font-size:13px">Lade…</div>';
  try {
    const [m, g] = await Promise.all([
      fetch(`${config.tokenBase}/market`, { headers: { Authorization: `Bearer ${sessionToken}` } }).then((r) => r.json()),
      fetch(`${config.tokenBase}/garage`, { headers: { Authorization: `Bearer ${sessionToken}` } }).then((r) => r.json()),
    ]);
    el('mkPoints').textContent = `${(m.points || 0).toLocaleString('de-DE')} Pkt.`;
    if (marketView === 'offers') {
      const offers = m.offers || [];
      if (!offers.length) { body.innerHTML = '<div style="color:var(--muted);font-size:13px">Keine Angebote.</div>'; return; }
      const grid = document.createElement('div'); grid.className = 'dino-grid'; body.innerHTML = ''; body.appendChild(grid);
      for (const o of offers) {
        const card = dinoCardEl(o, () => showDinoDetail(o, { mode: 'market', price: o.price, mine: o.mine }));
        const tag = document.createElement('div'); tag.className = 'price-tag'; tag.style.borderRadius = '0';
        tag.textContent = `${o.price.toLocaleString('de-DE')} Pkt.${o.mine ? ' (deins)' : ''}`;
        card.appendChild(tag); grid.appendChild(card);
      }
    } else {
      const slots = g.slots || [];
      if (!slots.length) { body.innerHTML = '<div style="color:var(--muted);font-size:13px">Garage leer — nichts zu verkaufen.</div>'; return; }
      body.innerHTML = '<p style="color:var(--muted);font-size:13px;margin-bottom:8px">Wähle einen Dino zum Verkaufen.</p>';
      const grid = document.createElement('div'); grid.className = 'dino-grid'; body.appendChild(grid);
      for (const s of slots) grid.appendChild(dinoCardEl(s, () => showSellDialog(s)));
    }
  } catch { body.innerHTML = '<div style="color:#ef4444;font-size:13px">Markt konnte nicht geladen werden.</div>'; }
}
function showSellDialog(card) {
  const box = el('dinoDetail').querySelector('.box');
  box.innerHTML = `<div style="display:flex;gap:14px;align-items:center;margin-bottom:14px"><div style="width:100px;height:62px;border-radius:10px;overflow:hidden;flex:none">${dinoPreviewSVG(card)}</div><div><div style="font-size:18px;font-weight:700">${card.dino}${card.isElder ? ' 👑' : ''}</div><div style="font-size:12px;color:var(--muted)">${card.gender || ''} · ${Math.round((card.grow || 0) * 100)}%</div></div></div>
    <button id="sdServer" style="width:100%;margin-bottom:8px">💰 An Server verkaufen (+500)</button>
    <div style="display:flex;gap:6px;margin-bottom:8px">
      <input id="sdPrice" type="number" min="1" placeholder="Preis in Punkten" style="flex:1;padding:9px;border-radius:8px;border:1px solid var(--border);background:#120d24;color:#eee;font-size:13px">
      <button id="sdPlayer" style="flex:none;padding:9px 14px">An Spieler listen</button>
    </div>
    <button class="secondary" id="sdClose" style="width:100%">Abbrechen</button>`;
  el('dinoDetail').style.display = 'flex';
  box.querySelector('#sdClose').onclick = closeDinoDetail;
  box.querySelector('#sdServer').onclick = () => { closeDinoDetail(); apiAction('/market/sell-server', { slotId: card.id }, '💰 An Server verkauft (+500)', loadMarket); };
  box.querySelector('#sdPlayer').onclick = () => { const p = parseInt(box.querySelector('#sdPrice').value); if (!p || p <= 0) { showToast('Bitte gültigen Preis eingeben', 'error'); return; } closeDinoDetail(); apiAction('/market/sell-player', { slotId: card.id, price: p }, '🏷️ Angebot erstellt', loadMarket); };
}

async function updateDinoInfo() {
  let d = null;
  try {
    const res = await fetch(`${config.tokenBase}/me`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (res.ok) d = await res.json();
  } catch {}
  if (!d || !d.online) {
    el('di-dino').textContent = 'Nicht im Spiel';
    el('di-grow').textContent = '';
    el('di-name').textContent = 'Verbinde dich mit dem Server, um deine Stats zu sehen.';
    el('di-badges').innerHTML = '';
    el('di-elder').innerHTML = '<span style="color:var(--muted);font-size:12px">—</span>';
    DI_STATS.forEach((s) => { el(`di-${s.key}-f`).style.width = '0%'; el(`di-${s.key}-v`).textContent = '—'; });
    return;
  }
  el('di-elder').innerHTML = elderHTML(d.primes);
  el('di-dino').textContent = d.dino || 'Dino';
  el('di-name').textContent = `${d.gender || ''} · ${d.name || ''}`;
  el('di-grow').textContent = `Wachstum ${Math.round((d.grow || 0) * 100)}%`;

  // Elder-Checker + Status-Badges
  const stage = d.isElder ? 'Elder' : d.isHatchling ? 'Hatchling' : 'Adult';
  el('di-badges').innerHTML =
    `<span class="di-badge ${d.isElder ? 'elder elder-glow' : 'off'}">${d.isElder ? '👑 ELDER' : 'Kein Elder'}${d.isElder && d.elderStacks ? ' · ' + d.elderStacks + ' Stacks' : ''}</span>` +
    `<span class="di-badge ${d.isPrime ? 'on' : 'off'}">${d.isPrime ? '⭐ Prime' : 'Kein Prime'}</span>` +
    `<span class="di-badge off">${stage}</span>` +
    (d.isBleeding ? `<span class="di-badge" style="background:rgba(220,38,38,0.2);border-color:#dc2626;color:#fca5a5">🩸 Blutet</span>` : '');

  DI_STATS.forEach((s) => {
    const pct = Math.max(0, Math.min(100, Math.round((d[s.key] ?? 0) * 100)));
    el(`di-${s.key}-f`).style.width = pct + '%';
    el(`di-${s.key}-v`).textContent = pct + '%';
  });
}

function updateInteractive() {
  // Maus durchlassen nur wenn Overlay-UI geschlossen ist
  window.bf.setInteractive(settingsOpen || mapOpen || !!featureOpen);
}

function toggleSettings(force) {
  settingsOpen = force !== undefined ? force : !settingsOpen;
  el('settings').style.display = settingsOpen ? 'block' : 'none';
  if (settingsOpen) renderVoiceUsers();
  updateInteractive();
}

function toggleMap(force) {
  mapOpen = force !== undefined ? force : !mapOpen;
  el('bigMap').style.display = mapOpen ? 'flex' : 'none';
  if (mapOpen) {
    // Panels wieder einblenden falls noch aktiv (Punkte bleiben erhalten)
    if (calibMode) { el('calibPanel').style.display = 'block'; renderCalibList(); }
    if (zoneEditMode) { el('zonePanel').style.display = 'block'; updateZoneInfo(); }
    renderBigMap();
  }
  // Kalibrierung NICHT abbrechen beim Schließen — Punkte bleiben erhalten,
  // damit man zwischen den Punkten fliegen kann.
  updateInteractive();
}

// ── Voice ─────────────────────────────────────────────────────────────────
// Setzt das Mikro-Icon je nach aktuellem Zustand
// Soll das Mikro gerade senden? (abhängig vom Voice-Modus)
function isMicOn() {
  if (!room) return false;
  if (voiceMode === 'ptt') return pttHeld;                 // nur während Taste gehalten
  if (voiceMode === 'ptm') return micEnabled && !ptmHeld;  // an, außer Taste gehalten
  return micEnabled;                                       // Sprachaktivierung
}

// Mikro-Sendezustand an den Voice-Modus angleichen
async function applyMic() {
  if (!room) return;
  try { await room.localParticipant.setMicrophoneEnabled(isMicOn()); } catch {}
  refreshMicState();
}

function refreshMicState() {
  if (!room) { setMicState('disconnected'); return; }
  if (!isMicOn()) { setMicState('muted'); return; }
  if (room.localParticipant.isSpeaking) { setMicState('speaking'); return; }
  setMicState('idle');
}

async function connectWithSession(session) {
  setMicState('connecting');
  try {
    const res = await fetch(`${config.tokenBase}/token`, { headers: { Authorization: `Bearer ${session}` } });
    if (res.status === 401) { window.bf.logout(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    isAdmin = !!data.admin;
    // Kalibrierung & Zonen sind fertig (server-gespeichert) — Tools ausgeblendet,
    // damit niemand versehentlich etwas überschreibt. Bei Bedarf wieder einblendbar.
    el('calibBtn').style.display = 'none';
    el('zoneBtn').style.display = 'none';
    renderHotkeys();
    if (data.name) el('hudName').textContent = data.name;
    setTier(data.tier);
    setStaff(data.staff);
    pollHud();
    if (!pollHud._timer) pollHud._timer = setInterval(pollHud, 6000);
    await connect(data);
  } catch (err) {
    setMicState('disconnected', `Fehler: ${err.message}`);
  }
}

async function connect({ token, url }) {
  setMicState('connecting');
  room = new Room({ adaptiveStream: true, dynacast: true });
  room
    .on(RoomEvent.Connected, () => { voiceConnected = true; refreshMicState(); el('connBtn').textContent = 'Trennen'; broadcastRange(); updateVoiceWarn(); })
    .on(RoomEvent.Disconnected, () => { voiceConnected = false; el('connBtn').textContent = 'Verbinden'; setMicState('disconnected'); updateVoiceWarn(); })
    .on(RoomEvent.ParticipantConnected, () => { broadcastRange(); if (settingsOpen) renderVoiceUsers(); })  // Neuer Teilnehmer lernt meine Reichweite
    .on(RoomEvent.ParticipantDisconnected, () => { if (settingsOpen) renderVoiceUsers(); })
    .on(RoomEvent.DataReceived, (payload, participant) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg.t === 'range' && participant) { remoteRanges[participant.identity] = msg.r; updateProximityVolumes(); }
      } catch {}
    })
    .on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) {
        const a = track.attach(); a.autoplay = true; document.body.appendChild(a);
        updateProximityVolumes();
      }
    });
  await room.connect(url, token);
  // Sprech-Erkennung des eigenen Mikros
  room.localParticipant.on(ParticipantEvent.IsSpeakingChanged, () => refreshMicState());
}

async function toggleConnect() {
  if (room) { await room.disconnect(); room = null; micEnabled = false; voiceConnected = false; el('connBtn').textContent = 'Verbinden'; setMicState('disconnected'); updateVoiceWarn(); }
  else {
    if (!me) { showToast('Voice nur auf dem BlackFossil-Server verfügbar', 'error'); return; }
    const s = await window.bf.getSession(); if (s) connectWithSession(s);
  }
}

async function toggleMic() {
  if (!room) return;
  micEnabled = !micEnabled;
  el('micBtn').textContent = micEnabled ? 'Mikro aus' : 'Mikro an';
  await applyMic();
}

init();
