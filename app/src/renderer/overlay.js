import { Room, RoomEvent, Track, ParticipantEvent } from 'livekit-client';
import { loadMapImage, drawFullMap, drawMinimap, normToWorld, zoneAt, getCal, setCal, resetCal } from './map.js';

const el = (id) => document.getElementById(id);

// ── Karten-/Positions-State ─────────────────────────────────────────────────
let players = [];
let me = null;
let waypoints = [];
let calibMode = false;
let sessionToken = null;

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

  window.bf.onHotkey(handleHotkey);

  // Kartenbild laden
  await loadMapImage('assets/map.jpg');

  // Wegpunkt setzen per Klick auf die große Karte
  el('bigMapCanvas').addEventListener('click', onMapClick);
  // Kalibrier-Tasten (nur bei offener Karte aktiv)
  window.addEventListener('keydown', onCalibKey);

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
        if (mapOpen) renderBigMap();
      }
    } catch {}
  };
  poll();
  setInterval(poll, 1500);
}

function updateZoneBox() {
  if (!me) { el('zoneBox').textContent = 'Zone: —'; return; }
  const z = zoneAt(me.x, me.y);
  el('zoneBox').textContent = z ? `Zone: ${z}` : 'Zone: Frei';
  el('zoneBox').style.color = z === 'PVP' ? '#ef4444' : z === 'PVE' ? '#22c55e' : '#b3a9cc';
}

// ── Rendering ────────────────────────────────────────────────────────────────
function renderMinimap() {
  const cv = el('minimap');
  drawMinimap({ ctx: cv.getContext('2d'), w: cv.width, h: cv.height }, players, me);
}
function renderBigMap() {
  const cv = el('bigMapCanvas');
  drawFullMap({ ctx: cv.getContext('2d'), w: cv.width, h: cv.height }, players, waypoints);
  if (calibMode) drawCalibOverlay(cv.getContext('2d'), cv.width, cv.height);
}

function onMapClick(e) {
  if (calibMode) return;
  const cv = el('bigMapCanvas');
  const rect = cv.getBoundingClientRect();
  const nx = (e.clientX - rect.left) / rect.width;
  const ny = (e.clientY - rect.top) / rect.height;
  const w = normToWorld(nx, ny);
  waypoints = [{ x: w.x, y: w.y }]; // ein Wegpunkt (ersetzt vorherigen)
  renderBigMap();
}

// ── Kalibrierung (Taste C auf der großen Karte) ──────────────────────────────
function onCalibKey(e) {
  if (!mapOpen) return;
  if (e.key === 'c' || e.key === 'C') { calibMode = !calibMode; renderBigMap(); return; }
  if (!calibMode) return;
  const cal = getCal();
  const panStep = 8000, zoomStep = 1.05;
  if (e.key === 'ArrowLeft')  setCal({ cx: cal.cx - panStep });
  else if (e.key === 'ArrowRight') setCal({ cx: cal.cx + panStep });
  else if (e.key === 'ArrowUp')    setCal({ cy: cal.cy + panStep });
  else if (e.key === 'ArrowDown')  setCal({ cy: cal.cy - panStep });
  else if (e.key === '+' || e.key === '=') setCal({ scale: cal.scale * zoomStep });
  else if (e.key === '-') setCal({ scale: cal.scale / zoomStep });
  else if (e.key === 'r' || e.key === 'R') resetCal();
  else return;
  e.preventDefault();
  renderBigMap();
}

function drawCalibOverlay(ctx, w, h) {
  const cal = getCal();
  ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(10, 10, 320, 96);
  ctx.fillStyle = '#fbbf24'; ctx.font = '13px system-ui'; ctx.textAlign = 'left';
  ctx.fillText('🔧 KALIBRIERUNG (C zum Beenden)', 22, 32);
  ctx.fillStyle = '#eee'; ctx.font = '12px system-ui';
  ctx.fillText('Pfeile = verschieben · +/- = zoomen · R = reset', 22, 52);
  ctx.fillText(`cx=${cal.cx|0}  cy=${cal.cy|0}  scale=${cal.scale.toExponential(3)}`, 22, 72);
  ctx.fillText('Schiebe bis dein Punkt (lila) zu deiner echten Position passt', 22, 92);
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
  else calibMode = false;
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
