import { Room, RoomEvent, Track, ParticipantEvent } from 'livekit-client';
import { loadMapImage, drawFullMap, drawMinimap, drawHeatmap, normToWorld, worldToNorm, zoneAt, resetCal, solveAffine, getCal, setCalAffine, setZones, ZONES, loadZoneLayer, setZoneLayer, isZoneLayerVisible, groupColorFor } from './map.js';

const el = (id) => document.getElementById(id);

// ── Karten-/Positions-State ─────────────────────────────────────────────────
let players = [];
let me = null;
let waypoints = [];
let calibMode = false;
let heatmapMode = false;
// Auto-Kalibrierung über ZONEN-Ecken: rohe Welt-Koordinaten der hinterlegten Zonen
// (PVP/PVE), gut über die Karte verteilt ausgewählt. Du erkennst die Ecken am Gelände
// und klickst sie an → solveAffine schiebt nur die DARSTELLUNG zurecht (kein Umrechnen
// der Teleport-Ziele!).
function pickCalibTargets(n) {
  const pts = [...((ZONES.pvp && ZONES.pvp.points) || []), ...((ZONES.pve && ZONES.pve.points) || [])]
    .map((p) => ({ x: p.x, y: p.y }));
  if (pts.length <= n) return pts;
  // Farthest-Point-Sampling: maximal weit auseinander liegende Punkte wählen
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const sel = [pts.reduce((a, b) => ((b.x - cx) ** 2 + (b.y - cy) ** 2) > ((a.x - cx) ** 2 + (a.y - cy) ** 2) ? b : a)];
  while (sel.length < n) {
    let best = null, bestD = -1;
    for (const p of pts) {
      const d = Math.min(...sel.map((s) => (s.x - p.x) ** 2 + (s.y - p.y) ** 2));
      if (d > bestD) { bestD = d; best = p; }
    }
    sel.push(best);
  }
  return sel;
}
let autoCalib = null; // { startPos, pairs, resolveClick }
const CALIB_HOVER_Z = 80000; // Schwebehöhe über der Zonen-Ecke (klar über jedem Gelände)
// Teleport-Punkte
let teleports = [];       // [{id,number,name,price,cooldownMin,x,y,cooldownRemaining}]
let myPoints = 0;
let hoveredTp = null;     // id des gehoverten TP (Map ↔ Liste)
let tpIsAdmin = false;
let tpConfirmTarget = null;
let appVersion = '?';
function updateVersionInfo() {
  const v = el('versionInfo');
  if (v) v.textContent = `v${appVersion}${tpIsAdmin ? ' · Team ✓' : ''}`;
}
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
// Master-Lautstärke für ALLE Spieler (0..2) — Regler über der Spielerliste.
let masterGain = (parseFloat(localStorage.getItem('bf-master-gain')) || 1);
// Eigene Mikrofon-Verstärkung (0..2) — wird per Web-Audio-GainNode auf den
// gesendeten Mikro-Track gelegt (siehe createMicGainProcessor).
let micGain = (parseFloat(localStorage.getItem('bf-mic-gain')) || 1);
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
let lastMe = null;
function updateHud(d) {
  if (!d) return;
  lastMe = d;
  if (featureOpen === 'profile') renderProfile();
  { const av = document.getElementById('hudAvatar'); if (av) { if (d.avatarUrl) { if (av.src !== d.avatarUrl) av.src = d.avatarUrl; av.style.display = 'inline-block'; } else av.style.display = 'none'; } }
  if (d.name) document.getElementById('hudName').textContent = d.name;
  if (typeof d.points === 'number') document.getElementById('hudPoints').textContent = `${d.points.toLocaleString('de-DE')} Pkt.`;
  if (d.tier) setTier(d.tier);
  checkPrimes(d.primes, d.dino);   // immer aufrufen → Offline/Dino-Wechsel resettet die Basis
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
let deafened = false;                                   // eingehenden Ton stummschalten
let micDeviceId = localStorage.getItem('bf-mic-dev') || '';   // gewähltes Mikrofon
let spkDeviceId = localStorage.getItem('bf-spk-dev') || '';   // gewähltes Ausgabegerät
let aiSpawnMode = false;                                // Karten-Klick-Spawn aktiv
let mapOpen = false;

async function init() {
  config = await window.bf.getConfig();
  try { appVersion = await window.bf.getVersion?.() || '?'; } catch {}
  updateVersionInfo();

  el('connBtn').onclick = () => toggleConnect();
  el('voiceWarn').onclick = () => toggleConnect();
  el('voiceSearch').oninput = (e) => { voiceSearch = e.target.value; renderVoiceUsers(); };
  el('micBtn').onclick = () => toggleMic();
  setMicBtn();
  el('logoutBtn').onclick = () => window.bf.logout();
  el('closeBtn').onclick = () => toggleSettings(false);
  el('heatBtn').onclick = () => {
    heatmapMode = !heatmapMode;
    el('heatBtn').style.background = heatmapMode ? '#8b5cf6' : 'var(--panel)';
    // Zonen-Layer-Toggles nur anbieten, wenn Heatmap aus ist
    el('zoneLayers').style.display = heatmapMode ? 'none' : 'flex';
    renderBigMap();
  };

  // Zonen-Layer-Toggles (Sanctuary/Patrol/Migration) — transparente Overlay-Bilder
  for (const key of ['sanctuary', 'patrol', 'migration']) {
    const btn = el('zl' + key[0].toUpperCase() + key.slice(1));
    if (!btn) continue;
    btn.onclick = () => {
      const on = !isZoneLayerVisible(key);
      setZoneLayer(key, on);
      btn.style.background = on ? '#8b5cf6' : 'var(--panel)';
      renderBigMap();
    };
  }
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
  el('checkUpdateBtn').onclick = () => {
    const b = el('checkUpdateBtn');
    b.disabled = true; b.textContent = '🔄 Suche…';
    setTimeout(() => { b.disabled = false; b.textContent = '🔄 Nach Updates suchen'; }, 6000);
    window.bf.updateCheck?.();
  };
  window.bf.onUpdateNone?.(() => {
    const b = el('checkUpdateBtn'); if (b) { b.disabled = false; b.textContent = '🔄 Nach Updates suchen'; }
    showToast('✅ Du hast die aktuelle Version', 'success');
  });
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
    if (!focused) { toggleSettings(false); toggleMap(false); closeAllFeatures(); toggleOverlayMode(false); }
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
  // Zonen-Layer-Bilder vorladen (fehlende werden still ignoriert) → bei Toggle neu zeichnen
  Promise.all(['sanctuary', 'patrol', 'migration'].map((k) => loadZoneLayer(k))).then(() => renderBigMap());

  // Karten-Interaktion
  const cv = el('bigMapCanvas');
  cv.addEventListener('click', onMapClick);
  cv.addEventListener('wheel', onMapWheel, { passive: false });
  cv.addEventListener('mousedown', onMapMouseDown);
  window.addEventListener('mousemove', onMapMouseMove);
  window.addEventListener('mouseup', () => { dragging = false; });
  cv.addEventListener('mousemove', tpHoverHitTest);
  cv.addEventListener('mouseleave', () => setHoveredTp(null));
  // Dock (Overlay-Modus / Alt)
  document.querySelectorAll('.dock-btn[data-act]').forEach((b) => {
    b.insertAdjacentHTML('afterbegin', DOCK_ICONS[b.dataset.act] || '');
    b.onclick = () => navTo(b.dataset.act);
  });
  // Einheitlicher Schließen-Button im Dock → alles zu + zurück ins Spiel
  { const c = el('dockClose'); if (c) { c.insertAdjacentHTML('afterbegin', DOCK_ICONS.close); c.onclick = () => closeOverlayAll(); } }
  // „^" auch schließen, wenn das Overlay den Fokus hat (dann verschluckt der globale
  // Hook den Dead-Key — der DOM-Event kommt hier aber zuverlässig an). Backquote = „^"/„`".
  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (e.code === 'Backquote' && !/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) { e.preventDefault(); toggleOverlayMode(); }
  });

  // Admin-Panel (eigenständiges Modal, nur Admins)
  el('openAdminBtn').onclick = () => openAdminPanel();
  el('adminCloseBtn').onclick = () => closeAdminPanel();
  el('admUserLoad').onclick = () => admLoadUserInfo();
  el('admLightningBtn').onclick = () => admLightning();
  el('giftTargetKind').onchange = () => updateGiftTarget();
  el('giftSubmit').onclick = () => admGift();
  el('adminCalibBtn').onclick = () => adminCalibrate();
  el('tpCreateBtn').onclick = () => createTp();

  // AI-Dinos (Team)
  populateAiSpecies();
  el('aiSpawnMapBtn').onclick = () => toggleAiSpawnMode();
  el('aiStartBtn').onclick = () => aiControl('start', 'Auto-Spawn gestartet');
  el('aiStopBtn').onclick = () => aiControl('stop', 'Auto-Spawn gestoppt');
  el('aiDespawnBtn').onclick = () => aiControl('despawnall', 'Despawn ausgelöst');
  el('aiKillBtn').onclick = () => aiControl('killall', 'Kill ausgelöst');
  el('aiPanicBtn').onclick = () => aiControl('panic', 'PANIC ausgeführt');
  el('aiDisableBtn').onclick = () => aiControl('disable', 'DLL deaktiviert (nach Neustart)');
  el('tpConfirmYes').onclick = () => useTp();
  el('tpConfirmNo').onclick = () => { el('tpConfirm').style.display = 'none'; tpConfirmTarget = null; };
  el('centerBtn').onclick = () => centerOnMe();
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

  // Deafen + Audio-Geräte
  el('deafenBtn').onclick = () => toggleDeafen();
  el('micDevSel').onchange = (e) => setMicDevice(e.target.value);
  el('spkDevSel').onchange = (e) => setSpkDevice(e.target.value);
  enumAudioDevices();
  if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', enumAudioDevices);

  // Eigene Mikrofon-Lautstärke (Gain auf den gesendeten Track)
  const mg = el('micGain');
  if (mg) { mg.value = String(Math.round(micGain * 100)); mg.oninput = (e) => setMicGain(parseInt(e.target.value)); }
  // Master-Lautstärke für alle Spieler
  const mv = el('masterGain');
  if (mv) { mv.value = String(Math.round(masterGain * 100)); mv.oninput = (e) => setMasterGain(parseInt(e.target.value)); }

  // Maustasten als Hotkey (für Push-to-Talk/Mute): während des Neubelegens Klick fangen
  window.addEventListener('mousedown', onRebindMouse, true);

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
        if (Array.isArray(data.toasts)) for (const t of data.toasts) showToast(t, 'success');
        applyServerState();
        updateZoneBox();
        checkZoneChange();
        updateProximityVolumes();
        if (settingsOpen) renderVoiceUsers();
        if (mapOpen) renderBigMap();
        if (featureOpen === 'group') renderGroup();
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
    // Pro-User-Grundlautstärke + Master-Regler obendrauf. Bei Deafen alles auf 0.
    // Dank webAudioMix:true setzt setVolume einen GainNode → Werte >1 wirken wirklich.
    const g = userGain[p.identity] ?? 1;
    const factor = deafened ? 0 : masterGain;
    try { p.setVolume(vol * g * factor); } catch {}
  }
}

// ── Pro-User-Lautstärke (Regler im Settings-Menü) ────────────────────────────
function setUserGain(identity, factor) {
  userGain[identity] = factor;
  try { localStorage.setItem('bf-user-gain', JSON.stringify(userGain)); } catch {}
  updateProximityVolumes();
}

// Master-Lautstärke für alle Spieler (Regler über der Spielerliste)
function setMasterGain(pct) {
  masterGain = Math.max(0, Math.min(2, pct / 100));
  try { localStorage.setItem('bf-master-gain', String(Math.round(masterGain * 100) / 100)); } catch {}
  const lbl = el('masterGainVal'); if (lbl) lbl.textContent = `${Math.round(masterGain * 100)}%`;
  updateProximityVolumes();
}

let voiceSearch = '';
function renderVoiceUsers() {
  const box = el('voiceUsers');
  if (!box) return;
  const q = voiceSearch.trim().toLowerCase();
  // Nur Teilnehmer, die GERADE auf dem Server sind (in /positions), + Suche, alphabetisch
  const list = (room ? [...room.remoteParticipants.values()] : [])
    .map((p) => { const pos = players.find((pl) => pl.steamId === p.identity); return { p, name: pos ? (pos.name || p.name || p.identity) : null }; })
    .filter((e) => e.name !== null)
    .filter((e) => !q || e.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) {
    box.innerHTML = `<div style="color:var(--muted);font-size:12px">${q ? 'Niemand gefunden.' : 'Keine anderen Spieler im Voice auf dem Server.'}</div>`;
    return;
  }
  box.innerHTML = '';
  for (const { p, name } of list) {
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
  else drawFullMap(view, players, waypoints, teleports, hoveredTp, 1 / mapZoom);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (calibMode) drawCalibOverlay(ctx, cv.width, cv.height);
  renderMapGroup();
}

// Gruppe unten-rechts auf der großen Karte (Mitglieder mit Map-Farbe + Distanz)
function renderMapGroup() {
  const box = el('mapGroup'); if (!box) return;
  box.style.display = 'block';   // immer sichtbar — zeigt auch den "keine Gruppe"-Hinweis
  const myG = me && me.groupId;
  const members = players.filter((p) => !p.isYou && !p.isDead && ((myG && p.groupId === myG) || p.ovgroup));
  if (!members.length) {
    box.innerHTML = `<div style="font-weight:700;margin-bottom:4px">👥 Gruppe</div>` +
      `<div style="color:var(--muted);line-height:1.4">Aktuell bist du in keiner Gruppe.</div>`;
    return;
  }
  if (me) members.sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y));
  box.innerHTML = `<div style="font-weight:700;margin-bottom:6px">👥 Gruppe (${members.length})</div>` +
    `<div style="color:var(--muted);font-size:10px;margin-bottom:6px">Klick = Karte auf Mitglied zentrieren</div>` +
    members.map((p) => {
      const col = groupColorFor(p.steamId);
      const dist = me ? `${Math.round(Math.hypot(p.x - me.x, p.y - me.y) / UNITS_PER_M)} m` : '';
      return `<div class="mapGroupRow" data-sid="${escapeHtml(p.steamId)}" style="display:flex;align-items:center;gap:7px;padding:4px 4px;margin:0 -4px;border-radius:6px;font-size:12px;cursor:pointer">
        <span style="width:9px;height:9px;border-radius:50%;background:${col};flex:none"></span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p.name || '?')}</span>
        <span style="color:var(--muted);flex:none">${dist}</span></div>`;
    }).join('');
  box.querySelectorAll('.mapGroupRow').forEach((row) => {
    row.onmouseenter = () => { row.style.background = 'rgba(139,92,246,0.18)'; };
    row.onmouseleave = () => { row.style.background = 'transparent'; };
    row.onclick = () => centerOnPlayer(row.dataset.sid);
  });
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

  // AI-Dino-Spawn-Modus (nur Team): Klick = Spawn-Position
  if (aiSpawnMode && tpIsAdmin) {
    aiSpawnAt(w.x, w.y);
    return;
  }

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

// Zentriert die Karte auf eine Welt-Position (mit Mindest-Zoom)
function centerOnWorld(wx, wy) {
  const cv = el('bigMapCanvas');
  const { nx, ny } = worldToNorm(wx, wy);
  mapZoom = Math.max(mapZoom, 3);
  mapPanX = cv.width / 2 - nx * cv.width * mapZoom;
  mapPanY = cv.height / 2 - ny * cv.height * mapZoom;
  clampPan();
  renderBigMap();
}
function centerOnMe() { if (me) centerOnWorld(me.x, me.y); }
function centerOnPlayer(steamId) {
  const p = players.find((pl) => pl.steamId === steamId);
  if (p) centerOnWorld(p.x, p.y);
}

// ── Auto-Kalibrierung (Teleport zu 6 Punkten + Klick auf die Karte) ──────────
async function calibTeleport(x, y, z) {
  // z mitschicken (richtige Höhe); ohne z nimmt der token-service die aktuelle Höhe
  const body = z === undefined ? { x, y } : { x, y, z };
  const res = await fetch(`${config.tokenBase}/player/teleport`, {
    method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
  const targets = pickCalibTargets(4);
  if (targets.length < 3) {
    showToast('Keine Zonen-Daten — Kalibrierung nicht möglich', 'error');
    endAutoCalib();
    return;
  }
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    calibPrompt(`Punkt ${i + 1}/${targets.length} — du wirst über die Zonen-Ecke teleportiert…`, true);
    try { await calibTeleport(t.x, t.y, CALIB_HOVER_Z); } // hoch über dem Punkt → kein Aufprall
    catch (e) { showToast(`Punkt ${i + 1} übersprungen (Teleport: ${e.message})`, 'error'); continue; }
    if (!autoCalib) return; // abgebrochen
    // Schweben: regelmäßig wieder hochteleportieren → man fällt nie auf, kein Schaden
    const hover = setInterval(() => { calibTeleport(t.x, t.y, CALIB_HOVER_Z).catch(() => {}); }, 800);
    calibPrompt(`Punkt ${i + 1}/${targets.length} — du schwebst über der Ecke. Klicke auf der Karte GENAU dort, wo du bist.`, true);
    const norm = await waitForCalibClick();
    clearInterval(hover);
    if (!autoCalib) return;
    if (!norm) { await abortAutoCalib(); return; }
    autoCalib.pairs.push({ world: { x: t.x, y: t.y }, norm });
  }
  calibPrompt('Zurück zur Startposition…', false);
  try { await calibTeleport(autoCalib.startPos.x, autoCalib.startPos.y, autoCalib.startPos.z); } catch {}
  const count = autoCalib.pairs.length;
  if (count < 3) {
    showToast(`Zu wenige Punkte (${count}/6) — bitte erneut versuchen`, 'error');
    endAutoCalib();
    return;
  }
  const ok = solveAffine(autoCalib.pairs);
  showToast(ok ? `✅ Karte kalibriert! (${count} Punkte)` : 'Kalibrierung fehlgeschlagen', ok ? 'success' : 'error');
  endAutoCalib();
  renderBigMap();
  return ok;
}
async function abortAutoCalib() {
  if (!autoCalib) return;
  const sp = autoCalib.startPos;
  if (autoCalib.resolveClick) { const r = autoCalib.resolveClick; autoCalib.resolveClick = null; r(null); }
  endAutoCalib();
  try { await calibTeleport(sp.x, sp.y, sp.z); } catch {}
  showToast('Kalibrierung abgebrochen', '');
}

// ── Teleport-Punkte ──────────────────────────────────────────────────────────
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function loadTeleports() {
  if (!sessionToken) return;
  try {
    const res = await fetch(`${config.tokenBase}/teleports`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!res.ok) return;
    const d = await res.json();
    teleports = d.teleports || [];
    myPoints = d.points || 0;
    tpIsAdmin = !!(d.isTeam || d.isAdmin);
    updateVersionInfo();
    renderTpList();
    renderAdminTpList();
    if (mapOpen) renderBigMap();
  } catch {}
}

function setHoveredTp(id) {
  if (hoveredTp === id) return;
  hoveredTp = id;
  renderTpList();
  if (mapOpen) renderBigMap();
}

function renderTpList() {
  const box = el('tpListItems'); if (!box) return;
  if (!teleports.length) { box.innerHTML = '<div style="color:var(--muted)">Keine Punkte.</div>'; return; }
  box.innerHTML = '';
  for (const t of [...teleports].sort((a, b) => a.number - b.number)) {
    const hot = t.id === hoveredTp;
    const cd = t.cooldownRemaining || 0;
    const row = document.createElement('div');
    row.style.cssText = `padding:6px 8px;margin-bottom:4px;border-radius:8px;cursor:pointer;border:1px solid ${hot ? 'var(--accent)' : 'transparent'};background:${hot ? 'rgba(139,92,246,0.20)' : 'rgba(255,255,255,0.04)'}`;
    row.innerHTML =
      `<div style="display:flex;justify-content:space-between;gap:6px"><b>#${t.number} ${escapeHtml(t.name)}</b>` +
      `<span style="color:var(--muted)">${t.price > 0 ? t.price + ' Pkt' : 'gratis'}</span></div>` +
      (cd > 0 ? `<div style="color:#f59e0b;font-size:11px">⏳ ${fmtCd(cd)}</div>` : '');
    row.onmouseenter = () => setHoveredTp(t.id);
    row.onmouseleave = () => setHoveredTp(null);
    row.onclick = () => confirmTp(t);
    box.appendChild(row);
  }
}

function confirmTp(t) {
  const cd = t.cooldownRemaining || 0;
  if (cd > 0) { showToast(`Cooldown: noch ${fmtCd(cd)}`, 'error'); return; }
  if (t.price > myPoints) { showToast(`Zu wenig Punkte (${myPoints}/${t.price})`, 'error'); return; }
  tpConfirmTarget = t;
  el('tpConfirmText').innerHTML =
    `Zu <b>#${t.number} ${escapeHtml(t.name)}</b> teleportieren?<br>` +
    `<span style="color:var(--muted)">${t.price > 0 ? `Kosten: ${t.price} Punkte (du hast ${myPoints})` : 'Kostenlos'}${t.cooldownMin > 0 ? ` · danach ${t.cooldownMin} Min Cooldown` : ''}</span>`;
  el('tpConfirm').style.display = 'block';
}

async function useTp() {
  const t = tpConfirmTarget;
  el('tpConfirm').style.display = 'none'; tpConfirmTarget = null;
  if (!t) return;
  try {
    const res = await fetch(`${config.tokenBase}/teleports/${t.id}/use`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` } });
    const d = await res.json(); if (!res.ok) throw new Error(d.error || 'Fehler');
    showToast(`✈️ Teleportiert zu ${t.name}`, 'success');
    myPoints = d.points ?? myPoints;
    pollHud();
    await loadTeleports();
  } catch (e) { showToast(e.message, 'error'); }
}

// Maus über einem TP-Marker auf der Karte? (Hover ↔ Liste)
function tpHoverHitTest(e) {
  if (dragging || !mapOpen || !teleports.length) return;
  const { nx, ny } = eventToNorm(e);
  let best = null, bestD = 0.02;
  for (const t of teleports) {
    const p = worldToNorm(t.x, t.y);
    const dd = Math.hypot(p.nx - nx, p.ny - ny);
    if (dd < bestD) { bestD = dd; best = t.id; }
  }
  setHoveredTp(best);
}

// ── Admin-Panel (eigenständiges Modal, NUR Admins) ───────────────────────────
let adminOpen = false;
let adminUserMap = new Map();   // Option-Text → { steamId, discordId, name }
let admSelectedSteamId = null;

function openAdminPanel() {
  if (!isAdmin) { showToast('Nur für Admins', 'error'); return; }
  adminOpen = true;
  el('adminPanel').style.display = 'block';
  updateInteractive();
  ensureGiftTypeOptions();
  loadAdminUsers();
  loadAdminRoles();
  loadTeleports();
  renderAdminTpList();
}
function closeAdminPanel() {
  adminOpen = false;
  el('adminPanel').style.display = 'none';
  updateInteractive();
}
// Hotkey „admin-menu": Panel umschalten (nur Admins)
function openAdminMenu() {
  if (!isAdmin) { loadTeleports(); return; }
  if (adminOpen) closeAdminPanel(); else openAdminPanel();
}

// Discord-User laden → Such-Datalists füllen + Name→SteamID-Map
async function loadAdminUsers() {
  if (!sessionToken) return;
  try {
    const res = await fetch(`${config.tokenBase}/admin/users`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!res.ok) return;
    const d = await res.json();
    adminUserMap = new Map();
    const dl = el('admUserList');
    dl.innerHTML = '';
    const seen = new Set();
    for (const u of (d.users || [])) {
      let key = u.name;
      if (seen.has(key)) key = `${u.name} (…${u.steamId.slice(-4)})`;
      seen.add(key);
      adminUserMap.set(key, u);
      const opt = document.createElement('option');
      opt.value = key;
      dl.appendChild(opt);
    }
  } catch {}
}

// Rollen laden → Beschenken-Rollen-Dropdown
async function loadAdminRoles() {
  if (!sessionToken) return;
  try {
    const res = await fetch(`${config.tokenBase}/admin/roles`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!res.ok) return;
    const d = await res.json();
    const sel = el('giftRoleSel');
    sel.innerHTML = '';
    for (const r of (d.roles || [])) {
      const o = document.createElement('option');
      o.value = r.id; o.textContent = r.name;
      sel.appendChild(o);
    }
  } catch {}
}

const GIFT_TYPES = [
  { value: 'points', label: '💰 Punkte' },
  { value: 'hunger', label: '🍖 Hunger-Token' },
  { value: 'thirst', label: '💧 Durst-Token' },
  { value: 'protein', label: '🥩 Protein-Token' },
  { value: 'carbs', label: '🌿 Carbs-Token' },
  { value: 'lipid', label: '🥑 Lipid-Token' },
  { value: 'heal', label: '❤️ Heal-Token' },
  { value: 'grow_boost', label: '📈 Grow-Boost-Token' },
  { value: 'insta_grow', label: '⚡ Insta-Grow-Token' },
];
function ensureGiftTypeOptions() {
  const sel = el('giftType');
  if (sel.options.length) return;
  for (const t of GIFT_TYPES) { const o = document.createElement('option'); o.value = t.value; o.textContent = t.label; sel.appendChild(o); }
}
function updateGiftTarget() {
  const kind = el('giftTargetKind').value;
  el('giftUserBox').style.display = kind === 'user' ? 'block' : 'none';
  el('giftRoleBox').style.display = kind === 'role' ? 'block' : 'none';
}

function resolveAdminUser(inputId) {
  const v = (el(inputId).value || '').trim();
  return adminUserMap.get(v) || null;
}

async function admLoadUserInfo() {
  const u = resolveAdminUser('admUserSearch');
  if (!u) { showToast('Bitte einen User aus der Liste wählen', 'error'); return; }
  admSelectedSteamId = u.steamId;
  el('admUserInfo').style.display = 'block';
  el('admUserInfo').innerHTML = '<span style="color:var(--muted)">Lädt…</span>';
  el('admUserActions').style.display = 'none';
  try {
    const res = await fetch(`${config.tokenBase}/admin/user-info`, {
      method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ steamId: u.steamId }),
    });
    const d = await res.json(); if (!res.ok) throw new Error(d.error || 'Fehler');
    const toks = Object.entries(d.tokens || {}).filter(([, n]) => n > 0).map(([k, n]) => `${k} ×${n}`).join(', ') || '—';
    const dino = d.dino && d.dino.online
      ? `${escapeHtml(d.dino.dinoClass || '?')} · ${Math.round((d.dino.grow || 0) * 100)}%${d.dino.elderReplicationStacks ? ` · 🪦${d.dino.elderReplicationStacks}` : ''}`
      : 'offline';
    el('admUserInfo').innerHTML =
      `<div><b>${escapeHtml(d.name || u.name)}</b> ${d.rank ? `<span style="color:var(--accent)">${escapeHtml(d.rank)}</span>` : ''}</div>` +
      `<div style="color:var(--muted)">SteamID: ${d.steamId}</div>` +
      `<div>💰 Punkte: <b>${d.points}</b></div>` +
      `<div>🎟️ Token: ${escapeHtml(toks)}</div>` +
      `<div>🦖 Live-Dino: ${dino}</div>`;
    el('admUserActions').style.display = 'block';
  } catch (e) { el('admUserInfo').innerHTML = `<span style="color:var(--off)">${escapeHtml(e.message)}</span>`; }
}

async function admLightning() {
  if (!admSelectedSteamId) { showToast('Erst einen User laden', 'error'); return; }
  if (!window.confirm('Lightning Strike (Slay) auf den aktiven Dino dieses Spielers ausführen?')) return;
  try {
    const res = await fetch(`${config.tokenBase}/admin/lightning`, {
      method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ steamId: admSelectedSteamId }),
    });
    const d = await res.json(); if (!res.ok) throw new Error(d.error || 'Fehler');
    showToast(d.slayed ? '⚡ Spieler geslayed' : '⚡ Blitz gesendet (kein aktiver Dino?)', d.slayed ? 'success' : '');
  } catch (e) { showToast(e.message, 'error'); }
}

async function admGift() {
  const kind = el('giftTargetKind').value;
  const type = el('giftType').value;
  const amount = parseInt(el('giftAmount').value) || 0;
  if (amount < 1) { showToast('Menge ≥ 1', 'error'); return; }
  const body = { targetKind: kind, type, amount };
  let label = '';
  if (kind === 'user') {
    const u = resolveAdminUser('giftUserSearch');
    if (!u) { showToast('User wählen', 'error'); return; }
    body.targetId = u.steamId; label = u.name;
  } else if (kind === 'role') {
    const sel = el('giftRoleSel');
    if (!sel.value) { showToast('Rolle wählen', 'error'); return; }
    body.targetId = sel.value; label = `Rolle ${sel.options[sel.selectedIndex].text}`;
  } else { label = 'alle Online'; }
  const typeLabel = (GIFT_TYPES.find((t) => t.value === type) || {}).label || type;
  if (!window.confirm(`${amount}× ${typeLabel} an ${label} vergeben?`)) return;
  el('giftResult').textContent = 'Vergebe…';
  try {
    const res = await fetch(`${config.tokenBase}/admin/gift`, {
      method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await res.json(); if (!res.ok) throw new Error(d.error || 'Fehler');
    el('giftResult').textContent = `✅ An ${d.affected} Spieler vergeben.`;
    showToast(`🎁 ${amount}× ${typeLabel} → ${d.affected} Spieler`, 'success');
  } catch (e) { el('giftResult').textContent = ''; showToast(e.message, 'error'); }
}

function renderAdminTpList() {
  const box = el('adminTpList'); if (!box || !tpIsAdmin) return;
  box.innerHTML = teleports.length ? '' : '<div style="color:var(--muted)">Keine.</div>';
  for (const t of [...teleports].sort((a, b) => a.number - b.number)) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;padding:4px 0';
    row.innerHTML = `<span>#${t.number} ${escapeHtml(t.name)} <span style="color:var(--muted)">${t.price}P</span></span>`;
    const del = document.createElement('button');
    del.textContent = '🗑'; del.style.cssText = 'width:auto;padding:3px 8px';
    del.onclick = () => deleteTp(t);
    row.appendChild(del);
    box.appendChild(row);
  }
}

async function createTp() {
  const name = el('tpName').value.trim();
  const price = parseInt(el('tpPrice').value) || 0;
  const cooldownMin = parseInt(el('tpCooldown').value) || 0;
  if (!name) { showToast('Name fehlt', 'error'); return; }
  try {
    const res = await fetch(`${config.tokenBase}/teleports`, {
      method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, price, cooldownMin }),
    });
    const d = await res.json(); if (!res.ok) throw new Error(d.error || 'Fehler');
    showToast(`📍 TP-Punkt "${name}" erstellt`, 'success');
    el('tpName').value = ''; el('tpPrice').value = ''; el('tpCooldown').value = '';
    await loadTeleports();
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteTp(t) {
  try {
    const res = await fetch(`${config.tokenBase}/teleports/${t.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Fehler'); }
    showToast(`TP-Punkt #${t.number} gelöscht`, '');
    await loadTeleports();
  } catch (e) { showToast(e.message, 'error'); }
}

async function adminCalibrate() {
  closeAdminPanel(); // Kalibrierung läuft auf der Karte → Modal schließen
  const ok = await startAutoCalibration();
  if (!ok) return;
  try {
    const res = await fetch(`${config.tokenBase}/calibration`, {
      method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ affine: getCal() }),
    });
    if (res.ok) showToast('🌍 Kalibrierung global für alle gespeichert', 'success');
    else { const d = await res.json().catch(() => ({})); showToast(d.error || 'Global-Speichern fehlgeschlagen', 'error'); }
  } catch (e) { showToast(e.message, 'error'); }
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
  if (action === 'overlay-mode') return toggleOverlayMode(); // Alt: Klick-Modus, auch off-server
  if (!me) return; // Off-Server: alle anderen Hotkeys blockiert (nur Hinweis sichtbar)
  if (action === 'admin-menu') return openAdminMenu();
  if (action === 'voice-connect') toggleConnect();
  else if (action === 'mic-toggle') toggleMic();
  else if (action === 'settings-toggle') toggleSettings();
  else if (action === 'map-toggle') toggleMap();
  else if (action === 'zone-capture') captureZonePoint();
  else if (action === 'dino-info') toggleFeature('dinoInfo');
  else if (action === 'skin-editor') toggleFeature('skinEditor');
  else if (action === 'garage') toggleFeature('garage');
  else if (action === 'market') toggleFeature('market');
  else if (action === 'group') toggleFeature('group');
  else if (action === 'profile') toggleFeature('profile');
  else if (action === 'lexikon') toggleFeature('lexikon');
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
  'group': 'Gruppe',
  'profile': 'Profil',
  'lexikon': 'Dino-Lexikon',
  'settings-toggle': 'Einstellungen',
  'admin-menu': 'Admin-/Team-Menü',
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
    const mm = /^Mouse(\d+)$/.exec(cur.key || '');
    btn.textContent = mm ? `🖱️ Maus ${mm[1]}` : (cur.key || '—');
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

// Maustaste während des Neubelegens fangen → als 'Mouse<N>' speichern (uiohook-Code).
// Linksklick (0) lassen wir fürs UI; nur Seiten-/Mittel-/Rechtstaste sind belegbar.
const BROWSER_TO_UIOHOOK_BTN = { 1: 3, 2: 2, 3: 4, 4: 5 }; // mitte, rechts, zurück, vor
async function onRebindMouse(e) {
  if (!listeningAction) return;
  const code = BROWSER_TO_UIOHOOK_BTN[e.button];
  if (!code) return;            // Linksklick → normal lassen
  e.preventDefault(); e.stopPropagation();
  await window.bf.setHotkey(listeningAction, `Mouse${code}`);
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
  else if (id === 'group') { ovInviteOpen = false; renderGroup(); loadOvGroup(); }
  else if (id === 'profile') { renderProfile(); loadMyTickets(); loadMyEvents(); }
  else if (id === 'lexikon') renderLexikon();
  else if (id === 'skinEditor') renderSkinEditor();
  else if (id === 'quests') { loadQuest(); startQuestPoll(); }
  el(id).style.display = 'block';
  updateInteractive();
}
function closeAllFeatures(skipInteractive) {
  ['dinoInfo', 'skinEditor', 'garage', 'market', 'group', 'profile', 'lexikon', 'quests'].forEach((id) => { el(id).style.display = 'none'; });
  const tc = el('ticketChat'); if (tc) tc.style.display = 'none';   // Ticket-Chat mit schließen
  stopQuestPoll();
  if (featureOpen === 'dinoInfo') stopDinoInfo();
  featureOpen = null;
  if (!skipInteractive) updateInteractive();
}

// ── Gruppen-Ansicht (Mitglieder mit gleicher groupId, Partner + Distanz) ─────
let ovGroupState = { groupId: null, members: [], invites: [] };
let ovInvitable = [];
let ovInviteOpen = false;
const ovInviteSeen = new Set();

function renderGroup() {
  const panel = el('group');
  const myG = me && me.groupId;
  let members = players.filter((p) => p.isYou || (myG && p.groupId === myG) || p.ovgroup);
  if (!members.length && me) members = [me];
  members.sort((a, b) => {
    if (a.isYou) return -1; if (b.isYou) return 1;
    if (!me) return 0;
    return Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y);
  });

  let body;
  if (!me) {
    body = '<p>Du bist gerade nicht auf dem Server.</p>';
  } else if (members.length <= 1) {
    body = '<p style="color:var(--muted)">Noch keine Gruppe. Bilde eine im Spiel — oder lade unten Spieler <b>gleicher Diät</b> in eine Overlay-Gruppe ein (auch andere Spezies).</p>';
  } else {
    body = members.map((p) => {
      const you = !!p.isYou;
      const partner = me.partnerSteamId && p.steamId === me.partnerSteamId;
      const grow = p.grow != null ? `${Math.round(p.grow * 100)}%` : '';
      const dist = (!you && me) ? `${Math.round(Math.hypot(p.x - me.x, p.y - me.y) / UNITS_PER_M)} m` : '';
      const tag = you ? ' <span style="color:var(--accent-2)">(Du)</span>' : (partner ? ' 💞' : (p.ovgroup ? ' 🔗' : ''));
      return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 10px;margin-bottom:6px;border-radius:9px;background:${you ? 'rgba(139,92,246,0.18)' : 'rgba(255,255,255,0.04)'};border:1px solid ${you ? 'var(--accent)' : 'transparent'}">
        <span style="font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p.name || '?')}${tag}</span>
        <span style="color:var(--muted);font-size:12px;flex:none">${escapeHtml(p.dino || '—')}${grow ? ' · ' + grow : ''}</span>
        <span style="color:var(--accent-2);font-size:12px;flex:none;min-width:42px;text-align:right">${dist}</span>
      </div>`;
    }).join('');
  }

  const inv = (ovGroupState.invites || []).map((i) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 8px;margin-bottom:5px;background:rgba(34,197,94,0.12);border:1px solid var(--border);border-radius:8px">
    <span style="font-size:12px">📨 Einladung von <b>${escapeHtml(i.fromName || '?')}</b></span>
    <button data-acc="${i.gid}" style="width:auto;padding:5px 10px;font-size:12px">Beitreten</button></div>`).join('');
  let invitable = '';
  if (ovInviteOpen) {
    invitable = ovInvitable.length
      ? ovInvitable.map((p) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 8px;margin-bottom:4px;background:rgba(255,255,255,0.04);border-radius:8px">
          <span style="font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p.name)} <span style="color:var(--muted)">· ${escapeHtml(p.dino)}</span></span>
          <button data-inv="${p.steamId}" style="width:auto;padding:5px 10px;font-size:12px">＋ Einladen</button></div>`).join('')
      : '<div style="color:var(--muted);font-size:12px">Keine einladbaren Spieler (gleiche Diät, online).</div>';
  }

  panel.innerHTML = `<h2>👥 Gruppe ${members.length > 1 ? `<span style="font-size:13px;color:var(--muted);font-weight:400">· ${members.length} Mitglieder</span>` : ''}</h2>
    <div style="max-height:36vh;overflow:auto">${body}</div>
    ${inv ? `<div class="sec-title" style="margin-top:12px">📨 Einladungen</div>${inv}` : ''}
    <div class="sec-title" style="margin-top:12px">🔗 Overlay-Gruppe <span style="color:var(--muted);font-weight:400;font-size:11px">(gleiche Diät, übers Overlay)</span></div>
    <button id="ovInviteToggle" style="width:100%;margin:6px 0">${ovInviteOpen ? '▲ Einladen schließen' : '➕ Spieler einladen'}</button>
    ${invitable}
    ${ovGroupState.groupId ? '<button id="ovLeave" class="secondary" style="width:100%;margin-top:6px">Overlay-Gruppe verlassen</button>' : ''}
    <button class="closeFeature secondary" style="margin-top:12px">Schließen</button>`;
  panel.querySelector('.closeFeature').onclick = () => closeAllFeatures();
  const tgl = el('ovInviteToggle'); if (tgl) tgl.onclick = () => { ovInviteOpen = !ovInviteOpen; if (ovInviteOpen) loadOvInvitable(); else renderGroup(); };
  panel.querySelectorAll('[data-acc]').forEach((b) => { b.onclick = () => ovAccept(b.dataset.acc); });
  panel.querySelectorAll('[data-inv]').forEach((b) => { b.onclick = () => ovInvite(b.dataset.inv); });
  const lv = el('ovLeave'); if (lv) lv.onclick = () => ovLeave();
}

async function loadOvGroup() {
  if (!sessionToken) return;
  try {
    const r = await fetch(`${config.tokenBase}/ovgroup`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!r.ok) return;
    ovGroupState = await r.json();
    for (const i of (ovGroupState.invites || [])) {
      if (!ovInviteSeen.has(i.gid)) { ovInviteSeen.add(i.gid); showToast(`📨 Gruppen-Einladung von ${i.fromName || '?'}`, 'success'); }
    }
    if (featureOpen === 'group') renderGroup();
  } catch {}
}
async function loadOvInvitable() {
  if (!sessionToken) return;
  try { const r = await fetch(`${config.tokenBase}/ovgroup/invitable`, { headers: { Authorization: `Bearer ${sessionToken}` } }); if (r.ok) ovInvitable = (await r.json()).players || []; } catch {}
  if (featureOpen === 'group') renderGroup();
}
async function ovInvite(sid) {
  try {
    const r = await fetch(`${config.tokenBase}/ovgroup/invite`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ toSteamId: sid }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Fehler');
    showToast('📨 Einladung gesendet', 'success');
    ovInvitable = ovInvitable.filter((p) => p.steamId !== sid); if (featureOpen === 'group') renderGroup();
  } catch (e) { showToast(e.message, 'error'); }
}
async function ovAccept(gid) {
  try {
    const r = await fetch(`${config.tokenBase}/ovgroup/accept`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ gid }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Fehler');
    showToast('✅ Overlay-Gruppe beigetreten', 'success'); loadOvGroup();
  } catch (e) { showToast(e.message, 'error'); }
}
async function ovLeave() {
  try { await fetch(`${config.tokenBase}/ovgroup/leave`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` } }); showToast('Overlay-Gruppe verlassen', ''); loadOvGroup(); } catch {}
}

// ── Profil / persönliche Stats (aus /me) ─────────────────────────────────────
function fmtPlaytime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}
function vitalBar(label, val, color) {
  const v = Math.max(0, Math.min(100, Math.round(val ?? 0)));
  return `<div style="margin-bottom:6px">
    <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px"><span>${label}</span><span style="color:var(--muted)">${v}%</span></div>
    <div style="height:7px;border-radius:4px;background:rgba(255,255,255,0.08);overflow:hidden"><div style="height:100%;width:${v}%;background:${color}"></div></div>
  </div>`;
}
function renderProfile() {
  const panel = el('profile');
  const d = lastMe;
  // Schließen läuft über den Dock-Button; In-Panel-Buttons existieren nicht mehr (null-sicher).
  const close = () => { const b = panel.querySelector('.closeFeature'); if (b) b.onclick = () => closeAllFeatures(); };
  if (!d) {
    panel.classList.add('pf-wide');
    panel.innerHTML = `<h2>🦖 Profil</h2><p style="color:var(--muted)">Lädt…</p>`;
    close(); pollHud(); return;
  }
  const tokenList = Object.entries(d.tokens || {}).filter(([, n]) => n > 0).map(([k, n]) => `${k.replace(/_/g, ' ')} ×${n}`).join('  ·  ') || '—';
  const tags = [];
  if (d.isHatchling) tags.push('🥚 Hatchling');
  if (d.isElder) tags.push(`🪦 Elder${d.elderStacks ? ` ×${d.elderStacks}` : ''}`);
  if (d.isPrime) tags.push('⭐ Prime');
  if (d.isBleeding) tags.push('🩸 blutet');
  const dinoBlock = d.online
    ? `<div style="margin:12px 0 8px"><b>${escapeHtml(d.dino || '?')}</b> · ${d.gender === 'Female' ? '♀' : '♂'} · ${Math.round((d.grow || 0) * 100)}% ${tags.length ? `<span style="color:var(--muted);font-size:12px">· ${tags.join(' · ')}</span>` : ''}</div>
       ${vitalBar('❤️ Gesundheit', d.health, '#ef4444')}
       ${vitalBar('🍖 Hunger', d.hunger, '#f59e0b')}
       ${vitalBar('💧 Durst', d.thirst, '#38bdf8')}
       ${vitalBar('⚡ Ausdauer', d.stamina, '#22c55e')}
       ${vitalBar('🩸 Blut', d.blood, '#e11d48')}`
    : `<p style="color:var(--muted);margin:12px 0">Aktuell nicht im Spiel — Vitals erscheinen, sobald du auf dem Server bist.</p>`;
  const avatar = d.avatarUrl
    ? `<img src="${d.avatarUrl}" alt="" style="width:46px;height:46px;border-radius:50%;border:2px solid var(--accent);object-fit:cover">`
    : `<span style="width:46px;height:46px;border-radius:50%;border:2px solid var(--accent);display:flex;align-items:center;justify-content:center;background:#1a1230;color:var(--accent-2);font-size:22px">🦖</span>`;
  panel.classList.add('pf-wide');   // breit, mit Seiten-Panels (wie Dino-Info/Settings)
  panel.innerHTML = `<h2>🦖 Profil</h2>
    <div class="pf-main">
      <!-- Links: Events -->
      <div class="pf-side">
        <div class="pf-col-head">📅 Events</div>
        ${profileEventsHtml()}
      </div>
      <!-- Mitte: Profil-Hauptinfo -->
      <div class="pf-center">
        <div style="display:flex;align-items:center;gap:11px;margin-bottom:14px">
          ${avatar}
          <div>
            <div style="font-size:17px;font-weight:600">${escapeHtml(d.name || '?')}</div>
            <span class="tier-badge tier-${d.tier || 'Fossil'}" style="margin-top:3px;display:inline-block">${escapeHtml(d.tier || 'Fossil')}</span>
          </div>
        </div>
        <div style="display:flex;gap:18px;margin-bottom:4px;font-size:13px">
          <span>💰 <b>${(d.points || 0).toLocaleString('de-DE')}</b> Punkte</span>
          <span>⏱️ <b>${fmtPlaytime(d.playtime)}</b> gespielt</span>
        </div>
        ${dinoBlock}
        <div style="margin-top:10px;font-size:12px;color:var(--muted)">🎟️ Token: <span style="color:#eee">${escapeHtml(tokenList)}</span></div>
      </div>
      <!-- Rechts: Tickets -->
      <div class="pf-side">
        <div class="pf-col-head">🎫 Tickets</div>
        ${profileTicketsHtml()}
      </div>
    </div>`;
  close();
  // Tickets anklickbar → Chat-Fenster
  panel.querySelectorAll('.profileTicketRow').forEach((row) => {
    row.onmouseenter = () => { row.style.background = 'rgba(139,92,246,0.16)'; };
    row.onmouseleave = () => { row.style.background = 'rgba(255,255,255,0.04)'; };
    row.onclick = () => openTicketChat(row.dataset.channel, row.dataset.ticket, row.dataset.cat);
  });
}

// ── Events & Tickets (Player-Info) ───────────────────────────────────────────
let myEvents = [];
let myTickets = [];
function fmtEventTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}
function profileEventsHtml() {
  if (!myEvents.length) return '<div style="color:var(--muted);font-size:12px">Keine Events, für die du dich interessierst.</div>';
  return myEvents.map((e) => `<div style="padding:7px 9px;margin-bottom:5px;background:rgba(255,255,255,0.04);border-radius:8px">
    <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(e.name || '?')}</div>
    <div style="font-size:11px;color:var(--accent-2)">🗓️ ${fmtEventTime(e.start)}${e.userCount != null ? ` · ${e.userCount} interessiert` : ''}</div>
  </div>`).join('');
}
function profileTicketsHtml() {
  if (!myTickets.length) return '<div style="color:var(--muted);font-size:12px">Keine offenen Tickets.</div>';
  return myTickets.map((t) => {
    const st = t.status === 'in_bearbeitung' ? `<span style="color:#22c55e">In Bearbeitung${t.handler ? ' · ' + escapeHtml(t.handler) : ''}</span>` : '<span style="color:#f59e0b">Offen</span>';
    const neu = t.lastFromOther ? ' <span style="background:rgba(34,197,94,0.2);color:#86efac;border-radius:5px;padding:1px 6px;font-size:10px">💬 neue Antwort</span>' : '';
    const role = t.role === 'handler' ? ' <span style="background:rgba(139,92,246,0.25);color:#c4b5fd;border-radius:5px;padding:1px 6px;font-size:10px">🛠️ Du bearbeitest</span>' : '';
    return `<div class="profileTicketRow" data-channel="${escapeHtml(t.channelId)}" data-ticket="${t.ticketId}" data-cat="${escapeHtml(t.category || '')}"
        style="padding:7px 9px;margin-bottom:5px;background:rgba(255,255,255,0.04);border-radius:8px;cursor:pointer;transition:background .12s">
      <div style="font-size:13px;font-weight:600">#${t.ticketId} · ${escapeHtml(t.category || '')}${role}${neu}</div>
      <div style="font-size:11px">${st} <span style="color:var(--muted)">· öffnen 💬</span></div>
    </div>`;
  }).join('');
}
function ticketSeen() { try { return JSON.parse(localStorage.getItem('bf-ticket-seen')) || {}; } catch { return {}; } }
function setTicketSeen(o) { localStorage.setItem('bf-ticket-seen', JSON.stringify(o)); }
async function loadMyTickets() {
  if (!sessionToken) return;
  try {
    const r = await fetch(`${config.tokenBase}/me/tickets`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!r.ok) return;
    myTickets = (await r.json()).tickets || [];
    const seen = ticketSeen(); let changed = false;
    for (const t of myTickets) {
      const last = t.lastMessageAt || 0;
      if (t.lastFromOther && last > (seen[t.channelId] || 0)) {
        showToast(`💬 Neue Support-Antwort — Ticket #${t.ticketId}`, 'success');
        seen[t.channelId] = last; changed = true;
      } else if (!(t.channelId in seen)) { seen[t.channelId] = last; changed = true; }
    }
    if (changed) setTicketSeen(seen);
    if (featureOpen === 'profile') renderProfile();
  } catch {}
}
async function loadMyEvents() {
  if (!sessionToken) return;
  try {
    const r = await fetch(`${config.tokenBase}/me/events`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!r.ok) return;
    myEvents = (await r.json()).events || [];
    if (featureOpen === 'profile') renderProfile();
  } catch {}
}

// ── Ticket-Chat-Fenster (kleines Modal über dem Profil) ──────────────────────
// Zeigt die letzte eigene Nachricht und — falls es danach neue Antworten gibt —
// diese direkt darunter. Antworten passieren weiterhin im Discord-Ticket.
function ticketChatModal() {
  let modal = el('ticketChat');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'ticketChat';
    modal.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:70;'
      + 'width:clamp(320px,30vw,440px);max-height:72vh;display:none;flex-direction:column;'
      + 'background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:16px;'
      + 'box-shadow:var(--glow-strong);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)';
    document.body.appendChild(modal);
  }
  return modal;
}
function closeTicketChat() {
  const modal = el('ticketChat'); if (modal) modal.style.display = 'none';
  if (featureOpen === 'profile') renderProfile();   // Badges/Seen aktualisieren
  updateInteractive();
}
async function openTicketChat(channelId, ticketId, category) {
  const modal = ticketChatModal();
  modal.style.display = 'flex';
  modal.innerHTML = `<div style="color:var(--muted)">Lädt Ticket #${ticketId}…</div>`;
  updateInteractive();
  try {
    const r = await fetch(`${config.tokenBase}/me/ticket-messages?channelId=${encodeURIComponent(channelId)}`,
      { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    renderTicketChat(modal, channelId, ticketId, category, data.messages || []);
  } catch (e) {
    modal.innerHTML = `<div style="font-weight:700;margin-bottom:10px">🎫 Ticket #${ticketId}</div>`
      + `<div style="color:#fca5a5;margin-bottom:12px">Nachrichten konnten nicht geladen werden.</div>`
      + `<button id="ticketChatClose" class="secondary">Schließen</button>`;
    el('ticketChatClose').onclick = closeTicketChat;
  }
}
function renderTicketChat(modal, channelId, ticketId, category, messages) {
  // Ticket als gesehen markieren (löscht die "neue Antwort"-Markierung)
  const t = myTickets.find((x) => x.channelId === channelId);
  if (t) { const seen = ticketSeen(); seen[channelId] = t.lastMessageAt || Date.now(); setTicketSeen(seen); }

  // Letzte eigene Nachricht finden; alles ab da zeigen (= eigene + neue Antworten danach).
  let ownIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) { if (messages[i].fromMe) { ownIdx = i; break; } }
  const shown = ownIdx >= 0 ? messages.slice(ownIdx) : messages.slice(-1);
  const hasNew = ownIdx >= 0 && shown.length > 1;

  const bubbles = shown.map((m) => {
    const mine = m.fromMe;
    const body = escapeHtml(m.content || '') || `<i style="opacity:.6">${m.hasAttachment ? '[Anhang]' : '[leer]'}</i>`;
    return `<div style="display:flex;flex-direction:column;align-items:${mine ? 'flex-end' : 'flex-start'};margin-bottom:9px">
      <div style="font-size:10px;color:var(--muted);margin-bottom:2px">${mine ? 'Du' : escapeHtml(m.author)} · ${fmtEventTime(m.at ? new Date(m.at).toISOString() : '')}</div>
      <div style="max-width:85%;padding:8px 11px;border-radius:12px;font-size:13px;line-height:1.35;${mine
        ? 'background:linear-gradient(135deg,var(--accent),#7c3aed);color:#fff;border-bottom-right-radius:4px'
        : 'background:rgba(255,255,255,0.06);color:#eee;border-bottom-left-radius:4px'}">${body}</div>
    </div>`;
  }).join('') || '<div style="color:var(--muted)">Noch keine Nachrichten in diesem Ticket.</div>';

  modal.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div style="font-weight:700">🎫 Ticket #${ticketId} <span style="color:var(--muted);font-weight:400;font-size:12px">· ${escapeHtml(category || '')}</span></div>
      <button id="ticketChatClose" class="secondary" style="flex:none;padding:4px 11px;min-width:0">✕</button>
    </div>
    ${hasNew ? '<div style="font-size:11px;color:#86efac;margin-bottom:8px">💬 Neue Antwort seit deiner letzten Nachricht</div>' : ''}
    <div style="flex:1;overflow:auto;padding-right:4px">${bubbles}</div>
    <div style="margin-top:10px;font-size:11px;color:var(--muted)">Zum Antworten ins Discord-Ticket schreiben.</div>`;
  el('ticketChatClose').onclick = closeTicketChat;
}

// ── Quests (RP-Challenge: Dino + Handicap + Kleinigkeit + RP-Rolle) ───────────
let questState = { rollsToday: 0, dailyLimit: 2, growTarget: 0.8, active: null, doneCount: 0, progress: null };
let questRolling = false;
let questPollTimer = null;
const QUEST_DINO_NAMES = ['Tyrannosaurus', 'Allosaurus', 'Carnotaurus', 'Ceratosaurus', 'Dilophosaurus', 'Herrerasaurus', 'Omniraptor', 'Troodon', 'Pteranodon', 'Deinosuchus', 'Triceratops', 'Diabloceratops', 'Stegosaurus', 'Tenontosaurus', 'Dryosaurus', 'Hypsilophodon', 'Pachycephalosaurus', 'Maiasaura', 'Gallimimus'];

function startQuestPoll() { stopQuestPoll(); questPollTimer = setInterval(() => { if (featureOpen === 'quests' && !questRolling) loadQuest(); }, 5000); }
function stopQuestPoll() { if (questPollTimer) clearInterval(questPollTimer); questPollTimer = null; }

async function loadQuest() {
  if (!sessionToken) return;
  try {
    const r = await fetch(`${config.tokenBase}/me/quest`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!r.ok) return;
    const d = await r.json();
    const wasActive = !!questState.active;
    questState = d;
    if (d.justCompleted) showToast('🏆 RP-Quest erfüllt! Prime mit 80% erreicht!', 'success');
    if (featureOpen === 'quests' && !questRolling) renderQuests();
    if (wasActive && d.justCompleted) { /* schon getoastet */ }
  } catch {}
}

function questLinesHtml(a) {
  const L = (ico, k, v) => `<div class="q-line"><div class="q-l-ico">${ico}</div><div><div class="q-l-k">${k}</div><div class="q-l-v">${escapeHtml(v)}</div></div></div>`;
  return L('🦖', 'Dino', a.dinoName || a.dino)
    + L('⛓️', 'Handicap', a.handicap)
    + L('🎭', 'RP-Rolle', a.rpRole)
    + L('✨', 'Kleinigkeit', a.kleinigkeit);
}
function questProgressHtml() {
  const p = questState.progress, a = questState.active; if (!a) return '';
  const target = Math.round((questState.growTarget || 0.8) * 100);
  let chips;
  if (a.instaUsed) {
    chips = `<span class="q-chip no">⚡ Insta-Grow benutzt — zählt nicht mehr</span>`;
  } else if (!p || !p.online) {
    chips = `<span class="q-chip no">Nicht im Spiel</span>`;
  } else {
    const dinoOk = p.rightDino;
    const growOk = (p.grow || 0) >= (questState.growTarget || 0.8);
    chips = `<span class="q-chip ${dinoOk ? 'ok' : 'no'}">${dinoOk ? '✅' : '🦖'} ${dinoOk ? 'Richtiger Dino' : 'Spiele ' + escapeHtml(a.dinoName || a.dino)}</span>`
      + `<span class="q-chip ${growOk ? 'ok' : 'no'}">📈 ${Math.round((p.grow || 0) * 100)}% / ${target}%</span>`
      + `<span class="q-chip ${p.isPrime ? 'ok' : 'no'}">${p.isPrime ? '⭐' : '☆'} Prime</span>`;
  }
  return `<div class="q-progress">${chips}</div>`;
}
function questStageHtml() {
  const a = questState.active;
  if (a) {
    return `<div style="font-size:12px;color:var(--accent-2);font-weight:700;margin-bottom:6px">DEINE AKTIVE QUEST</div>`
      + questLinesHtml(a).replace(/class="q-line"/g, 'class="q-line show"')
      + questProgressHtml()
      + `<div style="font-size:11px;color:var(--muted);margin-top:12px">Ziel: Mit diesem Dino <b>Prime</b> erreichen und <b>${Math.round((questState.growTarget || 0.8) * 100)}%</b> wachsen — Insta-Grow zählt nicht.</div>`
      + `<button id="qAbandon" class="secondary" style="margin-top:12px">Quest aufgeben</button>`;
  }
  const left = (questState.dailyLimit || 2) - (questState.rollsToday || 0);
  if (left <= 0) {
    return `<div style="text-align:center;color:var(--muted);padding:20px 0">
      <div style="font-size:32px">🌙</div>
      <div style="margin-top:8px;font-weight:600">Tageslimit erreicht</div>
      <div style="font-size:12px;margin-top:4px">Du hast deine ${questState.dailyLimit} Quests für heute verbraucht. Komm morgen wieder!</div></div>`;
  }
  return `<div style="text-align:center">
    <div class="q-slot" style="font-size:40px">🎲</div>
    <div style="color:var(--muted);font-size:13px;margin:8px 0 14px">Würfle eine RP-Challenge: ein Dino, ein Handicap, eine RP-Rolle und eine Kleinigkeit.</div>
    <button id="qRoll" style="max-width:280px;margin:0 auto">🎲 Quest würfeln (${left}/${questState.dailyLimit} heute)</button>
  </div>`;
}
function renderQuests() {
  const panel = el('quests'); if (!panel) return;
  panel.classList.add('q-wide');
  panel.innerHTML = `<h2>📜 Quests</h2>
    <div class="q-types">
      <div class="q-type q-soon"><div class="q-ico">⚔️</div><div class="q-name">PVP</div><div class="q-sub">Kampf-Aufgaben</div><div class="q-soon-badge">coming soon</div></div>
      <div class="q-type q-soon"><div class="q-ico">🧭</div><div class="q-name">Erkundung</div><div class="q-sub">Orte entdecken</div><div class="q-soon-badge">coming soon</div></div>
      <div class="q-type q-active" id="qTypeRp"><div class="q-ico">🎭</div><div class="q-name">RP-Quests</div><div class="q-sub">${questState.doneCount || 0} erfüllt</div></div>
    </div>
    <div class="q-stage" id="qStage">${questStageHtml()}</div>`;
  const roll = el('qRoll'); if (roll) roll.onclick = () => rollRpQuest();
  const ab = el('qAbandon');
  if (ab) {
    let armed = false;
    ab.onclick = () => {
      if (!armed) { armed = true; ab.textContent = '⚠️ Wirklich aufgeben? (Roll verbraucht)'; setTimeout(() => { if (ab) { armed = false; ab.textContent = 'Quest aufgeben'; } }, 3000); return; }
      abandonQuest();
    };
  }
}
async function rollRpQuest() {
  if (questRolling) return;
  if ((questState.rollsToday || 0) >= (questState.dailyLimit || 2)) { showToast('Tageslimit erreicht', 'error'); return; }
  questRolling = true;
  const stage = el('qStage');
  if (stage) stage.innerHTML = `<div class="q-slot spin" id="qSlot">🎲</div><div style="text-align:center;color:var(--muted);margin-top:12px;font-size:12px">Würfle deine Challenge…</div>`;
  const slot = el('qSlot');
  const spin = setInterval(() => { if (slot) slot.textContent = QUEST_DINO_NAMES[Math.floor(Math.random() * QUEST_DINO_NAMES.length)]; }, 85);
  const started = Date.now();
  let result = null, err = null;
  try {
    const r = await fetch(`${config.tokenBase}/me/quest/roll`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'rp' }) });
    const d = await r.json();
    if (!r.ok) err = d.error || 'Fehler'; else result = d;
  } catch { err = 'Verbindungsfehler'; }
  const wait = Math.max(0, 1700 - (Date.now() - started));
  setTimeout(() => {
    clearInterval(spin);
    questRolling = false;
    if (err) { showToast(err, 'error'); loadQuest(); return; }
    questState.active = result.active; questState.rollsToday = result.rollsToday; questState.dailyLimit = result.dailyLimit;
    revealQuest(result.active);
  }, wait);
}
function revealQuest(a) {
  const stage = el('qStage'); if (!stage) { renderQuests(); return; }
  stage.innerHTML = `<div style="font-size:12px;color:var(--accent-2);font-weight:700;margin-bottom:6px">DEINE NEUE QUEST</div>` + questLinesHtml(a);
  const lines = stage.querySelectorAll('.q-line');
  lines.forEach((ln, i) => setTimeout(() => ln.classList.add('show'), 140 * i));
  showToast('🎉 Neue RP-Quest gewürfelt!', 'success');
  setTimeout(() => { if (featureOpen === 'quests') renderQuests(); }, 140 * lines.length + 500);
}
async function abandonQuest() {
  try {
    const r = await fetch(`${config.tokenBase}/me/quest/abandon`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` } });
    const d = await r.json();
    if (r.ok) { questState.active = null; questState.rollsToday = d.rollsToday; showToast('Quest aufgegeben', ''); renderQuests(); }
  } catch {}
}

// ── Dino-Lexikon (statischer Content, von Hideki/Team pflegbar) ───────────────
const DINO_LEXIKON = {
  Tyrannosaurus:    { diet: 'carni', role: 'Apex-Räuber', growth: 'langsam', strengths: ['Höchster Schaden & HP', 'Einschüchterung', 'Bisskraft'], weaknesses: ['Wendet langsam', 'Ziel für Rudel', 'Hoher Hunger'], tip: 'Meide offene Kämpfe gegen Gruppen — nutze Deckung und gezielte Bisse.', fact: 'Lebte vor ~68–66 Mio. Jahren in Nordamerika. Mit bis zu 13 m Länge und einer der stärksten Bisskräfte aller Landtiere — Zähne so groß wie Bananen.' },
  Allosaurus:       { diet: 'carni', role: 'Apex / Rudel', growth: 'mittel', strengths: ['Starker Bleed', 'Rudeltaktik', 'Ausgewogen'], weaknesses: ['Einzeln verwundbar'], tip: 'Jage im Rudel und setze auf Blutung statt Dauer-Tank.', fact: 'Top-Räuber des Oberjura (~155 Mio. J.) in Nordamerika. Schlug den Oberkiefer wie eine Axt in die Beute und riss Stücke heraus.' },
  Carnotaurus:      { diet: 'carni', role: 'Schneller Mid-Carni', growth: 'mittel', strengths: ['Hohe Geschwindigkeit', 'Sprint'], weaknesses: ['Wenig HP', 'Schwach im Dauerkampf'], tip: 'Hit & Run — schlage zu und löse dich, lass dich nicht festklammern.', fact: 'Kreidezeit-Südamerika. Namensgebend sind die Stirnhörner; mit winzigen Ärmchen und langen Beinen einer der schnellsten Großraubsaurier.' },
  Ceratosaurus:     { diet: 'carni', role: 'Mid-Carni (semi-aquatisch)', growth: 'mittel', strengths: ['Bleed', 'Wendig', 'Wasser'], weaknesses: ['Zerbrechlich'], tip: 'Nutze Wasser zum Jagen und Fliehen.', fact: 'Oberjura-Nordamerika. Trug ein markantes Nasenhorn und eine Reihe knöcherner Hautplatten am Rücken; lebte neben Allosaurus.' },
  Deinosuchus:      { diet: 'carni', role: 'Aquatischer Apex', growth: 'langsam', strengths: ['Tödlich im Wasser', 'Grab/Latch'], weaknesses: ['An Land langsam & hilflos'], tip: 'Kämpfe nur im oder am Wasser — locke Beute ans Ufer.', fact: 'Kein Dino, sondern ein bis zu 10 m langer Verwandter heutiger Krokodile (Kreidezeit). Lauerte am Wasser selbst Dinosauriern auf.' },
  Dilophosaurus:    { diet: 'carni', role: 'Small-Carni', growth: 'schnell', strengths: ['Giftspucke aus Distanz', 'Wendig'], weaknesses: ['Sehr fragil'], tip: 'Schwäche aus Distanz an, stell dich nie offen.', fact: 'Frühjura-Nordamerika (~193 Mio. J.). Hatte zwei dünne Kopfkämme — anders als im Film aber kein Gift und keine Halskrause, und war ~6 m lang.' },
  Herrerasaurus:    { diet: 'carni', role: 'Small-Carni', growth: 'schnell', strengths: ['Schnell', 'Bleed', 'Agil'], weaknesses: ['Winzige HP'], tip: 'Hit & Run gegen Kleintiere, Kämpfe gegen Große meiden.', fact: 'Einer der ältesten Dinosaurier überhaupt (Trias, ~231 Mio. J., Argentinien) — leicht gebaut und flink, ein Blick in die Frühzeit der Dinos.' },
  Omniraptor:       { diet: 'carni', role: 'Rudel-Raptor', growth: 'schnell', strengths: ['Rudel', 'Pounce/Sprung', 'Wendig'], weaknesses: ['Einzeln schwach'], tip: 'Nur im Rudel stark — koordiniert Pounces.', fact: 'Spielname; angelehnt an Dromaeosaurier wie Utahraptor — den größten bekannten „Raptor" (~5–7 m) mit großer Sichelkralle und Federn.' },
  Pteranodon:       { diet: 'carni', role: 'Flieger / Scout', growth: 'mittel', strengths: ['Flug', 'Aufklärung', 'Fisch'], weaknesses: ['Am Boden hilflos'], tip: 'Bleib in der Luft und scoute für deine Gruppe.', fact: 'Ein Flugsaurier (kein Dinosaurier) der Kreidezeit mit bis zu 7 m Spannweite, zahnlosem Schnabel und langem Kopfkamm.' },
  Troodon:          { diet: 'carni', role: 'Nacht-Jäger (Small)', growth: 'schnell', strengths: ['Nachtsicht', 'Gift', 'Rudel'], weaknesses: ['Extrem fragil'], tip: 'Jage nachts und nur in der Gruppe.', fact: 'Kleiner Kreidezeit-Theropod mit großem Gehirn und riesigen Augen — galt als besonders „clever" und war wohl nachtaktiv.' },
  Triceratops:      { diet: 'herbi', role: 'Tank-Herbi (Apex)', growth: 'langsam', strengths: ['Enorme HP', 'Charge', 'Konter'], weaknesses: ['Langsam', 'Wendet schlecht'], tip: 'Stell dich und kontere Angreifer mit der Charge.', fact: 'Einer der letzten Dinos vor dem Massenaussterben (~66 Mio. J.). Drei Hörner und ein riesiger Nackenschild zum Schutz und Imponieren.' },
  Stegosaurus:      { diet: 'herbi', role: 'Tank-Herbi', growth: 'mittel', strengths: ['Thagomizer-Schwanz', 'Hohe Defensive'], weaknesses: ['Langsam', 'Nach vorn verwundbar'], tip: 'Halte Angreifer hinter dir und triff mit dem Schwanz.', fact: 'Oberjura-Nordamerika. Die Rückenplatten dienten wohl Wärmeregulation/Schau, die Schwanzstacheln („Thagomizer") der Verteidigung — bei walnussgroßem Gehirn.' },
  Diabloceratops:   { diet: 'herbi', role: 'Konter-Herbi (Mid)', growth: 'mittel', strengths: ['Hörner', 'Wendig', 'Konter'], weaknesses: ['Mittlere HP'], tip: 'Aggressiver Konter — nutze die Hörner offensiv.', fact: 'Früher Ceratopsier (Kreidezeit, Utah). Zwei große Schildhörner gaben ihm das „Teufelsgesicht", das seinen Namen prägte.' },
  Tenontosaurus:    { diet: 'herbi', role: 'Mid-Herbi', growth: 'mittel', strengths: ['Schwanzschlag', 'Zäh'], weaknesses: ['Kein Burst'], tip: 'Defensiv kämpfen, mit dem Schwanz auf Abstand halten.', fact: 'Frühe Kreidezeit-Nordamerika. Mittelgroßer Pflanzenfresser mit auffällig langem Schwanz; oft zusammen mit Deinonychus-Funden entdeckt.' },
  Maiasaura:        { diet: 'herbi', role: 'Herden-Herbi / Nester', growth: 'mittel', strengths: ['Tritt', 'Soziale Herde', 'Nest-Heilung'], weaknesses: ['Kein starker Burst'], tip: 'In der Herde sicher — tritt nach hinten aus.', fact: '„Gute-Mutter-Echse": In Montana fand man ganze Brutkolonien — einer der ersten klaren Belege, dass Dinos ihren Nachwuchs im Nest pflegten.' },
  Pachycephalosaurus:{ diet: 'herbi', role: 'Ramm-Herbi (Small-Mid)', growth: 'schnell', strengths: ['Aufgeladene Ramm-Charge', 'Knockback', 'Wendig'], weaknesses: ['Wenig HP'], tip: 'Lade Rammstöße auf und kite Carnivoren.', fact: 'Kreidezeit-Nordamerika. Die bis zu 25 cm dicke Schädelkuppel diente vermutlich Rivalen- und Flankenkämpfen.' },
  Dryosaurus:       { diet: 'herbi', role: 'Fluchttier (Small)', growth: 'schnell', strengths: ['Sehr schnell', 'Ausdauernd'], weaknesses: ['Keine Offensive'], tip: 'Reines Fluchttier — renne, setze auf Ausdauer-Mutationen.', fact: 'Oberjura-Nordamerika. Kleiner, schneller Pflanzenfresser ohne Panzerung — Überleben durch reine Geschwindigkeit.' },
  Hypsilophodon:    { diet: 'herbi', role: 'Tiny-Herbi', growth: 'schnell', strengths: ['Winzig', 'Schnell', 'Versteckt'], weaknesses: ['Wehrlos'], tip: 'Bleib unsichtbar, nutze Büsche und Deckung.', fact: 'Kleiner, flinker Pflanzenfresser (~2 m) aus der frühen Kreidezeit Englands; lange fälschlich als baumkletternd dargestellt.' },
  Gallimimus:       { diet: 'both', role: 'Speed-Omni (Small)', growth: 'schnell', strengths: ['Extrem schnell', 'Ausdauer'], weaknesses: ['Kaum Verteidigung'], tip: 'Speed-Build — fliehe statt zu kämpfen.', fact: '„Hühnchen-Nachahmer" aus der Mongolei (Kreidezeit). Straußenähnlich, mit zahnlosem Schnabel und einer der schnellsten Dinosaurier.' },
  Beipiaosaurus:    { diet: 'both', role: 'Krallen-Herbi (Small)', growth: 'schnell', strengths: ['Krallen', 'Wendig'], weaknesses: ['Fragil'], tip: 'Defensiv spielen und in Deckung wachsen.', fact: 'Gefiederter Therizinosaurier aus China (frühe Kreidezeit) mit langen Krallen — Pflanzen-/Allesfresser und einer der größten bekannten gefiederten Dinos.' },
};
const DIET_LABEL = { carni: '🥩 Fleischfresser', herbi: '🌿 Pflanzenfresser', both: '🍽️ Allesfresser' };
const DIET_DOT = { carni: '#ef4444', herbi: '#22c55e', both: '#f59e0b' };
let lexSel = null;

function renderLexikon() {
  const panel = el('lexikon');
  const wire = () => { panel.querySelector('.closeFeature').onclick = () => closeAllFeatures(); };

  if (lexSel && DINO_LEXIKON[lexSel]) {
    const d = DINO_LEXIKON[lexSel];
    const li = (arr, col) => arr.map((s) => `<li style="color:${col}">${escapeHtml(s)}</li>`).join('');
    panel.innerHTML = `<h2>📖 ${escapeHtml(lexSel)}</h2>
      <img src="assets/dinos/${encodeURIComponent(lexSel)}.png" alt="" onerror="this.style.display='none'" style="display:block;width:100%;max-height:180px;object-fit:contain;border-radius:10px;background:rgba(0,0,0,0.25);margin-bottom:10px">
      <div style="font-size:13px;margin-bottom:10px"><span style="color:${DIET_DOT[d.diet]}">●</span> ${DIET_LABEL[d.diet]} · <b>${escapeHtml(d.role)}</b> · Wachstum: ${escapeHtml(d.growth)}</div>
      <div style="display:flex;gap:18px;flex-wrap:wrap">
        <div style="flex:1;min-width:150px"><div style="font-weight:600;color:#22c55e;margin-bottom:4px">Stärken</div><ul style="margin:0 0 0 16px;font-size:13px;line-height:1.6">${li(d.strengths, '#cbd5b0')}</ul></div>
        <div style="flex:1;min-width:150px"><div style="font-weight:600;color:#ef4444;margin-bottom:4px">Schwächen</div><ul style="margin:0 0 0 16px;font-size:13px;line-height:1.6">${li(d.weaknesses, '#e4b8b8')}</ul></div>
      </div>
      <div style="margin-top:12px;padding:9px 11px;background:rgba(139,92,246,0.12);border:1px solid var(--border);border-radius:8px;font-size:13px">💡 ${escapeHtml(d.tip)}</div>
      ${d.fact ? `<div style="margin-top:10px;padding:9px 11px;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:8px;font-size:13px;line-height:1.55"><b style="color:var(--accent-2)">📚 Wissenswert</b><br>${escapeHtml(d.fact)}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:14px">
        <button id="lexBack" style="flex:1">← Zurück</button>
        <button class="closeFeature secondary" style="flex:1">Schließen</button>
      </div>`;
    panel.querySelector('#lexBack').onclick = () => { lexSel = null; renderLexikon(); };
    wire();
    return;
  }

  const order = ['carni', 'herbi', 'both'];
  const names = Object.keys(DINO_LEXIKON).sort();
  let html = '';
  for (const diet of order) {
    const group = names.filter((n) => DINO_LEXIKON[n].diet === diet);
    if (!group.length) continue;
    html += `<div style="font-weight:600;color:var(--accent);margin:10px 0 6px">${DIET_LABEL[diet]}</div>`;
    html += group.map((n) => `<button class="lexItem secondary" data-dino="${n}" style="display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;margin-bottom:5px;text-align:left">
      <span style="display:flex;align-items:center;gap:8px;min-width:0">
        <img src="assets/dinos/${encodeURIComponent(n)}.png" alt="" onerror="this.style.visibility='hidden'" style="width:32px;height:32px;border-radius:6px;object-fit:cover;background:rgba(0,0,0,0.25);flex:none">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span style="color:${DIET_DOT[diet]}">●</span> ${escapeHtml(n)}</span></span>
      <span style="color:var(--muted);font-size:12px;font-weight:400;flex:none">${escapeHtml(DINO_LEXIKON[n].role)}</span></button>`).join('');
  }
  panel.innerHTML = `<h2>📖 Dino-Lexikon <span style="font-size:13px;color:var(--muted);font-weight:400">· ${names.length} Spezies</span></h2>
    <div style="max-height:55vh;overflow:auto;padding-right:4px">${html}</div>
    <button class="closeFeature secondary" style="margin-top:10px">Schließen</button>`;
  panel.querySelectorAll('.lexItem').forEach((b) => { b.onclick = () => { lexSel = b.dataset.dino; renderLexikon(); }; });
  wire();
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
let primeDino = null;   // Dino, für den prevPrimes gilt — bei Wechsel neu baselinen
// Prüft auf neu erfüllte Prime-Bedingungen und meldet sie per Toast.
// Wird aus pollHud (6s) UND updateDinoInfo (2s) aufgerufen — geteilter State, kein Doppel-Toast.
function checkPrimes(primes, dino) {
  if (!Array.isArray(primes)) { prevPrimes = null; primeDino = null; return; }   // offline → Basis zurücksetzen
  if (dino !== primeDino) { prevPrimes = primes.slice(); primeDino = dino; return; } // neuer Dino → neu baselinen, KEIN Toast
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

// Vital-Balken → passender Token (nur diese sind im Overlay einlösbar;
// Grow-Boost & Insta-Grow sind Discord-only).
const VITAL_TOKEN = {
  health:  ['heal', '❤️', 'Heal'],
  hunger:  ['hunger', '🍖', 'Hunger'],
  thirst:  ['thirst', '💧', 'Durst'],
  carbs:   ['carbs', '🌿', 'Carbs'],
  protein: ['protein', '🥩', 'Protein'],
  lipid:   ['lipid', '🥑', 'Lipid'],
};

function renderDinoInfo() {
  const rows = DI_STATS.map((s) => `
    <div class="di-vrow">
      <div class="di-vbar">
        <div class="stat-top"><span>${s.label}</span><span class="val" id="di-${s.key}-v">—</span></div>
        <div class="stat-track"><div class="stat-fill" id="di-${s.key}-f" style="background:${s.color}"></div></div>
      </div>
      <div class="di-vtok" id="di-tok-${s.key}"></div>
    </div>`).join('');
  el('dinoInfo').classList.add('di-wide');
  el('dinoInfo').innerHTML = `
    <div class="di-head"><span class="di-dino" id="di-dino">Dino</span><span class="di-sub" id="di-grow"></span></div>
    <div class="di-sub" id="di-name"></div>
    <div class="di-badges" id="di-badges"></div>
    <div style="margin:10px 0 2px">
      <div class="stat-top"><span>🌱 Wachstum</span><span class="val" id="di-grow-v">—</span></div>
      <div class="stat-track" style="height:11px"><div class="stat-fill" id="di-grow-f" style="background:#84cc16"></div></div>
    </div>
    <div class="di-main">
      <div class="di-elder-col">
        <div class="sec-title">⏳ Elder-Fortschritt</div>
        <div id="di-elder" style="margin:6px 0"></div>
      </div>
      <div class="di-vitals-col">
        <div class="sec-title">📊 Vitals &amp; Token <span style="color:var(--muted);font-weight:400;font-size:11px">— Token rechts neben dem Balken einlösen</span></div>
        ${rows}
      </div>
    </div>
    <button class="closeFeature secondary" style="margin-top:14px">Schließen (F5)</button>`;
  el('dinoInfo').querySelector('.closeFeature').onclick = () => closeAllFeatures();
  tokenConfirmOpen = false; // frisch öffnen → keine hängende Bestätigungs-Sperre
  updateDinoInfo();
  if (dinoTimer) clearInterval(dinoTimer);
  dinoTimer = setInterval(updateDinoInfo, 2000);
}

// Token-Zellen rechts neben den passenden Vital-Balken füllen
let tokenConfirmOpen = false; // solange eine Einlöse-Bestätigung offen ist: Zellen nicht überschreiben
function renderDinoTokens(tokens) {
  if (tokenConfirmOpen) return; // sonst würde der 2s-Refresh die Bestätigung wegbügeln
  tokens = tokens || {};
  for (const [vital, [id, emoji, label]] of Object.entries(VITAL_TOKEN)) {
    const cell = el(`di-tok-${vital}`); if (!cell) continue;
    const n = tokens[id] || 0;
    if (n <= 0) { cell.innerHTML = ''; continue; }
    cell.innerHTML = '';
    const b = document.createElement('button');
    b.style.cssText = 'width:100%;padding:7px 8px;font-size:12px';
    b.innerHTML = `${emoji} ×${n} · einlösen`;
    b.onclick = () => confirmRedeemToken(id, label, emoji, cell);
    cell.appendChild(b);
  }
}
function confirmRedeemToken(id, label, emoji, cell) {
  tokenConfirmOpen = true; // Refresh friert die Token-Zellen ein, bis entschieden
  cell.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'padding:7px;border:1px solid var(--accent);border-radius:8px;background:rgba(139,92,246,0.14)';
  wrap.innerHTML = `<div style="font-size:11px;margin-bottom:6px">${emoji} ${label} einlösen?</div>`;
  const btns = document.createElement('div'); btns.style.cssText = 'display:flex;gap:5px';
  const yes = document.createElement('button'); yes.textContent = '✅'; yes.style.cssText = 'flex:1;padding:5px';
  const no = document.createElement('button'); no.className = 'secondary'; no.textContent = '✖️'; no.style.cssText = 'flex:1;padding:5px';
  yes.onclick = () => { tokenConfirmOpen = false; redeemOverlayToken(id, label, emoji); };
  no.onclick = () => { tokenConfirmOpen = false; updateDinoInfo(); };
  btns.append(yes, no); wrap.append(btns);
  cell.appendChild(wrap);
}
async function redeemOverlayToken(id, label, emoji) {
  try {
    const res = await fetch(`${config.tokenBase}/tokens/redeem`, {
      method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: id }),
    });
    const d = await res.json(); if (!res.ok) throw new Error(d.error || 'Fehler');
    showToast(`${emoji} ${label} eingelöst!`, 'success');
  } catch (e) { showToast(e.message, 'error'); }
  updateDinoInfo();
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
// Spezies-Bild (mit Alias für Spielnamen); fehlt es, bleibt die farbige Vorschau sichtbar.
const DINO_IMG_ALIAS = { Rex: 'Tyrannosaurus', Maiasaurus: 'Maiasaura' };
function dinoImgSrc(dinoClass) { const k = DINO_IMG_ALIAS[dinoClass] || dinoClass || ''; return 'assets/dinos/' + encodeURIComponent(k) + '.png'; }
function dinoPreview(card, cls) {
  return `<div class="prevwrap ${cls || ''}">${dinoPreviewSVG(card)}<img class="photo" src="${dinoImgSrc(card.dino)}" alt="" onerror="this.remove()"></div>`;
}

function dinoCardEl(card, onClick) {
  const d = document.createElement('div'); d.className = 'dino-card';
  d.innerHTML = dinoPreview(card) + `<div class="body"><div class="nm">${card.dino}${card.isElder ? ' 👑' : ''}</div><div class="mt">${card.gender || ''} · ${Math.round((card.grow || 0) * 100)}%</div></div>` + paletteHTML(card.colors);
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
  box.innerHTML = `<div style="display:flex;gap:14px;align-items:center;margin-bottom:14px">${dinoPreview(card, 'dd')}<div><div style="font-size:18px;font-weight:700">${card.dino}${card.isElder ? ' 👑' : ''}</div><div style="font-size:12px;color:var(--muted)">${card.gender || ''} · ${Math.round((card.grow || 0) * 100)}% Wachstum${card.isPrime ? ' · ⭐ Prime' : ''}</div></div></div><div class="sec-title">Vitals</div>${vitalsHTML(card)}<div class="sec-title" style="margin-top:12px">Mutationen</div><div style="margin-top:6px">${mutHTML(card.mutations)}</div>${action}<button class="secondary" id="ddClose" style="width:100%;margin-top:8px">Schließen</button>`;
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

  const swatches = SKIN_GROUPS.map(([k, l]) => `<label style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 8px;background:rgba(255,255,255,0.04);border-radius:8px;font-size:13px;cursor:pointer"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l}</span><input type="color" data-col="${k}" value="${linToHex(skinState.colors[k])}" style="width:40px;height:26px;border:0;background:none;cursor:pointer;flex:none"></label>`).join('');
  panel.innerHTML = `<h2>🎨 Skin Editor — ${me.dino}</h2>
    <div id="skLive" style="font-size:12px;color:#22c55e;margin:2px 0 14px">🟢 Änderungen werden live im Spiel übernommen</div>
    <div class="sec-title">Farben</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0 14px">${swatches}</div>
    <div class="sec-title">Muster & Variation</div>
    <div style="display:flex;gap:6px;margin:8px 0 8px">${[0, 1, 2].map((i) => `<button data-pat="${i}" style="flex:1" class="${skinState.patternIndex === i ? '' : 'secondary'}">Muster ${i + 1}</button>`).join('')}</div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><span style="font-size:13px">Skin-Variation</span><input id="skVar" type="number" min="0" value="${skinState.skinVariation}" style="width:80px;padding:6px;border-radius:6px;border:1px solid var(--border);background:#120d24;color:#eee"></div>
    <div class="sec-title" style="margin-top:16px">🔗 Farben teilen</div>
    <button id="skShare" style="width:100%;margin:8px 0">📋 Farb-Code kopieren</button>
    <div style="display:flex;gap:6px;margin-bottom:4px">
      <input id="skImport" placeholder="Farb-Code einfügen…" style="flex:1;min-width:0;padding:8px;border-radius:6px;border:1px solid var(--border);background:#120d24;color:#eee">
      <button id="skImportBtn" class="secondary" style="width:auto;padding:8px 12px">Anwenden</button>
    </div>
    <div class="sec-title" style="margin-top:16px">📁 Eigene Vorlagen <span style="color:var(--muted);font-weight:400;font-size:11px">(dino-übergreifend)</span></div>
    <div style="display:flex;gap:6px;margin:8px 0">
      <input id="skTplName" placeholder="Vorlagen-Name…" maxlength="30" style="flex:1;min-width:0;padding:8px;border-radius:6px;border:1px solid var(--border);background:#120d24;color:#eee">
      <button id="skTplSave" style="width:auto;padding:8px 12px">💾 Speichern</button>
    </div>
    <div id="skTplList"></div>
    <button class="closeFeature secondary" style="width:100%;margin-top:12px">Schließen</button>`;
  panel.querySelector('.closeFeature').onclick = closeAllFeatures;
  el('skTplSave').onclick = () => saveSkinTemplate();
  el('skShare').onclick = () => copySkinCode();
  el('skImportBtn').onclick = () => importSkinCode(el('skImport').value);
  renderSkinTemplates();
  updateSkinPreview();
  // Live-Anwendung: nach kurzer Pause automatisch übernehmen (kein Bestätigen nötig)
  panel.querySelectorAll('[data-col]').forEach((inp) => inp.oninput = () => { skinState.colors[inp.dataset.col] = hexToLin(inp.value); updateSkinPreview(); scheduleSkinApply(); });
  panel.querySelectorAll('[data-pat]').forEach((b) => b.onclick = () => { skinState.patternIndex = parseInt(b.dataset.pat); panel.querySelectorAll('[data-pat]').forEach((x) => x.className = x === b ? '' : 'secondary'); scheduleSkinApply(); });
  el('skVar').oninput = () => { skinState.skinVariation = parseInt(el('skVar').value) || 0; scheduleSkinApply(); };
}
function setSkinLive(txt, color) { const h = el('skLive'); if (h) { h.textContent = txt; h.style.color = color || '#22c55e'; } }
// Spiegelt skinState → UI (nach Import/Vorlage)
function syncSkinUI() {
  for (const [k] of SKIN_GROUPS) { const inp = document.querySelector(`#skinEditor [data-col="${k}"]`); if (inp) inp.value = linToHex(skinState.colors[k]); }
  const sv = el('skVar'); if (sv) sv.value = skinState.skinVariation;
  document.querySelectorAll('#skinEditor [data-pat]').forEach((x) => x.className = parseInt(x.dataset.pat) === skinState.patternIndex ? '' : 'secondary');
  updateSkinPreview();
}
let skinApplyTimer = null;
function scheduleSkinApply() {
  clearTimeout(skinApplyTimer);
  setSkinLive('… wird übernommen', '#f59e0b');
  skinApplyTimer = setTimeout(() => applySkin(true), 650);
}

// ── Farben teilen (Code) ─────────────────────────────────────────────────────
function skinCode() {
  const s = skinState;
  const payload = { v: s.skinVariation, p: s.patternIndex, c: SKIN_GROUPS.map(([k]) => s.colors[k].map((x) => Math.round(x * 1000) / 1000)) };
  return 'BFSKIN1:' + btoa(JSON.stringify(payload));
}
async function copySkinCode() {
  const code = skinCode();
  let ok = false;
  try { ok = await window.bf.copyText(code); } catch {}                 // Main-Prozess (auch ohne Fokus)
  if (!ok) { try { await navigator.clipboard.writeText(code); ok = true; } catch {} } // Fallback
  showToast(ok ? '📋 Farb-Code kopiert — zum Teilen einfügen' : 'Kopieren fehlgeschlagen', ok ? 'success' : 'error');
}
function importSkinCode(raw) {
  try {
    let code = (raw || '').trim();
    if (code.startsWith('BFSKIN1:')) code = code.slice(8);
    const p = JSON.parse(atob(code));
    skinState.skinVariation = p.v || 0;
    skinState.patternIndex = p.p || 0;
    SKIN_GROUPS.forEach(([k], i) => { if (p.c && Array.isArray(p.c[i]) && p.c[i].length === 3) skinState.colors[k] = p.c[i].map(Number); });
    syncSkinUI();
    applySkin();
    const imp = el('skImport'); if (imp) imp.value = '';
    showToast('🎨 Farben übernommen', 'success');
  } catch { showToast('Ungültiger Farb-Code', 'error'); }
}
function updateSkinPreview() {
  const p = el('skPreview'); if (!p) return; // Vorschau entfernt — Farben sieht man live im Spiel
  const c = skinState.colors;
  p.innerHTML = dinoPreviewSVG({ id: 'sk', colors: { body: c.bodyColor, markings: c.markingsColor, underbelly: c.underbellyColor, flank: c.flankColor, detail: c.detailColor, eyes: c.eyesColor } });
}
async function applySkin(auto) {
  setSkinLive('… wird übernommen', '#f59e0b');
  try {
    const body = { skinVariation: skinState.skinVariation, patternIndex: skinState.patternIndex, themeIndex: skinState.themeIndex, ...skinState.colors };
    const send = () => fetch(`${config.tokenBase}/skin`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let res = await send();
    if (res.status === 502) { await new Promise((r) => setTimeout(r, 1200)); res = await send(); } // ein Retry bei Server-Hänger
    const d = await res.json(); if (!res.ok) throw new Error(d.error || 'Fehler');
    setSkinLive('🟢 Live übernommen', '#22c55e');
    if (!auto) showToast('🎨 Skin angewendet!', 'success');
  } catch (err) { setSkinLive('⚠️ ' + err.message, '#ef4444'); showToast(err.message, 'error'); }
}

// ── Skin-Vorlagen (lokal, dino-übergreifend) ────────────────────────────────
function getSkinTemplates() { try { return JSON.parse(localStorage.getItem('bf-skin-templates')) || []; } catch { return []; } }
function setSkinTemplates(list) { localStorage.setItem('bf-skin-templates', JSON.stringify(list)); }
function saveSkinTemplate() {
  if (!skinState) return;
  const name = (el('skTplName').value || '').trim();
  if (!name) { showToast('Vorlagen-Name fehlt', 'error'); return; }
  const list = getSkinTemplates().filter((t) => t.name !== name); // gleicher Name → überschreiben
  list.push({ name, skinVariation: skinState.skinVariation, patternIndex: skinState.patternIndex, themeIndex: skinState.themeIndex, colors: { ...skinState.colors } });
  setSkinTemplates(list);
  el('skTplName').value = '';
  renderSkinTemplates();
  showToast(`📁 Vorlage „${name}" gespeichert`, 'success');
}
function applySkinTemplate(t) {
  if (!skinState) return;
  // Nur Farben/Muster/Variation übernehmen → passt auf JEDEN Dino (nicht spezies-gebunden)
  skinState.skinVariation = t.skinVariation || 0;
  skinState.patternIndex = t.patternIndex || 0;
  skinState.themeIndex = t.themeIndex || 0;
  for (const [k] of SKIN_GROUPS) if (t.colors && t.colors[k]) skinState.colors[k] = t.colors[k].slice();
  syncSkinUI();
  applySkin(); // direkt anwenden
  showToast(`🎨 Vorlage „${t.name}" angewendet`, 'success');
}
function deleteSkinTemplate(name) { setSkinTemplates(getSkinTemplates().filter((t) => t.name !== name)); renderSkinTemplates(); }
function renderSkinTemplates() {
  const box = el('skTplList'); if (!box) return;
  const list = getSkinTemplates();
  box.innerHTML = list.length ? '' : '<div style="color:var(--muted);font-size:12px">Noch keine Vorlagen gespeichert.</div>';
  for (const t of list) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:5px';
    const ap = document.createElement('button');
    ap.textContent = `🎨 ${t.name}`; ap.style.cssText = 'flex:1;text-align:left;padding:7px 10px';
    ap.onclick = () => applySkinTemplate(t);
    const del = document.createElement('button');
    del.className = 'secondary'; del.textContent = '🗑'; del.style.cssText = 'width:auto;padding:6px 10px';
    del.onclick = () => deleteSkinTemplate(t.name);
    row.append(ap, del);
    box.appendChild(row);
  }
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
  box.innerHTML = `<div style="display:flex;gap:14px;align-items:center;margin-bottom:14px">${dinoPreview(card, 'dd')}<div><div style="font-size:18px;font-weight:700">${card.dino}${card.isElder ? ' 👑' : ''}</div><div style="font-size:12px;color:var(--muted)">${card.gender || ''} · ${Math.round((card.grow || 0) * 100)}%</div></div></div>
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
    Object.keys(VITAL_TOKEN).forEach((k) => { const c = el(`di-tok-${k}`); if (c) c.innerHTML = ''; });
    DI_STATS.forEach((s) => { el(`di-${s.key}-f`).style.width = '0%'; el(`di-${s.key}-v`).textContent = '—'; });
    { const gf = el('di-grow-f'); if (gf) gf.style.width = '0%'; const gv = el('di-grow-v'); if (gv) gv.textContent = '—'; }
    checkPrimes(null);   // offline → Prime-Basis zurücksetzen
    return;
  }
  el('di-elder').innerHTML = elderHTML(d.primes);
  checkPrimes(d.primes, d.dino);   // schnellere Benachrichtigung solange F5 offen ist (2s)
  renderDinoTokens(d.tokens);
  el('di-dino').textContent = d.dino || 'Dino';
  el('di-name').textContent = `${d.gender || ''} · ${d.name || ''}`;
  const gp = Math.round((d.grow || 0) * 100);
  el('di-grow').textContent = `Wachstum ${gp}%`;
  { const gf = el('di-grow-f'); if (gf) gf.style.width = gp + '%'; const gv = el('di-grow-v'); if (gv) gv.textContent = gp + '%'; }

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
  updateDockActive(); // Dock-Highlight immer am aktuellen Stand halten
  const anyPanel = settingsOpen || mapOpen || adminOpen || !!featureOpen;
  // Dock IMMER einblenden, sobald ein Panel offen ist (auch per Hotkey geöffnet) — oder im „^"-Modus.
  const d = el('dock'); if (d) d.style.display = (overlayMode || anyPanel) ? 'flex' : 'none';
  // Maus durchlassen nur wenn nichts offen ist
  window.bf.setInteractive(overlayMode || anyPanel);
}

// Einheitliches Schließen (Dock-Button): alle Panels zu, Overlay-Modus aus,
// Fokus zurück ins Spiel (setInteractive(false) im Main-Prozess).
function closeOverlayAll() {
  closeAllPanels();
  overlayMode = false;
  updateInteractive();
}

// ── Overlay-/Nav-Modus („^"): Dock einblenden + Overlay klickbar machen ───────
let overlayMode = false;
let lastOverlayToggleAt = 0;
function toggleOverlayMode(force) {
  // Entprellen: uiohook (global) UND DOM-Keydown (wenn Overlay Fokus hat) können
  // beide für denselben „^"-Druck feuern → nur ein Toggle pro 250 ms.
  if (force === undefined) {
    const now = Date.now();
    if (now - lastOverlayToggleAt < 250) return;
    lastOverlayToggleAt = now;
  }
  overlayMode = force !== undefined ? force : !overlayMode;
  if (!overlayMode) closeAllPanels(); // „^" aus → alle Fenster zu
  updateInteractive();                // steuert Dock-Sichtbarkeit + Interactive
}

// Schließt jedes offene Dock-Panel (Feature/Karte/Settings/Admin) — Grundlage
// der „immer nur ein Fenster offen"-Navigation.
function closeAllPanels() {
  closeAllFeatures(true);
  if (mapOpen) toggleMap(false);
  if (settingsOpen) toggleSettings(false);
  if (adminOpen) closeAdminPanel();
}

// Dock-Icons (Lucide, stroke = currentColor → erbt Button-Farbe)
const dockSvg = (inner) => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const DOCK_ICONS = {
  profile:  dockSvg('<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  dino:     dockSvg('<path d="M22 12h-2.5l-2 7-4-18-3 11H2"/>'),
  group:    dockSvg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  lexikon:  dockSvg('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'),
  garage:   dockSvg('<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'),
  market:   dockSvg('<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2 2h2l2.6 12.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L21.3 6H5.1"/>'),
  map:      dockSvg('<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15"/><path d="M15 6v15"/>'),
  skin:     dockSvg('<circle cx="13.5" cy="6.5" r=".8" fill="currentColor" stroke="none"/><circle cx="17.5" cy="10.5" r=".8" fill="currentColor" stroke="none"/><circle cx="6.5" cy="12.5" r=".8" fill="currentColor" stroke="none"/><circle cx="8.5" cy="7.5" r=".8" fill="currentColor" stroke="none"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.6-.7 1.6-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1a1.6 1.6 0 0 1 1.6-1.6H16c3 0 5.5-2.5 5.5-5.5C22 6 17.5 2 12 2z"/>'),
  settings: dockSvg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>'),
  admin:    dockSvg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/>'),
  quests:   dockSvg('<path d="M4 22V4a1 1 0 0 1 1-1h12l-2 4 2 4H6"/><line x1="4" y1="22" x2="4" y2="15"/>'),
  close:    dockSvg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
};

// Welches Dock-Ziel ist gerade offen? (für das Highlight im Dock)
function activeNav() {
  if (settingsOpen) return 'settings';
  if (mapOpen) return 'map';
  if (adminOpen) return 'admin';
  if (featureOpen === 'skinEditor') return 'skin';
  if (featureOpen === 'dinoInfo') return 'dino';
  return featureOpen; // profile | group | lexikon | garage | market | null
}
function updateDockActive() {
  const cur = activeNav();
  document.querySelectorAll('.dock-btn').forEach((b) => b.classList.toggle('active', b.dataset.act === cur));
}

// Dock als Navigation: Klick wechselt zum Ziel-Fenster (immer nur eins offen);
// Klick aufs bereits aktive Icon schließt es wieder (zurück zum reinen Dock).
function navTo(target) {
  if (target === 'admin' && !isAdmin) { showToast('Nur für Admins', 'error'); return; }
  const wasActive = activeNav() === target;
  closeAllPanels();
  if (!wasActive) {
    if (target === 'map') toggleMap(true);
    else if (target === 'settings') toggleSettings(true);
    else if (target === 'admin') openAdminPanel();
    else if (target === 'skin') toggleFeature('skinEditor');
    else if (target === 'dino') toggleFeature('dinoInfo');
    else toggleFeature(target); // profile | group | lexikon | garage | market
  }
  updateInteractive();
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
    loadTeleports();
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
  return micEnabled;                                       // offenes Mikro: an solange aktiviert
}

// Mikro-Sendezustand an den Voice-Modus angleichen
async function applyMic() {
  if (!room) return;
  try { await room.localParticipant.setMicrophoneEnabled(isMicOn()); } catch {}
  if (isMicOn()) ensureMicProcessor();   // Gain-Processor auf den frischen Track legen
  refreshMicState();
}

// ── Eigene Mikrofon-Verstärkung (Web-Audio-GainNode auf dem gesendeten Track) ──
// LiveKit publisht das Roh-Mikro; ein Track-Processor hängt einen GainNode davor,
// damit micGain (0..2) das eigene Mikro für alle anderen lauter/leiser macht.
let micProc = null;
function createMicGainProcessor() {
  let src = null, gain = null, dest = null;
  const proc = {
    name: 'bf-mic-gain',
    async init(opts) {
      const ctx = opts.audioContext;
      src = ctx.createMediaStreamSource(new MediaStream([opts.track]));
      gain = ctx.createGain();
      gain.gain.value = micGain;
      dest = ctx.createMediaStreamDestination();
      src.connect(gain); gain.connect(dest);
      proc.processedTrack = dest.stream.getAudioTracks()[0];
      proc._ctx = ctx;
    },
    async restart(opts) { await proc.destroy(); await proc.init(opts); },
    async destroy() {
      try { src && src.disconnect(); } catch {}
      try { gain && gain.disconnect(); } catch {}
      try { dest && dest.disconnect(); } catch {}
    },
    setGain(v) { if (gain && proc._ctx) gain.gain.setTargetAtTime(v, proc._ctx.currentTime, 0.05); },
  };
  return proc;
}
async function ensureMicProcessor() {
  if (!room) return;
  const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  const track = pub && pub.track;
  if (!track || !track.setProcessor) return;
  if (track.__bfProc) { micProc = track.__bfProc; return; }   // schon gesetzt
  const proc = createMicGainProcessor();
  try { await track.setProcessor(proc); track.__bfProc = proc; micProc = proc; } catch {}
}
function setMicGain(pct) {
  micGain = Math.max(0, Math.min(2, pct / 100));
  try { localStorage.setItem('bf-mic-gain', String(Math.round(micGain * 100) / 100)); } catch {}
  if (micProc) micProc.setGain(micGain);
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
    { const ab = el('openAdminBtn'); if (ab) ab.style.display = isAdmin ? 'block' : 'none'; }
    { const da = el('dockAdmin'); if (da) da.style.display = isAdmin ? 'flex' : 'none'; }
    // Tickets/Events/Overlay-Gruppe laden + periodisch (Benachrichtigungen)
    loadMyTickets(); loadMyEvents(); loadOvGroup();
    if (!loadMyTickets._t) loadMyTickets._t = setInterval(loadMyTickets, 20000);
    if (!loadMyEvents._t) loadMyEvents._t = setInterval(loadMyEvents, 60000);
    if (!loadOvGroup._t) loadOvGroup._t = setInterval(loadOvGroup, 15000);
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
    loadTeleports();
    if (!loadTeleports._timer) loadTeleports._timer = setInterval(() => { if (mapOpen) loadTeleports(); }, 4000);
    await connect(data);
  } catch (err) {
    setMicState('disconnected', `Fehler: ${err.message}`);
  }
}

async function connect({ token, url }) {
  setMicState('connecting');
  // webAudioMix: leitet alle Remote-Audios über einen gemeinsamen AudioContext +
  //   GainNodes → setVolume kann >1.0 (Einzel- & Master-Regler wirken wirklich) und
  //   der Context wird auch auf den lokalen Teilnehmer gesetzt (Mikro-Gain-Processor).
  // adaptiveStream/dynacast: nur für Video sinnvoll; für reines Audio aus (vermeidet
  //   pausierte Subscriptions → Cutouts).
  room = new Room({ adaptiveStream: false, dynacast: false, webAudioMix: true });
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
        // Mit webAudioMix mutet LiveKit das Element selbst und spielt über den
        // AudioContext. Deafen/Lautstärke laufen daher über setVolume (s.u.),
        // nicht über a.muted.
        const a = track.attach(); a.autoplay = true;
        if (spkDeviceId && a.setSinkId) a.setSinkId(spkDeviceId).catch(() => {});
        document.body.appendChild(a);
        updateProximityVolumes();
      }
    });
  await room.connect(url, token);
  // Gewählte Audio-Geräte anwenden (falls gesetzt)
  try { if (micDeviceId) await room.switchActiveDevice('audioinput', micDeviceId); } catch {}
  try { if (spkDeviceId) await room.switchActiveDevice('audiooutput', spkDeviceId); } catch {}
  // Sprech-Erkennung des eigenen Mikros
  room.localParticipant.on(ParticipantEvent.IsSpeakingChanged, () => refreshMicState());
}

async function toggleConnect() {
  if (room) { await room.disconnect(); room = null; micEnabled = false; voiceConnected = false; el('connBtn').textContent = 'Verbinden'; setMicState('disconnected'); setMicBtn(); updateVoiceWarn(); }
  else {
    if (!me) { showToast('Voice nur auf dem BlackFossil-Server verfügbar', 'error'); return; }
    const s = await window.bf.getSession(); if (s) connectWithSession(s);
  }
}

// Button-Text spiegelt den AKTUELLEN Status (nicht die Aktion) + gleicher Stil wie Deafen.
function setMicBtn() {
  const b = el('micBtn'); if (!b) return;
  b.textContent = micEnabled ? '🎤 Mikro an' : '🔇 Mikro aus';
  b.classList.toggle('secondary', !micEnabled);
}

async function toggleMic() {
  if (!room) return;
  micEnabled = !micEnabled;
  setMicBtn();
  await applyMic();
}

// Eingehenden Ton stummschalten (Deafen). Mit webAudioMix läuft der Ton über den
// AudioContext → über setVolume(0) stummschalten, nicht über a.muted.
function toggleDeafen() {
  deafened = !deafened;
  updateProximityVolumes();   // setzt alle Remote-GainNodes auf 0 bzw. zurück
  const b = el('deafenBtn');
  // „Ton an" leuchtet, „Ton aus" ist gedimmt (secondary) — synchron zum Mikro-Button.
  if (b) { b.textContent = deafened ? '🔇 Ton aus' : '🔊 Ton an'; b.classList.toggle('secondary', deafened); }
}

// ── Audio-Geräteauswahl ─────────────────────────────────────────────────────
async function enumAudioDevices() {
  let devs = [];
  try {
    // Labels gibt's erst nach einer Mikro-Erlaubnis — einmal anstoßen, dann freigeben
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); } catch {}
    devs = await navigator.mediaDevices.enumerateDevices();
  } catch { return; }
  const fill = (sel, kind, saved) => {
    if (!sel) return;
    const list = devs.filter((d) => d.kind === kind);
    sel.innerHTML = '<option value="">Standard</option>' +
      list.map((d) => `<option value="${d.deviceId}">${escapeHtml(d.label || kind)}</option>`).join('');
    sel.value = saved || '';
  };
  fill(el('micDevSel'), 'audioinput', micDeviceId);
  fill(el('spkDevSel'), 'audiooutput', spkDeviceId);
}
async function setMicDevice(id) {
  micDeviceId = id; localStorage.setItem('bf-mic-dev', id);
  try { if (room && id) await room.switchActiveDevice('audioinput', id); } catch (e) { showToast('Mikro-Wechsel fehlgeschlagen', 'error'); }
}
async function setSpkDevice(id) {
  spkDeviceId = id; localStorage.setItem('bf-spk-dev', id);
  try { if (room && id) await room.switchActiveDevice('audiooutput', id); } catch {}
  for (const a of document.querySelectorAll('audio')) { if (a.setSinkId && id) a.setSinkId(id).catch(() => {}); }
}

// ── AI-Dinos (Team-Steuerung übers Overlay) ─────────────────────────────────
const AI_SPECIES = ['carno','cerato','compy','deino','diablo','dilo','dryo','galli','hypso','omni','psitta','psitta_coastal','ptera','tenonto','rex'];
function populateAiSpecies() {
  const sel = el('aiSpecies'); if (!sel || sel.options.length) return;
  sel.innerHTML = AI_SPECIES.map((s) => `<option value="${s}">${s}</option>`).join('');
}
async function aiPost(path, body) {
  const res = await fetch(`${config.tokenBase}/admin/ai/${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
  return d;
}
async function aiControl(action, label) {
  const st = el('aiStatus'); if (st) st.textContent = `… ${label}`;
  try { await aiPost(action); if (st) st.textContent = `✅ ${label}`; showToast(`🦖 ${label}`, 'success'); }
  catch (e) { if (st) st.textContent = `❌ ${e.message}`; showToast(e.message, 'error'); }
}
function toggleAiSpawnMode() {
  aiSpawnMode = !aiSpawnMode;
  // Zum Klicken auf die Karte das Admin-Modal schließen + Karte öffnen
  if (aiSpawnMode) { closeAdminPanel(); toggleMap(true); }
  const b = el('aiSpawnMapBtn');
  if (b) { b.classList.toggle('secondary', !aiSpawnMode); b.textContent = aiSpawnMode ? '🗺️ Klicke auf die Karte…' : '🗺️ Auf Karte klicken zum Spawnen'; }
  showToast(aiSpawnMode ? '🗺️ Spawn-Modus AN — klick auf die Karte' : 'Spawn-Modus aus', '');
}
async function aiSpawnAt(x, y) {
  const species = el('aiSpecies') ? el('aiSpecies').value : 'carno';
  const count = Math.max(1, Math.min(parseInt(el('aiCount') && el('aiCount').value) || 1, 50));
  toggleAiSpawnMode(); // Modus nach einem Klick wieder aus
  try {
    await aiPost('spawn', { species, count, x, y, z: (me && me.z) != null ? me.z : 0 });
    showToast(`🦖 ${count}× ${species} gespawnt`, 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

// ── Edit-Mode: Panels verschiebbar machen (Positionen in localStorage) ──────
const MOVABLE = [
  { id: 'hud',         label: 'Top-HUD' },
  { id: 'minimapWrap', label: 'Minimap & Mikro' },
  { id: 'settings',    label: 'Einstellungen' },
  { id: 'dinoInfo',    label: 'Dino-Info (F5)' },
  { id: 'skinEditor',  label: 'Skin-Editor' },
  { id: 'garage',      label: 'Garage' },
  { id: 'market',      label: 'Markt' },
  { id: 'group',       label: 'Gruppe (F2)' },
  { id: 'profile',     label: 'Profil (F1)' },
  { id: 'lexikon',     label: 'Dino-Lexikon' },
];
let editMode = false;
function loadPositions() { try { return JSON.parse(localStorage.getItem('bf-layout')) || {}; } catch { return {}; } }
function savePositions(p) { localStorage.setItem('bf-layout', JSON.stringify(p)); }
function applySavedPositions() {
  const p = loadPositions();
  for (const m of MOVABLE) {
    const e = el(m.id), pos = p[m.id]; if (!e || !pos) continue;
    e.style.left = pos.left; e.style.top = pos.top;
    e.style.right = 'auto'; e.style.bottom = 'auto';
    e.style.transform = 'none'; // Center-Transforms überschreiben
  }
}
function resetPositions() {
  localStorage.removeItem('bf-layout');
  for (const m of MOVABLE) {
    const e = el(m.id); if (!e) continue;
    e.style.left = ''; e.style.top = ''; e.style.right = ''; e.style.bottom = ''; e.style.transform = '';
  }
  showToast('Layout zurückgesetzt', 'success');
}
function setEditMode(on) {
  editMode = on;
  document.body.classList.toggle('bf-edit', on);
  // Edit-Mode setzt alle verschiebbaren Panels sichtbar, damit man sie ziehen kann
  for (const m of MOVABLE) {
    const e = el(m.id); if (!e) continue;
    e.classList.toggle('bf-movable', on);
    if (on) { e.dataset.editLabel = m.label; if (e.style.display === 'none') e.dataset.bfHidden = '1', e.style.display = m.id === 'hud' ? 'flex' : 'block'; }
    else if (e.dataset.bfHidden) { e.style.display = 'none'; delete e.dataset.bfHidden; }
  }
  window.bf.setInteractive(on || settingsOpen || mapOpen || !!featureOpen);
}
function makeDraggable(elm, id) {
  let dragging = false, ox = 0, oy = 0;
  elm.addEventListener('mousedown', (e) => {
    if (!editMode) return;
    // Buttons/Inputs nicht abfangen (man soll im Edit-Mode trotzdem nicht klicken können — alles als Drag werten)
    e.preventDefault(); e.stopPropagation();
    dragging = true; elm.classList.add('dragging');
    const r = elm.getBoundingClientRect();
    ox = e.clientX - r.left; oy = e.clientY - r.top;
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const x = Math.max(0, Math.min(window.innerWidth - 40, e.clientX - ox));
    const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - oy));
    elm.style.left = x + 'px'; elm.style.top = y + 'px';
    elm.style.right = 'auto'; elm.style.bottom = 'auto'; elm.style.transform = 'none';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; elm.classList.remove('dragging');
    const p = loadPositions();
    p[id] = { left: elm.style.left, top: elm.style.top };
    savePositions(p);
  });
}
function setupEditMode() {
  for (const m of MOVABLE) { const e = el(m.id); if (e) makeDraggable(e, m.id); }
  applySavedPositions();
  el('editModeBtn').onclick = () => { setEditMode(true); toggleSettings(false); };
  el('editDoneBtn').onclick = () => setEditMode(false);
  el('editResetBtn').onclick = () => resetPositions();
}

init().then(() => setupEditMode());
