import { Room, RoomEvent, Track } from 'livekit-client';

const el = (id) => document.getElementById(id);
let config = { tokenBase: 'https://voice.blackfossil.de' };
let room = null;
let micEnabled = false;

async function init() {
  config = await window.bf.getConfig();

  el('loginBtn').onclick = () => window.bf.openLogin();
  el('manualBtn').onclick = async () => {
    const t = el('manualSession').value.trim();
    if (t) { await window.bf.saveSession(t); start(t); }
  };
  el('logoutBtn').onclick = async () => { await disconnect(); await window.bf.logout(); showLogin(); };
  el('micBtn').onclick = toggleMic;

  // Deep-Link-Session zur Laufzeit
  window.bf.onSession((token) => start(token));

  // Gespeicherte Session?
  const saved = await window.bf.getSession();
  if (saved) start(saved);
}

function showLogin() { el('loginCard').classList.remove('hidden'); el('connectedCard').classList.add('hidden'); }
function showConnected() { el('loginCard').classList.add('hidden'); el('connectedCard').classList.remove('hidden'); }

function setVoiceStatus(text, dotClass) {
  el('voiceStatus').textContent = text;
  el('voiceDot').className = `dot ${dotClass}`;
}

async function start(sessionToken) {
  showConnected();
  setVoiceStatus('Hole Voice-Token…', 'warn');
  try {
    const res = await fetch(`${config.tokenBase}/token`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error(`Token-Service HTTP ${res.status}`);
    const data = await res.json();
    await connect(data);
  } catch (err) {
    setVoiceStatus(`Fehler: ${err.message}`, 'off');
  }
}

async function connect({ token, url, name }) {
  setVoiceStatus('Verbinde mit Voice…', 'warn');
  room = new Room({ adaptiveStream: true, dynacast: true });

  room
    .on(RoomEvent.Connected, () => {
      setVoiceStatus(`Verbunden als ${name}`, 'on');
      renderParticipants();
    })
    .on(RoomEvent.Disconnected, () => setVoiceStatus('Getrennt', 'off'))
    .on(RoomEvent.ParticipantConnected, renderParticipants)
    .on(RoomEvent.ParticipantDisconnected, renderParticipants)
    .on(RoomEvent.ActiveSpeakersChanged, renderParticipants)
    .on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) {
        const audioEl = track.attach();
        audioEl.autoplay = true;
        document.body.appendChild(audioEl);
      }
    });

  await room.connect(url, token);
}

async function disconnect() {
  if (room) { await room.disconnect(); room = null; }
  micEnabled = false;
}

async function toggleMic() {
  if (!room) return;
  micEnabled = !micEnabled;
  await room.localParticipant.setMicrophoneEnabled(micEnabled);
  el('micBtn').textContent = micEnabled ? '🔴 Mikro aus' : '🎙️ Mikro an';
}

function renderParticipants() {
  if (!room) return;
  const speakers = new Set(room.activeSpeakers.map((p) => p.identity));
  const all = [room.localParticipant, ...room.remoteParticipants.values()];
  el('participants').innerHTML = all.map((p) => {
    const speaking = speakers.has(p.identity) ? '<span class="speaking">● spricht</span>' : '';
    const label = p.name || p.identity;
    const you = p.identity === room.localParticipant.identity ? ' (du)' : '';
    return `<div class="participant"><span>${label}${you}</span>${speaking}</div>`;
  }).join('') || '<div class="sub" style="margin-top:6px">Niemand sonst im Raum.</div>';
}

init();
