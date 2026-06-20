import { Room, RoomEvent, Track, ParticipantEvent } from 'livekit-client';
import { loadMapImage, drawFullMap, drawMinimap, drawHeatmap, normToWorld, worldToNorm, zoneAt, resetCal, solveAffine, getCal, setCalAffine, setZones, ZONES } from './map.js';

const el = (id) => document.getElementById(id);

// ── Karten-/Positions-State ─────────────────────────────────────────────────
let players = [];
let me = null;
let waypoints = [];
let calibMode = false;
let heatmapMode = false;
let sessionToken = null;
let calibPairs = [];
let armedRef = null;
let isAdmin = false;
let zoneEditMode = false;
let activeZone = null; // 'pvp' | 'pve'
let pttHeld = false, ptmHeld = false;

// Proximity: Hörradius in Welt-Einheiten (cm). Innerhalb = volle Lautstärke fällt linear auf 0.
let HEAR_RANGE = parseInt(localStorage.getItem('bf-hear-range') || '45000');

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
}

let config = { tokenBase: 'https://voice.blackfossil.de', hotkeys: {} };
let room = null;
let micEnabled = false;
let settingsOpen = false;
let mapOpen = false;

async function init() {
  config = await window.bf.getConfig();

  el('connBtn').onclick = () => toggleConnect();
  el('micBtn').onclick = () => toggleMic();
  el('logoutBtn').onclick = () => window.bf.logout();
  el('closeBtn').onclick = () => toggleSettings(false);
  el('heatBtn').onclick = () => {
    heatmapMode = !heatmapMode;
    el('heatBtn').style.background = heatmapMode ? '#8b5cf6' : 'var(--panel)';
    renderBigMap();
  };
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

  // Hörradius-Regler
  const slider = el('rangeSlider');
  slider.value = String(HEAR_RANGE);
  updateRangeLabel();
  slider.addEventListener('input', () => {
    HEAR_RANGE = parseInt(slider.value);
    localStorage.setItem('bf-hear-range', String(HEAR_RANGE));
    updateRangeLabel();
    updateProximityVolumes();
  });

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
  if (session) { sessionToken = session; connectWithSession(session); startPositionPolling(); }
  else setMicState('disconnected', 'Keine Session');
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
        el('serverBanner').style.display = me ? 'none' : 'block';
        updateZoneBox();
        updateProximityVolumes();
        if (mapOpen) renderBigMap();
      }
    } catch {}
  };
  poll();
  setInterval(poll, 1500);
}

// ── Proximity: Lautstärke pro Spieler nach Distanz ──────────────────────────
function updateProximityVolumes() {
  if (!room) return;
  for (const p of room.remoteParticipants.values()) {
    const pos = players.find((pl) => pl.steamId === p.identity);
    let vol = 1;
    if (me && pos) {
      const d = Math.hypot(pos.x - me.x, pos.y - me.y);
      vol = Math.max(0, 1 - d / HEAR_RANGE);
    }
    try { p.setVolume(vol); } catch {}
  }
}

function updateZoneBox() {
  if (!me) { el('zoneBox').textContent = 'Zone: —'; el('zoneBox').style.color = '#b3a9cc'; return; }
  const z = zoneAt(me.x, me.y);
  const coords = `X ${(me.x / 1000) | 0}k  Y ${(me.y / 1000) | 0}k`;
  el('zoneBox').innerHTML = `${z ? 'Zone: ' + z : 'Zone: Frei'}<br><span style="font-size:11px;opacity:0.7">${coords}</span>`;
  el('zoneBox').style.color = z === 'PVP' ? '#ef4444' : z === 'PVE' ? '#22c55e' : '#b3a9cc';
}

function updateRangeLabel() {
  // grobe Umrechnung Welt-cm → Meter (1 m = 100 cm)
  el('rangeVal').textContent = `${Math.round(HEAR_RANGE / 100)} m`;
}

// ── Rendering ────────────────────────────────────────────────────────────────
function renderMinimap() {
  const cv = el('minimap');
  drawMinimap({ ctx: cv.getContext('2d'), w: cv.width, h: cv.height }, players, me);
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
  if (action === 'voice-connect') toggleConnect();
  else if (action === 'mic-toggle') toggleMic();
  else if (action === 'settings-toggle') toggleSettings();
  else if (action === 'map-toggle') toggleMap();
  else if (action === 'zone-capture') captureZonePoint();
  else if (action === 'dino-info') toggleFeature('dinoInfo');
  else if (action === 'skin-editor') toggleFeature('skinEditor');
  else if (action === 'garage') toggleFeature('garage');
  else if (action === 'market') toggleFeature('market');
}

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
  'voice-ptt': 'Push-to-Talk (halten)',
  'voice-ptm': 'Push-to-Mute (halten)',
  'zone-capture': 'Zonen-Punkt (Owner)',
};
let listeningAction = null;

async function renderHotkeys() {
  const hk = await window.bf.getHotkeys();
  const list = el('hotkeyList');
  list.innerHTML = '';
  for (const [action, label] of Object.entries(HK_LABELS)) {
    if (action === 'zone-capture' && !isAdmin) continue;
    const row = document.createElement('div');
    row.className = 'hk-row';
    const span = document.createElement('span');
    span.textContent = label;
    const btn = document.createElement('button');
    btn.textContent = hk[action] || '—';
    btn.dataset.action = action;
    btn.onclick = () => startRebind(action, btn);
    row.append(span, btn);
    list.appendChild(row);
  }
}

function startRebind(action, btn) {
  listeningAction = action;
  document.querySelectorAll('#hotkeyList button').forEach((b) => b.classList.remove('listening'));
  btn.classList.add('listening');
  btn.textContent = '… Taste drücken';
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
  let accel;
  if (e.key === 'Backspace' || e.key === 'Delete') accel = ''; // Taste entfernen
  else { accel = accelFromEvent(e); if (accel === undefined) return; }
  await window.bf.setHotkey(listeningAction, accel);
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
  el(id).style.display = 'block';
  updateInteractive();
}
function closeAllFeatures(skipInteractive) {
  ['dinoInfo', 'skinEditor', 'garage', 'market'].forEach((id) => { el(id).style.display = 'none'; });
  if (featureOpen === 'dinoInfo') stopDinoInfo();
  featureOpen = null;
  if (!skipInteractive) updateInteractive();
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
    ${bars}
    <button class="closeFeature secondary" style="margin-top:8px">Schließen (F5)</button>`;
  el('dinoInfo').querySelector('.closeFeature').onclick = () => closeAllFeatures();
  updateDinoInfo();
  if (dinoTimer) clearInterval(dinoTimer);
  dinoTimer = setInterval(updateDinoInfo, 2000);
}

function stopDinoInfo() { if (dinoTimer) { clearInterval(dinoTimer); dinoTimer = null; } }

// ── Garage (Ein-/Ausparken) ─────────────────────────────────────────────────
async function renderGarage() {
  el('garage').innerHTML = `
    <h2>🚗 Garage</h2>
    <p style="margin-bottom:12px">Parke deinen aktuellen Dino ein oder hole einen gespeicherten zurück.</p>
    <button id="parkBtn" style="width:100%;margin-bottom:14px">⬇️ Aktuellen Dino einparken</button>
    <div id="garageList" style="display:flex;flex-direction:column;gap:8px"></div>
    <button class="closeFeature secondary" style="margin-top:14px">Schließen (F8)</button>`;
  el('garage').querySelector('.closeFeature').onclick = () => closeAllFeatures();
  el('parkBtn').onclick = () => parkDino();
  await loadGarage();
}

async function loadGarage() {
  const list = el('garageList');
  list.innerHTML = '<div style="color:var(--muted);font-size:13px">Lade…</div>';
  try {
    const res = await fetch(`${config.tokenBase}/garage`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    const data = await res.json();
    const slots = data.slots || [];
    if (!slots.length) { list.innerHTML = '<div style="color:var(--muted);font-size:13px">Garage leer.</div>'; return; }
    list.innerHTML = '';
    for (const s of slots) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:8px;padding:10px 12px';
      row.innerHTML = `<div><div style="font-weight:600">${s.dino}${s.isElder ? ' 👑' : ''}</div>
        <div style="font-size:11px;color:var(--muted)">${s.gender} · ${Math.round((s.grow || 0) * 100)}% Wachstum${s.label ? ' · ' + s.label : ''}</div></div>`;
      const btn = document.createElement('button');
      btn.textContent = '⬆️ Ausparken';
      btn.style.cssText = 'flex:none;padding:7px 12px;font-size:12px';
      btn.onclick = () => unparkDino(s.id, btn);
      row.appendChild(btn);
      list.appendChild(row);
    }
  } catch {
    list.innerHTML = '<div style="color:#ef4444;font-size:13px">Garage konnte nicht geladen werden.</div>';
  }
}

async function parkDino() {
  const btn = el('parkBtn');
  btn.disabled = true; btn.textContent = 'Parke ein…';
  try {
    const res = await fetch(`${config.tokenBase}/garage/park`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: '{}' });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Fehler');
    btn.textContent = `✅ ${d.dino} eingeparkt`;
    setTimeout(() => { btn.disabled = false; btn.textContent = '⬇️ Aktuellen Dino einparken'; }, 1500);
    await loadGarage();
  } catch (err) {
    btn.disabled = false; btn.textContent = `❌ ${err.message}`;
    setTimeout(() => { btn.textContent = '⬇️ Aktuellen Dino einparken'; }, 2500);
  }
}

async function unparkDino(slotId, btn) {
  btn.disabled = true; btn.textContent = 'Parke aus…';
  try {
    const res = await fetch(`${config.tokenBase}/garage/unpark`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ slotId }) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Fehler');
    await loadGarage();
  } catch (err) {
    btn.disabled = false; btn.textContent = `❌ ${err.message}`.slice(0, 22);
    setTimeout(() => loadGarage(), 2500);
  }
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
    DI_STATS.forEach((s) => { el(`di-${s.key}-f`).style.width = '0%'; el(`di-${s.key}-v`).textContent = '—'; });
    return;
  }
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
    el('calibBtn').style.display = isAdmin ? 'block' : 'none';
    el('zoneBtn').style.display = isAdmin ? 'block' : 'none';
    renderHotkeys();
    await connect(data);
  } catch (err) {
    setMicState('disconnected', `Fehler: ${err.message}`);
  }
}

async function connect({ token, url }) {
  setMicState('connecting');
  room = new Room({ adaptiveStream: true, dynacast: true });
  room
    .on(RoomEvent.Connected, () => { refreshMicState(); el('connBtn').textContent = 'Trennen'; })
    .on(RoomEvent.Disconnected, () => { el('connBtn').textContent = 'Verbinden'; setMicState('disconnected'); })
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
  if (room) { await room.disconnect(); room = null; micEnabled = false; el('connBtn').textContent = 'Verbinden'; setMicState('disconnected'); }
  else { const s = await window.bf.getSession(); if (s) connectWithSession(s); }
}

async function toggleMic() {
  if (!room) return;
  micEnabled = !micEnabled;
  el('micBtn').textContent = micEnabled ? 'Mikro aus' : 'Mikro an';
  await applyMic();
}

init();
