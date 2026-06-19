import { Room, RoomEvent, Track } from 'livekit-client';

const el = (id) => document.getElementById(id);

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
  else setMic('Keine Session', 'off');
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
function setMic(text, dotClass) {
  el('micText').textContent = text;
  el('micDot').className = `dot ${dotClass}`;
}

async function connectWithSession(session) {
  setMic('Hole Voice-Token…', 'warn');
  try {
    const res = await fetch(`${config.tokenBase}/token`, { headers: { Authorization: `Bearer ${session}` } });
    if (res.status === 401) { window.bf.logout(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    await connect(data);
  } catch (err) {
    setMic(`Fehler: ${err.message}`, 'off');
  }
}

async function connect({ token, url, name }) {
  setMic('Verbinde…', 'warn');
  room = new Room({ adaptiveStream: true, dynacast: true });
  room
    .on(RoomEvent.Connected, () => { setMic(micEnabled ? 'Mikro an' : 'Verbunden', 'on'); el('connBtn').textContent = 'Trennen'; })
    .on(RoomEvent.Disconnected, () => { setMic('Getrennt', 'off'); el('connBtn').textContent = 'Verbinden'; })
    .on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) {
        const a = track.attach(); a.autoplay = true; document.body.appendChild(a);
      }
    });
  await room.connect(url, token);
}

async function toggleConnect() {
  if (room) { await room.disconnect(); room = null; micEnabled = false; setMic('Getrennt', 'off'); el('connBtn').textContent = 'Verbinden'; }
  else { const s = await window.bf.getSession(); if (s) connectWithSession(s); }
}

async function toggleMic() {
  if (!room) return;
  micEnabled = !micEnabled;
  await room.localParticipant.setMicrophoneEnabled(micEnabled);
  el('micBtn').textContent = micEnabled ? 'Mikro aus' : 'Mikro an';
  setMic(micEnabled ? 'Mikro an' : 'Verbunden', 'on');
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
