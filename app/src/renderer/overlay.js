import { Room, RoomEvent, Track, ParticipantEvent } from 'livekit-client';

const el = (id) => document.getElementById(id);

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

  drawMinimap();
  // Auto-Connect mit gespeicherter Session
  const session = await window.bf.getSession();
  if (session) connectWithSession(session);
  else setMicState('disconnected', 'Keine Session');
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
  if (mapOpen) drawBigMap();
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

// ── Map-Platzhalter (echte Karte folgt in der nächsten Phase) ──────────────
function drawMinimap() {
  const c = el('minimap').getContext('2d');
  c.clearRect(0, 0, 200, 200);
  c.fillStyle = 'rgba(40,30,70,0.5)';
  c.beginPath(); c.arc(100, 100, 98, 0, Math.PI * 2); c.fill();
  // eigener Standort (Platzhalter Mitte)
  c.fillStyle = '#8b5cf6';
  c.beginPath(); c.arc(100, 100, 6, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#b3a9cc'; c.font = '11px system-ui'; c.textAlign = 'center';
  c.fillText('Minimap', 100, 180);
}

function drawBigMap() {
  const c = el('bigMapCanvas').getContext('2d');
  c.clearRect(0, 0, 1000, 1000);
  c.fillStyle = '#b3a9cc'; c.font = '20px system-ui'; c.textAlign = 'center';
  c.fillText('🗺️ Große Karte', 500, 480);
  c.font = '14px system-ui';
  c.fillText('Kartenbild, Zonen & Wegpunkte folgen in der nächsten Phase', 500, 520);
}

init();
