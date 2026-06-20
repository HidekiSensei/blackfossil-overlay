import { Room, RoomEvent, Track, ParticipantEvent } from 'livekit-client';
import { loadMapImage, drawFullMap, drawMinimap, drawHeatmap, normToWorld, worldToNorm, zoneAt, resetCal, solveAffine, ZONES } from './map.js';

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
  applyHotkeyLabels();

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
  el('calibReset').onclick = () => { resetCal(); calibPairs = []; armedRef = null; renderCalibList(); renderBigMap(); };

  window.bf.onHotkey(handleHotkey);

  // Kartenbild laden
  await loadMapImage('assets/map.jpg');

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
  if (calibMode) { calibPairs = []; armedRef = null; renderCalibList(); }
  renderBigMap();
}

function refCandidates() {
  const list = [];
  for (const p of players) if (!p.isDead) list.push({ label: `👤 ${p.name}`, x: p.x, y: p.y });
  for (const [k, z] of Object.entries(ZONES))
    z.points.forEach((pt, i) => list.push({ label: `${z.label}-${'ABCD'[i]}`, x: pt.x, y: pt.y }));
  return list;
}

function renderCalibList() {
  const used = new Set(calibPairs.map((p) => p.label));
  el('calibRefs').innerHTML = '';
  for (const ref of refCandidates()) {
    const b = document.createElement('button');
    const isUsed = used.has(ref.label);
    const isArmed = armedRef && armedRef.label === ref.label;
    b.textContent = (isUsed ? '✓ ' : isArmed ? '➤ ' : '') + ref.label;
    b.style.cssText = `padding:6px 8px;font-size:12px;border-radius:6px;text-align:left;cursor:pointer;
      border:1px solid ${isArmed ? '#8b5cf6' : 'var(--border)'};
      background:${isUsed ? 'rgba(34,197,94,0.15)' : isArmed ? 'rgba(139,92,246,0.2)' : 'transparent'};color:#eee`;
    b.onclick = () => { armedRef = ref; renderCalibList(); };
    el('calibRefs').appendChild(b);
  }
  el('calibCount').textContent = `${calibPairs.length} Punkte gesetzt` + (armedRef ? ` · klicke wo "${armedRef.label}" ist` : '');
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
    el('calibCount').innerHTML = `<span style="color:#22c55e">✅ Kalibriert! Ø Abweichung ~${px}px — sehr gut.</span>`;
  } else if (px <= 50) {
    el('calibCount').innerHTML = `<span style="color:#f59e0b">⚠️ Kalibriert, aber ~${px}px Abweichung. Für mehr Genauigkeit weitere Punkte setzen.</span>`;
  } else {
    el('calibCount').innerHTML = `<span style="color:#ef4444">❌ ~${px}px Abweichung — ein Punkt ist wohl falsch geklickt. Reset und neu, weit verteilt.</span>`;
  }
}

function applyHotkeyLabels() {
  const h = config.hotkeys || {};
  if (h['connect-toggle']) el('hk-connect').textContent = h['connect-toggle'];
  if (h['mic-toggle']) el('hk-mic').textContent = h['mic-toggle'];
  if (h['settings-toggle']) el('hk-settings').textContent = h['settings-toggle'];
  if (h['map-toggle']) el('hk-map').textContent = h['map-toggle'];
}

// ── Hotkeys ─────────────────────────────────────────────────────────────────
function handleHotkey(action) {
  if (action === 'connect-toggle') toggleConnect();
  else if (action === 'mic-toggle') toggleMic();
  else if (action === 'settings-toggle') toggleSettings();
  else if (action === 'map-toggle') toggleMap();
}

function updateInteractive() {
  // Maus nur durchlassen wenn weder Settings noch Map offen sind
  window.bf.setInteractive(settingsOpen || mapOpen);
}

function toggleSettings(force) {
  settingsOpen = force !== undefined ? force : !settingsOpen;
  el('settings').style.display = settingsOpen ? 'block' : 'none';
  updateInteractive();
}

function toggleMap(force) {
  mapOpen = force !== undefined ? force : !mapOpen;
  el('bigMap').style.display = mapOpen ? 'flex' : 'none';
  if (mapOpen) renderBigMap();
  else toggleCalib(false);
  updateInteractive();
}

// ── Voice ─────────────────────────────────────────────────────────────────
// Setzt das Mikro-Icon je nach aktuellem Zustand
function refreshMicState() {
  if (!room) { setMicState('disconnected'); return; }
  if (!micEnabled) { setMicState('muted'); return; }
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
  await room.localParticipant.setMicrophoneEnabled(micEnabled);
  el('micBtn').textContent = micEnabled ? 'Mikro aus' : 'Mikro an';
  refreshMicState();
}

init();
