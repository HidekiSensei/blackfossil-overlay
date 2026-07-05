import { Room, RoomEvent, Track, ParticipantEvent } from 'livekit-client';
import { loadMapImage, drawFullMap, drawMinimap, drawHeatmap, normToWorld, worldToNorm, zoneAt, resetCal, solveAffine, getCal, setCalAffine, setZones, newZone, ZONES, ZONE_TYPES, ZONE_META, loadZoneLayer, setZoneLayer, isZoneLayerVisible, groupColorFor, setMarkerStyle } from './map.js';

const el = (id) => document.getElementById(id);

// ── Color-Themes (Overlay personalisieren) ───────────────────────────────────
// rgb = "r,g,b" des Akzents (für rgba(var(--accent-rgb),a) in FX/Blitzen).
// panel = ans Theme gekoppelte Hintergrundfarbe der Panels (dunkler Akzent-Ton).
// min = Mindest-Abo-Rang (0 Fossil/Free · 1 Knochen · 2 Bernstein · 3 Obsidian). Gating über aboTier.
const BF_THEMES = {
  violett: { name: 'Violett', min: 0, accent: '#8b5cf6', accent2: '#a78bfa', accentD: '#7c3aed', border: 'rgba(139,92,246,0.32)', rgb: '139,92,246', panel: 'rgba(20,13,38,0.82)', inputBg: '#160d28' },
  blau:    { name: 'Blau',    min: 1, accent: '#3b82f6', accent2: '#60a5fa', accentD: '#2563eb', border: 'rgba(59,130,246,0.32)', rgb: '59,130,246', panel: 'rgba(12,18,38,0.82)', inputBg: '#0c1426' },
  cyan:    { name: 'Cyan',    min: 1, accent: '#06b6d4', accent2: '#22d3ee', accentD: '#0891b2', border: 'rgba(6,182,212,0.32)', rgb: '6,182,212', panel: 'rgba(8,24,30,0.82)', inputBg: '#07181d' },
  gruen:   { name: 'Grün',    min: 1, accent: '#22c55e', accent2: '#4ade80', accentD: '#16a34a', border: 'rgba(34,197,94,0.32)', rgb: '34,197,94', panel: 'rgba(10,28,18,0.82)', inputBg: '#0a1c12' },
  gold:    { name: 'Gold',    min: 2, accent: '#f59e0b', accent2: '#fbbf24', accentD: '#d97706', border: 'rgba(245,158,11,0.32)', rgb: '245,158,11', panel: 'rgba(32,24,8,0.84)', inputBg: '#1c1506' },
  rot:     { name: 'Rot',     min: 2, accent: '#ef4444', accent2: '#f87171', accentD: '#dc2626', border: 'rgba(239,68,68,0.32)', rgb: '239,68,68', panel: 'rgba(34,12,12,0.84)', inputBg: '#1e0c0c' },
  pink:    { name: 'Pink',    min: 2, accent: '#ec4899', accent2: '#f472b6', accentD: '#db2777', border: 'rgba(236,72,153,0.32)', rgb: '236,72,153', panel: 'rgba(34,12,26,0.84)', inputBg: '#1e0c18' },
};
// ── Abo-Gating (Stichtag-aware aboTier kommt aus /token) ─────────────────────
const ABO_ORDER = ['Fossil', 'Knochen', 'Bernstein', 'Obsidian'];
let myAboTier = 'Fossil';
let mySkinFree = false;   // 🎨 Skin-Creator gratis (ab Knochen ODER Beta-Tester-Rolle) — aus /token
const myAboIdx = () => Math.max(0, ABO_ORDER.indexOf(myAboTier));
const themeUnlocked = (key) => { const t = BF_THEMES[key]; return !!t && myAboIdx() >= (t.min || 0); };
function setAboTier(tier) {
  myAboTier = ABO_ORDER.includes(tier) ? tier : 'Fossil';
  // Gespeicherte Theme-Wahl jetzt mit korrektem Rang anwenden (beim Laden war der Rang noch unbekannt).
  applyTheme(localStorage.getItem('bf-theme') || 'violett');
  if (featureOpen === 'settings') renderThemePicker();
}
// Custom-Theme (Obsidian): vollständiges Theme aus EINER Akzent-Farbe ableiten.
function hexToRgb(hex) { const n = parseInt(String(hex).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgbToHex(r, g, b) { const h = (v) => ('0' + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2); return '#' + h(r) + h(g) + h(b); }
function themeFromHex(hex) {
  const [r, g, b] = hexToRgb(hex);
  const li = (v) => v + (255 - v) * 0.25, dk = (v) => v * 0.82;
  return {
    name: 'Custom', min: 3, accent: hex, accent2: rgbToHex(li(r), li(g), li(b)), accentD: rgbToHex(dk(r), dk(g), dk(b)),
    border: `rgba(${r},${g},${b},0.32)`, rgb: `${r},${g},${b}`,
    panel: `rgba(${Math.round(r * 0.14)},${Math.round(g * 0.14)},${Math.round(b * 0.14)},0.84)`, inputBg: rgbToHex(r * 0.16, g * 0.16, b * 0.16),
  };
}
let currentTheme = localStorage.getItem('bf-theme') || 'violett';
function buildTheme(key) {
  if (key === 'custom') return themeFromHex(localStorage.getItem('bf-custom') || '#8b5cf6');
  return BF_THEMES[key] || BF_THEMES.violett;
}
// persist nur bei expliziter Nutzer-Wahl → Fallback-auf-Violett (Rang noch unbekannt/herabgestuft)
// überschreibt NICHT die gespeicherte Präferenz.
function applyTheme(key, persist) {
  const allowed = key === 'custom' ? myAboIdx() >= 3 : themeUnlocked(key);
  if (!allowed) key = 'violett';
  const t = buildTheme(key); currentTheme = key;
  const r = document.documentElement.style;
  r.setProperty('--accent', t.accent); r.setProperty('--accent-2', t.accent2);
  r.setProperty('--accent-d', t.accentD); r.setProperty('--border', t.border);
  r.setProperty('--accent-rgb', t.rgb); r.setProperty('--panel', t.panel);
  r.setProperty('--input-bg', t.inputBg);
  if (persist) localStorage.setItem('bf-theme', key);
  minimapDirty = true;   // Theme-Farben geändert → Minimap neu zeichnen
}
function renderThemePicker() {
  const box = el('themePicker'); if (!box) return;
  box.innerHTML = Object.entries(BF_THEMES).map(([k, t]) => {
    const locked = !themeUnlocked(k);
    const tip = locked ? `${t.name} 🔒 ab ${ABO_ORDER[t.min]}` : t.name;
    return `<button class="theme-sw${k === currentTheme ? ' on' : ''}${locked ? ' locked' : ''}" data-theme="${k}" title="${tip}" style="background:linear-gradient(135deg,${t.accent},${t.accentD})">${locked ? '🔒' : ''}</button>`;
  }).join('') + customThemeHTML();
  box.querySelectorAll('.theme-sw').forEach((b) => b.onclick = () => {
    const k = b.dataset.theme;
    if (!themeUnlocked(k)) { showToast(`🔒 „${BF_THEMES[k].name}" gibt's ab Rang ${ABO_ORDER[BF_THEMES[k].min]}.`, 'error'); return; }
    applyTheme(k, true);
    box.querySelectorAll('.theme-sw,.theme-custom').forEach((x) => x.classList.toggle('on', x.dataset.theme === currentTheme));
  });
  wireCustomTheme(box);
}
function customThemeHTML() {
  if (myAboIdx() < 3) return `<div class="theme-custom locked" title="Eigene Akzentfarbe — exklusiv für Obsidian">🎨🔒 Eigene Farbe</div>`;
  const cur = localStorage.getItem('bf-custom') || '#8b5cf6';
  return `<label class="theme-custom${currentTheme === 'custom' ? ' on' : ''}" data-theme="custom" title="Eigene Akzentfarbe wählen">🎨 <input type="color" id="themeCustomInput" value="${cur}"></label>`;
}
function wireCustomTheme(box) {
  const inp = box.querySelector('#themeCustomInput'); if (!inp) return;
  inp.oninput = () => {
    localStorage.setItem('bf-custom', inp.value);
    applyTheme('custom', true);
    box.querySelectorAll('.theme-sw,.theme-custom').forEach((x) => x.classList.toggle('on', x.dataset.theme === currentTheme));
  };
}
applyTheme(currentTheme);   // sofort beim Laden anwenden (kein Flash; Rang folgt via setAboTier)

// ── Blitz-Effekte an/aus (Settings-Toggle, persistent) ──────────────────────
let fxOff = localStorage.getItem('bf-noblitz') === '1';
function applyFx() {
  document.body.classList.toggle('bf-noblitz', fxOff);
  const b = document.getElementById('fxToggleBtn');
  if (b) { b.textContent = fxOff ? '⚡ Effekte: Aus' : '⚡ Effekte: An'; b.classList.toggle('secondary', fxOff); }
  if (typeof updateLowSpecBtn === 'function') updateLowSpecBtn();
}
function toggleFx() { fxOff = !fxOff; localStorage.setItem('bf-noblitz', fxOff ? '1' : '0'); applyFx(); }
document.addEventListener('DOMContentLoaded', applyFx);

// ── Minimap an/aus (Settings-Toggle, persistent) ────────────────────────────
let miniHidden = localStorage.getItem('bf-hide-mini') === '1';
function applyMiniToggle() {
  const b = el('miniToggleBtn');
  if (b) { b.textContent = miniHidden ? '🗺️ Minimap: Aus' : '🗺️ Minimap: An'; b.classList.toggle('secondary', miniHidden); }
  applyServerState();   // Sichtbarkeit neu setzen (berücksichtigt onServer + miniHidden)
}
function toggleMinimap() { miniHidden = !miniHidden; localStorage.setItem('bf-hide-mini', miniHidden ? '1' : '0'); applyMiniToggle(); }

// ── Weichzeichner (Blur) an/aus — größter GPU-Kostenpunkt, wichtigster Low-Spec-Schalter ─────
let blurOff = localStorage.getItem('bf-noblur') === '1';
function applyBlur() {
  document.body.classList.toggle('bf-noblur', blurOff);
  const b = document.getElementById('blurToggleBtn');
  if (b) { b.textContent = blurOff ? '🌫️ Weichzeichner: Aus' : '🌫️ Weichzeichner: An'; b.classList.toggle('secondary', blurOff); }
  updateLowSpecBtn();
}
function toggleBlur() { blurOff = !blurOff; localStorage.setItem('bf-noblur', blurOff ? '1' : '0'); applyBlur(); }
document.addEventListener('DOMContentLoaded', applyBlur);

// ── Master „Low-Spec-Modus" — schaltet Blur + Effekte in einem Rutsch ───────────────────────
function lowSpecActive() { return blurOff && fxOff; }
function updateLowSpecBtn() {
  const b = document.getElementById('lowSpecBtn');
  if (!b) return;
  const on = lowSpecActive();
  b.textContent = on ? '⚡ Low-Spec-Modus: AN' : '⚡ Low-Spec-Modus aktivieren';
  b.classList.toggle('secondary', !on);
}
function toggleLowSpec() {
  const on = !lowSpecActive();   // war aus → alles aus; war an → alles wieder an
  blurOff = on; fxOff = on;
  localStorage.setItem('bf-noblur', on ? '1' : '0');
  localStorage.setItem('bf-noblitz', on ? '1' : '0');
  applyBlur(); applyFx();
}

// ── Karten-Marker-Stil (Wegpunkt-Farbe/-Größe + Spieler-Pfeil-Farbe) ─────────
const MARKER_DEFAULTS = { wpColor: '#fbbf24', wpSize: 1, selfColor: '#00e5ff' };
function loadMarkerStyle() {
  return {
    wpColor: localStorage.getItem('bf-wp-color') || MARKER_DEFAULTS.wpColor,
    wpSize: parseFloat(localStorage.getItem('bf-wp-size')) || MARKER_DEFAULTS.wpSize,
    selfColor: localStorage.getItem('bf-self-color') || MARKER_DEFAULTS.selfColor,
  };
}
function applyMarkerStyle() {
  const m = loadMarkerStyle();
  setMarkerStyle(m);
  const wc = document.getElementById('wpColorInp'); if (wc) wc.value = m.wpColor;
  const ws = document.getElementById('wpSizeInp'); if (ws) ws.value = String(m.wpSize);
  const sc = document.getElementById('selfColorInp'); if (sc) sc.value = m.selfColor;
  try { renderBigMap(); } catch {}   // sofort sichtbar, falls die Karte offen ist
}
function setupMarkerSettings() {
  const wc = document.getElementById('wpColorInp');
  const ws = document.getElementById('wpSizeInp');
  const sc = document.getElementById('selfColorInp');
  const rb = document.getElementById('markerResetBtn');
  const save = (k, v) => { localStorage.setItem(k, v); applyMarkerStyle(); };
  if (wc) wc.oninput = () => save('bf-wp-color', wc.value);
  if (ws) ws.oninput = () => save('bf-wp-size', ws.value);
  if (sc) sc.oninput = () => save('bf-self-color', sc.value);
  if (rb) rb.onclick = () => {
    ['bf-wp-color', 'bf-wp-size', 'bf-self-color'].forEach((k) => localStorage.removeItem(k));
    applyMarkerStyle();
  };
  applyMarkerStyle();
}
document.addEventListener('DOMContentLoaded', setupMarkerSettings);

// ── Karten-/Positions-State ─────────────────────────────────────────────────
let players = [];
let me = null;
let waypoints = [];
// Pfeil-Richtung aus der tatsächlichen Bewegung auf der Karte (konventions-frei,
// unabhängig von Heading/Kalibrierung). prevPos = letzte Welt-Position je Spieler.
const _prevPos = {};
const _moveAngle = {};
function computeMoveAngles() {
  for (const p of players) {
    const prev = _prevPos[p.steamId];
    if (prev) {
      const a0 = worldToNorm(prev.x, prev.y), a1 = worldToNorm(p.x, p.y);
      const dnx = a1.nx - a0.nx, dny = a1.ny - a0.ny;
      if (Math.hypot(p.x - prev.x, p.y - prev.y) > 40) _moveAngle[p.steamId] = Math.atan2(dny, dnx); // genug Bewegung
    }
    _prevPos[p.steamId] = { x: p.x, y: p.y };
    if (_moveAngle[p.steamId] != null) p.dirAngle = _moveAngle[p.steamId];
  }
}
let calibMode = false;
let heatmapMode = false;
// Auto-Kalibrierung über ZONEN-Ecken: rohe Welt-Koordinaten der hinterlegten Zonen
// (PVP/PVE), gut über die Karte verteilt ausgewählt. Du erkennst die Ecken am Gelände
// und klickst sie an → solveAffine schiebt nur die DARSTELLUNG zurecht (kein Umrechnen
// der Teleport-Ziele!).
function pickCalibTargets(n) {
  const pts = ZONES.flatMap((z) => z.points || []).map((p) => ({ x: p.x, y: p.y }));
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
let isAdmin = false;     // Owner/Admin — volle Config
let isIngame = false;    // Owner/Admin/Moderator — Ingame-Tools (Admin-Panel)
let isTeam = false;      // Owner/Admin/Support
let isStaff = false;     // isIngame || isTeam → sieht Support-Tools (Dino-Token etc.)
let zoneEditMode = false;
let activeZoneId = null; // id der aktuell gewählten Zone (Editor)
let zonesDirty = false;  // ungespeicherte lokale Zonen-Änderungen → Auto-Refresh pausiert
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

// ── Voice-Verbindungs-Indikator (Qualität + Latenz + Relay-Warnung) ──────────
let connQuality = 'unknown';   // excellent | good | poor | lost | unknown (LiveKit)
let connRtt = null;            // ms
let connRelay = false;         // läuft über TCP/Relay (= höhere Latenz)
let connStatsTimer = null;
function setConnQuality(q) { connQuality = String(q || 'unknown').toLowerCase(); renderConnInd(); }
function renderConnInd() {
  const wrap = el('connInd'); if (!wrap) return;
  if (!voiceConnected) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'flex';
  const map = { excellent: ['#22c55e', 'Gut'], good: ['#22c55e', 'Gut'], poor: ['#f59e0b', 'Schwach'], lost: ['#ef4444', 'Schlecht'], unknown: ['#888', '…'] };
  const [color, label] = map[connQuality] || map.unknown;
  const dot = el('connDot'); if (dot) dot.style.background = color;
  let txt = `Verbindung: ${label}`;
  if (connRtt != null) txt += ` · ${connRtt} ms`;
  if (connRelay) txt += ' · ⚠️ Relay';
  const t = el('connText'); if (t) { t.textContent = txt; t.style.color = connRelay ? '#fca5a5' : '#ddd'; }
}
function startConnStats() { stopConnStats(); pollConnStats(); connStatsTimer = setInterval(pollConnStats, 3000); }
function stopConnStats() { if (connStatsTimer) clearInterval(connStatsTimer); connStatsTimer = null; connRtt = null; connRelay = false; }
async function pollConnStats() {
  if (!room) return;
  try {
    const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const sender = pub && pub.track && pub.track.sender;
    if (sender && sender.getStats) {
      const stats = await sender.getStats();
      let rtt = null, localId = null; const locals = {};
      stats.forEach((s) => {
        if (s.type === 'candidate-pair' && (s.state === 'succeeded' || s.nominated) && typeof s.currentRoundTripTime === 'number') { rtt = s.currentRoundTripTime; localId = s.localCandidateId; }
        if (s.type === 'local-candidate') locals[s.id] = s;
      });
      if (rtt != null) connRtt = Math.round(rtt * 1000);
      const lc = localId && locals[localId];
      connRelay = !!(lc && (lc.candidateType === 'relay' || (lc.protocol && String(lc.protocol).toLowerCase() === 'tcp')));
    }
  } catch {}
  renderConnInd();
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
  updateHeart(d);                   // permanente Lebensanzeige
}
// Grow-Waben-HUD: 3 Honigwaben (Grow · Grow-Rate · HP), füllen sich von unten.
// Wird von pollVitals (0,5 s) UND updateHud (/me, 6 s) aufgerufen — beide liefern
// grow/carbs/protein/lipid/health/online.
function setHex(fillFrac, col, e1id, f1id, f2id) {
  const line = 1 - Math.max(0, Math.min(1, fillFrac)); // 0 = voll (von unten), 1 = leer
  const e1 = document.getElementById(e1id), f1 = document.getElementById(f1id), f2 = document.getElementById(f2id);
  if (e1) e1.setAttribute('offset', line);
  if (f1) { f1.setAttribute('offset', line); f1.setAttribute('stop-color', col); }
  if (f2) f2.setAttribute('stop-color', col);
}
function updateHeart(d) {
  const online = !!(d && d.online);
  const gray = '#555';
  // GROW (aktueller Wachstumsstand 0..100 %)
  const grow = online && typeof d.grow === 'number' ? Math.max(0, Math.min(1, d.grow)) : 0;
  setHex(grow, online ? '#8fae54' : gray, 'ggE1', 'ggF1', 'ggF2');
  { const v = document.getElementById('growVal'); if (v) v.textContent = online ? Math.round(grow * 100) + '%' : '—'; }
  // GROW-RATE = Σ Nährstoffe (0..3) → Anzeige 0..300 %, Füllung /3.
  // Ab 75 % Grow stoppt das Wachstum (Adult) → Rate auf 0.
  const nut = (online && grow <= 0.75) ? ((d.carbs || 0) + (d.protein || 0) + (d.lipid || 0)) : 0;
  setHex(nut / 3, online ? '#e7cf7a' : gray, 'grE1', 'grF1', 'grF2');
  { const v = document.getElementById('rateVal'); if (v) v.textContent = online ? Math.round(nut * 100) + '%' : '—'; }
  // HP (Farbe nach Höhe)
  const hp = online && typeof d.health === 'number' ? Math.max(0, Math.min(100, Math.round(d.health * 100))) : 0;
  const hcol = !online ? gray : hp > 50 ? '#22c55e' : hp > 25 ? '#f59e0b' : '#ef4444';
  setHex(hp / 100, hcol, 'ghE1', 'ghF1', 'ghF2');
  { const v = document.getElementById('heartVal'); if (v) v.textContent = online ? hp + '%' : '—'; }
}
// HP/Vitals separat & schnell pollen (Combat-Stat → möglichst live). Eigener leichter Endpoint.
async function pollVitals() {
  if (!sessionToken) return;
  try {
    const res = await fetch(`${config.tokenBase}/me/vitals`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (res.ok) updateHeart(await res.json());
  } catch {}
}
async function pollHud() {
  if (!sessionToken) return;
  try {
    const res = await fetch(`${config.tokenBase}/me`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (res.ok) updateHud(await res.json());
  } catch {}
  pollGrowStatus();
}

// ── Grow-Boost/Stop-Timer (HUD-Pill, nur sichtbar wenn aktiv) ─────────────────
// Server-Sync alle 6s (über pollHud) + lokaler 1s-Countdown für einen flüssigen Balken.
// Der Timer läuft nur online (Backend zählt nur dann runter) → lokal nur dekrementieren, wenn on-server.
let growTimerState = null; // { kind:'boost'|'stop', remaining, total, targetPct }
async function pollGrowStatus() {
  if (!sessionToken) return;
  try {
    const res = await fetch(`${config.tokenBase}/me/grow-status`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!res.ok) return;
    const d = await res.json();
    if ((d.boostRemaining || 0) > 0) growTimerState = { kind: 'boost', remaining: d.boostRemaining, total: d.boostTotal || d.boostRemaining };
    else if ((d.stopRemaining || 0) > 0) growTimerState = { kind: 'stop', remaining: d.stopRemaining, total: d.stopTotal || d.stopRemaining, targetPct: d.stopTargetPct || 0 };
    else growTimerState = null;
    renderGrowTimer();
  } catch {}
}
function renderGrowTimer() {
  const box = el('growTimer'); if (!box) return;
  const s = growTimerState;
  if (!s || !me) { box.style.display = 'none'; return; } // nur on-server + aktiv
  box.style.display = 'block';
  el('gtIcon').textContent = s.kind === 'boost' ? '📈' : '⏹️';
  el('gtLabel').textContent = s.kind === 'boost' ? 'Grow-Boost' : `Grow-Stop · ${s.targetPct} %`;
  const m = Math.floor(s.remaining / 60), sec = s.remaining % 60;
  el('gtTime').textContent = `${m}:${String(sec).padStart(2, '0')}`;
  const pct = s.total > 0 ? Math.max(0, Math.min(100, (s.remaining / s.total) * 100)) : 0;
  el('gtFill').style.width = pct + '%';
}
function tickGrowTimer() {
  if (!growTimerState) return;
  if (me && growTimerState.remaining > 0) growTimerState.remaining -= 1; // Timer läuft nur online
  if (growTimerState.remaining <= 0) growTimerState = null;
  renderGrowTimer();
}

let config = { tokenBase: 'https://api.blackfossil.de', hotkeys: {} };
let room = null;
let micEnabled = false;
let settingsOpen = false;
let deafened = false;                                   // eingehenden Ton stummschalten
let amDead = false;                                     // tot / kein Dino → Voice komplett aus (weder hören noch senden)
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
  { const mb = el('muteAllBtn'); if (mb) mb.onclick = () => toggleMuteAll(); }
  setMicBtn();
  el('logoutBtn').onclick = () => window.bf.logout();
  el('closeBtn').onclick = () => toggleSettings(false);
  el('heatBtn').onclick = () => {
    heatmapMode = !heatmapMode;
    el('heatBtn').style.background = heatmapMode ? 'var(--accent)' : 'var(--panel)';
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
      btn.style.background = on ? 'var(--accent)' : 'var(--panel)';
      renderBigMap();
    };
  }
  el('calibCancelBtn').onclick = () => abortAutoCalib();
  el('calibBtn').onclick = () => toggleCalib();
  el('calibSolve').onclick = () => solveCalibration();
  el('calibReset').onclick = () => { resetCal(); calibPairs = []; saveCalibPairs(); armedRef = null; renderCalibList(); renderBigMap(); };

  // Zonen-Aufnahme (mehrere benannte Zonen)
  el('zoneBtn').onclick = () => toggleZonePanel();
  el('zoneNewBtn').onclick = () => createZone(el('zoneTypeSel').value);
  el('zoneAddBtn').onclick = () => captureZonePoint();
  el('zoneUndoBtn').onclick = () => { const z = getActiveZone(); if (z) { z.points.pop(); zonesDirty = true; updateZoneInfo(); renderZoneList(); renderBigMap(); } };
  el('zoneClearBtn').onclick = () => { const z = getActiveZone(); if (z) { z.points = []; zonesDirty = true; updateZoneInfo(); renderZoneList(); renderBigMap(); } };
  el('zoneName').oninput = () => { const z = getActiveZone(); if (z) { z.name = el('zoneName').value; zonesDirty = true; renderZoneList(); if (mapOpen) renderBigMap(); } };
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
  // Zonen periodisch nachladen, damit von Admins neu gezeichnete Zonen OHNE Neustart
  // bei allen erscheinen. NICHT während man selbst editiert (sonst würden ungespeicherte
  // Punkte vom Server-Stand überschrieben).
  if (!loadServerZones._timer) {
    loadServerZones._timer = setInterval(() => { if (!zoneEditMode && !zonesDirty) loadServerZones(); }, 60000);
  }
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

  // Admin-Panel (eigenständiges Modal, nur Admins) — Einstieg läuft übers Dock (Admin-Button)
  { const oab = el('openAdminBtn'); if (oab) oab.onclick = () => openAdminPanel(); }
  el('adminCloseBtn').onclick = () => closeAdminPanel();
  el('admUserLoad').onclick = () => admLoadUserInfo();
  el('admLightningBtn').onclick = () => admLightning();
  document.querySelectorAll('#adminTabs [data-atab]').forEach((b) => { b.onclick = () => showAdminTab(b.dataset.atab); });
  { const b = el('dtTabGive'); if (b) b.onclick = () => { dtTab = 'give'; renderDtTab(); }; }
  { const b = el('dtTabEdit'); if (b) b.onclick = () => { dtTab = 'edit'; renderDtTab(); }; }
  { const b = el('dtTabDel'); if (b) b.onclick = () => { dtTab = 'delete'; renderDtTab(); }; }
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
  { const c = el('clearWpBtn'); if (c) c.onclick = () => { waypoints = []; renderBigMap(); renderMinimap(); }; }

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

  // Render-Loops — Minimap nur neu zeichnen, wenn sichtbar UND etwas geändert.
  // Spart bei vielen Spielern hunderte identische Redraws/Min; der 1,5s-Positions-Poll
  // markiert ohnehin dirty → die Minimap ist nie länger als ~1,5s veraltet.
  setInterval(() => {
    if (!minimapDirty || !me) return;                 // off-server (!me) → Minimap ausgeblendet
    const mw = el('minimapWrap');
    if (mw && mw.style.display === 'none') return;
    minimapDirty = false;
    renderMinimap();
  }, 200);
  // Minimap per Mausrad zoomen (greift, wenn das Overlay interaktiv ist: Dock/Panel offen)
  { const mm = el('minimap'); if (mm) mm.addEventListener('wheel', (e) => {
      e.preventDefault(); setMiniZoom(miniZoom * (e.deltaY < 0 ? 1.18 : 1 / 1.18));
    }, { passive: false }); }

  // Auto-Connect + Positions-Polling
  const session = await window.bf.getSession();
  // Voice verbindet NICHT sofort — erst wenn man laut Positions-Poll auf dem
  // BlackFossil-Server ist (siehe applyServerState). Off-Server kein Voice.
  if (session) {
    sessionToken = session;
    startPositionPolling();
    // Zonen (und Kalibrierung) JETZT nachladen — der erste Load in init() lief noch OHNE
    // sessionToken (→ 401). Ohne das erscheinen die Zonen erst beim 60s-Auto-Refresh.
    loadServerCalibration();
    loadServerZones();
  } else setMicState('disconnected', 'Keine Session');
}

// ── Server-Gating ────────────────────────────────────────────────────────────
// Nur wenn man wirklich auf dem BlackFossil-Server ist (taucht im Positions-Poll
// als "isYou" auf), sind Karte/Minimap/HUD sichtbar und Voice + Hotkeys aktiv.
// Sonst nur der "Nicht auf dem Server"-Hinweis.
let wasOnServer = false;
function applyServerState() {
  const onServer = !!me;
  el('serverBanner').style.display = onServer ? 'none' : 'block';
  const mw = el('minimapWrap'); if (mw) mw.style.display = (onServer && !miniHidden) ? '' : 'none';
  const hud = el('hud'); if (hud) hud.style.display = onServer ? '' : 'none';
  renderGrowTimer(); // Grow-Timer folgt dem Server-Gating (versteckt sich off-server)
  updateVoiceWarn();
  if (onServer === wasOnServer) return;
  wasOnServer = onServer;
  if (onServer) {
    // Auf dem Server → Voice verbinden (nur hier erlaubt)
    if (!room && sessionToken) connectWithSession(sessionToken);
    pollGrowStatus(); // nach (Re-)Login sofort den Grow-Timer wiederherstellen (überlebt Relog)
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
        // Tot / kein Dino → Voice komplett aus (weder hören noch senden). Wechsel → Mic umschalten + Hinweis.
        const wasDead = amDead;
        amDead = !me || !!me.isDead;
        if (amDead !== wasDead) {
          if (room) applyMic();                              // sofort aufhören/wieder senden
          if (amDead && voiceConnected) showToast('💀 Tot — Voice ist stumm bis zum Respawn.', 'warn');
          else if (!amDead && voiceConnected) showToast('🎙️ Wieder im Spiel — Voice aktiv.', 'success');
          refreshMicState();
        }
        // Health läuft separat über pollVitals() (0,5s, Combat-Stat) — nicht über Positionen
        computeMoveAngles();   // Pfeil-Richtung aus tatsächlicher Karten-Bewegung
        minimapDirty = true;   // neue Positionen → Minimap neu zeichnen
        if (Array.isArray(data.toasts)) for (const t of data.toasts) showToast(t, 'success');
        applyServerState();
        updateZoneBox();
        checkZoneChange();
        updateProximityVolumes();
        if (settingsOpen) renderVoiceUsers();
        if (mapOpen) renderBigMap();
        if (featureOpen === 'group') updateGroupLive();   // nur Mitglieder/Chat updaten, NICHT das Eingabefeld neu bauen
        if (featureOpen === 'profile') updateProfileServerDinos();   // Server-Dino-Zahlen live
        updateSpeakingBox();   // Sprecher-Namen aktualisieren/ausblenden
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
    const factor = (deafened || amDead) ? 0 : masterGain;   // tot → du hörst niemanden
    try { p.setVolume(vol * g * factor); } catch {}
  }
}

// ── Info-Box: Namen der Spieler, die man gerade hört (active speakers) ───────
// Kurzer Nachlauf (1,5 s) gegen Flackern bei Sprechpausen. Wird per
// ActiveSpeakersChanged-Event UND im Positions-Poll (zum Ausblenden) aufgerufen.
let _speakSeen = new Map();   // identity(steamId) → letzter Sprech-Zeitpunkt
// Tatsächliche Wiedergabe-Lautstärke eines Sprechers (gleiche Rechnung wie
// updateProximityVolumes). 0 = nicht hörbar (außer Reichweite / deafened / stumm).
function audibleVol(steamId) {
  let vol = 1;
  const pos = players.find((pl) => pl.steamId === steamId);
  if (me && pos) {
    const Rw = (remoteRanges[steamId] ?? DEFAULT_RANGE) * UNITS_PER_M;
    const d = Math.hypot(pos.x - me.x, pos.y - me.y);
    vol = Math.max(0, Math.min(1, 2 * (1 - d / Rw)));
  }
  const g = userGain[steamId] ?? 1;
  const factor = (deafened || amDead) ? 0 : masterGain;
  return vol * g * factor;
}
function updateSpeakingBox(speakers) {
  const box = el('speakingBox'); if (!box) return;
  const now = Date.now();
  const active = (speakers || (room ? room.activeSpeakers : []) || []).filter((p) => room && p !== room.localParticipant);
  for (const p of active) _speakSeen.set(p.identity, now);
  const items = [];
  for (const [id, ts] of _speakSeen) {
    if (now - ts > 1500) { _speakSeen.delete(id); continue; }
    if (audibleVol(id) <= 0) continue;                        // nur wen man WIRKLICH hört (Reichweite/deafened/stumm)
    const pl = players.find((x) => x.steamId === id);
    const nm = pl && (pl.name || pl.playerName);
    if (nm) items.push({ nm, color: pl.roleColor });          // roleColor = Discord-Rollenfarbe (Integer) oder null
  }
  if (!items.length) { box.style.display = 'none'; return; }
  box.style.display = '';
  // Namen in der Discord-Rollenfarbe (Spender/Abonnenten/Team erkennbar); ohne Farbe = Standard.
  box.innerHTML = `🔊 ${items.map(({ nm, color }) => {
    const hex = (color && color > 0) ? '#' + (color >>> 0).toString(16).padStart(6, '0') : null;
    return hex ? `<span style="color:${hex}">${escapeHtml(nm)}</span>` : escapeHtml(nm);
  }).join(', ')}`;
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

let miniZoom = parseFloat(localStorage.getItem('bf-mini-zoom')) || 1;   // Nutzer-Zoom der Minimap (Mausrad)
let minimapDirty = true;   // Minimap nur neu zeichnen, wenn sich etwas geändert hat (Daten/Zoom/Theme)
function setMiniZoom(z) {
  miniZoom = Math.min(6, Math.max(0.5, z));
  localStorage.setItem('bf-mini-zoom', miniZoom.toFixed(2));
  renderMinimap();
}
function renderMinimap() {
  const cv = el('minimap');
  const ctx = cv.getContext('2d');
  const { w, h } = fitCanvasDPR(cv, ctx);
  drawMinimap({ ctx, w, h }, players, me, myRange * UNITS_PER_M, waypoints, miniZoom);
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
    row.onmouseenter = () => { row.style.background = 'rgba(var(--accent-rgb),0.18)'; };
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
  const d = await res.json(); if (!res.ok) throw new Error(apiErr(d));
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
    row.style.cssText = `padding:6px 8px;margin-bottom:4px;border-radius:8px;cursor:pointer;border:1px solid ${hot ? 'var(--accent)' : 'transparent'};background:${hot ? 'rgba(var(--accent-rgb),0.20)' : 'rgba(255,255,255,0.04)'}`;
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
    const d = await res.json(); if (!res.ok) throw new Error(apiErr(d));
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
  if (!isStaff) { showToast('Nur für Staff (Supporter/Moderator+)', 'error'); return; }
  adminOpen = true;
  el('adminPanel').style.display = 'block';
  // Spalten nach Rang einblenden: admin-only nur Admin, ingame-only nur Moderator+.
  // Supporter (Team) sehen Spieler-Verwaltung (Info/Lightning) + Dino-Token-Tools.
  document.querySelectorAll('#adminPanel .admin-only').forEach((c) => { c.style.display = isAdmin ? '' : 'none'; });
  document.querySelectorAll('#adminPanel .ingame-only').forEach((c) => { c.style.display = isIngame ? '' : 'none'; });
  updateInteractive();
  ensureGiftTypeOptions();
  loadAdminUsers();
  if (isIngame) loadAdminRoles();         // Gift-Rollen-Dropdown — nur Moderator+ (Beschenken)
  if (isAdmin) loadDinoLimits();
  if (isIngame) { loadTeleports(); renderAdminTpList(); }
  showAdminTab('tools');
}
// Admin-Panel-Tabs (Tools / Dino-Token / künftige Staff-Chunks)
let adminTab = 'tools';
function showAdminTab(t) {
  const btn = document.querySelector(`#adminTabs [data-atab="${t}"]`);
  if (btn && btn.style.display === 'none') t = 'tools';   // gesperrten Tab → zurück auf Tools
  adminTab = t;
  document.querySelectorAll('#adminTabs [data-atab]').forEach((b) => b.classList.toggle('secondary', b.dataset.atab !== t));
  document.querySelectorAll('#adminPanel .admin-pane').forEach((p) => { p.hidden = p.dataset.pane !== t; });
  if (t === 'dtoken') ensureDtLoaded();
  else if (t === 'pvp') ensurePvpLoaded();
  else if (t === 'account') renderAccount();
  else if (t === 'lootbox') ensureLootboxCfgLoaded();
  else if (t === 'server') renderServer();
  else if (t === 'warn') renderWarnPane();
  else if (t === 'handbuch') renderHandbuch();
  bfScheduleFrameSync && bfScheduleFrameSync();
}

// ── Verwarnungen (Staff) ─────────────────────────────────────────────────────
function renderWarnPane() {
  const box = el('warnBody'); if (!box) return;
  const inp = 'width:100%;box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--input-bg);color:#eee;margin-top:4px';
  box.innerHTML = `
    <div style="font-weight:600;font-size:14px;margin-bottom:4px">⚠️ User verwarnen</div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:8px">Discord- ODER Steam-ID reicht — die andere wird automatisch verknüpft. Die laufende Nummer (1./2./3. …) zählt das System.</div>
    <div style="display:flex;gap:8px">
      <div style="flex:1"><label style="font-size:11px;color:var(--muted)">Discord-ID</label><input id="wnDiscord" placeholder="z. B. 4785…" style="${inp}"></div>
      <div style="flex:1"><label style="font-size:11px;color:var(--muted)">Steam-ID</label><input id="wnSteam" placeholder="7656…" style="${inp}"></div>
    </div>
    <label style="font-size:11px;color:var(--muted);margin-top:8px;display:block">Regel-Paragraph *</label>
    <input id="wnPara" placeholder="z. B. §3.2 Combat-Logging" maxlength="120" style="${inp}">
    <label style="font-size:11px;color:var(--muted);margin-top:8px;display:block">Grund *</label>
    <textarea id="wnReason" rows="3" placeholder="Was ist passiert?" maxlength="1000" style="${inp};resize:vertical"></textarea>
    <button id="wnSubmit" style="width:100%;margin-top:10px">⚠️ Verwarnen</button>
    <hr style="border:none;border-top:1px solid var(--border);margin:16px 0 12px">
    <div style="font-weight:600;font-size:14px;margin-bottom:6px">🔎 Verwarnungen durchsuchen</div>
    <div style="display:flex;gap:8px">
      <input id="wnSearch" placeholder="User-ID / Steam / Grund / Paragraph…" style="${inp};margin-top:0;flex:1">
      <button id="wnSearchBtn" class="secondary" style="width:auto;padding:8px 16px">Suchen</button>
    </div>
    <div id="wnResults" style="margin-top:10px"></div>`;

  el('wnSubmit').onclick = async () => {
    const discordId = el('wnDiscord').value.trim();
    const steamId = el('wnSteam').value.trim();
    const ruleParagraph = el('wnPara').value.trim();
    const reason = el('wnReason').value.trim();
    if (!discordId && !steamId) { showToast('Discord- oder Steam-ID nötig', 'error'); return; }
    if (!ruleParagraph || !reason) { showToast('Paragraph und Grund sind Pflicht', 'error'); return; }
    await apiAction('/admin/warnings', { discordId, steamId, reason, ruleParagraph }, '⚠️ Verwarnung erfasst', () => {
      el('wnDiscord').value = ''; el('wnSteam').value = ''; el('wnPara').value = ''; el('wnReason').value = '';
      warnSearch('');
    });
  };
  el('wnSearchBtn').onclick = () => warnSearch(el('wnSearch').value.trim());
  el('wnSearch').onkeydown = (e) => { if (e.key === 'Enter') warnSearch(el('wnSearch').value.trim()); };
  warnSearch('');
}

async function warnSearch(q) {
  const box = el('wnResults'); if (!box) return;
  box.innerHTML = '<div style="color:var(--muted);font-size:12px">Lade…</div>';
  try {
    const res = await fetch(`${config.tokenBase}/admin/warnings${q ? `?q=${encodeURIComponent(q)}` : ''}`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    const d = await res.json(); if (!res.ok) throw new Error(apiErr(d));
    const items = d.items || [];
    if (!items.length) { box.innerHTML = `<div style="color:var(--muted);font-size:12px">${q ? 'Keine Treffer.' : 'Noch keine Verwarnungen erfasst.'}</div>`; return; }
    box.innerHTML = items.slice(0, 50).map((w) => {
      const who = w.discordId ? `Discord ${w.discordId}` : (w.steamId ? `Steam ${w.steamId}` : '—');
      const dt = w.createdAtMs ? new Date(w.createdAtMs).toLocaleDateString('de-DE') : '';
      const col = w.warnNumber >= 3 ? '#ef4444' : (w.warnNumber === 2 ? '#f97316' : '#f59e0b');
      return `<div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:6px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:600;font-size:13px">${escapeHtml(who)}</span>
          <span style="color:${col};font-weight:700;font-size:12px">${w.warnNumber}. Verwarnung</span>
        </div>
        <div style="font-size:12px;margin-top:3px">📖 ${escapeHtml(w.ruleParagraph || '—')}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">📝 ${escapeHtml(w.reason || '—')}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:3px">${escapeHtml(w.issuedByName || 'Staff')} · ${dt}</div>
      </div>`;
    }).join('');
  } catch (err) { box.innerHTML = `<div style="color:#ef4444;font-size:12px">${escapeHtml(err.message || 'Fehler')}</div>`; }
}

// ── Staff-Handbuch ───────────────────────────────────────────────────────────
// Katalog aller Staff-Funktionen (aus dem echten Code). need = benötigter Rang; angezeigt werden
// nur Funktionen, die der Aufrufer mit seinem Rang wirklich ausführen darf.
const HB_BADGE = { staff: ['Support-Team', '#22c55e'], ingame: ['Moderator+', '#3b82f6'], admin: ['Admin', '#ef4444'], any: ['Staff', '#9aa0a6'] };
function hbCanDo(need) {
  if (need === 'admin') return isAdmin;
  if (need === 'ingame') return isIngame;
  if (need === 'staff') return isTeam;
  return isStaff;
}
const HANDBUCH = [
  // 🦕 Dino-Token
  { id: 'token_create', cat: '🦕 Dino-Token', title: 'Dino-Token geben', need: 'staff',
    where: ['Overlay → Admin → 🦕 Dino-Token', 'Discord → Support-Panel → DINO TOKEN GEBEN'],
    short: 'Kompletten Dino als Garage-Token an einen Spieler vergeben.',
    details: 'Erstellt einen frei konfigurierten Dino und legt ihn als Token in die Garage des Ziel-Spielers. Spezies, Wachstum, Geschlecht, Prime-Bedingungen, Elder-Stacks und alle Mutationen (Base/Parent/Elder) sind wählbar. Ziel per Spieler-Auswahl, SteamID oder ganzer Rolle.',
    steps: ['Ziel wählen (Spieler / SteamID / Rolle)', 'Dino-Spezies wählen', 'Wachstum & Geschlecht', 'Prime-Bedingungen & Elder-Stacks', 'Mutationen wählen', 'Bestätigen'],
    caveat: 'Der Token landet in der Garage — der Spieler spielt ihn selbst auf. Jede Vergabe wird im Audit-Log protokolliert.' },
  { id: 'token_edit', cat: '🦕 Dino-Token', title: 'Dino-Token bearbeiten', need: 'staff',
    where: ['Overlay → Admin → 🦕 Dino-Token', 'Discord → Support-Panel → DINO TOKEN BEARBEITEN'],
    short: 'Vitals, Grow, Prime & Mutationen eines vorhandenen Garage-Tokens ändern.',
    details: 'Öffnet einen bestehenden Garage-Token eines Spielers und passt Wachstum, Geschlecht, Elder-Stacks, Prime-Bedingungen und Mutationen an.', steps: ['Spieler/SteamID wählen', 'Garage-Slot wählen', 'Werte anpassen', 'Speichern'], caveat: '' },
  { id: 'token_delete', cat: '🦕 Dino-Token', title: 'Dino-Token löschen', need: 'staff',
    where: ['Overlay → Admin → 🦕 Dino-Token', 'Discord → Support-Panel → DINO TOKEN LÖSCHEN'],
    short: 'Einen Token aus der Garage eines Spielers entfernen.', details: 'Löscht einen einzelnen Garage-Slot eines Spielers unwiderruflich.', steps: ['Spieler/SteamID wählen', 'Slot wählen', 'Bestätigen'], caveat: 'Unwiderruflich — der eingelagerte Dino ist danach weg.' },
  // 🏆 PvP / Prime
  { id: 'pvp_grant', cat: '🏆 PvP / Prime', title: 'PvP-Build verteilen', need: 'staff',
    where: ['Overlay → Admin → 🏆 PvP / Prime', 'Discord → Support-Panel → PVP-BUILD VERTEILEN'],
    short: 'Vordefinierten Turnier-Dino (100 %, Elder 3×, 16 Mutationen) vergeben.', details: 'Verteilt einen fertig konfigurierten Turnier-Build an einen Spieler, eine SteamID oder eine ganze Rolle — für PvP-Events.', steps: ['Build wählen', 'Ziel wählen (User/SteamID/Rolle)', 'Bestätigen'], caveat: 'Als Garage-Token. Über „PvP-Build entfernen" wieder einsammelbar.' },
  { id: 'pvp_remove', cat: '🏆 PvP / Prime', title: 'PvP-Build entfernen', need: 'staff',
    where: ['Overlay → Admin → 🏆 PvP / Prime', 'Discord → Support-Panel → PVP-BUILD ENTFERNEN'],
    short: 'Alle verteilten Turnier-Builds bei User/SteamID/Rolle wieder einsammeln.', details: 'Entfernt die per „PvP-Build verteilen" vergebenen Turnier-Token wieder aus den Garagen.', steps: ['Ziel wählen', 'Bestätigen'], caveat: '' },
  { id: 'prime', cat: '🏆 PvP / Prime', title: 'Prime-Bedingungen setzen', need: 'staff',
    where: ['Overlay → Admin → 🏆 PvP / Prime', 'Discord → Support-Panel → PRIME CONDITIONS'],
    short: 'Prime-Bedingungen auf dem AKTIVEN Ingame-Dino eines Spielers freischalten.', details: 'Setzt die gewählten Prime-Bedingungen (1–10) direkt auf den Dino, den der Spieler gerade ingame spielt.', steps: ['Spieler wählen', 'Bedingungen anhaken', 'Anwenden'], caveat: 'Der Spieler muss lebend ingame auf einem Dino sein.' },
  // ⚔️ Ingame-Eingriffe
  { id: 'lightning', cat: '⚔️ Ingame-Eingriffe', title: 'Lightning Strike (Slay)', need: 'ingame',
    where: ['Overlay → Admin → 🛠️ Tools', 'Discord → Support-Panel → LIGHTNING STRIKE'],
    short: 'Den aktiven Dino eines Spielers per Blitz töten.', details: 'Tötet den aktuell gespielten Dino eines Spielers (Slay) — z. B. bei Regelverstoß oder Steckenbleiben.', steps: ['Spieler wählen', 'Bestätigen'], caveat: 'Der Dino stirbt. Wird protokolliert.' },
  { id: 'gift', cat: '⚔️ Ingame-Eingriffe', title: 'Beschenken (Punkte/Token)', need: 'ingame',
    where: ['Overlay → Admin → 🛠️ Tools'],
    short: 'Punkte oder Token an einen User oder eine ganze Rolle vergeben.', details: 'Schenkt Punkte oder Inventar-Token (z. B. Grow-Boost, Lootbox) an einzelne Spieler oder alle Mitglieder einer Rolle.', steps: ['Ziel wählen (User/Rolle)', 'Typ & Menge', 'Bestätigen'], caveat: 'Wird protokolliert.' },
  { id: 'wipecorpses', cat: '⚔️ Ingame-Eingriffe', title: 'Leichen-Wipe', need: 'ingame',
    where: ['Overlay → Admin → 📢 Server'],
    short: 'KI-Dinos & Kadaver auf dem Server leeren.', details: 'Räumt herumliegende Kadaver und KI-Dinos ab (Performance/Aufräumen).', steps: ['Im Server-Tab auslösen'], caveat: 'Kann kurz ruckeln, während der Server aufräumt.' },
  // ⚠️ Verwarnungen & Moderation
  { id: 'warn', cat: '⚠️ Verwarnungen & Moderation', title: 'User verwarnen', need: 'staff',
    where: ['Overlay → Admin → ⚠️ Verwarnungen', 'Discord → Support-Panel → VERWARNEN'],
    short: 'Verwarnung mit Grund + Regel-Paragraph erfassen (laufende Nummer automatisch).', details: 'Erfasst eine Verwarnung für einen User. Steam- und Discord-ID werden automatisch verknüpft, die laufende Nummer (1./2./3. …) zählt das System. Jede Verwarnung wird im Doku-Channel als Embed festgehalten.', steps: ['User wählen oder SteamID eingeben', 'Regel-Paragraph angeben', 'Grund angeben', 'Erfassen'], caveat: 'Doku-Channel vorher per /verwarn-channel setzen.' },
  { id: 'warn_search', cat: '⚠️ Verwarnungen & Moderation', title: 'Verwarnungen durchsuchen', need: 'staff',
    where: ['Overlay → Admin → ⚠️ Verwarnungen', 'Discord → Support-Panel → VERWARNUNGEN'],
    short: 'Liste der verwarnten User durchsuchen (User-ID, Steam, Grund, Paragraph).', details: 'Zeigt alle Verwarnungen, filterbar per Suchbegriff — inkl. Anzahl je User, Grund, Paragraph, Aussteller und Datum.', steps: ['Suchbegriff eingeben (leer = neueste)', 'Ergebnisse ansehen'], caveat: '' },
  { id: 'ban', cat: '⚠️ Verwarnungen & Moderation', title: 'Bann / Timeout', need: 'ingame',
    where: ['Discord → Support-/Admin-Panel'],
    short: 'Einen User vom Discord bannen oder timeouten.', details: 'Discord-Moderation: dauerhafter Bann oder temporärer Timeout eines Users. Wird ins Audit-Log geschrieben.', steps: ['User wählen', 'Dauer/Grund', 'Bestätigen'], caveat: 'Discord-seitige Aktion — betrifft nicht den Game-Server.' },
  { id: 'ticket', cat: '⚠️ Verwarnungen & Moderation', title: 'Support-Tickets bearbeiten', need: 'staff',
    where: ['Discord → Ticket-System', 'Overlay → Support (Tickets)'],
    short: 'Tickets übernehmen (claim), übergeben (forward) und schließen.', details: 'Support-Tickets der Spieler bearbeiten: übernehmen, an ein anderes Team-Mitglied übergeben, oder mit Grund schließen (Transcript wird archiviert).', steps: ['Ticket öffnen', 'Übernehmen / Übergeben / Schließen'], caveat: '' },
  // 🖥️ Server & KI
  { id: 'announce', cat: '🖥️ Server & KI', title: 'Ingame-Ankündigung', need: 'staff',
    where: ['Overlay → Admin → 📢 Server', 'Discord → Support-Panel → ANNOUNCEMENT'],
    short: 'Nachricht an alle Spieler ingame senden.', details: 'Sendet einen Broadcast an alle Spieler auf dem Server (z. B. Event-Hinweis, Restart-Warnung).', steps: ['Text eingeben', 'Senden'], caveat: '' },
  { id: 'srv_status', cat: '🖥️ Server & KI', title: 'Server-Status', need: 'staff',
    where: ['Overlay → Admin → 📢 Server'],
    short: 'Aktuellen Server-Status & Spielerzahl ansehen.', details: 'Zeigt, ob der Game-Server läuft, wie viele Spieler online sind usw.', steps: ['Server-Tab öffnen'], caveat: '' },
  { id: 'srv_control', cat: '🖥️ Server & KI', title: 'Server-Steuerung (Start/Stop/Restart)', need: 'admin',
    where: ['Overlay → Admin → 📢 Server'],
    short: 'Den Game-Server starten, stoppen oder neu starten.', details: 'Steuert den Game-Server-Prozess über den control-server. Nur für Admins/Owner.', steps: ['Aktion wählen', 'Bestätigen'], caveat: 'Betrifft ALLE Spieler — Restart trennt jeden. Mit Ankündigung vorwarnen.' },
  { id: 'ai_control', cat: '🖥️ Server & KI', title: 'KI-Dino-Steuerung', need: 'ingame',
    where: ['Overlay → Admin → 📢 Server'],
    short: 'KI-Dino-Dichte / -Spawns steuern.', details: 'Status und Steuerung der KI-Dinos (Dichte, Spawns). Gefährlichere Aktionen sind Admin-beschränkt.', steps: ['KI-Status ansehen', 'Aktion auslösen'], caveat: '' },
  { id: 'dino_limits', cat: '🖥️ Server & KI', title: 'Dino-Limits', need: 'ingame',
    where: ['Overlay → Admin', 'Discord → /dino-limits'],
    short: 'Maximale gleichzeitige Anzahl je Spezies festlegen.', details: 'Setzt Server-weite Caps, wie viele Dinos einer Spezies gleichzeitig gespielt werden dürfen (z. B. Rex-Limit).', steps: ['Spezies-Limit eintragen', 'Speichern'], caveat: 'Greift beim Swappen/Spawnen.' },
  // 👤 Spieler
  { id: 'user_info', cat: '👤 Spieler', title: 'Spieler-Info', need: 'ingame',
    where: ['Overlay → Admin → 🛠️ Tools'],
    short: 'Discord↔Steam, Punkte, Abo-Rang & mehr zu einem Spieler nachschlagen.', details: 'Zeigt die verknüpften IDs, Punktestand, Abo-Rang, Inventar und weitere Infos zu einem Spieler.', steps: ['Spieler/SteamID wählen', 'Infos ansehen'], caveat: '' },
  // 🔗 Accounts (Admin)
  { id: 'accounts_find', cat: '🔗 Accounts', title: 'Account suchen', need: 'admin',
    where: ['Overlay → Admin → 🔗 Accounts'],
    short: 'Discord↔Steam-Verknüpfung eines Users finden.', details: 'Sucht die Verknüpfung eines Accounts (per Discord-, Steam-ID oder Name).', steps: ['Suchbegriff eingeben'], caveat: '' },
  { id: 'accounts_link', cat: '🔗 Accounts', title: 'Account verknüpfen', need: 'admin',
    where: ['Overlay → Admin → 🔗 Accounts'],
    short: 'Discord- und Steam-ID manuell verknüpfen.', details: 'Legt eine Verknüpfung zwischen Discord- und Steam-Account an (falls die automatische Verknüpfung nicht griff).', steps: ['Discord-ID + Steam-ID eingeben', 'Verknüpfen'], caveat: 'Überschreibt eine bestehende Verknüpfung.' },
  { id: 'accounts_unlink', cat: '🔗 Accounts', title: 'Account trennen', need: 'admin',
    where: ['Overlay → Admin → 🔗 Accounts'],
    short: 'Eine Discord↔Steam-Verknüpfung aufheben.', details: 'Trennt die Verknüpfung eines Accounts.', steps: ['Account wählen', 'Trennen'], caveat: '' },
  { id: 'accounts_dups', cat: '🔗 Accounts', title: 'Doppel-Accounts finden', need: 'admin',
    where: ['Overlay → Admin → 🔗 Accounts'],
    short: 'Mehrfach-Verknüpfungen / verdächtige Accounts aufspüren.', details: 'Listet Accounts mit auffälligen Mehrfach-Verknüpfungen (Multi-Account-Verdacht).', steps: ['Liste ansehen'], caveat: '' },
  // 🎁 Wirtschaft
  { id: 'lootbox_config', cat: '🎁 Wirtschaft', title: 'Lootbox-Drop-Gewichte', need: 'admin',
    where: ['Overlay → Admin → 🎁 Lootbox'],
    short: 'Preis & Drop-Wahrscheinlichkeiten der Lootbox einstellen.', details: 'Konfiguriert den Preis pro Lootbox und die Gewichte der einzelnen Belohnungen.', steps: ['Kosten & Gewichte anpassen', 'Speichern'], caveat: 'Betrifft die Wirtschaft — mit Bedacht ändern.' },
];

let hbSearchTerm = '';
function renderHandbuch() {
  const box = el('hbBody'); if (!box) return;
  const inp = 'width:100%;box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--input-bg);color:#eee';
  box.innerHTML = `
    <div style="font-weight:600;font-size:14px;margin-bottom:2px">📖 Staff-Handbuch</div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:8px">Alle Funktionen, die du mit deinem Rang ausführen darfst. Auf eine Funktion klicken für Details.</div>
    <input id="hbSearch" placeholder="🔎 Funktion suchen…" style="${inp}" value="${escapeHtml(hbSearchTerm)}">
    <div id="hbList" style="margin-top:10px"></div>`;
  const s = el('hbSearch');
  s.oninput = () => { hbSearchTerm = s.value; hbRenderList(); };
  hbRenderList();
}
function hbRenderList() {
  const list = el('hbList'); if (!list) return;
  const q = (hbSearchTerm || '').toLowerCase().trim();
  const items = HANDBUCH.filter((f) => hbCanDo(f.need) &&
    (!q || f.title.toLowerCase().includes(q) || f.short.toLowerCase().includes(q) || f.cat.toLowerCase().includes(q)));
  if (!items.length) { list.innerHTML = `<div style="color:var(--muted);font-size:12px">${q ? 'Keine passende Funktion.' : 'Für deinen Rang sind keine Funktionen hinterlegt.'}</div>`; return; }
  const cats = [...new Set(items.map((f) => f.cat))];
  list.innerHTML = cats.map((c) => {
    const rows = items.filter((f) => f.cat === c).map((f) => {
      const [bl, bc] = HB_BADGE[f.need] || HB_BADGE.any;
      return `<button class="hb-item" data-hb="${f.id}" style="width:100%;text-align:left;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:5px;cursor:pointer;color:#eee;display:flex;justify-content:space-between;align-items:center;gap:8px">
        <span style="min-width:0"><span style="font-weight:600;font-size:13px">${escapeHtml(f.title)}</span><br><span style="font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;display:inline-block;max-width:100%">${escapeHtml(f.short)}</span></span>
        <span style="flex:none;font-size:10px;font-weight:700;color:${bc};border:1px solid ${bc};border-radius:6px;padding:2px 6px">${bl}</span>
      </button>`;
    }).join('');
    return `<div style="font-size:12px;font-weight:700;color:var(--muted);margin:10px 0 4px">${escapeHtml(c)}</div>${rows}`;
  }).join('');
  list.querySelectorAll('[data-hb]').forEach((b) => { b.onclick = () => hbDetail(b.dataset.hb); });
}
function hbDetail(id) {
  const f = HANDBUCH.find((x) => x.id === id); if (!f) return;
  const box = el('hbBody'); if (!box) return;
  const [bl, bc] = HB_BADGE[f.need] || HB_BADGE.any;
  const where = (f.where || []).map((w) => `<li style="margin-bottom:2px">${escapeHtml(w)}</li>`).join('');
  const steps = (f.steps || []).map((s) => `<li style="margin-bottom:3px">${escapeHtml(s)}</li>`).join('');
  box.innerHTML = `
    <button id="hbBack" class="secondary" style="width:auto;padding:6px 12px;margin-bottom:10px">← Zurück</button>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <div style="font-weight:700;font-size:16px">${escapeHtml(f.title)}</div>
      <span style="flex:none;font-size:11px;font-weight:700;color:${bc};border:1px solid ${bc};border-radius:6px;padding:2px 8px">${bl}</span>
    </div>
    <div style="font-size:12px;color:var(--muted);margin:8px 0 12px">${escapeHtml(f.cat)}</div>
    <div style="font-size:13px;line-height:1.5;margin-bottom:12px">${escapeHtml(f.details || f.short)}</div>
    <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:3px">📍 Wo</div>
    <ul style="margin:0 0 12px;padding-left:18px;font-size:12px">${where || '<li>—</li>'}</ul>
    ${steps ? `<div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:3px">🪜 Schritte</div><ol style="margin:0 0 12px;padding-left:18px;font-size:12px">${steps}</ol>` : ''}
    ${f.caveat ? `<div style="border-left:3px solid #f59e0b;background:rgba(245,158,11,0.08);border-radius:6px;padding:8px 10px;font-size:12px"><b>⚠️ Hinweis:</b> ${escapeHtml(f.caveat)}</div>` : ''}`;
  el('hbBack').onclick = () => renderHandbuch();
}
function closeAdminPanel() {
  adminOpen = false;
  el('adminPanel').style.display = 'none';
  updateInteractive();
}
// Hotkey „admin-menu": Panel umschalten (nur Admins)
function openAdminMenu() {
  if (!isIngame) { loadTeleports(); return; }
  if (adminOpen) closeAdminPanel(); else openAdminPanel();
}

// ── Dino-Limits (Admin-Editor + globaler Cache fürs Lexikon) ─────────────────
let dinoLimits = {};          // {species: max} — für alle (Lexikon)
let dinoLimitSpecies = [];
let dinoLimitsLoaded = false;
async function fetchDinoLimits() {
  if (!sessionToken) return;
  try {
    const r = await fetch(`${config.tokenBase}/dino-limits`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!r.ok) return;
    const d = await r.json();
    dinoLimits = d.limits || {};
    dinoLimitSpecies = d.species || [];
    dinoLimitsLoaded = true;
  } catch {}
}
async function loadDinoLimits() {            // Admin-Editor
  await fetchDinoLimits();
  const box = el('dinoLimitList'); if (!box) return;
  box.innerHTML = dinoLimitSpecies.map((sp) =>
    `<div class="dlimit-row"><span>${escapeHtml(sp)}</span><input type="number" min="0" data-sp="${escapeHtml(sp)}" value="${dinoLimits[sp] || 0}" class="bf-select"></div>`).join('');
  const btn = el('dinoLimitSave'); if (btn) btn.onclick = () => saveDinoLimits();
}
async function saveDinoLimits() {
  const limits = {};
  document.querySelectorAll('#dinoLimitList input[data-sp]').forEach((inp) => { const v = parseInt(inp.value, 10); if (v > 0) limits[inp.dataset.sp] = v; });
  const res = el('dinoLimitResult'); if (res) res.textContent = 'Speichere…';
  try {
    const r = await fetch(`${config.tokenBase}/admin/dino-limits`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ limits }) });
    const d = await r.json(); if (!r.ok) throw new Error(apiErr(d));
    dinoLimits = d.limits || {};
    if (res) res.textContent = '✅ Gespeichert.';
    showToast('🦖 Dino-Limits gespeichert', 'success');
  } catch (e) { if (res) res.textContent = '⚠️ ' + e.message; showToast(e.message, 'error'); }
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
  { value: 'grow_stop', label: '⏹️ Grow-Stop-Token' },
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
    const d = await res.json(); if (!res.ok) throw new Error(apiErr(d));
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
    const d = await res.json(); if (!res.ok) throw new Error(apiErr(d));
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
    const d = await res.json(); if (!res.ok) throw new Error(apiErr(d));
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
    const d = await res.json(); if (!res.ok) throw new Error(apiErr(d));
    showToast(`📍 TP-Punkt "${name}" erstellt`, 'success');
    el('tpName').value = ''; el('tpPrice').value = ''; el('tpCooldown').value = '';
    await loadTeleports();
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteTp(t) {
  try {
    const res = await fetch(`${config.tokenBase}/teleports/${t.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(apiErr(d)); }
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
    else { const d = await res.json().catch(() => ({})); showToast(apiErr(d, 'Global-Speichern fehlgeschlagen'), 'error'); }
  } catch (e) { showToast(e.message, 'error'); }
}

// ── Kalibrierung (3-Punkt-Klick, affin) ──────────────────────────────────────
function toggleCalib(force) {
  if (!isAdmin) { calibMode = false; el('calibPanel').style.display = 'none'; return; }
  calibMode = force !== undefined ? force : !calibMode;
  el('calibPanel').style.display = calibMode ? 'block' : 'none';
  el('calibBtn').style.background = calibMode ? 'var(--accent)' : 'var(--panel)';
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
      border:1px solid ${isArmed ? 'var(--accent)' : 'var(--border)'};
      background:${isArmed ? 'rgba(var(--accent-rgb),0.2)' : 'transparent'};color:#eee`;
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
  if (!isStaff) return;
  zoneEditMode = force !== undefined ? force : !zoneEditMode;
  el('zonePanel').style.display = zoneEditMode ? 'block' : 'none';
  el('zoneBtn').style.background = zoneEditMode ? 'var(--accent)' : 'var(--panel)';
  if (zoneEditMode) { renderZoneList(); syncZoneName(); updateZoneInfo(); }
}

function getActiveZone() {
  return ZONES.find((z) => z.id === activeZoneId) || null;
}

function selectZone(id) {
  activeZoneId = id;
  syncZoneName();
  renderZoneList();
  updateZoneInfo();
  if (mapOpen) renderBigMap();
}

function syncZoneName() {
  const z = getActiveZone();
  el('zoneName').value = z ? (z.name || '') : '';
}

function createZone(type) {
  const z = newZone(type);
  activeZoneId = z.id;
  zonesDirty = true;
  syncZoneName();
  renderZoneList();
  updateZoneInfo();
  if (mapOpen) renderBigMap();
}

function deleteZone(id) {
  const i = ZONES.findIndex((z) => z.id === id);
  if (i >= 0) ZONES.splice(i, 1);
  zonesDirty = true;
  if (activeZoneId === id) { activeZoneId = null; syncZoneName(); }
  renderZoneList();
  updateZoneInfo();
  if (mapOpen) renderBigMap();
}

// Liste aller Zonen im Panel (farbiger Punkt + Name/Typ + Punktzahl; klicken = wählen, ✕ = löschen)
function renderZoneList() {
  const wrap = el('zoneList');
  if (!wrap) return;
  if (!ZONES.length) {
    wrap.innerHTML = '<div style="color:var(--muted);padding:4px 2px">Noch keine Zonen — Typ wählen und „＋ Neue Zone".</div>';
    return;
  }
  // nach Typ-Reihenfolge sortiert anzeigen
  const order = (t) => { const i = ZONE_TYPES.indexOf(t); return i < 0 ? 99 : i; };
  const sorted = ZONES.slice().sort((a, b) => order(a.type) - order(b.type));
  wrap.innerHTML = '';
  for (const z of sorted) {
    const meta = ZONE_META[z.type] || ZONE_META.pvp;
    const active = z.id === activeZoneId;
    const row = document.createElement('div');
    row.style.cssText = `display:flex;align-items:center;gap:7px;padding:6px 7px;border-radius:6px;cursor:pointer;border:1px solid ${active ? meta.color : 'var(--border)'};background:${active ? meta.color + '22' : 'transparent'}`;
    const dot = document.createElement('span');
    dot.style.cssText = `flex:0 0 auto;width:10px;height:10px;border-radius:50%;background:${meta.color}`;
    const label = document.createElement('span');
    label.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#eee';
    label.textContent = z.name || meta.label;
    const cnt = document.createElement('span');
    cnt.style.cssText = 'flex:0 0 auto;color:var(--muted);font-size:11px';
    cnt.textContent = `${z.points.length}P`;
    const del = document.createElement('span');
    del.style.cssText = 'flex:0 0 auto;color:var(--muted);cursor:pointer;padding:0 2px';
    del.textContent = '✕';
    del.title = 'Zone löschen';
    del.onclick = (e) => { e.stopPropagation(); deleteZone(z.id); };
    row.onclick = () => selectZone(z.id);
    row.append(dot, label, cnt, del);
    wrap.appendChild(row);
  }
}

function updateZoneInfo() {
  const z = getActiveZone();
  if (!z) { el('zoneInfo').textContent = 'Keine Zone gewählt'; return; }
  const meta = ZONE_META[z.type] || ZONE_META.pvp;
  const nm = z.name || meta.label;
  el('zoneInfo').innerHTML = `<b style="color:${meta.color}">${meta.label}</b> · ${nm} · ${z.points.length} Punkt(e) — F6 an jeder Ecke`;
}

// Aktuelle Live-Position als Zonen-Eckpunkt aufnehmen (frische Abfrage für Präzision)
async function captureZonePoint() {
  if (!zoneEditMode) return;
  const z = getActiveZone();
  if (!z) { el('zoneInfo').innerHTML = '<span style="color:#f59e0b">Zuerst eine Zone wählen/anlegen.</span>'; return; }
  try {
    const res = await fetch(`${config.tokenBase}/positions`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!res.ok) return;
    const data = await res.json();
    const meNow = (data.players || []).find((p) => p.isYou);
    if (!meNow) return;
    z.points.push({ x: meNow.x, y: meNow.y });
    zonesDirty = true;
    updateZoneInfo();
    renderZoneList();
    if (mapOpen) renderBigMap();
  } catch {}
}

async function saveZones() {
  try {
    const res = await fetch(`${config.tokenBase}/zones`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ zones: ZONES.map((z) => ({ id: z.id, type: z.type, name: z.name, points: z.points })) }),
    });
    if (res.ok) zonesDirty = false; // gespeichert → Auto-Refresh wieder erlaubt
    el('zoneInfo').innerHTML = res.ok
      ? '<span style="color:#22c55e">✅ Zonen für alle gespeichert!</span>'
      : '<span style="color:#ef4444">❌ Speichern fehlgeschlagen</span>';
  } catch {
    el('zoneInfo').innerHTML = '<span style="color:#ef4444">❌ Server nicht erreichbar</span>';
  }
}

async function loadServerZones() {
  try {
    // GET /zones braucht Auth (RequireActor) → ohne Header 401 = Zonen laden nie.
    const res = await fetch(`${config.tokenBase}/zones`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (res.ok) { const d = await res.json(); setZones(d); zonesDirty = false; }
  } catch {}
  renderZoneList();
  renderBigMap();
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
// Panel-Hotkeys → Dock-Navigation: navTo schließt zuerst alle anderen Panels,
// damit IMMER nur ein Panel offen ist (Hotkey = Navigation, kein Stapeln).
const HK_PANEL_NAV = {
  'map-toggle': 'map', 'settings-toggle': 'settings', 'dino-info': 'dino', 'skin-editor': 'skin',
  'garage': 'garage', 'market': 'market', 'group': 'group', 'profile': 'profile', 'lexikon': 'lexikon',
};
function handleHotkey(action) {
  if (action === 'overlay-mode' || action === 'dock-toggle') return toggleOverlayMode(); // „^"/F5: Dock-Modus, auch off-server
  if (!me) return; // Off-Server: alle anderen Hotkeys blockiert (nur Hinweis sichtbar)
  if (action === 'admin-menu') return openAdminMenu();
  if (HK_PANEL_NAV[action]) return navTo(HK_PANEL_NAV[action]);
  if (action === 'voice-connect') toggleConnect();
  else if (action === 'mic-toggle') toggleMic();
  else if (action === 'zone-capture') captureZonePoint();
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
  'dock-toggle': 'Overlay/Dock öffnen',
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

// Primäre, dauerhaft sichtbare Hotkeys. Der Rest (Panel-Schnellzugriffe) liegt
// standardmäßig leer in einem ausklappbaren Bereich darunter.
const HK_PRIMARY = ['dock-toggle', 'voice-connect', 'mic-toggle', 'range-cycle', 'voice-ptt', 'voice-ptm', 'admin-menu'];
let hkExtrasOpen = false;
async function renderHotkeys() {
  const hk = await window.bf.getHotkeys();
  config.hotkeys = hk;   // lokalen Tasten-Fallback aktuell halten
  const list = el('hotkeyList');
  list.innerHTML = '';
  const buildRow = (action, label) => {
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
    return row;
  };
  // 1) Primäre Hotkeys (immer sichtbar)
  for (const action of HK_PRIMARY) { if (HK_LABELS[action]) list.appendChild(buildRow(action, HK_LABELS[action])); }
  // 2) Panel-Schnellzugriffe (optional, ausklappbar, standardmäßig leer)
  const extras = Object.keys(HK_LABELS).filter((a) => !HK_PRIMARY.includes(a) && a !== 'zone-capture');
  const toggle = document.createElement('button');
  toggle.className = 'secondary';
  toggle.style.cssText = 'width:100%;margin-top:10px;font-size:12px;text-align:left';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-top:6px;' + (hkExtrasOpen ? '' : 'display:none');
  const labelFor = () => `${hkExtrasOpen ? '▾' : '▸'} Panel-Schnellzugriffe (optional — standardmäßig leer)`;
  toggle.textContent = labelFor();
  toggle.onclick = () => { hkExtrasOpen = !hkExtrasOpen; wrap.style.display = hkExtrasOpen ? 'block' : 'none'; toggle.textContent = labelFor(); };
  for (const action of extras) wrap.appendChild(buildRow(action, HK_LABELS[action]));
  list.appendChild(toggle);
  list.appendChild(wrap);
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
  else if (id === 'group') { ovInviteOpen = false; renderGroup(); loadOvGroup(); setChatUnread(0); pollGroupChat(); }
  else if (id === 'profile') { renderProfile(); loadMyTickets(); loadMyEvents(); }
  else if (id === 'lexikon') renderLexikon();
  else if (id === 'skinEditor') renderSkinEditor();
  else if (id === 'quests') { loadQuest(); startQuestPoll(); }
  else if (id === 'lootbox') renderLootbox();
  else if (id === 'support') { renderSupport(); startSupportPoll(); }
  el(id).style.display = 'block';
  updateInteractive();
}
function closeAllFeatures(skipInteractive) {
  ['dinoInfo', 'skinEditor', 'garage', 'market', 'group', 'profile', 'lexikon', 'quests', 'lootbox', 'support'].forEach((id) => { el(id).style.display = 'none'; });
  const tc = el('ticketChat'); if (tc) tc.style.display = 'none';   // Ticket-Chat mit schließen
  stopQuestPoll();
  stopSupportPoll();
  if (featureOpen === 'dinoInfo') stopDinoInfo();
  featureOpen = null;
  if (!skipInteractive) updateInteractive();
}

// ── Gruppen-Ansicht (Mitglieder mit gleicher groupId, Partner + Distanz) ─────
let ovGroupState = { groupId: null, members: [], invites: [] };
// ── Gruppen-Chat (eigener Backend-Relay über token-service) ──────────────────
let groupChat = [];          // aktuell sichtbare Nachrichten der eigenen Gruppe
let chatLastId = 0;          // höchste gesehene Nachrichten-ID
let chatGroupCur = null;     // aktueller Gruppen-Key (Wechsel erkennen)
let chatUnread = 0;          // ungelesene Nachrichten (Zähler am Dock)
// Chat ist nutzbar, sobald man in irgendeiner Gruppe ist (vom Server bestimmt)
function myChatGroup() { return (ovGroupState && ovGroupState.groupId) || (me && me.groupId) || null; }
function renderGroupChat() {
  const box = el('grpChatBox'); if (!box) return;
  if (!groupChat.length) { box.innerHTML = '<div style="color:var(--muted);text-align:center;margin:auto;font-size:11px">Noch keine Nachrichten.</div>'; return; }
  box.innerHTML = groupChat.map((m) => `<div style="${m.own ? 'align-self:flex-end;background:linear-gradient(135deg,var(--accent),var(--accent-d));color:#fff' : 'align-self:flex-start;background:rgba(255,255,255,0.07)'};max-width:86%;padding:5px 9px;border-radius:10px;line-height:1.3">${m.own ? '' : `<b style="color:var(--accent-2);font-size:11px">${escapeHtml(m.name || '?')}</b><br>`}${escapeHtml(m.text)}</div>`).join('');
  box.scrollTop = box.scrollHeight;
}
function setChatUnread(n) {
  chatUnread = Math.max(0, n);
  const btn = document.querySelector('.dock-btn[data-act="group"]'); if (!btn) return;
  let b = btn.querySelector('.chat-badge');
  if (!chatUnread) { if (b) b.remove(); return; }
  if (!b) { b = document.createElement('span'); b.className = 'chat-badge'; btn.appendChild(b); }
  b.textContent = chatUnread > 9 ? '9+' : String(chatUnread);
}
async function pollGroupChat() {
  if (!sessionToken) return;
  let data;
  try {
    const res = await fetch(`${config.tokenBase}/group/chat`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!res.ok) return; data = await res.json();
  } catch { return; }
  const msgs = data.messages || [];
  const groupChanged = data.group !== chatGroupCur;
  chatGroupCur = data.group;
  const panelOpen = featureOpen === 'group';
  if (!groupChanged) {
    const fresh = msgs.filter((m) => m.id > chatLastId && !m.me);
    if (fresh.length && !panelOpen) {
      setChatUnread(chatUnread + fresh.length);
      const last = fresh[fresh.length - 1];
      showToast(`💬 ${last.name || 'Gruppe'}: ${String(last.text).slice(0, 80)}`);
    }
  }
  groupChat = msgs.map((m) => ({ name: m.name, text: m.text, own: !!m.me }));
  chatLastId = msgs.reduce((mx, m) => Math.max(mx, m.id), groupChanged ? 0 : chatLastId);
  if (panelOpen) { renderGroupChat(); setChatUnread(0); }
}
async function sendGroupChat(text) {
  text = (text || '').trim(); if (!text) return;
  if (!myChatGroup()) { showToast('Du bist in keiner Gruppe.', 'error'); return; }
  try {
    const res = await fetch(`${config.tokenBase}/group/chat`, {
      method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const d = await res.json(); if (!res.ok) throw new Error(apiErr(d));
  } catch (e) { showToast(e.message, 'error'); return; }
  pollGroupChat();   // eigene Nachricht sofort nachladen
}
let ovInviteOpen = false;
const ovInviteSeen = new Set();

// Mitglieder-Liste als HTML (+ Anzahl) — getrennt, damit der Live-Update (Polling)
// nur diesen Teil neu zeichnet und das Chat-Eingabefeld unberührt lässt.
function groupMembersHtml() {
  const myG = me && me.groupId;
  let members = players.filter((p) => p.isYou || (myG && p.groupId === myG) || p.ovgroup);
  if (!members.length && me) members = [me];
  members.sort((a, b) => {
    if (a.isYou) return -1; if (b.isYou) return 1;
    if (!me) return 0;
    return Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y);
  });
  let html;
  if (!me) {
    html = '<p>Du bist gerade nicht auf dem Server.</p>';
  } else if (members.length <= 1) {
    html = '<p style="color:var(--muted)">Noch keine Gruppe. Bilde eine im Spiel — oder lade unten Spieler <b>gleicher Diät</b> in eine Overlay-Gruppe ein (auch andere Spezies).</p>';
  } else {
    html = members.map((p) => {
      const you = !!p.isYou;
      const partner = me.partnerSteamId && p.steamId === me.partnerSteamId;
      const grow = p.grow != null ? `${Math.round(p.grow * 100)}%` : '';
      const dist = (!you && me) ? `${Math.round(Math.hypot(p.x - me.x, p.y - me.y) / UNITS_PER_M)} m` : '';
      const tag = you ? ' <span style="color:var(--accent-2)">(Du)</span>' : (partner ? ' 💞' : (p.ovgroup ? ' 🔗' : ''));
      return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 10px;margin-bottom:6px;border-radius:9px;background:${you ? 'rgba(var(--accent-rgb),0.18)' : 'rgba(255,255,255,0.04)'};border:1px solid ${you ? 'var(--accent)' : 'transparent'}">
        <span style="font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p.name || '?')}${tag}</span>
        <span style="color:var(--muted);font-size:12px;flex:none">${escapeHtml(p.dino || '—')}${grow ? ' · ' + grow : ''}</span>
        <span style="color:var(--accent-2);font-size:12px;flex:none;min-width:42px;text-align:right">${dist}</span>
      </div>`;
    }).join('');
  }
  return { html, count: members.length };
}
// Live-Update (Positions-Poll): NUR Mitglieder-Liste + Chat-Nachrichten, NICHT das Panel/Eingabefeld neu bauen
function updateGroupLive() {
  const c = el('grpMembers'); if (!c) return;
  const mem = groupMembersHtml();
  c.innerHTML = mem.html;
  const cnt = el('grpCount'); if (cnt) cnt.textContent = mem.count > 1 ? ` · ${mem.count} Mitglieder` : '';
  renderGroupChat();
}

function renderGroup() {
  const panel = el('group');
  // Chat-Eingabefeld über das (seltene) volle Re-Render retten
  const _ci = el('grpChatInput');
  const _chat = _ci ? { val: _ci.value, focused: document.activeElement === _ci, s: _ci.selectionStart, e: _ci.selectionEnd } : null;
  const mem = groupMembersHtml();
  const body = mem.html;

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

  panel.innerHTML = `<h2>👥 Gruppe <span id="grpCount" style="font-size:13px;color:var(--muted);font-weight:400">${mem.count > 1 ? ` · ${mem.count} Mitglieder` : ''}</span></h2>
    <div id="grpMembers" style="max-height:36vh;overflow:auto">${body}</div>
    ${inv ? `<div class="sec-title" style="margin-top:12px">📨 Einladungen</div>${inv}` : ''}
    <div class="sec-title" style="margin-top:12px">🔗 Overlay-Gruppe <span style="color:var(--muted);font-weight:400;font-size:11px">(gleiche Diät, übers Overlay)</span></div>
    <button id="ovInviteToggle" style="width:100%;margin:6px 0">${ovInviteOpen ? '▲ Einladen schließen' : '➕ Spieler einladen'}</button>
    ${invitable}
    ${ovGroupState.groupId ? '<button id="ovLeave" class="secondary" style="width:100%;margin-top:6px">Overlay-Gruppe verlassen</button>' : ''}
    <div class="sec-title" style="margin-top:12px">💬 Gruppen-Chat</div>
    ${myChatGroup()
      ? `<div id="grpChatBox" style="height:150px;overflow:auto;background:rgba(0,0,0,0.22);border:1px solid var(--border);border-radius:10px;padding:8px;font-size:12px;display:flex;flex-direction:column;gap:5px"></div>
         <div style="display:flex;gap:6px;margin-top:6px">
           <input id="grpChatInput" maxlength="240" placeholder="Nachricht an die Gruppe…" style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--input-bg);color:#eee;box-sizing:border-box">
           <button id="grpChatSend" style="width:auto;padding:8px 14px;flex:none">Senden</button>
         </div>`
      : '<div style="color:var(--muted);font-size:12px">Tritt einer Gruppe bei (im Spiel oder Overlay-Gruppe oben), um zu chatten.</div>'}
    <button class="closeFeature secondary" style="margin-top:12px">Schließen</button>`;
  panel.querySelector('.closeFeature').onclick = () => closeAllFeatures();
  renderGroupChat();
  { const ci = el('grpChatInput'), cs = el('grpChatSend');
    if (cs && ci) cs.onclick = () => { sendGroupChat(ci.value); ci.value = ''; ci.focus(); };
    if (ci) ci.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); sendGroupChat(ci.value); ci.value = ''; } };
    if (_chat && ci) { ci.value = _chat.val; if (_chat.focused) { ci.focus(); try { ci.setSelectionRange(_chat.s, _chat.e); } catch {} } } }
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
    const d = await r.json(); if (!r.ok) throw new Error(apiErr(d));
    showToast('📨 Einladung gesendet', 'success');
    ovInvitable = ovInvitable.filter((p) => p.steamId !== sid); if (featureOpen === 'group') renderGroup();
  } catch (e) { showToast(e.message, 'error'); }
}
async function ovAccept(gid) {
  try {
    const r = await fetch(`${config.tokenBase}/ovgroup/accept`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ gid }) });
    const d = await r.json(); if (!r.ok) throw new Error(apiErr(d));
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
  // Profil zeigt KEINE Dino-Vitals (die stehen im Dino-Tab) — stattdessen Account-/Status-Infos.
  const onlineDino = d.online
    ? `${escapeHtml(d.dino || '?')} · ${d.gender === 'Female' ? '♀' : '♂'} · ${Math.round((d.grow || 0) * 100)}%${tags.length ? ' · ' + tags.join(' · ') : ''}`
    : 'Aktuell nicht im Spiel';
  const inGroup = !!(me && (me.groupId || players.some((p) => p.ovgroup)));
  const qa = questState && questState.active;
  const questLine = qa
    ? (qa.status === 'active' ? '🟢 Läuft' : qa.status === 'rolled' ? '⏳ Bereit zum Start' : qa.status === 'failed' ? '❌ Fehlgeschlagen' : '—')
    : 'Keine aktive Quest';
  const pfStat = (ico, label, val, wide) => `<div class="pf-stat${wide ? ' pf-stat-wide' : ''}"><div class="pf-stat-l">${ico} ${label}</div><div class="pf-stat-v">${val}</div></div>`;
  const avInner = d.avatarUrl
    ? `<img class="pf-av" src="${d.avatarUrl}" alt="">`
    : `<span class="pf-av">🦖</span>`;
  const avatar = `<div class="pf-av-wrap">${avInner}<span class="pf-av-bolt"></span></div>`;
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
        <div class="pf-hero">
          ${avatar}
          <div style="min-width:0">
            <div class="pf-nm">${escapeHtml(d.name || '?')}</div>
            <div style="display:flex;gap:6px;align-items:center;margin-top:5px;flex-wrap:wrap">
              <span class="tier-badge tier-${d.tier || 'Fossil'}">${escapeHtml(d.tier || 'Fossil')}</span>
              <span style="font-size:12px;color:var(--muted)">${d.online ? '🟢 Online' : '⚫ Offline'}</span>
            </div>
          </div>
        </div>
        <div class="pf-stats">
          ${pfStat('💰', 'Punkte', (d.points || 0).toLocaleString('de-DE'))}
          ${pfStat('⏱️', 'Spielzeit', fmtPlaytime(d.playtime))}
          ${pfStat('👥', 'Gruppe', inGroup ? 'In einer Gruppe' : 'Allein')}
          ${pfStat('📜', 'RP-Quest', questLine)}
          ${pfStat('🦖', 'Aktueller Dino', escapeHtml(onlineDino), true)}
        </div>
        <div class="pf-inv">🎟️ Inventar: <b>${escapeHtml(tokenList)}</b></div>
      </div>
      <!-- Rechts: Dinos auf dem Server (aktuelle Zahlen + Limits) -->
      <div class="pf-side">
        <div class="pf-col-head">🦖 Dinos auf dem Server</div>
        <div id="pfServerDinos" class="pf-dino-list">${profileServerDinosHtml()}</div>
      </div>
    </div>`;
  close();
  // Dino-Limits einmalig nachladen, dann die Liste füllen (Tickets sind in den Support-Bereich gewandert)
  if (!dinoLimitsLoaded) fetchDinoLimits().then(() => { if (featureOpen === 'profile') updateProfileServerDinos(); });
  // Events anklickbar → Detail-Modal (Banner, Beschreibung, Ort)
  panel.querySelectorAll('.profileEventRow').forEach((row) => {
    row.onmouseenter = () => { row.style.background = 'rgba(var(--accent-rgb),0.16)'; };
    row.onmouseleave = () => { row.style.background = 'rgba(255,255,255,0.04)'; };
    row.onclick = () => openEventDetail(parseInt(row.dataset.ev));
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
  if (!myEvents.length) return '<div style="color:var(--muted);font-size:12px">Aktuell keine geplanten Events.</div>';
  return myEvents.map((e, i) => `<div class="profileEventRow" data-ev="${i}" style="padding:7px 9px;margin-bottom:5px;background:rgba(255,255,255,0.04);border-radius:8px;cursor:pointer;transition:background .12s">
    <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${e.interested ? '⭐ ' : ''}${escapeHtml(e.name || '?')}</div>
    <div style="font-size:11px;color:var(--accent-2)">🗓️ ${fmtEventTime(e.start)}${e.userCount != null ? ` · ${e.userCount} interessiert` : ''} · Details 📋</div>
  </div>`).join('');
}
// Event-Detail-Modal (Banner, Beschreibung, Ort, Zeit) — nutzt das Ticket-Modal-Muster
function openEventDetail(idx) {
  const e = myEvents[idx]; if (!e) return;
  const modal = ticketChatModal();   // gleiches Modal-Element wiederverwenden
  modal.style.display = 'flex';
  const when = `${fmtEventTime(e.start)}${e.end ? ' – ' + fmtEventTime(e.end) : ''}`;
  modal.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div style="font-weight:700">📅 Event</div>
      <button id="ticketChatClose" class="secondary" style="flex:none;padding:4px 11px;min-width:0">✕</button>
    </div>
    <div style="flex:1;overflow:auto;padding-right:4px">
      ${e.image ? `<img src="${e.image}" alt="" onerror="this.style.display='none'" style="width:100%;max-height:200px;object-fit:cover;border-radius:12px;margin-bottom:12px">` : ''}
      <div style="font-size:17px;font-weight:700;margin-bottom:6px">${e.interested ? '⭐ ' : ''}${escapeHtml(e.name || '?')}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
        <span class="di-mchip">🗓️ ${when}</span>
        ${e.location ? `<span class="di-mchip">📍 ${escapeHtml(e.location)}</span>` : ''}
        ${e.userCount != null ? `<span class="di-mchip">👥 ${e.userCount} interessiert</span>` : ''}
        ${e.interested ? '<span class="di-mchip" style="color:#fcd34d">⭐ Du bist dabei</span>' : ''}
      </div>
      ${e.description ? `<div style="font-size:13px;line-height:1.5;white-space:pre-wrap;color:#ddd">${escapeHtml(e.description)}</div>` : '<div style="color:var(--muted);font-size:13px">Keine Beschreibung.</div>'}
    </div>
    <div style="margin-top:10px;font-size:11px;color:var(--muted)">Interesse bekundest du im Discord (Event-Beitrag).</div>`;
  el('ticketChatClose').onclick = closeTicketChat;
}
function profileTicketsHtml() {
  if (!myTickets.length) return '<div style="color:var(--muted);font-size:12px">Keine offenen Tickets.</div>';
  return myTickets.map((t) => {
    const st = t.status === 'in_bearbeitung' ? `<span style="color:#22c55e">In Bearbeitung${t.handler ? ' · ' + escapeHtml(t.handler) : ''}</span>` : '<span style="color:#f59e0b">Offen</span>';
    const neu = t.lastFromOther ? ' <span style="background:rgba(34,197,94,0.2);color:#86efac;border-radius:5px;padding:1px 6px;font-size:10px">💬 neue Antwort</span>' : '';
    const role = t.role === 'handler' ? ' <span style="background:rgba(var(--accent-rgb),0.25);color:#c4b5fd;border-radius:5px;padding:1px 6px;font-size:10px">🛠️ Du bearbeitest</span>' : '';
    return `<div class="profileTicketRow" data-channel="${escapeHtml(t.channelId)}" data-ticket="${t.ticketId}" data-cat="${escapeHtml(t.category || '')}"
        style="padding:7px 9px;margin-bottom:5px;background:rgba(255,255,255,0.04);border-radius:8px;cursor:pointer;transition:background .12s">
      <div style="font-size:13px;font-weight:600">#${t.ticketId} · ${escapeHtml(t.category || '')}${role}${neu}</div>
      <div style="font-size:11px">${st} <span style="color:var(--muted)">· öffnen 💬</span></div>
    </div>`;
  }).join('');
}
// Rechte Profil-Spalte: aktuelle Spezies-Zahlen auf dem Server vs. ihre Limits.
// Zahlen kommen aus denselben Online-Spielern wie die Karte (`players[].dino`),
// die Limits aus `dinoLimits` (GET /dino-limits). Farbe nach Auslastung.
function profileServerDinosHtml() {
  const counts = {};
  for (const p of players) {
    const sp = ((p && p.dino) || '').split('_')[0];
    if (!sp || sp === '?') continue;
    counts[sp] = (counts[sp] || 0) + 1;
  }
  const roster = dinoLimitSpecies.length ? dinoLimitSpecies : Object.keys(dinoLimits);
  const inRoster = new Set(roster);
  const rows = [];
  for (const sp of roster) {
    const lim = dinoLimits[sp] || 0;
    const cur = counts[sp] || 0;
    if (lim <= 0 && cur <= 0) continue;            // unbegrenzt + keiner da → weglassen
    rows.push({ sp, cur, lim });
  }
  for (const sp of Object.keys(counts)) {           // präsente Spezies ohne Limit-Eintrag (unbegrenzt)
    if (!inRoster.has(sp)) rows.push({ sp, cur: counts[sp], lim: 0 });
  }
  if (!rows.length) return '<div style="color:var(--muted);font-size:12px">Aktuell keine Dinos auf dem Server.</div>';
  rows.sort((a, b) => {
    const al = a.lim > 0, bl = b.lim > 0;
    if (al !== bl) return al ? -1 : 1;              // limitierte zuerst
    if (al && bl) { const r = (b.cur / b.lim) - (a.cur / a.lim); if (r) return r; }   // nach Auslastung
    if (b.cur !== a.cur) return b.cur - a.cur;      // dann nach Anzahl
    return a.sp.localeCompare(b.sp);
  });
  return rows.map(({ sp, cur, lim }) => {
    let val;
    if (lim > 0) {
      const col = cur >= lim ? '#ef4444' : (cur / lim >= 0.8 ? '#f59e0b' : '#22c55e');
      val = `<b style="color:${col}">${cur}</b><span style="color:var(--muted)">/${lim}</span>`;
    } else {
      val = `<b>${cur}</b><span style="color:var(--muted)">/∞</span>`;
    }
    return `<div class="pf-dino-row"><span class="pf-dino-nm">${escapeHtml(sp)}</span><span>${val}</span></div>`;
  }).join('');
}
function updateProfileServerDinos() {
  const box = el('pfServerDinos'); if (box) box.innerHTML = profileServerDinosHtml();
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

  // Ganzen Verlauf anzeigen (inkl. Bot-Nachrichten). Vor der ersten neuen Antwort
  // (= alles nach deiner letzten eigenen Nachricht) eine Trennlinie einziehen.
  let ownIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) { if (messages[i].fromMe) { ownIdx = i; break; } }
  const newFrom = (ownIdx >= 0 && ownIdx < messages.length - 1) ? ownIdx + 1 : -1;

  const bubbles = messages.map((m, i) => {
    const divider = (i === newFrom) ? '<div style="text-align:center;margin:6px 0 10px;font-size:10px;color:#86efac"><span style="background:rgba(34,197,94,0.14);border-radius:999px;padding:2px 10px">💬 Neue Antworten</span></div>' : '';
    const body = escapeHtml(m.content || '') || `<i style="opacity:.6">${m.hasAttachment ? '[Anhang]' : '[leer]'}</i>`;
    if (m.fromBot) {
      return divider + `<div style="margin:8px 0;text-align:center"><div style="display:inline-block;max-width:92%;padding:7px 11px;border-radius:10px;background:rgba(var(--accent-rgb),0.10);border:1px solid var(--border);color:var(--muted);font-size:12px;line-height:1.35">🤖 <b style="color:var(--accent-2)">${escapeHtml(m.author)}</b> · ${body}</div></div>`;
    }
    const mine = m.fromMe;
    return divider + `<div style="display:flex;flex-direction:column;align-items:${mine ? 'flex-end' : 'flex-start'};margin-bottom:9px">
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
    <div id="ticketChatScroll" style="flex:1;overflow:auto;padding-right:4px">${bubbles}</div>
    <div style="margin-top:10px;font-size:11px;color:var(--muted)">Zum Antworten ins Discord-Ticket schreiben.</div>`;
  el('ticketChatClose').onclick = closeTicketChat;
  const sc = el('ticketChatScroll'); if (sc) sc.scrollTop = sc.scrollHeight;   // ans Ende scrollen (neueste sichtbar)
}

// ── 🆘 Support-Panel (Tickets im Overlay, immer synchron mit Discord) ─────────
// Spieler öffnen Hilfe-/Melde-Tickets, schreiben im Overlay; Team kann annehmen,
// schreiben, weiterleiten (Rolle/Person) und schließen (mit Grund). Schreiben geht
// direkt über den token-service in den Discord-Channel; Öffnen/Annehmen/Weiterleiten/
// Schließen läuft über eine Request-Queue, die der Bot-Job abarbeitet.
let supTickets = [];          // Liste der sichtbaren Tickets
let supSel = null;            // ausgewählter channelId
let supCfg = null;            // /me/ticket-config (Kategorien, isStaff, Weiterleit-Ziele)
let supMessages = [];         // Nachrichten des ausgewählten Tickets
let supComposing = false;     // gerade „Neues Ticket"-Formular offen
let supListTimer = null, supMsgTimer = null;

function startSupportPoll() {
  stopSupportPoll();
  supListTimer = setInterval(() => { if (featureOpen === 'support' && !supComposing) loadSupportTickets(); }, 6000);
  supMsgTimer = setInterval(() => { if (featureOpen === 'support' && supSel && !supComposing) loadSupportMessages(); }, 4000);
}
function stopSupportPoll() {
  if (supListTimer) clearInterval(supListTimer); supListTimer = null;
  if (supMsgTimer) clearInterval(supMsgTimer); supMsgTimer = null;
  const m = el('supPicker'); if (m) m.style.display = 'none';
}

async function renderSupport() {
  const panel = el('support');
  panel.classList.add('sup-wide');
  panel.innerHTML = `
    <div class="sup-head">
      <h2 style="margin:0">🆘 Support</h2>
      <div style="display:flex;gap:8px">
        <button id="supNew" style="width:auto;flex:none;padding:8px 14px">➕ Neues Ticket</button>
        <button class="closeFeature secondary" style="width:auto;flex:none;padding:8px 14px">Schließen</button>
      </div>
    </div>
    <div class="sup-body">
      <div id="supTickets" class="sup-list"><div class="sup-empty">Lädt…</div></div>
      <div id="supChat" class="sup-chat"><div class="sup-empty">Wähle links ein Ticket – oder öffne oben ein neues.</div></div>
    </div>`;
  panel.querySelector('.closeFeature').onclick = () => closeAllFeatures();
  el('supNew').onclick = openSupportTicketForm;
  await loadSupportConfig();
  await loadSupportTickets();
  if (supSel && supTickets.some((t) => t.channelId === supSel)) loadSupportMessages();
}

async function loadSupportConfig() {
  if (!sessionToken) return;
  try {
    const r = await fetch(`${config.tokenBase}/me/ticket-config`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (r.ok) supCfg = await r.json();
  } catch {}
}

async function loadSupportTickets() {
  if (!sessionToken) return;
  try {
    const r = await fetch(`${config.tokenBase}/me/tickets`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!r.ok) return;
    supTickets = (await r.json()).tickets || [];
  } catch { return; }
  // Erstmalig gesehene Tickets in die Seen-Map aufnehmen (Toasts macht der globale loadMyTickets-Poll).
  const seen = ticketSeen(); let changed = false;
  for (const t of supTickets) { if (!(t.channelId in seen)) { seen[t.channelId] = t.lastMessageAt || 0; changed = true; } }
  if (changed) setTicketSeen(seen);
  if (featureOpen === 'support' && !supComposing) renderSupTicketList();
}

function supCatLabel(id) { return (supCfg && supCfg.categories && (supCfg.categories.find((c) => c.id === id) || {}).label) || id || ''; }

function renderSupTicketList() {
  const box = el('supTickets'); if (!box) return;
  if (!supTickets.length) { box.innerHTML = '<div class="sup-empty">Keine Tickets.<br>Öffne oben ein neues.</div>'; return; }
  box.innerHTML = supTickets.map((t) => {
    const sel = t.channelId === supSel ? ' sel' : '';
    const inBearb = t.status === 'in_bearbeitung';
    const stCol = inBearb ? '#22c55e' : '#f59e0b';
    const stTxt = inBearb ? `In Bearbeitung${t.handler ? ' · ' + escapeHtml(t.handler) : ''}` : 'Offen';
    const neu = t.lastFromOther ? '<span class="sup-dot"></span>' : '';
    const roleTag = t.role === 'handler' ? '🛠️' : (t.role === 'available' ? '🆕' : '');
    const who = (t.role !== 'opener' && t.openerName) ? ` · von ${escapeHtml(t.openerName)}` : '';
    return `<div class="sup-trow${sel}" data-ch="${escapeHtml(t.channelId)}">
      <div class="sup-trow-top"><b>#${t.ticketId} · ${escapeHtml(supCatLabel(t.category))}</b> ${roleTag}${neu}</div>
      <div class="sup-trow-sub" style="color:${stCol}">${stTxt}${who}</div>
    </div>`;
  }).join('');
  box.querySelectorAll('.sup-trow').forEach((row) => { row.onclick = () => selectSupportTicket(row.dataset.ch); });
}

function selectSupportTicket(channelId) {
  supSel = channelId; supComposing = false; supMessages = [];
  renderSupTicketList();
  loadSupportMessages();
}

async function loadSupportMessages() {
  if (!sessionToken || !supSel) return;
  const chat = el('supChat'); if (chat && !supMessages.length) chat.innerHTML = '<div class="sup-empty">Lädt Nachrichten…</div>';
  try {
    const r = await fetch(`${config.tokenBase}/me/ticket-messages?channelId=${encodeURIComponent(supSel)}`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    supMessages = data.messages || [];
    // Als gesehen markieren (löscht die „neue Antwort"-Markierung in Liste)
    const t = supTickets.find((x) => x.channelId === supSel);
    if (t) { const seen = ticketSeen(); seen[supSel] = t.lastMessageAt || Date.now(); setTicketSeen(seen); if (t.lastFromOther) { t.lastFromOther = false; renderSupTicketList(); } }
    renderSupChat(data);
  } catch {
    if (chat && !supMessages.length) chat.innerHTML = '<div class="sup-empty" style="color:#fca5a5">Nachrichten konnten nicht geladen werden.</div>';
  }
}

function supBubbleHtml(m) {
  const body = escapeHtml(m.content || '') || `<i style="opacity:.6">${m.hasAttachment ? '[Anhang]' : '[leer]'}</i>`;
  if (m.fromBot) {
    return `<div style="margin:8px 0;text-align:center"><div style="display:inline-block;max-width:92%;padding:7px 11px;border-radius:10px;background:rgba(var(--accent-rgb),0.10);border:1px solid var(--border);color:var(--muted);font-size:12px;line-height:1.35">🤖 <b style="color:var(--accent-2)">${escapeHtml(m.author)}</b> · ${body}</div></div>`;
  }
  const mine = m.fromMe;
  return `<div style="display:flex;flex-direction:column;align-items:${mine ? 'flex-end' : 'flex-start'};margin-bottom:9px">
    <div style="font-size:10px;color:var(--muted);margin-bottom:2px">${mine ? 'Du' : escapeHtml(m.author)} · ${fmtEventTime(m.at ? new Date(m.at).toISOString() : '')}</div>
    <div style="max-width:85%;padding:8px 11px;border-radius:12px;font-size:13px;line-height:1.35;${mine
      ? 'background:linear-gradient(135deg,var(--accent),#7c3aed);color:#fff;border-bottom-right-radius:4px'
      : 'background:rgba(255,255,255,0.06);color:#eee;border-bottom-left-radius:4px'}">${body}</div>
  </div>`;
}

function renderSupChat(data) {
  const chat = el('supChat'); if (!chat) return;
  // Entwurf im Eingabefeld über Re-Renders (Polling) hinweg erhalten
  const prev = el('supInput'); const draft = prev ? prev.value : ''; const focused = document.activeElement === prev; const caret = prev ? prev.selectionStart : null;
  const t = supTickets.find((x) => x.channelId === supSel);
  const staff = !!(supCfg && supCfg.isStaff);
  const role = t ? t.role : null;
  const catLabel = supCatLabel((t && t.category) || (data && data.category));
  let actions = '';
  if (staff) {
    if (role === 'available') actions += `<button id="supClaim" style="width:auto;flex:none;padding:6px 12px;font-size:12px">✋ Annehmen</button>`;
    if (role === 'handler' || role === 'available') {
      actions += `<button id="supForward" class="secondary" style="width:auto;flex:none;padding:6px 12px;font-size:12px">↗️ Weiterleiten</button>`;
      actions += `<button id="supClose" class="secondary" style="width:auto;flex:none;padding:6px 12px;font-size:12px">🔒 Schließen</button>`;
    }
  }
  const bubbles = (supMessages || []).map(supBubbleHtml).join('') || '<div class="sup-empty">Noch keine Nachrichten in diesem Ticket.</div>';
  const tid = (data && data.ticketId != null) ? data.ticketId : (t ? t.ticketId : '');
  chat.innerHTML = `
    <div class="sup-chat-head">
      <div><b>🎫 #${tid}</b> <span style="color:var(--muted);font-size:12px">· ${escapeHtml(catLabel)}</span></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">${actions}</div>
    </div>
    <div id="supScroll" class="sup-scroll">${bubbles}</div>
    <div class="sup-compose">
      <input id="supInput" class="tm-input" style="flex:1" placeholder="Nachricht schreiben…" maxlength="1500">
      <button id="supSend" style="width:auto;flex:none;padding:9px 16px">Senden</button>
    </div>`;
  const sc = el('supScroll'); if (sc) sc.scrollTop = sc.scrollHeight;
  const ni = el('supInput'); if (ni) { ni.value = draft; if (focused) { ni.focus(); if (caret != null) { try { ni.setSelectionRange(caret, caret); } catch {} } } }
  el('supSend').onclick = () => sendSupportMsg();
  el('supInput').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendSupportMsg(); } };
  if (el('supClaim')) el('supClaim').onclick = supClaim;
  if (el('supForward')) el('supForward').onclick = supForward;
  if (el('supClose')) el('supClose').onclick = supClose;
}

async function sendSupportMsg() {
  const inp = el('supInput'); if (!inp || !supSel) return;
  const message = inp.value.trim(); if (!message) return;
  inp.value = ''; inp.disabled = true;
  try {
    const r = await fetch(`${config.tokenBase}/me/ticket-send`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId: supSel, message }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { showToast(apiErr(d, 'Senden fehlgeschlagen'), 'error'); inp.value = message; }
    else { await loadSupportMessages(); }
  } catch { showToast('Senden fehlgeschlagen', 'error'); inp.value = message; }
  if (el('supInput')) { el('supInput').disabled = false; el('supInput').focus(); }
}

function openSupportTicketForm() {
  supComposing = true; supSel = null; supMessages = [];
  renderSupTicketList();
  const chat = el('supChat'); if (!chat) return;
  const cats = (supCfg && supCfg.categories) || [{ id: 'help', label: 'Frage / Hilfe', emoji: '❓' }, { id: 'report', label: 'Spieler melden', emoji: '🚨' }];
  let cat = cats[0].id; let known = true;
  chat.innerHTML = `
    <div class="sup-chat-head"><div><b>➕ Neues Ticket</b></div></div>
    <div class="sup-scroll" style="display:block">
      <div class="tm-form" style="max-width:480px">
        <label>Kategorie</label>
        <div id="supCatRow" style="display:flex;gap:8px;flex-wrap:wrap">
          ${cats.map((c, i) => `<button class="sup-cat secondary${i === 0 ? ' on' : ''}" data-cat="${c.id}" style="width:auto;flex:none;padding:8px 14px">${c.emoji || ''} ${escapeHtml(c.label)}</button>`).join('')}
        </div>
        <div id="supReportBox" style="display:none">
          <label>Kennst du den gemeldeten Spieler?</label>
          <div style="display:flex;gap:8px">
            <button id="supKnownYes" class="secondary on" style="width:auto;flex:none;padding:7px 12px">Ja, bekannt</button>
            <button id="supKnownNo" class="secondary" style="width:auto;flex:none;padding:7px 12px">Unbekannt</button>
          </div>
          <label id="supTargetLbl">Name / SteamID des Spielers</label>
          <input id="supTarget" class="tm-input" placeholder="z. B. Spielername oder 7656…" maxlength="100">
        </div>
        <label>Beschreibung</label>
        <textarea id="supDesc" class="tm-input" rows="5" placeholder="Beschreibe dein Anliegen…" maxlength="1500"></textarea>
        <button id="supSubmit" style="margin-top:10px">Ticket erstellen</button>
      </div>
    </div>`;
  const refresh = () => {
    chat.querySelectorAll('.sup-cat').forEach((b) => b.classList.toggle('on', b.dataset.cat === cat));
    el('supReportBox').style.display = cat === 'report' ? 'block' : 'none';
  };
  chat.querySelectorAll('.sup-cat').forEach((b) => { b.onclick = () => { cat = b.dataset.cat; refresh(); }; });
  el('supKnownYes').onclick = () => { known = true; el('supKnownYes').classList.add('on'); el('supKnownNo').classList.remove('on'); el('supTargetLbl').style.display = ''; el('supTarget').style.display = ''; };
  el('supKnownNo').onclick = () => { known = false; el('supKnownNo').classList.add('on'); el('supKnownYes').classList.remove('on'); el('supTargetLbl').style.display = 'none'; el('supTarget').style.display = 'none'; };
  el('supSubmit').onclick = () => submitSupportTicket(cat, () => known);
  refresh();
}

async function submitSupportTicket(category, getKnown) {
  const desc = (el('supDesc') ? el('supDesc').value : '').trim();
  if (!desc) { showToast('Bitte beschreibe dein Anliegen.', 'error'); return; }
  const body = { category, message: desc };
  if (category === 'report') { const known = getKnown(); body.reportKnown = known; body.reportTarget = known ? (el('supTarget') ? el('supTarget').value.trim() : '') : ''; }
  const btn = el('supSubmit'); if (btn) btn.disabled = true;
  try {
    const r = await fetch(`${config.tokenBase}/me/ticket-open`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { showToast(apiErr(d, 'Konnte Ticket nicht öffnen'), 'error'); if (btn) btn.disabled = false; return; }
    showToast('🎫 Ticket wird erstellt…', 'success');
    supComposing = false;
    const chat = el('supChat'); if (chat) chat.innerHTML = '<div class="sup-empty">🎫 Dein Ticket wird angelegt – gleich erscheint es links in der Liste.</div>';
    setTimeout(loadSupportTickets, 1500);
    setTimeout(loadSupportTickets, 4000);
  } catch { showToast('Konnte Ticket nicht öffnen', 'error'); if (btn) btn.disabled = false; }
}

// Team-Aktionen (annehmen/weiterleiten/schließen) → Request-Queue, Bot-Job arbeitet sie ab
async function supAction(path, body, okMsg) {
  try {
    const r = await fetch(`${config.tokenBase}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { showToast(apiErr(d, 'Aktion fehlgeschlagen'), 'error'); return false; }
    if (okMsg) showToast(okMsg, 'success');
    setTimeout(loadSupportTickets, 1500);
    setTimeout(() => { if (supSel && featureOpen === 'support') loadSupportMessages(); }, 1800);
    return true;
  } catch { showToast('Aktion fehlgeschlagen', 'error'); return false; }
}
function supClaim() { if (supSel) supAction('/me/ticket-claim', { channelId: supSel }, '✋ Ticket angenommen'); }

function supModalEl() {
  let m = el('supPicker');
  if (!m) {
    m = document.createElement('div'); m.id = 'supPicker';
    m.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:80;'
      + 'width:clamp(320px,30vw,420px);max-height:70vh;display:none;flex-direction:column;'
      + 'background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:16px;'
      + 'box-shadow:var(--glow-strong);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)';
    document.body.appendChild(m);
  }
  return m;
}
function supCloseModal() { const m = el('supPicker'); if (m) m.style.display = 'none'; updateInteractive(); }

function supForward() {
  if (!supSel || !supCfg) return;
  const m = supModalEl(); m.style.display = 'flex';
  const roles = supCfg.roles || []; const users = supCfg.users || [];
  m.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><b>↗️ Ticket weiterleiten</b><button id="supPkClose" class="secondary" style="width:auto;flex:none;padding:4px 11px">✕</button></div>
    <label style="font-size:11px;color:var(--muted)">An Rolle</label>
    <select id="supFwRole" class="tm-input"><option value="">— Rolle wählen —</option>${roles.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`).join('')}</select>
    <label style="font-size:11px;color:var(--muted);margin-top:8px">oder an Person</label>
    <select id="supFwUser" class="tm-input"><option value="">— Person wählen —</option>${users.map((u) => `<option value="${escapeHtml(u.discordId)}">${escapeHtml(u.name)}</option>`).join('')}</select>
    <button id="supFwGo" style="margin-top:14px">Weiterleiten</button>`;
  el('supPkClose').onclick = supCloseModal;
  el('supFwRole').onchange = () => { if (el('supFwRole').value) el('supFwUser').value = ''; };
  el('supFwUser').onchange = () => { if (el('supFwUser').value) el('supFwRole').value = ''; };
  el('supFwGo').onclick = async () => {
    const roleId = el('supFwRole').value, userId = el('supFwUser').value;
    if (!roleId && !userId) { showToast('Bitte Rolle oder Person wählen', 'error'); return; }
    const ok = await supAction('/me/ticket-forward', userId ? { channelId: supSel, targetType: 'user', targetId: userId } : { channelId: supSel, targetType: 'role', targetId: roleId }, '↗️ Weitergeleitet');
    if (ok) supCloseModal();
  };
  updateInteractive();
}

function supClose() {
  if (!supSel) return;
  const m = supModalEl(); m.style.display = 'flex';
  m.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><b>🔒 Ticket schließen</b><button id="supPkClose" class="secondary" style="width:auto;flex:none;padding:4px 11px">✕</button></div>
    <label style="font-size:11px;color:var(--muted)">Grund (wird im Transcript vermerkt)</label>
    <textarea id="supCloseReason" class="tm-input" rows="4" placeholder="z. B. Anliegen gelöst…" maxlength="500"></textarea>
    <button id="supCloseGo" style="margin-top:14px">Ticket schließen</button>`;
  el('supPkClose').onclick = supCloseModal;
  el('supCloseGo').onclick = async () => {
    const reason = (el('supCloseReason').value || '').trim();
    if (!reason) { showToast('Bitte einen Grund angeben', 'error'); return; }
    const ok = await supAction('/me/ticket-close', { channelId: supSel, reason }, '🔒 Ticket geschlossen');
    if (ok) { supCloseModal(); supSel = null; supMessages = []; const c = el('supChat'); if (c) c.innerHTML = '<div class="sup-empty">Ticket geschlossen.</div>'; setTimeout(loadSupportTickets, 1500); }
  };
  updateInteractive();
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
    const prevId = questState.active && questState.active.id;
    const prevStatus = questState.active && questState.active.status;
    questState = d;
    if (featureOpen !== 'quests' || questRolling) return;
    if (d.justCompleted) { showToast(`🏆 RP-Quest erfüllt! +${(d.reward || 0).toLocaleString('de-DE')} Punkte`, 'success'); pollHud(); renderQuests(); return; }
    // Gleiche Quest UND gleicher Status → nur die Fortschritts-Chips updaten (kein Flackern).
    // Statuswechsel (rolled→active→failed) → voll neu rendern (Buttons ändern sich).
    const sameView = d.active && d.active.id === prevId && d.active.status === prevStatus;
    if (sameView && el('qProgress')) { const p = el('qProgress'); p.outerHTML = questProgressHtml(); }
    else renderQuests();
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
  if (a.status === 'rolled') return `<div class="q-progress" id="qProgress"><span class="q-chip no">⏳ Quest-Fortschritt: nicht gestartet</span></div>`;
  if (a.status === 'failed') return `<div class="q-progress" id="qProgress"><span class="q-chip no" style="color:#fca5a5">❌ Quest fehlgeschlagen — versuch es erneut</span></div>`;
  const target = Math.round((questState.growTarget || 0.8) * 100);
  let chips;
  if (a.instaUsed) {
    chips = `<span class="q-chip no">⚡ Insta-Grow benutzt — zählt nicht mehr</span>`;
  } else if (p && p.dead) {
    chips = `<span class="q-chip no" style="color:#fca5a5">💀 Gestorben…</span>`;
  } else if (!p || !p.online) {
    chips = `<span class="q-chip no">Nicht im Spiel</span>`;
  } else {
    const dinoOk = p.rightDino;
    const growOk = (p.grow || 0) >= (questState.growTarget || 0.8);
    chips = `<span class="q-chip ${dinoOk ? 'ok' : 'no'}">${dinoOk ? '✅' : '🦖'} ${dinoOk ? 'Richtiger Dino' : 'Spiele ' + escapeHtml(a.dinoName || a.dino)}</span>`
      + `<span class="q-chip ${growOk ? 'ok' : 'no'}">📈 ${Math.round((p.grow || 0) * 100)}% / ${target}%</span>`
      + `<span class="q-chip ${p.isPrime ? 'ok' : 'no'}">${p.isPrime ? '⭐' : '☆'} Prime</span>`;
  }
  return `<div class="q-progress" id="qProgress">${chips}</div>`;
}
function questStageHtml() {
  const a = questState.active;
  if (a) {
    const lines = questLinesHtml(a).replace(/class="q-line"/g, 'class="q-line show"');
    const target = Math.round((questState.growTarget || 0.8) * 100);
    const reward = `<div style="font-size:12px;color:#fbbf24;font-weight:700;margin-top:6px">🏆 Belohnung: ${(questState.reward || 0).toLocaleString('de-DE')} Punkte</div>`;
    if (a.status === 'rolled') {
      return `<div style="font-size:12px;color:var(--accent-2);font-weight:700;margin-bottom:6px">DEINE QUEST</div>` + lines
        + questProgressHtml() + reward
        + `<div style="font-size:11px;color:var(--muted);margin-top:10px">Beim Start wird dein aktueller Dino <b>eingeparkt</b> und du startest als <b>${escapeHtml(a.dinoName || a.dino)}</b>-Juvi (25%). Ziel: <b>Prime + ${target}%</b>.</div>`
        + `<div style="display:flex;gap:8px;margin-top:12px"><button id="qStart" style="flex:1">🚀 Quest starten</button><button id="qAbandon" class="secondary" style="flex:none">Aufgeben</button></div>`;
    }
    if (a.status === 'failed') {
      return `<div style="font-size:12px;color:#fca5a5;font-weight:700;margin-bottom:6px">QUEST FEHLGESCHLAGEN</div>` + lines
        + questProgressHtml() + reward
        + `<div style="display:flex;gap:8px;margin-top:12px"><button id="qStart" style="flex:1">🔄 Quest neu starten</button><button id="qAbandon" class="secondary" style="flex:none">Aufgeben</button></div>`;
    }
    // status === 'active' (gestartet)
    return `<div style="font-size:12px;color:var(--accent-2);font-weight:700;margin-bottom:6px">AKTIVE QUEST · LÄUFT</div>` + lines
      + questProgressHtml()
      + `<div style="font-size:11px;color:var(--muted);margin-top:12px">Ziel: Mit <b>${escapeHtml(a.dinoName || a.dino)}</b> <b>Prime</b> + <b>${target}%</b> erreichen — Insta-Grow zählt nicht.</div>`
      + reward
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
    <div style="color:var(--muted);font-size:13px;margin:8px 0 6px">Würfle eine RP-Challenge: ein Dino, ein Handicap, eine RP-Rolle und eine Kleinigkeit.</div>
    <div style="color:#fbbf24;font-size:12px;font-weight:700;margin-bottom:14px">🏆 Belohnung bei Erfüllung: ${(questState.reward || 0).toLocaleString('de-DE')} Punkte</div>
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
  const start = el('qStart'); if (start) start.onclick = () => startQuest(start);
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
    if (!r.ok) err = apiErr(d); else result = d;
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
async function startQuest(btn) {
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Wird gestartet…'; }
  try {
    const r = await fetch(`${config.tokenBase}/me/quest/start`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    const d = await r.json();
    if (!r.ok) { showToast(apiErr(d, 'Start fehlgeschlagen'), 'error'); if (btn) { btn.disabled = false; renderQuests(); } return; }
    questState.active = d.active;
    showToast('🚀 Quest gestartet! Wachse als Quest-Dino auf Prime + 80%.', 'success');
    renderQuests();
  } catch { showToast('Verbindungsfehler', 'error'); if (btn) btn.disabled = false; }
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

// Lexikon-Reihenfolge (für „Durchblättern"): nach Diät, dann alphabetisch
const LEX_ORDER = ['carni', 'herbi', 'both'];
function lexOrderedNames() {
  return LEX_ORDER.flatMap((diet) => Object.keys(DINO_LEXIKON).filter((n) => DINO_LEXIKON[n].diet === diet).sort());
}
function renderLexikon() {
  const panel = el('lexikon');
  panel.classList.add('lex-wide');
  if (!dinoLimitsLoaded) fetchDinoLimits().then(() => { if (featureOpen === 'lexikon') renderLexikon(); });

  if (lexSel && DINO_LEXIKON[lexSel]) {
    const d = DINO_LEXIKON[lexSel];
    const lim = dinoLimits[lexSel];
    const limitHtml = `<div style="font-size:13px;margin-bottom:10px">🦖 <b>Server-Limit:</b> ${lim ? `max. ${lim} gleichzeitig` : '<span style="color:var(--muted)">unbegrenzt</span>'}</div>`;
    const li = (arr, col) => arr.map((s) => `<li style="color:${col}">${escapeHtml(s)}</li>`).join('');
    const ord = lexOrderedNames();
    const idx = ord.indexOf(lexSel);
    const prev = ord[(idx - 1 + ord.length) % ord.length];
    const next = ord[(idx + 1) % ord.length];
    panel.innerHTML = `<h2>📖 ${escapeHtml(lexSel)} <span style="font-size:12px;color:var(--muted);font-weight:400">· ${idx + 1}/${ord.length}</span></h2>
      <img src="assets/dinos/${encodeURIComponent(lexSel)}.png" alt="" onerror="this.style.display='none'" style="display:block;width:100%;max-height:200px;object-fit:contain;border-radius:10px;background:rgba(0,0,0,0.25);margin-bottom:10px">
      <div style="font-size:13px;margin-bottom:10px"><span style="color:${DIET_DOT[d.diet]}">●</span> ${DIET_LABEL[d.diet]} · <b>${escapeHtml(d.role)}</b> · Wachstum: ${escapeHtml(d.growth)}</div>
      ${limitHtml}
      <div style="display:flex;gap:18px;flex-wrap:wrap">
        <div style="flex:1;min-width:180px"><div style="font-weight:600;color:#22c55e;margin-bottom:4px">Stärken</div><ul style="margin:0 0 0 16px;font-size:13px;line-height:1.6">${li(d.strengths, '#cbd5b0')}</ul></div>
        <div style="flex:1;min-width:180px"><div style="font-weight:600;color:#ef4444;margin-bottom:4px">Schwächen</div><ul style="margin:0 0 0 16px;font-size:13px;line-height:1.6">${li(d.weaknesses, '#e4b8b8')}</ul></div>
      </div>
      <div style="margin-top:12px;padding:9px 11px;background:rgba(var(--accent-rgb),0.12);border:1px solid var(--border);border-radius:8px;font-size:13px">💡 ${escapeHtml(d.tip)}</div>
      ${d.fact ? `<div style="margin-top:10px;padding:9px 11px;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:8px;font-size:13px;line-height:1.55"><b style="color:var(--accent-2)">📚 Wissenswert</b><br>${escapeHtml(d.fact)}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:14px;align-items:center">
        <button id="lexPrev" class="secondary" style="flex:1">← ${escapeHtml(prev)}</button>
        <button id="lexBack" class="secondary" style="flex:none;width:auto;padding:9px 16px">☰ Übersicht</button>
        <button id="lexNext" style="flex:1">${escapeHtml(next)} →</button>
      </div>`;
    panel.querySelector('#lexBack').onclick = () => { lexSel = null; renderLexikon(); };
    panel.querySelector('#lexPrev').onclick = () => { lexSel = prev; renderLexikon(); };
    panel.querySelector('#lexNext').onclick = () => { lexSel = next; renderLexikon(); };
    return;
  }

  // Übersicht: 3 Spalten nach Diät getrennt (Karni / Herbi / Omni)
  const colHtml = (diet) => {
    const group = Object.keys(DINO_LEXIKON).filter((n) => DINO_LEXIKON[n].diet === diet).sort();
    const items = group.map((n) => `<button class="lexItem secondary" data-dino="${n}" style="display:flex;align-items:center;gap:8px;width:100%;margin-bottom:5px;text-align:left;padding:6px 8px">
        <img src="assets/dinos/${encodeURIComponent(n)}.png" alt="" onerror="this.style.visibility='hidden'" style="width:30px;height:30px;border-radius:6px;object-fit:cover;background:rgba(0,0,0,0.25);flex:none">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px">${escapeHtml(n)}</span></button>`).join('') || '<div style="color:var(--muted);font-size:12px">—</div>';
    return `<div class="lex-col">
      <div class="lex-col-head" style="color:${DIET_DOT[diet]}">● ${DIET_LABEL[diet]} <span style="color:var(--muted);font-weight:400">(${group.length})</span></div>
      <div class="lex-col-list">${items}</div>
    </div>`;
  };
  const total = Object.keys(DINO_LEXIKON).length;
  panel.innerHTML = `<h2>📖 Dino-Lexikon <span style="font-size:13px;color:var(--muted);font-weight:400">· ${total} Spezies</span></h2>
    <div class="lex-cols">${LEX_ORDER.map(colHtml).join('')}</div>`;
  panel.querySelectorAll('.lexItem').forEach((b) => { b.onclick = () => { lexSel = b.dataset.dino; renderLexikon(); }; });
}

// ── Elder / Prime-Bedingungen ────────────────────────────────────────────────
const PRIME_LABELS = [
  'Sanctuary als Juvenile besucht',
  'Genested (in ein Nest gelegt)',
  'Perfekte Ernährung',
  'Mass-Migration-Zone besucht',
  '2 Migrations-Zonen besucht',
  '4 Patrol-Zonen besucht',
  'Nie unfruchtbar',
  'Keine Muskelkrämpfe',
  'Kinder zu Subadult großgezogen',
  'Spezies-Bonus',
];
// Bedingungen, die das Spiel automatisch erfüllt (kein aktives Zutun nötig) → als „auto" markiert.
const PRIME_AUTO = new Set([6, 7, 9]);
// Zwischenschritt-Hinweise pro Bedingung (da echte Teil-Zähler nicht in den Daten stehen).
const PRIME_HINT = { 2: '1% je Makronährstoff', 4: '2 verschiedene Zonen', 5: '4 verschiedene Zonen' };
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
  const need = 5;
  const met = p.filter(Boolean).length;
  const done = met >= need;
  const pct = Math.min(100, Math.round(met / need * 100));
  const head = `
    <div class="di-prime-head">
      <span class="di-prime-title" style="color:${done ? '#22c55e' : 'var(--text)'}">${done ? '👑 Prime erreicht!' : 'Prime-Fortschritt'}</span>
      <span class="di-prime-count" style="color:${done ? '#22c55e' : 'var(--muted)'}">${met}/${need}${done ? '' : ` · noch ${need - met}`}</span>
    </div>
    <div class="di-prime-bar"><div class="di-prime-fill" style="width:${pct}%;background:${done ? '#22c55e' : 'var(--accent)'}"></div></div>`;
  const rows = p.map((v, i) => {
    const hint = PRIME_HINT[i] ? `<span class="di-prime-hint">${PRIME_HINT[i]}</span>` : '';
    const auto = PRIME_AUTO.has(i) ? `<span class="di-prime-auto">auto</span>` : '';
    return `<div class="di-prime-row${v ? ' is-done' : ''}"><span class="di-prime-ic">${v ? '✅' : '⬜'}</span><span class="di-prime-lbl">${PRIME_LABELS[i]}${auto}${hint}</span></div>`;
  }).join('');
  return head + `<div class="di-prime-list">${rows}</div>`;
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
    <div class="di-topbar">
      <div class="di-imgwrap"><img id="di-img" alt="" onerror="this.style.visibility='hidden'"></div>
      <div style="flex:1;min-width:0">
        <div class="di-head"><span class="di-dino" id="di-dino">Dino</span><span class="di-sub" id="di-grow"></span></div>
        <div class="di-sub" id="di-name"></div>
        <div class="di-actions">
          <button id="diEntombBtn" class="di-btn di-entomb" title="Dino entomben">⚰️ Entomben</button>
          <button id="diSlayBtn" class="di-btn di-slay-btn" title="Aktuellen Dino töten">💀 Slay</button>
        </div>
        <div style="margin-top:10px">
          <div class="stat-top"><span>🌱 Wachstum</span><span class="val" id="di-grow-v">—</span></div>
          <div class="stat-track" style="height:11px"><div class="stat-fill" id="di-grow-f" style="background:#84cc16"></div></div>
        </div>
      </div>
    </div>
    <div class="di-main">
      <div class="di-elder-col">
        <div class="sec-title">⏳ Elder-Fortschritt</div>
        <div id="di-elder" style="margin:6px 0"></div>
      </div>
      <div class="di-vitals-col">
        <div class="sec-title">📊 Vitals &amp; Token <span style="color:var(--muted);font-weight:400;font-size:11px">— Token rechts neben dem Balken einlösen</span></div>
        ${rows}
        <div class="sec-title" style="margin-top:16px">🧬 Mutationen</div>
        <div id="di-mut" class="mut-tbl-wrap" style="margin:6px 0"></div>
      </div>
    </div>
    <div id="diGrowDock" class="di-grow-dock">
      <div id="diGrowTab" class="di-grow-tab">📈 Grow-Boosts <span class="gd-caret" id="diGrowCaret">▶</span></div>
      <div class="di-grow-panel"><div class="di-grow-inner">
        <div class="sec-title" style="margin-bottom:8px">📈 Grow-Token</div>
        <div id="diGrowList"><div style="font-size:12px;color:var(--muted)">Lade…</div></div>
      </div></div>
    </div>`;
  { const gt = el('diGrowTab'); if (gt) gt.onclick = () => {
      const dock = el('diGrowDock'); const open = dock.classList.toggle('open');
      const c = el('diGrowCaret'); if (c) c.textContent = open ? '◀' : '▶';
      bfScheduleFrameSync && bfScheduleFrameSync();
    }; }
  tokenConfirmOpen = false; // frisch öffnen → keine hängende Bestätigungs-Sperre
  { const sb = el('diSlayBtn'); if (sb) sb.onclick = () => bfConfirm({
      title: '💀 Dino töten?', danger: true, confirmLabel: 'Ja, töten',
      body: 'Dein <b>aktueller Dino</b> wird sofort getötet (Lightning Strike). Das kann nicht rückgängig gemacht werden.',
      onConfirm: slayMyDino }); }
  { const eb = el('diEntombBtn'); if (eb) eb.onclick = () => bfConfirm({
      title: '⚰️ Dino entomben?', confirmLabel: 'Ja, entomben',
      body: 'Dein <b>aktueller Dino</b> wird entombt (Entomb).',
      onConfirm: entombMyDino }); }
  updateDinoInfo();
  if (dinoTimer) clearInterval(dinoTimer);
  dinoTimer = setInterval(updateDinoInfo, 2000);
}
// Bestätigungs-Popup (generisch, zentriert) — auch für andere destruktive Aktionen nutzbar
function bfConfirm(opts) {
  const ov = document.createElement('div'); ov.className = 'bf-confirm-ov';
  ov.innerHTML = `<div class="bf-confirm">
    <div class="bf-confirm-t">${opts.title || 'Bestätigen?'}</div>
    ${opts.body ? `<div class="bf-confirm-b">${opts.body}</div>` : ''}
    <div class="bf-confirm-btns">
      <button class="secondary bf-c-no">Abbrechen</button>
      <button class="bf-c-yes${opts.danger ? ' bf-danger' : ''}">${opts.confirmLabel || 'Bestätigen'}</button>
    </div></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('.bf-c-no').onclick = close;
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('.bf-c-yes').onclick = () => { close(); opts.onConfirm && opts.onConfirm(); };
}
async function slayMyDino() {
  try {
    const res = await fetch(`${config.tokenBase}/me/slay`, {
      method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` },
    });
    const d = await res.json(); if (!res.ok) throw new Error(apiErr(d));
    showToast('💀 Dein Dino wurde getötet.', 'success');
  } catch (e) { showToast(e.message || 'Slay fehlgeschlagen', 'error'); }
}
async function entombMyDino() {
  try {
    const res = await fetch(`${config.tokenBase}/me/entomb`, {
      method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` },
    });
    const d = await res.json(); if (!res.ok) throw new Error(apiErr(d));
    showToast('⚰️ Dein Dino wird entombt.', 'success');
  } catch (e) { showToast(e.message || 'Entomben fehlgeschlagen', 'error'); }
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
  wrap.style.cssText = 'padding:7px;border:1px solid var(--accent);border-radius:8px;background:rgba(var(--accent-rgb),0.14)';
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
    const d = await res.json(); if (!res.ok) throw new Error(apiErr(d));
    showToast(`${emoji} ${label} eingelöst!`, 'success');
  } catch (e) { showToast(e.message, 'error'); }
  updateDinoInfo();
}

function stopDinoInfo() { if (dinoTimer) { clearInterval(dinoTimer); dinoTimer = null; } }

// ── Lootbox (Slot-Machine) + Grow-Token (Seitenmenü am Dino-Tab) ─────────────
const LB_TOKEN_META = {
  hunger: ['🍖', 'Hunger'], thirst: ['💧', 'Durst'], protein: ['🥩', 'Protein'],
  carbs: ['🌿', 'Carbs'], lipid: ['🥑', 'Lipid'], heal: ['❤️', 'Heal'],
  grow_boost: ['📈', 'Grow-Boost'], grow_stop: ['⏹️', 'Grow-Stop'], insta_grow: ['⚡', 'Insta-Grow'],
};
function lbTok(id) { return LB_TOKEN_META[id] || ['🎁', id]; }
const LB_SPIN = Object.values(LB_TOKEN_META).map((x) => x[0]); // Emoji-Pool für die drehenden Walzen
const lbSleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Grow-Token (keine Vital-Bar) → ausklappbares Seitenmenü am Dino-Tab.
const GROW_REDEEM = [
  { id: 'grow_boost', desc: 'Beschleunigt dein Wachstum ~1 Stunde lang (+~20 % pro Stunde aktiver Spielzeit). Pausiert in der PvE-Zone.' },
  { id: 'grow_stop', desc: 'Stoppt dein Wachstum 1 Stunde lang auf einer Wunsch-Prozentzahl.' },
  { id: 'insta_grow', desc: 'Setzt dein Wachstum sofort auf 80 % (du musst lebend im Spiel sein).' },
];
let lbOpening = false;
let lbCurGrowPct = 0;
let lbCost = 0;
let growPickOpen = false; // Grow-Stop-Slider offen → 2s-Refresh nicht überschreiben

// ── Lootbox-Panel (Dock) ─────────────────────────────────────────────────────
function renderLootbox() {
  const panel = el('lootbox');
  panel.innerHTML = `<h2>🎁 Lootbox</h2>
    <div id="lbBox"><div style="color:var(--muted);font-size:13px">Lade…</div></div>
    <button class="closeFeature secondary" style="width:100%;margin-top:14px">Schließen</button>`;
  panel.querySelector('.closeFeature').onclick = () => closeAllFeatures();
  loadLootbox();
}

async function loadLootbox() {
  try {
    const lb = await fetch(`${config.tokenBase}/lootbox`, { headers: { Authorization: `Bearer ${sessionToken}` } }).then((r) => r.json());
    renderLootboxBox(lb);
  } catch (e) {
    const b = el('lbBox'); if (b) b.innerHTML = '<div style="color:#ef4444;font-size:13px">Lootbox konnte nicht geladen werden.</div>';
  }
}

function renderLootboxBox(lb) {
  const box = el('lbBox'); if (!box) return;
  lbCost = lb.cost || 0;
  const chances = (lb.chances || []).map((c) => { const [e, l] = lbTok(c.id); return `<div><span>${e} ${l}</span><span style="color:var(--muted)">${(c.pct || 0).toFixed(1)} %</span></div>`; }).join('');
  box.innerHTML = `
    <div class="lb-hero"><div class="lb-box">🎁</div></div>
    <div class="lb-chips" id="lbChips"></div>
    <div class="lb-slot"><div class="lb-reel" id="lbR0">❔</div><div class="lb-reel" id="lbR1">❔</div><div class="lb-reel" id="lbR2">❔</div></div>
    <div id="lbResult"></div>
    <button id="lbOpenBtn" style="width:100%;margin-top:8px"></button>
    <details style="margin-top:12px"><summary style="cursor:pointer;font-size:12px;color:var(--muted);user-select:none">🎲 Drop-Chancen anzeigen</summary>
      <div class="lb-chance-grid" style="margin-top:8px">${chances}</div>
    </details>`;
  const btn = el('lbOpenBtn'); if (btn) btn.onclick = () => openLootbox();
  updateLbAvail(lb.points, lb.freeBoxes);
}

// Punkte-/Gratis-Box-Chips + Öffnen-Button aktualisieren, OHNE die Walzen neu zu bauen.
function updateLbAvail(pts, free) {
  pts = pts || 0; free = free || 0;
  const chips = el('lbChips');
  if (chips) chips.innerHTML = `<span class="lb-chip">💰 ${pts.toLocaleString('de-DE')} Pkt.</span>${free > 0 ? `<span class="lb-chip free">🎁 ${free} Gratis-Box${free > 1 ? 'en' : ''}</span>` : ''}`;
  const btn = el('lbOpenBtn');
  if (btn) {
    const canOpen = free > 0 || pts >= lbCost;
    btn.disabled = !canOpen || lbOpening;
    btn.textContent = free > 0 ? `🎁 Gratis-Box öffnen (${free} übrig)` : (canOpen ? `🎁 Box öffnen — ${lbCost.toLocaleString('de-DE')} Pkt.` : `🎁 Box — ${lbCost.toLocaleString('de-DE')} Pkt. (zu wenig Punkte)`);
  }
}

function lbLockReel(reel, emoji, jackpot) {
  if (!reel) return;
  reel.dataset.locked = '1';
  reel.textContent = emoji;
  reel.classList.remove('spin');
  reel.classList.add('locked');
  if (jackpot) reel.classList.add('jackpot');
}

async function openLootbox() {
  if (lbOpening) return; lbOpening = true;
  const btn = el('lbOpenBtn'); if (btn) { btn.disabled = true; btn.textContent = '🎰 Dreht…'; }
  const res = el('lbResult'); if (res) res.innerHTML = '';
  const reels = [el('lbR0'), el('lbR1'), el('lbR2')].filter(Boolean);
  reels.forEach((r) => { r.classList.remove('locked', 'jackpot'); r.dataset.locked = ''; r.classList.add('spin'); });
  const spin = setInterval(() => { reels.forEach((r) => { if (!r.dataset.locked) r.textContent = LB_SPIN[Math.floor(Math.random() * LB_SPIN.length)]; }); }, 70);

  let d = null, err = null;
  try {
    const r = await fetch(`${config.tokenBase}/lootbox/open`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: '{}' });
    d = await r.json(); if (!r.ok) throw new Error(apiErr(d));
  } catch (e) { err = e; }
  await lbSleep(750); // Mindest-Spin für Spannung

  if (err || !d) {
    clearInterval(spin);
    reels.forEach((r) => { r.classList.remove('spin'); r.textContent = '❔'; });
    lbOpening = false;
    showToast((err && err.message) || 'Lootbox fehlgeschlagen', 'error');
    updateLbAvail(0, 0); loadLootbox(); // Button-Zustand zurücksetzen
    return;
  }

  const jackpot = d.outcome === 'jackpot';
  for (const idx of [0, 2, 1]) { // links, rechts, dann mitte einrasten
    lbLockReel(reels[idx], lbTok((d.reels || [])[idx])[0], jackpot);
    await lbSleep(480);
  }
  clearInterval(spin);

  const [e, l] = lbTok(d.reward);
  if (res) res.innerHTML = `<div class="lb-result${jackpot ? ' jackpot' : ''}"><div style="font-size:15px">${jackpot ? '🎉 JACKPOT! ' : ''}${e} <b>${d.count}× ${l}</b> gewonnen!</div></div>`;
  showToast(`${e} ${d.count}× ${l} gewonnen!`, 'success');
  if (typeof d.points === 'number') setPointsHud(d.points);
  lbOpening = false;
  updateLbAvail(d.points, d.freeBoxes);
}

// ── Grow-Token-Seitenmenü (am Dino-Tab, gefüllt aus updateDinoInfo) ───────────
function renderDiGrow(tokens) {
  const list = el('diGrowList'); if (!list) return;
  if (growPickOpen) return; // Slider/Picker offen → nicht überschreiben
  const offline = tokens === null;
  tokens = tokens || {};
  // IMMER alle drei Grow-Aktionen zeigen (auch mit 0 → damit Grow-Stop sichtbar/entdeckbar ist).
  list.innerHTML = GROW_REDEEM.map((g) => {
    const [e, l] = lbTok(g.id); const n = tokens[g.id] || 0;
    const action = offline
      ? '<span style="font-size:10px;color:var(--muted)">offline</span>'
      : (n > 0 ? `<button data-grow="${g.id}">Einlösen</button>` : '<span style="font-size:10px;color:var(--muted)">🎁 aus Lootbox</span>');
    return `<div class="di-grow-card"${n > 0 ? '' : ' style="opacity:.6"'}><div class="gc-head"><b>${e} ${l} ×${n}</b>${action}</div><div class="gc-desc">${g.desc}</div></div>`;
  }).join('');
  list.querySelectorAll('[data-grow]').forEach((b) => { b.onclick = () => redeemGrowToken(b.dataset.grow); });
}

function redeemGrowToken(id) {
  if (id === 'grow_stop') { showGrowStopPicker(); return; }
  if (id === 'insta_grow') { showInstaGrowPicker(); return; }
  const [e, l] = lbTok(id);
  if (!window.confirm(`${e} ${l} einlösen?`)) return;
  doRedeemGrow({ type: id });
}

function showGrowStopPicker() {
  const wrap = el('diGrowList'); if (!wrap) return;
  growPickOpen = true;
  const start = Math.max(lbCurGrowPct || 50, 5);
  wrap.innerHTML = `<div style="border:1px solid var(--accent);border-radius:10px;padding:11px;background:rgba(var(--accent-rgb),.1)">
    <div style="font-size:12px;margin-bottom:8px">⏹️ <b>Grow-Stop</b> — bei wie viel % 1 Stunde stoppen?</div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <input id="gsRange" type="range" min="5" max="100" value="${start}" style="flex:1">
      <span id="gsVal" style="min-width:42px;text-align:right;font-weight:600">${start} %</span>
    </div>
    ${lbCurGrowPct ? `<div style="font-size:10px;color:var(--muted);margin-bottom:9px">Du bist bei ~${lbCurGrowPct} % — Ziel muss ≥ sein.</div>` : '<div style="font-size:10px;color:var(--muted);margin-bottom:9px">Greift, sobald du im Spiel bist.</div>'}
    <div style="display:flex;gap:6px">
      <button id="gsGo" style="flex:1">✅ Aktivieren</button>
      <button id="gsCancel" class="secondary" style="flex:1">Zurück</button>
    </div></div>`;
  const range = el('gsRange'), val = el('gsVal');
  range.oninput = () => { val.textContent = range.value + ' %'; };
  el('gsGo').onclick = () => { growPickOpen = false; doRedeemGrow({ type: 'grow_stop', targetPct: parseInt(range.value, 10) }); };
  el('gsCancel').onclick = () => { growPickOpen = false; updateDinoInfo(); };
}

async function doRedeemGrow(body) {
  try {
    const r = await fetch(`${config.tokenBase}/tokens/redeem`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json(); if (!r.ok) throw new Error(apiErr(d));
    let msg = 'Token eingelöst!';
    if (body.type === 'grow_boost') msg = '📈 Grow-Boost aktiv (~1 Stunde).';
    else if (body.type === 'insta_grow') msg = '⚡ Insta-Grow eingelöst!';
    else if (body.type === 'grow_stop') msg = `⏹️ Grow-Stop bei ${body.targetPct} % aktiv (~1 Stunde).`;
    showToast(msg, 'success');
    pollGrowStatus(); // Timer-Pill sofort aktualisieren
  } catch (e) { showToast(e.message, 'error'); }
  updateDinoInfo();
}

// ── Insta-Grow: Mutations-Picker (Katalog aus dem Bot portiert) ──────────────
// diet-Zuordnung je Spezies (unbekannt → 'both').
const DIET_MAP = {
  Allosaurus: 'carni', Carnotaurus: 'carni', Ceratosaurus: 'carni', Deinosuchus: 'carni', Dilophosaurus: 'carni',
  Herrerasaurus: 'carni', Omniraptor: 'carni', Pteranodon: 'carni', Troodon: 'carni', Tyrannosaurus: 'carni', Rex: 'carni',
  Diabloceratops: 'herbi', Dryosaurus: 'herbi', Hypsilophodon: 'herbi', Kentrosaurus: 'herbi', Maiasaura: 'herbi', Maiasaurus: 'herbi',
  Pachycephalosaurus: 'herbi', Stegosaurus: 'herbi', Tenontosaurus: 'herbi', Triceratops: 'herbi',
  Beipiaosaurus: 'both', Gallimimus: 'both',
};
// Mutations-Katalog: v=Ingame-Name, l=Label, d=diet, s=Basis-Slots, h=hidden(★), f=femaleOnly, x=Beschreibung.
const MUT_CATALOG = [
  { v: 'Accelerated Prey Drive', l: 'Accelerated Prey Drive', d: 'carni', s: [1, 2, 3], x: 'Mehr Schaden gegen Tiere mit niedriger Gesundheit (10%)' },
  { v: 'Advanced Gestation', l: 'Advanced Gestation', d: 'both', f: 1, s: [1, 2, 3], x: 'Schnellere Ei-Gestation/Inkubation/Cooldown (50%)' },
  { v: 'Barometric Sensitivity', l: 'Barometric Sensitivity', d: 'herbi', s: [1, 2, 3], x: 'Vorwarnung vor Stürmen oder Dürren' },
  { v: 'Cellular Regeneration', l: 'Cellular Regeneration', d: 'both', s: [1, 2, 3], x: 'Regeneriert Gesundheit etwas schneller (15%)' },
  { v: 'Congenital Hypoalgesia', l: 'Congenital Hypoalgesia', d: 'both', s: [1, 2, 3], x: 'Weniger Schaden gegen größere Spezies (15%)' },
  { v: 'Efficient Digestion', l: 'Efficient Digestion', d: 'both', s: [1, 2, 3], x: 'Nahrungsverbrauch verlangsamt sich (20%)' },
  { v: 'Enlarged Meniscus', l: 'Enlarged Meniscus', d: 'both', s: [1, 2, 3], x: 'Fallschaden trifft zuerst die Ausdauer' },
  { v: 'Epidermal Fibrosis', l: 'Epidermal Fibrosis', d: 'both', s: [1, 2, 3], x: 'Erhöht Blutungsresistenz (15%)' },
  { v: 'Featherweight', l: 'Featherweight', d: 'both', s: [1, 2, 3], x: 'Fußabdrücke verblassen schneller (50%)' },
  { v: 'Hematophagy', l: 'Hematophagy', d: 'both', s: [1, 2, 3], x: 'Stellt beim Fressen etwas Durst wieder her (15%)' },
  { v: 'Hemomania', l: 'Hemomania', d: 'carni', s: [1, 2, 3], x: 'Zusatzschaden gegen blutende Ziele (5%)' },
  { v: 'Hydrodynamic', l: 'Hydrodynamic', d: 'both', s: [1, 2, 3], x: 'Erhöhte Schwimmgeschwindigkeit (15%)' },
  { v: 'Hydro-regenerative', l: 'Hydro-regenerative', d: 'both', s: [1, 2, 3], x: 'Schnellere HP-Regen bei Regen (25%)' },
  { v: 'Hypervigilance', l: 'Hypervigilance', d: 'herbi', s: [1, 2, 3], x: 'Größerer Kamerawinkel beim Essen/Trinken, besseres Hören (50%)' },
  { v: 'Increased Inspiratory Capacity', l: 'Increased Inspiratory Capacity', d: 'both', s: [1, 2, 3], x: 'Erhöhte Sauerstoffkapazität (15%)' },
  { v: 'Infrasound Communication', l: 'Infrasound Communication', d: 'both', s: [1, 2, 3], x: 'Deutlich weniger Lärm beim Sprechen (50%)' },
  { v: 'Nocturnal', l: 'Nocturnal', d: 'both', s: [1, 2, 3], x: 'Schnellere Regen. & höheres Tempo nachts (5%)' },
  { v: 'Osteosclerosis', l: 'Osteosclerosis', d: 'both', s: [1, 2, 3], x: 'Resistenz gegen Knochenbrüche (20%)' },
  { v: 'Photosynthetic Regeneration', l: 'Photosynthetic Regeneration', d: 'herbi', s: [1, 2, 3], x: 'Erhöhte Ausdauerregen. am Tag (10%)' },
  { v: 'Photosynthetic Tissue', l: 'Photosynthetic Tissue', d: 'both', s: [1, 2, 3], x: 'Schnellere Regen. & höheres Tempo am Tag (5%)' },
  { v: 'Reabsorption', l: 'Reabsorption', d: 'both', s: [1, 2, 3], x: 'Stellt etwas Wasser bei Regen/Schwimmen wieder her' },
  { v: 'Social Behavior', l: 'Social Behavior', d: 'both', s: [1, 2, 3], x: 'Erhöhte Gruppengröße' },
  { v: 'Submerged Optical Retention', l: 'Submerged Optical Retention', d: 'both', s: [1, 2, 3], x: 'Erhöhte Sichtweite unter Wasser (5%)' },
  { v: 'Sustained Hydration', l: 'Sustained Hydration', d: 'both', s: [1, 2, 3], x: 'Wasserverbrauch verlangsamt sich (20%)' },
  { v: 'Truculency', l: 'Truculency', d: 'herbi', s: [1, 2, 3], x: 'Tritte schütteln festgeklammerte Tiere eher ab (5%)' },
  { v: 'Wader', l: 'Wader', d: 'both', s: [1, 2, 3], x: 'Weniger behindert beim Waten durch flaches Wasser (25%)' },
  { v: 'Xerocole Adaptation', l: 'Xerocole Adaptation', d: 'herbi', s: [1, 2, 3], x: 'Erhält Wasser beim Verzehr von Pflanzen (15%)' },
  { v: 'Tactile Endurance', l: 'Tactile Endurance', d: 'herbi', s: [2], x: 'Verwandelt eingehenden Schaden in Ausdauer' },
  { v: 'Traumatic Thrombosis', l: 'Traumatic Thrombosis', d: 'both', s: [2], x: 'Verhindert Tod durch Blutverlust beim Ruhen' },
  { v: 'Gastronomic Regeneration', l: 'Gastronomic Regeneration', d: 'both', s: [2], x: 'Essen stellt etwas Gesundheit wieder her' },
  { v: 'Hypermetabolic Inanition', l: 'Hypermetabolic Inanition', d: 'carni', s: [2], x: 'Je weniger Hunger, desto mehr Schaden' },
  { v: 'Augmented Tapetum', l: 'Augmented Tapetum', d: 'carni', h: 1, s: [2, 3], x: 'Erhöhte Nachtsicht' },
  { v: 'Cannibalistic', l: 'Cannibalistic', d: 'carni', h: 1, s: [2, 3], x: 'Eigene Spezies als bevorzugte Beute' },
  { v: 'Enhanced Digestion', l: 'Enhanced Digestion', d: 'both', h: 1, s: [2, 3], x: 'Verringert Abbaurate von Nährstoffen' },
  { v: 'Heightened Ghrelin', l: 'Heightened Ghrelin', d: 'both', h: 1, s: [2], x: 'Erhöhte Kapazität für übermäßiges Essen' },
  { v: 'Multichambered Lungs', l: 'Multichambered Lungs', d: 'both', h: 1, s: [2, 3], x: 'Verringert Schwelle für Ausdauerregeneration' },
  { v: 'Osteophagic', l: 'Osteophagic', d: 'carni', h: 1, s: [2, 3], x: 'Kann Knochen fressen, heilt Knochenbrüche schneller' },
  { v: 'Prolific Reproduction', l: 'Prolific Reproduction', d: 'both', f: 1, h: 1, s: [2, 3], x: 'Junge wachsen schneller, brauchen weniger Nahrung' },
  { v: 'Reinforced Tendons', l: 'Reinforced Tendons', d: 'both', h: 1, s: [2, 3], x: 'Springen kostet weniger Ausdauer' },
  { v: 'Reniculate Kidneys', l: 'Reniculate Kidneys', d: 'both', h: 1, s: [2, 3], x: 'Kann Salzwasser trinken' },
];
// Erlaubte Mutationen für (Slot + Kontext). Slot 4 = Union aus Slot 2/3 (nur wenn freigeschaltet).
function mutForSlot(slot, ctx) {
  return MUT_CATALOG.filter((m) => {
    const allowed = slot === 4 ? (ctx.fourth && (m.s.includes(2) || m.s.includes(3))) : m.s.includes(slot);
    if (!allowed) return false;
    if (m.d !== 'both' && m.d !== ctx.diet) return false;
    if (m.f && ctx.gender !== 'female') return false;
    return true;
  });
}

async function showInstaGrowPicker() {
  let d = null;
  try { d = await fetch(`${config.tokenBase}/me`, { headers: { Authorization: `Bearer ${sessionToken}` } }).then((r) => r.json()); } catch {}
  if (!d || !d.online) { showToast('Du musst lebend im Spiel auf einem Dino sein.', 'error'); return; }
  if ((d.grow || 0) >= 0.80) { showToast(`Dein Dino ist schon bei ${Math.round((d.grow || 0) * 100)} % — Insta-Grow geht nur bis 80 %.`, 'error'); return; }
  const diet = DIET_MAP[d.dino] || 'both';
  const gender = /female|^1$|^f$/i.test(String(d.gender || '')) ? 'female' : 'male';
  const met = Array.isArray(d.primes) ? d.primes.filter(Boolean).length : 0;
  const fourth = !!(d.isElder || d.isPrime || met / 10 >= 0.5);
  const ctx = { diet, gender, fourth };
  const slotCount = fourth ? 4 : 3;
  // Aktuelle Mutationen vorbelegen (nur bekannte) → „nicht ändern" = bleibt erhalten.
  const curBase = (d.mutations && Array.isArray(d.mutations.base)) ? d.mutations.base : [];
  const sel = new Array(slotCount).fill(null).map((_, i) => {
    const v = curBase[i];
    return (v && MUT_CATALOG.some((m) => m.v === v)) ? v : null;
  });
  let openSlot = null;

  const ov = document.createElement('div'); ov.className = 'bf-confirm-ov';
  ov.innerHTML = `<div class="bf-confirm" style="max-width:460px;width:92%">
    <div class="bf-confirm-t">⚡ Insta-Grow — Mutationen wählen</div>
    <div class="bf-confirm-b" style="text-align:left;max-height:60vh;overflow-y:auto">
      <div style="margin-bottom:10px">Dein <b>${escapeHtml(d.dino || 'Dino')}</b> wächst auf <b>80 %</b>. Prime-/Elder-Fortschritt bleibt erhalten.${fourth ? '' : ' <span style="color:var(--muted)">(4. Slot ab ≥50 % Prime/Elder)</span>'}</div>
      <div id="igSlots"></div>
    </div>
    <div class="bf-confirm-btns"><button class="secondary bf-c-no">Abbrechen</button><button class="bf-c-yes">⚡ Boosten</button></div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('.bf-c-no').onclick = close;
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });

  function renderSlots() {
    const box = ov.querySelector('#igSlots'); if (!box) return;
    box.innerHTML = '';
    for (let slot = 1; slot <= slotCount; slot++) {
      const cur = sel[slot - 1];
      const curMut = MUT_CATALOG.find((m) => m.v === cur);
      const taken = new Set(sel.filter((v, i) => v && i !== slot - 1)); // in anderen Slots gewählt → hier raus
      const opts = mutForSlot(slot, ctx).filter((m) => !taken.has(m.v));
      const items = ['<div class="ig-dd-item" data-val=""><div class="nm" style="color:var(--muted)">— leer —</div></div>']
        .concat(opts.map((m) => `<div class="ig-dd-item${m.v === cur ? ' sel' : ''}" data-val="${escapeHtml(m.v)}"><div class="nm">${m.h ? '★ ' : ''}${escapeHtml(m.l)}</div><div class="ds">${escapeHtml(m.x)}</div></div>`)).join('');
      const wrap = document.createElement('div'); wrap.className = 'ig-slot';
      wrap.innerHTML = `
        <div class="ig-slot-h">🧬 Slot ${slot}${slot === 4 ? ' <span style="color:var(--muted);font-weight:400">(Prime/Elder)</span>' : ''}</div>
        <button class="bf-select ig-dd-btn" data-slot="${slot}"><span>${curMut ? `${curMut.h ? '★ ' : ''}${escapeHtml(curMut.l)}` : '<span style="color:var(--muted)">— leer —</span>'}</span><span style="color:var(--muted)">▾</span></button>
        ${curMut ? `<div class="ig-selDesc">${escapeHtml(curMut.x)}</div>` : ''}
        <div class="ig-dd-menu" data-menu="${slot}"${openSlot === slot ? '' : ' style="display:none"'}>${items}</div>`;
      box.appendChild(wrap);
    }
    box.querySelectorAll('.ig-dd-btn').forEach((b) => { b.onclick = () => { const s = parseInt(b.dataset.slot, 10); openSlot = openSlot === s ? null : s; renderSlots(); }; });
    box.querySelectorAll('.ig-dd-item').forEach((it) => { it.onclick = () => {
      const s = parseInt(it.closest('.ig-dd-menu').dataset.menu, 10);
      sel[s - 1] = it.dataset.val || null; openSlot = null; renderSlots();
    }; });
  }
  renderSlots();

  ov.querySelector('.bf-c-yes').onclick = () => { close(); doRedeemGrow({ type: 'insta_grow', mutations: sel.map((v) => v || null) }); };
}

// ── Admin: Lootbox-Drop-Gewichte + Box-Preis (Vorlage: Dino-Limits) ──────────
function ensureLootboxCfgLoaded() { loadLootboxConfig(); }
async function loadLootboxConfig() {
  const root = el('lbCfgRoot'); if (!root) return;
  root.innerHTML = '<div class="dt-muted">Lade…</div>';
  try {
    const r = await fetch(`${config.tokenBase}/admin/lootbox-config`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    const d = await r.json(); if (!r.ok) throw new Error(apiErr(d));
    const tokens = d.tokens || [], weights = d.weights || {};
    const rows = tokens.map((t) => { const [e, l] = lbTok(t); return `<div class="dlimit-row"><span>${e} ${l}</span><input type="number" min="0" data-tok="${t}" value="${weights[t] || 0}" class="bf-select"></div>`; }).join('');
    root.innerHTML = `
      <div style="font-size:12px;color:var(--muted);margin-bottom:10px">Box-Preis (Punkte) + Drop-Gewichte. Höheres Gewicht = häufigerer Drop; die Chancen ergeben sich relativ zur Summe.</div>
      <div class="dlimit-row"><span><b>💰 Box-Preis (Pkt.)</b></span><input type="number" min="0" id="lbCfgCost" value="${d.cost || 0}" class="bf-select"></div>
      <div style="height:10px"></div>
      ${rows}
      <button id="lbCfgSave" style="width:100%;margin-top:12px">💾 Speichern</button>
      <div id="lbCfgResult" style="margin-top:8px;font-size:12px"></div>`;
    el('lbCfgSave').onclick = () => saveLootboxConfig();
  } catch (e) { root.innerHTML = `<div style="color:#ef4444">⚠️ ${escapeHtml(e.message)}</div>`; }
}
async function saveLootboxConfig() {
  const cost = parseInt(el('lbCfgCost').value, 10) || 0;
  const weights = {};
  document.querySelectorAll('#lbCfgRoot input[data-tok]').forEach((inp) => { const v = parseInt(inp.value, 10); weights[inp.dataset.tok] = v > 0 ? v : 0; });
  const res = el('lbCfgResult'); if (res) res.textContent = 'Speichere…';
  try {
    const r = await fetch(`${config.tokenBase}/admin/lootbox-config`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ cost, weights }) });
    const d = await r.json(); if (!r.ok) throw new Error(apiErr(d));
    if (res) res.textContent = '✅ Gespeichert.';
    showToast('🎁 Lootbox-Konfiguration gespeichert', 'success');
  } catch (e) { if (res) res.textContent = '⚠️ ' + e.message; showToast(e.message, 'error'); }
}

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
// Deutsche Kurzbeschreibungen der Mutationen — gespiegelt aus token-service staffConfig.MUTATIONS
// (bei Änderungen dort hier mitziehen). value → [Anzeigename, Beschreibung].
const MUT_INFO = {
  'Accelerated Prey Drive': ['Accelerated Prey Drive', 'Mehr Schaden gegen Tiere mit niedriger Gesundheit (10%)'],
  'Advanced Gestation': ['Advanced Gestation', 'Schnellere Ei-Gestation/Inkubation/Cooldown (50%)'],
  'Barometric Sensitivity': ['Barometric Sensitivity', 'Vorwarnung vor Stürmen oder Dürren'],
  'Cellular Regeneration': ['Cellular Regeneration', 'Regeneriert Gesundheit etwas schneller (15%)'],
  'Congenital Hypoalgesia': ['Congenital Hypoalgesia', 'Weniger Schaden gegen größere Spezies (15%)'],
  'Efficient Digestion': ['Efficient Digestion', 'Nahrungsverbrauch verlangsamt sich (20%)'],
  'Enlarged Meniscus': ['Enlarged Meniscus', 'Fallschaden trifft zuerst die Ausdauer'],
  'Epidermal Fibrosis': ['Epidermal Fibrosis', 'Erhöht Blutungsresistenz (15%)'],
  'Featherweight': ['Featherweight', 'Fußabdrücke verblassen schneller (50%)'],
  'Hematophagy': ['Hematophagy', 'Stellt beim Fressen etwas Durst wieder her (15%)'],
  'Hemomania': ['Hemomania', 'Zusatzschaden gegen blutende Ziele (5%)'],
  'Hydrodynamic': ['Hydrodynamic', 'Erhöhte Schwimmgeschwindigkeit (15%)'],
  'Hydro-regenerative': ['Hydro-regenerative', 'Schnellere HP-Regen bei Regen (25%)'],
  'Hypervigilance': ['Hypervigilance', 'Größerer Kamerawinkel beim Essen/Trinken, besseres Hören (50%)'],
  'Increased Inspiratory Capacity': ['Increased Inspiratory Capacity', 'Erhöhte Sauerstoffkapazität (15%)'],
  'Infrasound Communication': ['Infrasound Communication', 'Deutlich weniger Lärm beim Sprechen (50%)'],
  'Nocturnal': ['Nocturnal', 'Schnellere Regeneration & höheres Tempo nachts (5%)'],
  'Osteosclerosis': ['Osteosclerosis', 'Resistenz gegen Knochenbrüche (20%)'],
  'Photosynthetic Regeneration': ['Photosynthetic Regeneration', 'Erhöhte Ausdauerregeneration am Tag (10%)'],
  'Photosynthetic Tissue': ['Photosynthetic Tissue', 'Schnellere Regeneration & höheres Tempo am Tag (5%)'],
  'Reabsorption': ['Reabsorption', 'Stellt etwas Wasser bei Regen/Schwimmen wieder her'],
  'Social Behavior': ['Social Behavior', 'Erhöhte Gruppengröße'],
  'Submerged Optical Retention': ['Submerged Optical Retention', 'Erhöhte Sichtweite unter Wasser (5%)'],
  'Sustained Hydration': ['Sustained Hydration', 'Wasserverbrauch verlangsamt sich (20%)'],
  'Truculency': ['Truculency', 'Tritte schütteln festgeklammerte Tiere eher ab (5%)'],
  'Wader': ['Wader', 'Weniger behindert beim Waten durch flaches Wasser (25%)'],
  'Xerocole Adaptation': ['Xerocole Adaptation', 'Erhält Wasser beim Verzehr von Pflanzen (15%)'],
  'Tactile Endurance': ['Tactile Endurance', 'Verwandelt eingehenden Schaden in Ausdauer'],
  'Traumatic Thrombosis': ['Traumatic Thrombosis', 'Verhindert Tod durch Blutverlust beim Ruhen'],
  'Gastronomic Regeneration': ['Gastronomic Regeneration', 'Essen stellt etwas Gesundheit wieder her'],
  'Hypermetabolic Inanition': ['Hypermetabolic Inanition', 'Je weniger Hunger, desto mehr Schaden'],
  'Augmented Tapetum': ['★ Augmented Tapetum', 'Erhöhte Nachtsicht'],
  'Cannibalistic': ['★ Cannibalistic', 'Eigene Spezies als bevorzugte Beute'],
  'Enhanced Digestion': ['★ Enhanced Digestion', 'Verringert Abbaurate von Nährstoffen'],
  'Heightened Ghrelin': ['★ Heightened Ghrelin', 'Erhöhte Kapazität für übermäßiges Essen'],
  'Multichambered Lungs': ['★ Multichambered Lungs', 'Verringert Schwelle für Ausdauerregeneration'],
  'Osteophagic': ['★ Osteophagic', 'Kann Knochen fressen, heilt Knochenbrüche schneller'],
  'Prolific Reproduction': ['★ Prolific Reproduction', 'Junge wachsen schneller, brauchen weniger Nahrung'],
  'Reinforced Tendons': ['★ Reinforced Tendons', 'Springen kostet weniger Ausdauer'],
  'Reniculate Kidneys': ['★ Reniculate Kidneys', 'Kann Salzwasser trinken'],
};
function mutName(x) { const i = MUT_INFO[x]; return i ? i[0] : x; }
function mutDesc(x) { const i = MUT_INFO[x]; return i ? i[1] : ''; }
// Mutationen tabellarisch nach Generation (Basis / Eltern / Elder), je Zeile Name + deutsche Kurzbeschreibung.
function mutHTML(m) {
  const groups = [['Basis', m?.base || []], ['Eltern', m?.parent || []], ['Elder', m?.elder || []]];
  const total = groups.reduce((n, [, arr]) => n + arr.filter(Boolean).length, 0);
  if (!total) return '<span style="color:var(--muted);font-size:12px">Keine Mutationen</span>';
  return '<div class="mut-tbl">' + groups.map(([label, arr]) => {
    const items = (arr || []).filter(Boolean);
    if (!items.length) return '';
    const rows = items.map((x) => `<div class="mut-row"><span class="mut-nm">${escapeHtml(mutName(x))}</span><span class="mut-dsc">${escapeHtml(mutDesc(x))}</span></div>`).join('');
    return `<div class="mut-grp"><div class="mut-grp-h">${label}<span class="mut-grp-n">${items.length}</span></div>${rows}</div>`;
  }).join('') + '</div>';
}
function closeDinoDetail() { el('dinoDetail').style.display = 'none'; }
function showDinoDetail(card, ctx) {
  const box = el('dinoDetail').querySelector('.box');
  let action = '';
  if (ctx.mode === 'garage') {
    const minG = card.sellMinGrow ?? 0.75, growPct = Math.round((card.grow ?? 0) * 100), minPct = Math.round(minG * 100);
    const price = card.serverPrice ?? 0;
    const canSell = (card.grow ?? 0) >= minG;
    const sellBtn = canSell
      ? `<button id="ddSellServer" class="secondary" style="width:100%">💰 An Server verkaufen (+${price.toLocaleString('de-DE')})</button>`
      : `<button id="ddSellServer" class="secondary" style="width:100%;opacity:.55;cursor:not-allowed" disabled title="Verkauf erst ab ${minPct}% Wachstum — aktuell ${growPct}% (es fehlen ${minPct - growPct}%).">💰 An Server verkaufen (ab ${minPct}%)</button>`;
    const myDino = ((me && me.dino) || '').split('_')[0];
    const slotDino = (card.dino || '').split('_')[0];
    const sameSpecies = myDino && slotDino && myDino === slotDino;
    // Ausparken (nur gleiche Spezies, aktueller Dino geht verloren) + Swapen (jede Spezies, tauscht)
    const unparkBtn = sameSpecies ? `<button id="ddUnpark" style="width:100%">⬆️ Ausparken</button>` : '';
    // B-7: Swap-Cooldown sichtbar machen — Button sperren + Restzeit anzeigen, statt stumm zu scheitern.
    const swapCd = garageCooldowns.swap || 0;
    const swapBtn = swapCd > 0
      ? `<button id="ddSwap" class="secondary" style="width:100%;opacity:.55;cursor:not-allowed" disabled title="Swap noch im Cooldown">🔄 Swapen — noch ${fmtCd(swapCd)}</button>`
      : `<button id="ddSwap" class="secondary" style="width:100%">🔄 Swapen (Dino tauschen)</button>`;
    action = unparkBtn + swapBtn
      + sellBtn
      + `<button id="ddDelete" class="secondary" style="width:100%;color:#fca5a5;border-color:#7f1d1d">🗑️ Aus Garage löschen</button>`;
  }
  else if (ctx.mode === 'market') action = ctx.mine ? `<div class="price-tag" style="margin-bottom:8px">Dein Angebot · ${(ctx.price || 0).toLocaleString('de-DE')} Pkt.</div><button id="ddWithdraw" class="secondary" style="width:100%">↩️ Angebot zurückziehen</button>` : `<button id="ddBuy" style="width:100%;margin-top:14px">🦖 Kaufen — ${(ctx.price || 0).toLocaleString('de-DE')} Pkt.</button>`;
  box.classList.add('dd-box-wide');
  const badges = [card.isElder ? '👑 Elder' : '', card.isPrime ? '⭐ Prime' : '', card.gender || '', card.isBleeding ? '🩸 Blutet' : '']
    .filter(Boolean).map((b) => `<span class="di-mchip">${b}</span>`).join('');
  box.innerHTML = `
    <div class="dd-header">
      <div class="prevwrap ddbig">${dinoPreviewSVG(card)}<img class="photo" src="${dinoImgSrc(card.dino)}" alt="" onerror="this.remove()"></div>
      <div style="flex:1;min-width:0">
        <div class="dd-nm" style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(card.dino || '?')}</div>
        <div style="font-size:12px;color:var(--muted);margin:3px 0 9px">${Math.round((card.grow || 0) * 100)}% Wachstum</div>
        <div style="display:flex;gap:5px;flex-wrap:wrap">${badges}</div>
        ${paletteHTML(card.colors)}
      </div>
    </div>
    <div class="dd-cols">
      <div style="flex:1;min-width:0"><div class="sec-title">📊 Vitals</div>${vitalsHTML(card)}</div>
      <div style="flex:1;min-width:0"><div class="sec-title">🧬 Mutationen</div><div style="margin-top:6px">${mutHTML(card.mutations)}</div></div>
    </div>
    <div id="ddActions" style="margin-top:16px;display:flex;flex-direction:column;gap:8px">${action}<button class="secondary" id="ddClose">Schließen</button></div>`;
  el('dinoDetail').style.display = 'flex';
  box.querySelector('#ddClose').onclick = closeDinoDetail;
  const u = box.querySelector('#ddUnpark'); if (u) u.onclick = () => { closeDinoDetail(); unparkById(card.id); };
  const sw = box.querySelector('#ddSwap'); if (sw && !sw.disabled) sw.onclick = () => { closeDinoDetail(); apiAction('/garage/swap', { slotId: card.id }, '🔄 Gswapt zu {dino}', loadGarage); };
  const b = box.querySelector('#ddBuy'); if (b) b.onclick = () => { closeDinoDetail(); buyOfferId(card.id); };
  const wd = box.querySelector('#ddWithdraw'); if (wd) wd.onclick = () => { closeDinoDetail(); apiAction('/market/withdraw', { offerId: card.id }, '↩️ Angebot zurückgezogen', loadMarket); };
  const ss = box.querySelector('#ddSellServer');
  if (ss && !ss.disabled) ss.onclick = () => {
    const price = card.serverPrice ?? 0;
    const acts = box.querySelector('#ddActions');
    acts.innerHTML = `<div style="text-align:center;font-size:13px;margin-bottom:6px">${escapeHtml(card.dino || 'Dino')} an den Server verkaufen für <b style="color:#fbbf24">+${price.toLocaleString('de-DE')} Punkte</b>?</div>
      <div style="display:flex;gap:8px"><button id="ddSellYes" style="flex:1">✅ Verkaufen</button><button id="ddSellNo" class="secondary" style="flex:1">Abbrechen</button></div>`;
    acts.querySelector('#ddSellYes').onclick = () => { closeDinoDetail(); apiAction('/market/sell-server', { slotId: card.id }, `💰 An Server verkauft (+${price})`, loadGarage); };
    acts.querySelector('#ddSellNo').onclick = () => showDinoDetail(card, ctx);
  };
  const dd = box.querySelector('#ddDelete');
  if (dd) { let armed = false; dd.onclick = () => {
    if (!armed) { armed = true; dd.textContent = '⚠️ Wirklich löschen?'; setTimeout(() => { if (dd) { armed = false; dd.textContent = '🗑️ Aus Garage löschen'; } }, 3000); return; }
    closeDinoDetail(); apiAction('/garage/delete', { slotId: card.id }, '🗑️ Dino aus Garage gelöscht', loadGarage);
  }; }
}

// Gemeinsame POST-Aktion mit Toast-Feedback
// Fehlermeldung robust extrahieren: Backend liefert {error:{code,message}}, der
// token-service (proxied) {error:"text"}. Sonst gäbe „throw new Error(d.error)" bei
// einem Objekt die Meldung „[object Object]".
function apiErr(d, fallback) {
  const e = d && d.error;
  if (e && typeof e === 'object') return e.message || e.code || fallback || 'Fehler';
  return e || fallback || 'Fehler';
}
async function apiAction(path, body, okMsg, reload) {
  try {
    const res = await fetch(`${config.tokenBase}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const d = await res.json(); if (!res.ok) throw new Error(apiErr(d));
    showToast(okMsg.replace('{dino}', d.dino || ''), 'success'); pollHud(); if (reload) await reload();
  } catch (err) { showToast(err.message, 'error'); }
}
const unparkById = (id) => apiAction('/garage/unpark', { slotId: id }, '⬆️ {dino} ausgeparkt', loadGarage);
const buyOfferId = (id) => apiAction('/market/buy', { offerId: id }, '🦖 {dino} gekauft!', loadMarket);

// ── Garage (Karten-Grid) ─────────────────────────────────────────────────────
let garageCooldowns = {}; // zuletzt geladene Cooldowns (park/unpark/swap) — für die Swap-Sperre im Dino-Detail (B-7)
async function renderGarage() {
  el('garage').classList.add('gr-wide');
  el('garage').innerHTML = `<h2>🚗 Garage <span id="garageCount" style="font-size:13px;color:var(--muted);font-weight:400"></span></h2>
    <div class="gr-park">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:13px">Aktuellen Dino einparken</div>
        <div style="font-size:11px;color:var(--muted)">Speichert deinen Dino als Token-Slot. Klick auf einen Dino unten für Details.</div>
        <div id="garageCd" style="font-size:12px;color:#f59e0b;margin-top:5px;display:none"></div>
      </div>
      <button id="parkBtn" style="flex:none;width:auto;padding:9px 16px">⬇️ Einparken</button>
    </div>
    <div id="garageGrid" class="dino-grid"></div>`;
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
    garageCooldowns = cd; // fürs Swap-Cooldown-Gating im Dino-Detail (B-7)
    const cdBox = el('garageCd');
    const parts = [];
    if (cd.park > 0) parts.push(`⏳ Einparken in ${fmtCd(cd.park)} wieder möglich`);
    if (cd.unpark > 0) parts.push(`⏳ Ausparken in ${fmtCd(cd.unpark)} wieder möglich`);
    if (cd.swap > 0) parts.push(`⏳ Swapen in ${fmtCd(cd.swap)} wieder möglich`); // B-7: Swap-Countdown sichtbar machen
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
let skinPays = false;       // Free (myAboIdx<1) zahlt + nicht-live; ab Knochen live & gratis
let zombieTimer = null;
let skinTpl = { templates: [], limit: 0, used: 0, free: true, costs: { color: 50, tplSave: 500, tplApply: 250 } };
function linToHex(rgb) { if (!rgb) return '#888888'; const h = (v) => ('0' + gc(v).toString(16)).slice(-2); return '#' + h(rgb[0]) + h(rgb[1]) + h(rgb[2]); }
function hexToLin(hex) { const n = parseInt(hex.slice(1), 16); const f = (v) => Math.pow(v / 255, 2.2); return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)]; }
function setPointsHud(p) { const e = el('hudPoints'); if (e && typeof p === 'number') e.textContent = `${p.toLocaleString('de-DE')} Pkt.`; }
// Baseline = zuletzt angewendeter Stand (für Free-Kosten = geänderte Farben ggü. Baseline + Reset).
function deepColors(c) { const o = {}; for (const [k] of SKIN_GROUPS) o[k] = (c[k] || [0.5, 0.5, 0.5]).slice(); return o; }
function setSkinBaseline() { if (skinState) skinState.baseline = { colors: deepColors(skinState.colors), skinVariation: skinState.skinVariation, patternIndex: skinState.patternIndex }; }
function changedColorFields() {
  if (!skinState?.baseline) return 0;
  let n = 0;
  for (const [k] of SKIN_GROUPS) {
    const a = skinState.colors[k] || [0, 0, 0], b = skinState.baseline.colors[k] || [0, 0, 0];
    if (a.some((v, i) => Math.abs(v - (b[i] ?? 0)) > 0.01)) n++;
  }
  return n;
}
function skinDirty() {
  if (!skinState?.baseline) return false;
  return changedColorFields() > 0 || skinState.skinVariation !== skinState.baseline.skinVariation || skinState.patternIndex !== skinState.baseline.patternIndex;
}
// Aktualisiert den Free-„Anwenden"-Button (Kosten = 50 × geänderte Farben).
function updateApplyCost() {
  const btn = el('skApply'); if (!btn) return;
  const cost = changedColorFields() * (skinTpl.costs?.color ?? 50);
  const dirty = skinDirty();
  btn.disabled = !dirty; btn.style.opacity = dirty ? '1' : '.5';
  btn.textContent = cost > 0 ? `✅ Anwenden (${cost} Pkt)` : (dirty ? '✅ Anwenden (gratis)' : '✅ Angewendet');
}
// 🧟 Zombie-Look setzen (Obsidian; Backend erzwingt zusätzlich).
async function setZombie(value) {
  try {
    const r = await fetch(`${config.tokenBase}/me/zombie`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ value }) });
    const d = await r.json(); if (!r.ok) throw new Error(apiErr(d));
    showToast('🧟 Zombie-Look aktualisiert', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

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
  skinState = { skinVariation: sk.skinVariation || 0, patternIndex: sk.patternIndex || 0, themeIndex: sk.themeIndex || 0, gender: me.gender === 'Female' ? 'Female' : 'Male', colors: {} };
  for (const [k] of SKIN_GROUPS) skinState.colors[k] = (sk.colors && sk.colors[k]) ? sk.colors[k] : [0.5, 0.5, 0.5];
  setSkinBaseline();
  skinPays = !mySkinFree;                    // Free zahlt + nicht-live; ab Knochen ODER Beta-Tester live & gratis
  const obsidian = myAboIdx() >= 3;
  const canGender = myAboIdx() >= 2;         // Geschlechtswechsel erst ab Bernstein
  const genderTip = canGender ? 'Geschlecht wechseln (Respawn)' : '🔒 Geschlechtswechsel ist ab Rang Bernstein freigeschaltet';

  const swatches = SKIN_GROUPS.map(([k, l]) => `<label style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 8px;background:rgba(255,255,255,0.04);border-radius:8px;font-size:13px;cursor:pointer"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l}</span><input type="color" data-col="${k}" value="${linToHex(skinState.colors[k])}" style="width:40px;height:26px;border:0;background:none;cursor:pointer;flex:none"></label>`).join('');
  const liveMsg = skinPays
    ? '✏️ Vorschau — Farben kosten 50 Pkt/Stück. Erst mit „Anwenden" geht der Skin live.'
    : '🟢 Änderungen werden live im Spiel übernommen';
  panel.innerHTML = `<h2>🎨 Skin Editor — ${me.dino}</h2>
    <div id="skLive" style="font-size:12px;color:${skinPays ? '#f59e0b' : '#22c55e'};margin:2px 0 14px">${liveMsg}</div>
    <div class="sec-title">Geschlecht ${canGender ? '' : '<span style="color:var(--muted);font-weight:400;font-size:11px">🔒 ab Bernstein</span>'}</div>
    <div style="display:flex;gap:6px;margin:8px 0 14px">
      <button data-gender="Female" title="${genderTip}" style="flex:1${canGender ? '' : ';opacity:.5'}" class="${skinState.gender === 'Female' ? '' : 'secondary'}">♀ Female</button>
      <button data-gender="Male" title="${genderTip}" style="flex:1${canGender ? '' : ';opacity:.5'}" class="${skinState.gender === 'Male' ? '' : 'secondary'}">♂ Male</button>
    </div>
    <div class="sec-title">Farben</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0 14px">${swatches}</div>
    <div class="sec-title">Muster & Variation</div>
    <div style="display:flex;gap:6px;margin:8px 0 8px">${[0, 1, 2].map((i) => `<button data-pat="${i}" style="flex:1" class="${skinState.patternIndex === i ? '' : 'secondary'}">Muster ${i + 1}</button>`).join('')}</div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><span style="font-size:13px">Skin-Variation</span><input id="skVar" type="number" min="0" value="${skinState.skinVariation}" style="width:80px;padding:6px;border-radius:6px;border:1px solid var(--border);background:var(--input-bg);color:#eee"></div>
    ${skinPays ? `<button id="skApply" disabled style="width:100%;margin:10px 0 4px;opacity:.5">✅ Angewendet</button>
    <div style="font-size:11px;color:var(--muted);margin-bottom:8px">Unbestätigte Änderungen werden NICHT aufs Dino übertragen.</div>` : ''}
    <div class="sec-title" style="margin-top:16px">🧟 Zombie-Look ${obsidian ? '' : '<span style="color:var(--muted);font-weight:400;font-size:11px">🔒 Obsidian</span>'}</div>
    <div style="display:flex;align-items:center;gap:8px;margin:8px 0 4px">
      <input type="range" id="skZombie" min="0" max="1" step="0.05" value="0" ${obsidian ? '' : 'disabled'} style="flex:1;accent-color:var(--accent)${obsidian ? '' : ';opacity:.45'}">
      <span id="skZombieVal" style="font-size:12px;width:38px;text-align:right">0%</span>
    </div>
    <div class="sec-title" style="margin-top:16px">🔗 Farben teilen</div>
    <button id="skShare" style="width:100%;margin:8px 0">📋 Farb-Code kopieren</button>
    <div style="display:flex;gap:6px;margin-bottom:4px">
      <input id="skImport" placeholder="Farb-Code einfügen…" style="flex:1;min-width:0;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--input-bg);color:#eee">
      <button id="skImportBtn" class="secondary" style="width:auto;padding:8px 12px">${skinPays ? 'Vorschau' : 'Anwenden'}</button>
    </div>
    <div id="skTplHead" class="sec-title" style="margin-top:16px">📁 Eigene Vorlagen</div>
    <div style="display:flex;gap:6px;margin:8px 0">
      <input id="skTplName" placeholder="Vorlagen-Name…" maxlength="30" style="flex:1;min-width:0;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--input-bg);color:#eee">
      <button id="skTplSave" style="width:auto;padding:8px 12px">💾 Speichern</button>
    </div>
    <div id="skTplList"></div>
    <button class="closeFeature secondary" style="width:100%;margin-top:12px">Schließen</button>`;
  panel.querySelector('.closeFeature').onclick = closeAllFeatures;
  el('skTplSave').onclick = () => saveSkinTemplate();
  el('skShare').onclick = () => copySkinCode();
  el('skImportBtn').onclick = () => importSkinCode(el('skImport').value);
  if (skinPays) el('skApply').onclick = () => applySkin(false);
  loadSkinTemplates();
  updateSkinPreview();
  // Free: nur Vorschau (updateApplyCost) — geht erst mit „Anwenden" live. Ab Knochen: live nach kurzer Pause.
  const onEdit = () => { if (skinPays) updateApplyCost(); else scheduleSkinApply(); };
  panel.querySelectorAll('[data-col]').forEach((inp) => inp.oninput = () => { skinState.colors[inp.dataset.col] = hexToLin(inp.value); updateSkinPreview(); onEdit(); });
  panel.querySelectorAll('[data-pat]').forEach((b) => b.onclick = () => { skinState.patternIndex = parseInt(b.dataset.pat); panel.querySelectorAll('[data-pat]').forEach((x) => x.className = x === b ? '' : 'secondary'); onEdit(); });
  el('skVar').oninput = () => { skinState.skinVariation = parseInt(el('skVar').value) || 0; onEdit(); };
  panel.querySelectorAll('[data-gender]').forEach((b) => b.onclick = () => changeGender(b.dataset.gender, panel));
  // 🧟 Zombie-Slider (Obsidian) — debounced; sonst Upsell.
  const zin = el('skZombie');
  if (obsidian) zin.oninput = () => { el('skZombieVal').textContent = Math.round(zin.value * 100) + '%'; clearTimeout(zombieTimer); zombieTimer = setTimeout(() => setZombie(parseFloat(zin.value)), 500); };
  else zin.onclick = () => showToast('🧟 Der Zombie-Look ist exklusiv für Obsidian.', 'error');
}
// Geschlecht wechseln: The Isle kann das nur per Respawn → /me/gender (selber Dino,
// selbes Wachstum, neues Geschlecht), danach Skin erneut anwenden (Farben behalten).
async function changeGender(gender, panel) {
  if (!skinState || skinState.gender === gender) return;
  if (myAboIdx() < 2) { showToast('🔒 Geschlechtswechsel gibt es ab Rang Bernstein.', 'error'); return; }
  setSkinLive('… Geschlecht wird gewechselt (Respawn)', '#f59e0b');
  try {
    const r = await fetch(`${config.tokenBase}/me/gender`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ gender }) });
    const d = await r.json(); if (!r.ok) throw new Error(apiErr(d));
    skinState.gender = gender;
    panel.querySelectorAll('[data-gender]').forEach((x) => x.className = x.dataset.gender === gender ? '' : 'secondary');
    setSkinLive('🟢 Geschlecht gewechselt', '#22c55e');
    showToast(`Geschlecht: ${gender === 'Female' ? '♀ Female' : '♂ Male'}`, 'success');
    setTimeout(() => applySkin(true), 1600);   // nach Respawn Farben erneut aufspielen
  } catch (e) { setSkinLive('⚠️ ' + e.message, '#ef4444'); showToast(e.message, 'error'); }
}
function setSkinLive(txt, color) { const h = el('skLive'); if (h) { h.textContent = txt; h.style.color = color || '#22c55e'; } }
// Spiegelt skinState → UI (nach Import/Vorlage)
function syncSkinUI() {
  for (const [k] of SKIN_GROUPS) { const inp = document.querySelector(`#skinEditor [data-col="${k}"]`); if (inp) inp.value = linToHex(skinState.colors[k]); }
  const sv = el('skVar'); if (sv) sv.value = skinState.skinVariation;
  document.querySelectorAll('#skinEditor [data-pat]').forEach((x) => x.className = parseInt(x.dataset.pat) === skinState.patternIndex ? '' : 'secondary');
  updateSkinPreview();
  updateApplyCost();   // Free-Button nach Import/Vorlage aktualisieren
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
    syncSkinUI();   // ruft updateApplyCost()
    const imp = el('skImport'); if (imp) imp.value = '';
    if (skinPays) showToast('🎨 Vorschau geladen — mit „Anwenden" bestätigen (50 Pkt pro geänderte Farbe)', 'success');
    else { applySkin(); showToast('🎨 Farben übernommen', 'success'); }
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
    const body = { skinVariation: skinState.skinVariation, patternIndex: skinState.patternIndex, themeIndex: skinState.themeIndex, gender: skinState.gender, ...skinState.colors };
    const send = () => fetch(`${config.tokenBase}/skin`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let res = await send();
    if (res.status === 502) { await new Promise((r) => setTimeout(r, 1200)); res = await send(); } // ein Retry bei Server-Hänger
    const d = await res.json(); if (!res.ok) throw new Error(apiErr(d));
    if (typeof d.points === 'number') setPointsHud(d.points);
    setSkinBaseline(); updateApplyCost();   // angewendeter Stand = neue Baseline (Free-Kosten ab hier neu)
    setSkinLive(d.charged ? `🟢 Übernommen (−${d.charged} Pkt)` : '🟢 Live übernommen', '#22c55e');
    if (!auto) showToast(d.charged ? `🎨 Skin angewendet — ${d.charged} Punkte abgebucht` : '🎨 Skin angewendet!', 'success');
  } catch (err) { setSkinLive('⚠️ ' + err.message, '#ef4444'); showToast(err.message, 'error'); }
}

// ── Skin-Vorlagen (server-seitig, dino-übergreifend) — Slots + Free-Kosten ───
async function loadSkinTemplates() {
  try {
    const r = await fetch(`${config.tokenBase}/skin/templates`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    const d = await r.json(); if (r.ok) skinTpl = d;
  } catch {}
  renderSkinTemplates();
}
async function saveSkinTemplate() {
  if (!skinState) return;
  const name = (el('skTplName').value || '').trim();
  if (!name) { showToast('Vorlagen-Name fehlt', 'error'); return; }
  try {
    const body = { name, skinVariation: skinState.skinVariation, patternIndex: skinState.patternIndex, themeIndex: skinState.themeIndex, colors: skinState.colors };
    const r = await fetch(`${config.tokenBase}/skin/templates`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json(); if (!r.ok) throw new Error(apiErr(d));
    skinTpl = { ...skinTpl, templates: d.templates, used: d.used, limit: d.limit };
    if (typeof d.points === 'number') setPointsHud(d.points);
    el('skTplName').value = '';
    renderSkinTemplates();
    showToast(d.charged ? `📁 „${name}" gespeichert — ${d.charged} Punkte abgebucht` : `📁 Vorlage „${name}" gespeichert`, 'success');
  } catch (e) { showToast(e.message, 'error'); }
}
async function applySkinTemplate(t) {
  try {
    const r = await fetch(`${config.tokenBase}/skin/templates/${t.id}/apply`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` } });
    const d = await r.json(); if (!r.ok) throw new Error(apiErr(d));
    if (typeof d.points === 'number') setPointsHud(d.points);
    // skinState + Baseline auf die (server-seitig angewendete) Vorlage ziehen
    skinState.skinVariation = t.skinVariation || 0;
    skinState.patternIndex = t.patternIndex || 0;
    skinState.themeIndex = t.themeIndex || 0;
    for (const [k] of SKIN_GROUPS) if (t.colors && t.colors[k]) skinState.colors[k] = t.colors[k].slice();
    syncSkinUI(); setSkinBaseline(); updateApplyCost();
    showToast(d.charged ? `🎨 „${t.name}" angewendet — ${d.charged} Punkte` : `🎨 Vorlage „${t.name}" angewendet`, 'success');
  } catch (e) { showToast(e.message, 'error'); }
}
async function deleteSkinTemplate(id) {
  try {
    const r = await fetch(`${config.tokenBase}/skin/templates/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${sessionToken}` } });
    const d = await r.json(); if (r.ok) { skinTpl = { ...skinTpl, templates: d.templates, used: d.used, limit: d.limit }; renderSkinTemplates(); }
  } catch {}
}
function renderSkinTemplates() {
  const box = el('skTplList'); if (!box) return;
  const list = skinTpl.templates || [];
  const head = el('skTplHead');
  if (head) head.innerHTML = `📁 Eigene Vorlagen (${list.length}/${skinTpl.limit})` +
    (skinTpl.free ? '' : ` <span style="color:var(--muted);font-weight:400;font-size:11px">· Speichern ${skinTpl.costs?.tplSave} · Anwenden ${skinTpl.costs?.tplApply} Pkt</span>`);
  box.innerHTML = list.length ? '' : '<div style="color:var(--muted);font-size:12px">Noch keine Vorlagen gespeichert.</div>';
  for (const t of list) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:5px';
    const ap = document.createElement('button');
    ap.textContent = `🎨 ${t.name}`; ap.style.cssText = 'flex:1;text-align:left;padding:7px 10px';
    ap.onclick = () => applySkinTemplate(t);
    const del = document.createElement('button');
    del.className = 'secondary'; del.textContent = '🗑'; del.style.cssText = 'width:auto;padding:6px 10px';
    del.onclick = () => deleteSkinTemplate(t.id);
    row.append(ap, del);
    box.appendChild(row);
  }
}

// ── Dino-Markt (Karten-Grid + Angebot erstellen) ───────────────────────────
let marketView = 'offers'; // 'offers' | 'create'
// Diät pro Spezies (für Markt-Filter/Gruppierung). Omnivoren als eigene Kategorie.
const DINO_DIET = {
  Tyrannosaurus: 'carni', Rex: 'carni', Allosaurus: 'carni', Carnotaurus: 'carni', Ceratosaurus: 'carni', Deinosuchus: 'carni', Dilophosaurus: 'carni', Herrerasaurus: 'carni', Omniraptor: 'carni', Pteranodon: 'carni', Troodon: 'carni',
  Triceratops: 'herbi', Stegosaurus: 'herbi', Diabloceratops: 'herbi', Tenontosaurus: 'herbi', Maiasaura: 'herbi', Maiasaurus: 'herbi', Pachycephalosaurus: 'herbi', Dryosaurus: 'herbi', Hypsilophodon: 'herbi',
  Gallimimus: 'omni', Beipiaosaurus: 'omni',
};
const dietOfDino = (c) => DINO_DIET[(c || '').split('_')[0]] || 'other';
// [key, Chip-Label, Gruppen-Label, Farbe]
const MK_DIETS = [['carni', '🥩 Karni', 'Karnivoren', '#ef4444'], ['herbi', '🌿 Herbi', 'Herbivoren', '#22c55e'], ['omni', '🍃 Omni', 'Omnivoren', '#eab308']];
let marketSearch = '', marketDiet = 'all', marketSort = 'price-asc', marketOffers = [];
let marketTab = 'dino'; // 'dino' | 'token' | 'mine' — oberster Markt-Tab
async function renderMarket() {
  el('market').classList.add('m-wide');
  el('market').innerHTML = `
    <div style="display:flex;gap:6px;margin-bottom:12px">
      <button id="mtDino" style="flex:1">🦖 Dino-Markt</button>
      <button id="mtToken" class="secondary" style="flex:1">🎁 Token-Markt</button>
      <button id="mtMine" class="secondary" style="flex:1">📋 Meine</button>
    </div>
    <div id="mkRoot"></div>`;
  el('mtDino').onclick = () => { if (marketTab !== 'dino') { marketTab = 'dino'; renderMarketTab(); } };
  el('mtToken').onclick = () => { if (marketTab !== 'token') { marketTab = 'token'; renderMarketTab(); } };
  el('mtMine').onclick = () => { if (marketTab !== 'mine') { marketTab = 'mine'; renderMarketTab(); } };
  renderMarketTab();
}
function renderMarketTab() {
  [['mtDino', 'dino'], ['mtToken', 'token'], ['mtMine', 'mine']].forEach(([id, v]) => { const b = el(id); if (b) b.className = marketTab === v ? '' : 'secondary'; });
  if (marketTab === 'dino') renderDinoMarket();
  else if (marketTab === 'token') renderTokenMarket();
  else renderMyOffers();
}
function renderDinoMarket() {
  el('mkRoot').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h2 style="margin:0">🦖 Dino-Markt</h2>
      <span id="mkPoints" class="price-tag">… Pkt.</span>
    </div>
    <div style="display:flex;gap:6px;margin-bottom:12px">
      <button id="mkTabOffers" style="flex:1">Angebote</button>
      <button id="mkTabWants" class="secondary" style="flex:1">🔎 Gesuche</button>
      <button id="mkTabCreate" class="secondary" style="flex:1">➕ Verkaufen</button>
    </div>
    <div id="mkControls" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
      <input id="mkSearch" placeholder="🔍 Spezies suchen…" style="flex:1;min-width:150px;padding:8px;border-radius:8px;border:1px solid var(--border);background:rgba(0,0,0,0.25);color:#eee;font-size:13px">
      <div id="mkDiet" style="display:flex;gap:4px"></div>
      <select id="mkSort" class="bf-select" style="width:auto;flex:none">
        <option value="price-asc">Preis ↑</option>
        <option value="price-desc">Preis ↓</option>
        <option value="name">Name A–Z</option>
        <option value="grow-desc">Wachstum ↓</option>
      </select>
    </div>
    <div id="mkBody"></div>`;
  el('mkTabOffers').onclick = () => { marketView = 'offers'; loadMarket(); };
  el('mkTabWants').onclick = () => { marketView = 'wants'; loadMarket(); };
  el('mkTabCreate').onclick = () => { marketView = 'create'; loadMarket(); };
  const dietBox = el('mkDiet');
  const chips = [['all', 'Alle', '', 'var(--accent)'], ...MK_DIETS];
  dietBox.innerHTML = chips.map(([k, l, , c]) => `<button class="mk-chip${marketDiet === k ? ' on' : ''}" data-diet="${k}" style="--c:${c}">${l}</button>`).join('');
  dietBox.querySelectorAll('.mk-chip').forEach((b) => { b.onclick = () => { marketDiet = b.dataset.diet; dietBox.querySelectorAll('.mk-chip').forEach((x) => x.classList.toggle('on', x.dataset.diet === marketDiet)); renderMarketOffers(); }; });
  const se = el('mkSearch'); se.value = marketSearch; se.oninput = (e) => { marketSearch = e.target.value; renderMarketOffers(); };
  const so = el('mkSort'); so.value = marketSort; so.onchange = (e) => { marketSort = e.target.value; renderMarketOffers(); };
  marketView = 'offers';
  loadMarket();
}
let dmState = null, dmGarage = [];
async function loadMarket() {
  if (!el('mkTabOffers')) return;
  [['mkTabOffers', 'offers'], ['mkTabWants', 'wants'], ['mkTabCreate', 'create']].forEach(([id, v]) => { const b = el(id); if (b) b.className = marketView === v ? '' : 'secondary'; });
  const ctrl = el('mkControls'); if (ctrl) ctrl.style.display = marketView === 'offers' ? 'flex' : 'none';
  const body = el('mkBody'); body.innerHTML = '<div style="color:var(--muted);font-size:13px">Lade…</div>';
  try {
    const [m, g] = await Promise.all([
      fetch(`${config.tokenBase}/market`, { headers: { Authorization: `Bearer ${sessionToken}` } }).then((r) => r.json()),
      fetch(`${config.tokenBase}/garage`, { headers: { Authorization: `Bearer ${sessionToken}` } }).then((r) => r.json()),
    ]);
    dmState = m; dmGarage = g.slots || [];
    el('mkPoints').textContent = `${(m.points || 0).toLocaleString('de-DE')} Pkt.`;
    if (marketView === 'offers') { marketOffers = m.offers || []; renderMarketOffers(); }
    else if (marketView === 'wants') { renderDinoWants(); }
    else {
      const slots = dmGarage;
      if (!slots.length) { body.innerHTML = '<div style="color:var(--muted);font-size:13px">Garage leer — nichts zu verkaufen.</div>'; return; }
      body.innerHTML = '<p style="color:var(--muted);font-size:13px;margin-bottom:8px">Wähle einen Dino zum Verkaufen.</p>';
      const grid = document.createElement('div'); grid.className = 'dino-grid'; body.appendChild(grid);
      for (const s of slots) grid.appendChild(dinoCardEl(s, () => showSellDialog(s)));
    }
  } catch { body.innerHTML = '<div style="color:#ef4444;font-size:13px">Markt konnte nicht geladen werden.</div>'; }
}
// Dino-Gesuche (Suche Dino X, biete …) — stöbern, erfüllen, selbst aufgeben
function renderDinoWants() {
  const body = el('mkBody'); if (!body || !dmState) return;
  const wants = dmState.wants || [];
  let html = '<div style="margin-bottom:12px"><button id="dwNew">➕ Gesuch aufgeben</button></div>';
  html += wants.length ? wants.map((w) => `
    <div class="tm-row"><div class="tm-info"><b>Suche ${escapeHtml(w.wantDino)}</b><span style="${tmMuted}">bietet ${escapeHtml(w.offerText || '')} · von ${escapeHtml(w.requesterName || '?')}</span></div>
      ${w.mine ? `<button class="secondary" data-wcancel="${w.id}">Zurückziehen</button>` : `<button data-wfill="${w.id}" data-dino="${escapeHtml(w.wantDino)}">Erfüllen</button>`}</div>`).join('')
    : `<div style="${tmMuted}">Keine Dino-Gesuche. Gib selbst eins auf! 🔎</div>`;
  body.innerHTML = html;
  el('dwNew').onclick = () => showDinoWantForm();
  body.querySelectorAll('[data-wcancel]').forEach((b) => { b.onclick = () => apiAction('/wants/cancel', { wantId: b.dataset.wcancel }, '↩️ Gesuch zurückgezogen', loadMarket); });
  body.querySelectorAll('[data-wfill]').forEach((b) => { b.onclick = () => fulfillDinoWant(b.dataset.wfill, b.dataset.dino); });
}
function showDinoWantForm() {
  const body = el('mkBody');
  const spOpts = Object.keys(DINO_DIET).sort().map((sp) => `<option value="${sp}">${sp}</option>`).join('');
  const allTok = (dmState.tokenDefs || []).map((t) => `<option value="${t.id}">${t.emoji} ${t.label}</option>`).join('');
  const q25 = Array.from({ length: 25 }, (_, i) => `<option value="${i + 1}">${i + 1}×</option>`).join('');
  body.innerHTML = `
    <div class="tm-form">
      <label>Gesuchter Dino</label><select id="dwDino" class="bf-select">${spOpts}</select>
      <label>Gebot-Art</label><select id="dwKind" class="bf-select"><option value="points">💰 Punkte</option><option value="token">🎁 Token</option></select>
      <div id="dwPriceWrap"></div>
      <div style="display:flex;gap:6px;margin-top:10px"><button id="dwSubmit" style="flex:1">🔎 Gesuch aufgeben (${dmState.offerHours || 72}h)</button><button id="dwBack" class="secondary" style="flex:none">Zurück</button></div>
    </div>`;
  const fillPrice = () => {
    el('dwPriceWrap').innerHTML = el('dwKind').value === 'points'
      ? '<label>Gebot (Punkte)</label><input id="dwAmt" type="number" min="1" placeholder="z.B. 5000" class="tm-input">'
      : `<label>Gebot-Token</label><select id="dwPtok" class="bf-select">${allTok}</select><label>Menge</label><select id="dwPamt" class="bf-select">${q25}</select>`;
  };
  el('dwKind').onchange = fillPrice; fillPrice();
  el('dwBack').onclick = () => { marketView = 'wants'; loadMarket(); };
  el('dwSubmit').onclick = () => {
    const kind = el('dwKind').value;
    const payload = { wantKind: 'dino', wantDino: el('dwDino').value, offerKind: kind };
    if (kind === 'points') { const a = parseInt(el('dwAmt').value); if (!a || a <= 0) { showToast('Bitte gültiges Punkte-Gebot eingeben', 'error'); return; } payload.offerAmount = a; }
    else { payload.offerAmount = parseInt(el('dwPamt').value); payload.offerTokenType = el('dwPtok').value; }
    apiAction('/wants/create', payload, '🔎 Gesuch aufgegeben', () => { marketView = 'wants'; loadMarket(); });
  };
}
function fulfillDinoWant(wantId, dino) {
  const matches = (dmGarage || []).filter((s) => (s.snapshot?.dinoClass || '').split('_')[0] === dino);
  if (!matches.length) { showToast(`Du hast keinen ${dino} in der Garage.`, 'error'); return; }
  const box = el('dinoDetail').querySelector('.box');
  box.innerHTML = `<div style="font-weight:700;margin-bottom:10px">Welchen ${escapeHtml(dino)} liefern?</div><div class="dino-grid" id="wfGrid"></div><button class="secondary" id="wfClose" style="width:100%;margin-top:10px">Abbrechen</button>`;
  el('dinoDetail').style.display = 'flex';
  const grid = box.querySelector('#wfGrid');
  matches.forEach((s) => grid.appendChild(dinoCardEl(s, () => { closeDinoDetail(); apiAction('/wants/fulfill', { wantId, slotId: s.id }, '✅ Gesuch erfüllt!', loadMarket); })));
  box.querySelector('#wfClose').onclick = closeDinoDetail;
}
// Angebote filtern (Suche + Diät) + sortieren + nach Diät gruppiert anzeigen
function renderMarketOffers() {
  const body = el('mkBody'); if (!body) return;
  let offers = marketOffers.slice();
  const q = marketSearch.trim().toLowerCase();
  if (q) offers = offers.filter((o) => (o.dino || '').toLowerCase().includes(q));
  if (marketDiet !== 'all') offers = offers.filter((o) => dietOfDino(o.dino) === marketDiet);
  const sorters = {
    'price-asc': (a, b) => (a.price || 0) - (b.price || 0),
    'price-desc': (a, b) => (b.price || 0) - (a.price || 0),
    'name': (a, b) => (a.dino || '').localeCompare(b.dino || ''),
    'grow-desc': (a, b) => (b.grow || 0) - (a.grow || 0),
  };
  offers.sort(sorters[marketSort] || sorters['price-asc']);
  if (!offers.length) { body.innerHTML = `<div style="color:var(--muted);font-size:13px">${marketOffers.length ? 'Keine passenden Angebote.' : 'Keine Angebote.'}</div>`; return; }
  body.innerHTML = '';
  const addCard = (grid, o) => {
    const card = dinoCardEl(o, () => showDinoDetail(o, { mode: 'market', price: o.price, mine: o.mine }));
    const tag = document.createElement('div'); tag.className = 'price-tag'; tag.style.borderRadius = '0';
    tag.textContent = `${(o.price || 0).toLocaleString('de-DE')} Pkt.${o.mine ? ' (deins)' : ''}`;
    card.appendChild(tag); grid.appendChild(card);
  };
  for (const [key, , label, color] of [...MK_DIETS, ['other', '', 'Sonstige', '#888']]) {
    const list = offers.filter((o) => dietOfDino(o.dino) === key);
    if (!list.length) continue;
    const head = document.createElement('div'); head.className = 'mk-group-head'; head.style.color = color;
    head.innerHTML = `● ${label} <span style="color:var(--muted);font-weight:400">(${list.length})</span>`;
    body.appendChild(head);
    const grid = document.createElement('div'); grid.className = 'dino-grid'; body.appendChild(grid);
    for (const o of list) addCard(grid, o);
  }
}
function showSellDialog(card) {
  const box = el('dinoDetail').querySelector('.box');
  box.innerHTML = `<div style="display:flex;gap:14px;align-items:center;margin-bottom:14px">${dinoPreview(card, 'dd')}<div><div style="font-size:18px;font-weight:700">${card.dino}${card.isElder ? ' 👑' : ''}</div><div style="font-size:12px;color:var(--muted)">${card.gender || ''} · ${Math.round((card.grow || 0) * 100)}%</div></div></div>
    <button id="sdServer" style="width:100%;margin-bottom:8px">💰 An Server verkaufen (+500)</button>
    <div style="display:flex;gap:6px;margin-bottom:8px">
      <input id="sdPrice" type="number" min="1" placeholder="Preis in Punkten" style="flex:1;padding:9px;border-radius:8px;border:1px solid var(--border);background:var(--input-bg);color:#eee;font-size:13px">
      <button id="sdPlayer" style="flex:none;padding:9px 14px">An Spieler listen</button>
    </div>
    <button class="secondary" id="sdClose" style="width:100%">Abbrechen</button>`;
  el('dinoDetail').style.display = 'flex';
  box.querySelector('#sdClose').onclick = closeDinoDetail;
  box.querySelector('#sdServer').onclick = () => { closeDinoDetail(); apiAction('/market/sell-server', { slotId: card.id }, '💰 An Server verkauft (+500)', loadMarket); };
  box.querySelector('#sdPlayer').onclick = () => { const p = parseInt(box.querySelector('#sdPrice').value); if (!p || p <= 0) { showToast('Bitte gültigen Preis eingeben', 'error'); return; } closeDinoDetail(); apiAction('/market/sell-player', { slotId: card.id, price: p }, '🏷️ Angebot erstellt', loadMarket); };
}

// ── Token-Markt (Auktionshaus + Direkt-Tausch) ─────────────────────────────
let tokenView = 'auctions'; // 'auctions' | 'create' | 'trade'
let tmState = null;
const tmMuted = 'color:var(--muted);font-size:12px';
function tmDef(id) { return (tmState?.tokenDefs || []).find((t) => t.id === id) || { id, label: id, emoji: '🎁' }; }
function tmTokenLabel(id) { const d = tmDef(id); return `${d.emoji} ${d.label}`; }
function tmPriceText(a) { return a.priceKind === 'points' ? `${(a.priceAmount || 0).toLocaleString('de-DE')} Pkt.` : `${a.priceAmount}× ${tmTokenLabel(a.priceTokenType)}`; }

async function renderTokenMarket() {
  el('mkRoot').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h2 style="margin:0">🎁 Token-Markt</h2>
      <span id="tmPoints" class="price-tag">… Pkt.</span>
    </div>
    <div style="display:flex;gap:6px;margin-bottom:12px">
      <button id="tvAuc" style="flex:1">🏛️ Auktionen</button>
      <button id="tvWants" class="secondary" style="flex:1">🔎 Gesuche</button>
      <button id="tvCreate" class="secondary" style="flex:1">📤 Einstellen</button>
      <button id="tvTrade" class="secondary" style="flex:1">🔄 Tausch</button>
    </div>
    <div id="tmBody"><div style="${tmMuted}">Lade…</div></div>`;
  el('tvAuc').onclick = () => { tokenView = 'auctions'; renderTokenView(); };
  el('tvWants').onclick = () => { tokenView = 'wants'; renderTokenView(); };
  el('tvCreate').onclick = () => { tokenView = 'create'; renderTokenView(); };
  el('tvTrade').onclick = () => { tokenView = 'trade'; renderTokenView(); };
  await loadTokenMarket();
}
async function loadTokenMarket() {
  try {
    const d = await fetch(`${config.tokenBase}/tokenmarket`, { headers: { Authorization: `Bearer ${sessionToken}` } }).then((r) => r.json());
    if (d.error) throw new Error(d.error);
    tmState = d;
    if (el('tmPoints')) el('tmPoints').textContent = `${(d.points || 0).toLocaleString('de-DE')} Pkt.`;
    renderTokenView();
  } catch { if (el('tmBody')) el('tmBody').innerHTML = '<div style="color:#ef4444;font-size:13px">Token-Markt konnte nicht geladen werden.</div>'; }
}
function renderTokenView() {
  [['tvAuc', 'auctions'], ['tvWants', 'wants'], ['tvCreate', 'create'], ['tvTrade', 'trade']].forEach(([id, v]) => { const b = el(id); if (b) b.className = tokenView === v ? '' : 'secondary'; });
  const body = el('tmBody'); if (!body || !tmState) return;
  if (tokenView === 'auctions') renderTokenAuctions(body);
  else if (tokenView === 'wants') renderTokenWants(body);
  else if (tokenView === 'create') renderTokenCreate(body);
  else renderTokenTrade(body);
}
// Token-Gesuche (Suche Token X, biete …) — stöbern, erfüllen, selbst aufgeben
function renderTokenWants(body) {
  const wants = tmState.wants || [];
  let html = '<div style="margin-bottom:12px"><button id="twNew">➕ Gesuch aufgeben</button></div>';
  html += wants.length ? wants.map((w) => `
    <div class="tm-row"><div class="tm-info"><b>Suche ${w.wantQty}× ${tmTokenLabel(w.wantTokenType)}</b><span style="${tmMuted}">bietet ${escapeHtml(w.offerText || '')} · von ${escapeHtml(w.requesterName || '?')}</span></div>
      ${w.mine ? `<button class="secondary" data-wcancel="${w.id}">Zurückziehen</button>` : `<button data-wfill="${w.id}">Erfüllen</button>`}</div>`).join('')
    : `<div style="${tmMuted}">Keine Token-Gesuche. Gib selbst eins auf! 🔎</div>`;
  body.innerHTML = html;
  el('twNew').onclick = () => showTokenWantForm(body);
  body.querySelectorAll('[data-wcancel]').forEach((b) => { b.onclick = () => apiAction('/wants/cancel', { wantId: b.dataset.wcancel }, '↩️ Gesuch zurückgezogen', loadTokenMarket); });
  body.querySelectorAll('[data-wfill]').forEach((b) => { b.onclick = () => apiAction('/wants/fulfill', { wantId: b.dataset.wfill }, '✅ Gesuch erfüllt!', loadTokenMarket); });
}
function showTokenWantForm(body) {
  const allTok = (tmState.tokenDefs || []).map((t) => `<option value="${t.id}">${t.emoji} ${t.label}</option>`).join('');
  const q25 = Array.from({ length: 25 }, (_, i) => `<option value="${i + 1}">${i + 1}×</option>`).join('');
  body.innerHTML = `
    <div class="tm-form">
      <label>Gesuchter Token</label><select id="twTok" class="bf-select">${allTok}</select>
      <label>Menge</label><select id="twQty" class="bf-select">${q25}</select>
      <label>Gebot-Art</label><select id="twKind" class="bf-select"><option value="points">💰 Punkte</option><option value="token">🎁 Token</option></select>
      <div id="twPriceWrap"></div>
      <div style="display:flex;gap:6px;margin-top:10px"><button id="twSubmit" style="flex:1">🔎 Gesuch aufgeben (${tmState.auctionHours || 72}h)</button><button id="twBack" class="secondary" style="flex:none">Zurück</button></div>
    </div>`;
  const fillPrice = () => {
    el('twPriceWrap').innerHTML = el('twKind').value === 'points'
      ? '<label>Gebot (Punkte)</label><input id="twAmt" type="number" min="1" placeholder="z.B. 400" class="tm-input">'
      : `<label>Gebot-Token</label><select id="twPtok" class="bf-select">${allTok}</select><label>Menge</label><select id="twPamt" class="bf-select">${q25}</select>`;
  };
  el('twKind').onchange = fillPrice; fillPrice();
  el('twBack').onclick = () => { tokenView = 'wants'; renderTokenView(); };
  el('twSubmit').onclick = () => {
    const kind = el('twKind').value;
    const payload = { wantKind: 'token', wantTokenType: el('twTok').value, wantQty: parseInt(el('twQty').value), offerKind: kind };
    if (kind === 'points') { const a = parseInt(el('twAmt').value); if (!a || a <= 0) { showToast('Bitte gültiges Punkte-Gebot eingeben', 'error'); return; } payload.offerAmount = a; }
    else { payload.offerAmount = parseInt(el('twPamt').value); payload.offerTokenType = el('twPtok').value; }
    apiAction('/wants/create', payload, '🔎 Gesuch aufgegeben', () => { tokenView = 'wants'; loadTokenMarket(); });
  };
}
function renderTokenAuctions(body) {
  const list = tmState.auctions || [];
  if (!list.length) { body.innerHTML = `<div style="${tmMuted}">Keine aktiven Angebote. Stell selbst welche ein! 📤</div>`; return; }
  body.innerHTML = list.map((a) => `
    <div class="tm-row">
      <div class="tm-info"><b>${a.qty}× ${tmTokenLabel(a.tokenType)}</b><span style="${tmMuted}">${tmPriceText(a)} · von ${escapeHtml(a.sellerName || '?')}</span></div>
      ${a.mine ? `<button class="secondary" data-cancel="${a.id}">Abbrechen</button>` : `<button data-buy="${a.id}">Kaufen</button>`}
    </div>`).join('');
  body.querySelectorAll('[data-buy]').forEach((b) => { b.onclick = () => apiAction('/tokenmarket/auction/buy', { auctionId: b.dataset.buy }, '🎉 Token gekauft!', loadTokenMarket); });
  body.querySelectorAll('[data-cancel]').forEach((b) => { b.onclick = () => apiAction('/tokenmarket/auction/cancel', { auctionId: b.dataset.cancel }, '↩️ Auktion abgebrochen', loadTokenMarket); });
}
function renderTokenCreate(body) {
  const owned = (tmState.tokenDefs || []).filter((t) => (tmState.inventory?.[t.id] || 0) > 0);
  if (!owned.length) { body.innerHTML = `<div style="${tmMuted}">Du hast keine Token zum Verkaufen. Kauf dir eine Lootbox! 🎁</div>`; return; }
  const ownedOpts = owned.map((t) => `<option value="${t.id}">${t.emoji} ${t.label} (${tmState.inventory[t.id]}×)</option>`).join('');
  const allOpts = (tmState.tokenDefs || []).map((t) => `<option value="${t.id}">${t.emoji} ${t.label}</option>`).join('');
  const q25 = Array.from({ length: 25 }, (_, i) => `<option value="${i + 1}">${i + 1}×</option>`).join('');
  body.innerHTML = `
    <div class="tm-form">
      <label>Token</label><select id="acTok" class="bf-select">${ownedOpts}</select>
      <label>Menge</label><select id="acQty" class="bf-select"></select>
      <label>Preis-Art</label><select id="acKind" class="bf-select"><option value="points">💰 Punkte</option><option value="token">🎁 Anderer Token</option></select>
      <div id="acPriceWrap"></div>
      <button id="acSubmit" style="width:100%;margin-top:10px">📤 Einstellen (${tmState.auctionHours || 48}h)</button>
    </div>`;
  const fillQty = () => { const max = Math.min(25, tmState.inventory[el('acTok').value] || 1); el('acQty').innerHTML = Array.from({ length: max }, (_, i) => `<option value="${i + 1}">${i + 1}×</option>`).join(''); };
  const fillPrice = () => {
    el('acPriceWrap').innerHTML = el('acKind').value === 'points'
      ? '<label>Preis (Punkte)</label><input id="acAmt" type="number" min="1" placeholder="z.B. 400" class="tm-input">'
      : `<label>Preis-Token</label><select id="acPtok" class="bf-select">${allOpts}</select><label>Menge</label><select id="acPamt" class="bf-select">${q25}</select>`;
  };
  el('acTok').onchange = fillQty; el('acKind').onchange = fillPrice; fillQty(); fillPrice();
  el('acSubmit').onclick = () => {
    const kind = el('acKind').value;
    const payload = { tokenType: el('acTok').value, qty: parseInt(el('acQty').value), priceKind: kind };
    if (kind === 'points') { const amt = parseInt(el('acAmt').value); if (!amt || amt <= 0) { showToast('Bitte gültigen Punkte-Preis eingeben', 'error'); return; } payload.priceAmount = amt; }
    else { payload.priceAmount = parseInt(el('acPamt').value); payload.priceTokenType = el('acPtok').value; }
    apiAction('/tokenmarket/auction/create', payload, '🏛️ Auktion erstellt', () => { tokenView = 'auctions'; loadTokenMarket(); });
  };
}
function renderTokenTrade(body) {
  const owned = (tmState.tokenDefs || []).filter((t) => (tmState.inventory?.[t.id] || 0) > 0);
  const players = tmState.players || [];
  const inc = tmState.trades?.incoming || [], out = tmState.trades?.outgoing || [];
  let html = '<div class="tm-sec">📨 Eingehende Angebote</div>';
  html += inc.length ? inc.map((t) => `
    <div class="tm-row"><div class="tm-info"><b>von ${escapeHtml(t.fromName)}</b><span style="${tmMuted}">Du bekommst ${t.giveQty}× ${tmTokenLabel(t.giveType)} · gibst ${t.wantQty}× ${tmTokenLabel(t.wantType)}</span></div>
      <div style="display:flex;gap:6px"><button data-acc="${t.id}">✅</button><button class="secondary" data-dec="${t.id}">✖️</button></div></div>`).join('') : `<div style="${tmMuted}">Keine.</div>`;
  html += '<div class="tm-sec">📤 Meine Angebote</div>';
  html += out.length ? out.map((t) => `
    <div class="tm-row"><div class="tm-info"><b>an ${escapeHtml(t.toName)}</b><span style="${tmMuted}">${t.giveQty}× ${tmTokenLabel(t.giveType)} → ${t.wantQty}× ${tmTokenLabel(t.wantType)}</span></div>
      <button class="secondary" data-cxl="${t.id}">Zurückziehen</button></div>`).join('') : `<div style="${tmMuted}">Keine.</div>`;
  html += '<div class="tm-sec">🔄 Neues Angebot</div>';
  if (!owned.length) html += `<div style="${tmMuted}">Du hast keine Token zum Tauschen.</div>`;
  else if (!players.length) html += `<div style="${tmMuted}">Keine Online-Spieler als Tauschpartner. (Offline-Tausch geht im Discord.)</div>`;
  else {
    const pOpts = players.map((p) => `<option value="${p.steamId}">${escapeHtml(p.name)}</option>`).join('');
    const ownedOpts = owned.map((t) => `<option value="${t.id}">${t.emoji} ${t.label} (${tmState.inventory[t.id]}×)</option>`).join('');
    const allOpts = (tmState.tokenDefs || []).map((t) => `<option value="${t.id}">${t.emoji} ${t.label}</option>`).join('');
    const q25 = Array.from({ length: 25 }, (_, i) => `<option value="${i + 1}">${i + 1}×</option>`).join('');
    html += `<div class="tm-form">
      <label>Partner (online)</label><select id="trUser" class="bf-select">${pOpts}</select>
      <label>Du gibst</label><div style="display:flex;gap:6px"><select id="trGive" class="bf-select" style="flex:1">${ownedOpts}</select><select id="trGiveQ" class="bf-select" style="flex:none;width:84px"></select></div>
      <label>Du willst dafür</label><div style="display:flex;gap:6px"><select id="trWant" class="bf-select" style="flex:1">${allOpts}</select><select id="trWantQ" class="bf-select" style="flex:none;width:84px">${q25}</select></div>
      <button id="trSend" style="width:100%;margin-top:10px">🔄 Angebot senden</button></div>`;
  }
  body.innerHTML = html;
  body.querySelectorAll('[data-acc]').forEach((b) => { b.onclick = () => apiAction('/tokenmarket/trade/accept', { tradeId: b.dataset.acc }, '🤝 Tausch angenommen', loadTokenMarket); });
  body.querySelectorAll('[data-dec]').forEach((b) => { b.onclick = () => apiAction('/tokenmarket/trade/cancel', { tradeId: b.dataset.dec }, '✖️ Abgelehnt', loadTokenMarket); });
  body.querySelectorAll('[data-cxl]').forEach((b) => { b.onclick = () => apiAction('/tokenmarket/trade/cancel', { tradeId: b.dataset.cxl }, '↩️ Zurückgezogen', loadTokenMarket); });
  if (el('trSend')) {
    const fillGiveQ = () => { const max = Math.min(25, tmState.inventory[el('trGive').value] || 1); el('trGiveQ').innerHTML = Array.from({ length: max }, (_, i) => `<option value="${i + 1}">${i + 1}×</option>`).join(''); };
    el('trGive').onchange = fillGiveQ; fillGiveQ();
    el('trSend').onclick = () => {
      const u = players.find((p) => p.steamId === el('trUser').value);
      apiAction('/tokenmarket/trade/offer', { toSteamId: el('trUser').value, toName: u?.name || 'Spieler', giveType: el('trGive').value, giveQty: parseInt(el('trGiveQ').value), wantType: el('trWant').value, wantQty: parseInt(el('trWantQ').value) }, '📨 Angebot gesendet', loadTokenMarket);
    };
  }
}

// ── Meine Angebote (alle eigenen Listings + Gesuche, zentral zurückziehbar) ──
async function renderMyOffers() {
  el('mkRoot').innerHTML = '<h2 style="margin:0 0 12px">📋 Meine Angebote</h2><div id="myBody"><div style="' + tmMuted + '">Lade…</div></div>';
  try {
    const [m, tm] = await Promise.all([
      fetch(`${config.tokenBase}/market`, { headers: { Authorization: `Bearer ${sessionToken}` } }).then((r) => r.json()),
      fetch(`${config.tokenBase}/tokenmarket`, { headers: { Authorization: `Bearer ${sessionToken}` } }).then((r) => r.json()),
    ]);
    const lbl = (id, data) => { const d = (data.tokenDefs || []).find((x) => x.id === id) || { emoji: '🎁', label: id }; return `${d.emoji} ${d.label}`; };
    const rows = [];
    (m.offers || []).filter((o) => o.mine).forEach((o) => rows.push({ t: `🦖 ${o.dino} — ${(o.price || 0).toLocaleString('de-DE')} Pkt.`, sub: 'Dino-Angebot', act: () => apiAction('/market/withdraw', { offerId: o.id }, '↩️ Zurückgezogen', renderMyOffers) }));
    (m.wants || []).filter((w) => w.mine).forEach((w) => rows.push({ t: `🔎 Suche ${w.wantDino} — bietet ${w.offerText}`, sub: 'Dino-Gesuch', act: () => apiAction('/wants/cancel', { wantId: w.id }, '↩️ Zurückgezogen', renderMyOffers) }));
    (tm.auctions || []).filter((a) => a.mine).forEach((a) => rows.push({ t: `🏛️ ${a.qty}× ${lbl(a.tokenType, tm)} — ${a.priceText}`, sub: 'Token-Auktion', act: () => apiAction('/tokenmarket/auction/cancel', { auctionId: a.id }, '↩️ Zurückgezogen', renderMyOffers) }));
    (tm.wants || []).filter((w) => w.mine).forEach((w) => rows.push({ t: `🔎 Suche ${w.wantQty}× ${lbl(w.wantTokenType, tm)} — bietet ${w.offerText}`, sub: 'Token-Gesuch', act: () => apiAction('/wants/cancel', { wantId: w.id }, '↩️ Zurückgezogen', renderMyOffers) }));
    (tm.trades?.outgoing || []).forEach((t) => rows.push({ t: `🔄 an ${t.toName}: ${t.giveQty}× ${lbl(t.giveType, tm)} → ${t.wantQty}× ${lbl(t.wantType, tm)}`, sub: 'Tausch-Angebot', act: () => apiAction('/tokenmarket/trade/cancel', { tradeId: t.id }, '↩️ Zurückgezogen', renderMyOffers) }));
    const body = el('myBody'); if (!body) return;
    if (!rows.length) { body.innerHTML = `<div style="${tmMuted}">Du hast keine aktiven Angebote oder Gesuche.</div>`; return; }
    body.innerHTML = '';
    rows.forEach((r) => {
      const d = document.createElement('div'); d.className = 'tm-row';
      d.innerHTML = `<div class="tm-info"><b>${escapeHtml(r.t)}</b><span style="${tmMuted}">${r.sub}</span></div>`;
      const btn = document.createElement('button'); btn.className = 'secondary'; btn.textContent = 'Zurückziehen'; btn.onclick = r.act;
      d.appendChild(btn); body.appendChild(d);
    });
  } catch { const b = el('myBody'); if (b) b.innerHTML = '<div style="color:#ef4444;font-size:13px">Konnte nicht geladen werden.</div>'; }
}

// ── Dino-Token-Verwaltung (Staff: geben / bearbeiten / löschen) ─────────────
let dtTab = 'give';                 // 'give' | 'edit' | 'delete'
let dtCfg = null;                   // {species, dietBySpecies, primeLabels, mutations}
let dtUsers = [], dtRoles = [];
let dtSel = { species: null, gender: 'Male', grow: 25, elder: 0, primes: [], mut: { base: [], parent: [], elder: [] }, targetKind: 'user' };

async function ensureDtLoaded() {
  if (!isStaff) return;
  if (dtCfg) { renderDtTab(); return; }
  const body = el('dtBody'); if (body) body.innerHTML = '<div class="dt-muted">Lade…</div>';
  dtTab = 'give';
  dtSel = { species: null, gender: 'Male', grow: 25, elder: 0, primes: [], mut: { base: [], parent: [], elder: [] }, targetKind: 'user' };
  try {
    const [cfg, users, roles] = await Promise.all([
      fetch(`${config.tokenBase}/admin/dino-token/config`, { headers: { Authorization: `Bearer ${sessionToken}` } }).then((r) => r.json()),
      fetch(`${config.tokenBase}/admin/users`, { headers: { Authorization: `Bearer ${sessionToken}` } }).then((r) => r.json()).catch(() => ({ users: [] })),
      isIngame ? fetch(`${config.tokenBase}/admin/roles`, { headers: { Authorization: `Bearer ${sessionToken}` } }).then((r) => r.json()).catch(() => ({ roles: [] })) : Promise.resolve({ roles: [] }),
    ]);
    if (cfg.error) throw new Error(cfg.error);
    dtCfg = cfg; dtUsers = users.users || []; dtRoles = roles.roles || [];
    dtSel.species = (dtCfg.species || [])[0] || '';
  } catch (e) { const b = el('dtBody'); if (b) b.innerHTML = `<div style="color:#ef4444;font-size:13px">Konnte nicht laden: ${escapeHtml(e.message || '')}</div>`; return; }
  renderDtTab();
}
function renderDtTab() {
  [['dtTabGive', 'give'], ['dtTabEdit', 'edit'], ['dtTabDel', 'delete']].forEach(([id, v]) => { const b = el(id); if (b) b.className = dtTab === v ? '' : 'secondary'; });
  if (dtTab === 'give') renderDtGive(); else renderDtEditDelete();
}
function dtDiet() { return (dtCfg.dietBySpecies || {})[(dtSel.species || '').split('_')[0]] || 'both'; }
function renderDtPrime() {
  const box = el('dtPrime'); if (!box) return;
  box.innerHTML = (dtCfg.primeLabels || []).map((lbl, i) => { const n = i + 1; const on = dtSel.primes.includes(n); return `<span class="dt-chip${on ? ' on' : ''}" data-prime="${n}">${n}. ${escapeHtml(lbl)}</span>`; }).join('');
  box.querySelectorAll('[data-prime]').forEach((ch) => { ch.onclick = () => { const n = parseInt(ch.dataset.prime); const i = dtSel.primes.indexOf(n); if (i >= 0) dtSel.primes.splice(i, 1); else dtSel.primes.push(n); const l = el('dtPrimeLbl'); if (l) l.textContent = `Prime-Bedingungen (${dtSel.primes.length}/10)`; renderDtPrime(); renderDtMut(); }; });
}
function renderDtMut() {
  const box = el('dtMut'); if (!box) return;
  const c = dtSel, diet = dtDiet(), gender = c.gender;
  const list = (dtCfg.mutations || []).filter((m) => (m.diet === 'both' || m.diet === diet) && (!m.femaleOnly || gender === 'female' || gender === 'Female'));
  const primeCount = c.primes.length, baseMax = primeCount >= 5 ? 4 : 3, elderUnlocked = primeCount >= 1;
  const valid = new Set(list.map((m) => m.value));
  c.mut.base = c.mut.base.filter((v) => valid.has(v)).slice(0, baseMax);
  c.mut.parent = c.mut.parent.filter((v) => valid.has(v)).slice(0, 4);
  c.mut.elder = elderUnlocked ? c.mut.elder.filter((v) => valid.has(v)).slice(0, 8) : [];
  const group = (key, title, max, enabled) => {
    if (!enabled) return `<div class="dt-sec">${title} — gesperrt (≥1 Prime nötig)</div>`;
    const others = new Set([...(key !== 'base' ? c.mut.base : []), ...(key !== 'parent' ? c.mut.parent : []), ...(key !== 'elder' ? c.mut.elder : [])]);
    const sel = new Set(c.mut[key]);
    const chips = list.map((m) => { const on = sel.has(m.value); const dim = others.has(m.value) && !on; return `<span class="dt-chip${on ? ' on' : ''}${dim ? ' dim' : ''}" data-mut="${key}" data-val="${escapeHtml(m.value)}" title="${escapeHtml(m.description || '')}">${escapeHtml(m.label)}</span>`; }).join('');
    return `<div class="dt-sec">${title} (${sel.size}/${max})</div><div class="dt-chips">${chips}</div>`;
  };
  box.innerHTML = group('base', '🧬 Base', baseMax, true) + group('parent', '🧬 Parent', 4, true) + group('elder', '🧬 Elder', 8, elderUnlocked);
  box.querySelectorAll('[data-mut]').forEach((ch) => { ch.onclick = () => {
    const key = ch.dataset.mut, val = ch.dataset.val, arr = c.mut[key], i = arr.indexOf(val);
    const max = key === 'base' ? baseMax : key === 'parent' ? 4 : 8;
    if (i >= 0) arr.splice(i, 1); else { if (arr.length >= max) { showToast(`Max. ${max} in ${key}`, 'error'); return; } arr.push(val); }
    renderDtMut();
  }; });
}
function renderDtGive() {
  const c = dtSel;
  const userOpts = dtUsers.map((u) => `<option value="${u.steamId}">${escapeHtml(u.name)}</option>`).join('');
  const roleOpts = dtRoles.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
  const spOpts = (dtCfg.species || []).map((s) => `<option value="${s}"${s === c.species ? ' selected' : ''}>${s}</option>`).join('');
  el('dtBody').innerHTML = `
    <div class="dt-form">
      <label>Ziel</label>
      <select id="dtKind" class="bf-select">
        <option value="user"${c.targetKind === 'user' ? ' selected' : ''}>👤 Einzelner Spieler</option>
        <option value="role"${c.targetKind === 'role' ? ' selected' : ''}>👥 Rolle (alle Verknüpften)</option>
        <option value="online"${c.targetKind === 'online' ? ' selected' : ''}>🌐 Alle Online</option>
      </select>
      <div id="dtTargetBox"></div>
      <label>Spezies</label><select id="dtSpecies" class="bf-select">${spOpts}</select>
      <div class="dt-row">
        <div style="flex:1"><label>Geschlecht</label><select id="dtGender" class="bf-select"><option value="Male"${c.gender === 'Male' ? ' selected' : ''}>♂ Male</option><option value="Female"${c.gender === 'Female' ? ' selected' : ''}>♀ Female</option></select></div>
        <div style="flex:1"><label>Wachstum %</label><input id="dtGrow" type="number" min="1" max="100" value="${c.grow}" class="tm-input"></div>
        <div style="flex:1"><label>Elder-Stacks</label><select id="dtElder" class="bf-select">${[0, 1, 2, 3].map((n) => `<option value="${n}"${c.elder === n ? ' selected' : ''}>${n}×</option>`).join('')}</select></div>
      </div>
      <label id="dtPrimeLbl">Prime-Bedingungen (${c.primes.length}/10)</label>
      <div class="dt-chips" id="dtPrime"></div>
      <div id="dtMut"></div>
      <button id="dtGiveSubmit" style="width:100%;margin-top:14px;background:#16a34a">🎁 Token geben</button>
    </div>`;
  const renderTarget = () => {
    c.targetKind = el('dtKind').value;
    el('dtTargetBox').innerHTML = c.targetKind === 'user'
      ? `<label>Spieler</label><select id="dtUser" class="bf-select">${userOpts}</select>`
      : c.targetKind === 'role'
        ? `<label>Rolle</label><select id="dtRole" class="bf-select">${roleOpts}</select>`
        : '<div class="dt-muted" style="margin-top:6px">→ an alle aktuell online Spieler.</div>';
  };
  renderTarget();
  el('dtKind').onchange = renderTarget;
  el('dtSpecies').onchange = (e) => { c.species = e.target.value; renderDtMut(); };
  el('dtGender').onchange = (e) => { c.gender = e.target.value; renderDtMut(); };
  el('dtGrow').oninput = (e) => { c.grow = e.target.value; };
  el('dtElder').onchange = (e) => { c.elder = parseInt(e.target.value); };
  renderDtPrime(); renderDtMut();
  el('dtGiveSubmit').onclick = () => {
    const body = { targetKind: c.targetKind, dino: c.species, gender: el('dtGender').value, grow: (parseInt(el('dtGrow').value) || 25) / 100, elderStacks: c.elder, primes: c.primes, mutations: c.mut };
    if (c.targetKind === 'user') { const u = el('dtUser'); if (!u || !u.value) { showToast('Spieler wählen', 'error'); return; } body.targetSteamId = u.value; }
    else if (c.targetKind === 'role') { const r = el('dtRole'); if (!r || !r.value) { showToast('Rolle wählen', 'error'); return; } body.roleId = r.value; }
    apiAction('/admin/dino-token/create', body, '🎁 Dino-Token vergeben', () => { c.primes = []; c.mut = { base: [], parent: [], elder: [] }; renderDtPrime(); renderDtMut(); const l = el('dtPrimeLbl'); if (l) l.textContent = 'Prime-Bedingungen (0/10)'; });
  };
}
function renderDtEditDelete() {
  const userOpts = dtUsers.map((u) => `<option value="${u.steamId}">${escapeHtml(u.name)}</option>`).join('');
  el('dtBody').innerHTML = `
    <div class="dt-form">
      <label>Spieler (${dtTab === 'delete' ? 'Token löschen' : 'Token bearbeiten'})</label>
      <select id="dtEdUser" class="bf-select">${userOpts}</select>
      <button id="dtEdLoad" style="width:100%;margin-top:8px">📋 Garage laden</button>
    </div>
    <div id="dtEdList" style="margin-top:12px"></div>`;
  el('dtEdLoad').onclick = dtLoadGarage;
}
async function dtLoadGarage() {
  const sid = el('dtEdUser').value; if (!sid) { showToast('Spieler wählen', 'error'); return; }
  const box = el('dtEdList'); box.innerHTML = '<div class="dt-muted">Lade…</div>';
  try {
    const d = await fetch(`${config.tokenBase}/admin/dino-token/garage?steamId=${encodeURIComponent(sid)}`, { headers: { Authorization: `Bearer ${sessionToken}` } }).then((r) => r.json());
    if (d.error) throw new Error(d.error);
    const slots = d.slots || [];
    if (!slots.length) { box.innerHTML = '<div class="dt-muted">Garage leer.</div>'; return; }
    box.innerHTML = slots.map((s) => `<div class="dt-slot"><span>${escapeHtml(s.dino)} · ${Math.round((s.grow || 0) * 100)}% · ${escapeHtml(s.gender || '')}${s.isElder ? ' 👑' : ''}${s.isPrime ? ' ⭐' : ''}</span>${dtTab === 'delete' ? `<button class="secondary" data-del="${s.id}" style="flex:none;width:auto;padding:5px 10px;color:#fca5a5">🗑️</button>` : `<button data-edit="${s.id}" style="flex:none;width:auto;padding:5px 10px">✏️</button>`}</div>`).join('');
    box.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { if (b.dataset.armed) { apiAction('/admin/dino-token/delete', { targetSteamId: sid, slotId: b.dataset.del }, '🗑️ Token gelöscht', dtLoadGarage); } else { b.dataset.armed = '1'; b.textContent = 'Sicher?'; setTimeout(() => { b.textContent = '🗑️'; delete b.dataset.armed; }, 2500); } }; });
    box.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => dtOpenEdit(sid, slots.find((s) => s.id === b.dataset.edit)); });
  } catch (e) { box.innerHTML = `<div style="color:#ef4444;font-size:13px">${escapeHtml(e.message || '')}</div>`; }
}
function dtOpenEdit(steamId, slot) {
  if (!slot) return;
  const c = dtSel;
  c.species = slot.dino; c.gender = slot.gender || 'Male'; c.grow = Math.round((slot.grow || 0) * 100);
  c.elder = slot.elderStacks || 0; c.primes = (slot.primes || []).slice();
  c.mut = { base: (slot.mutations?.base || []).filter(Boolean), parent: (slot.mutations?.parent || []).filter(Boolean), elder: (slot.mutations?.elder || []).filter(Boolean) };
  el('dtBody').innerHTML = `
    <div class="dt-form">
      <div class="dt-sec">✏️ ${escapeHtml(slot.dino)} bearbeiten</div>
      <div class="dt-row">
        <div style="flex:1"><label>Geschlecht</label><select id="dtGender" class="bf-select"><option value="Male"${c.gender === 'Male' ? ' selected' : ''}>♂ Male</option><option value="Female"${c.gender === 'Female' ? ' selected' : ''}>♀ Female</option></select></div>
        <div style="flex:1"><label>Wachstum %</label><input id="dtGrow" type="number" min="1" max="100" value="${c.grow}" class="tm-input"></div>
        <div style="flex:1"><label>Elder-Stacks</label><select id="dtElder" class="bf-select">${[0, 1, 2, 3].map((n) => `<option value="${n}"${c.elder === n ? ' selected' : ''}>${n}×</option>`).join('')}</select></div>
      </div>
      <label id="dtPrimeLbl">Prime-Bedingungen (${c.primes.length}/10)</label>
      <div class="dt-chips" id="dtPrime"></div>
      <div id="dtMut"></div>
      <div class="dt-row" style="margin-top:14px"><button id="dtSave" style="flex:1;background:#16a34a">💾 Speichern</button><button id="dtBack" class="secondary" style="flex:none">Zurück</button></div>
    </div>`;
  el('dtGender').onchange = (e) => { c.gender = e.target.value; renderDtMut(); };
  el('dtGrow').oninput = (e) => { c.grow = e.target.value; };
  el('dtElder').onchange = (e) => { c.elder = parseInt(e.target.value); };
  renderDtPrime(); renderDtMut();
  el('dtBack').onclick = () => { dtTab = 'edit'; renderDtTab(); };
  el('dtSave').onclick = () => apiAction('/admin/dino-token/edit', { targetSteamId: steamId, slotId: slot.id, gender: el('dtGender').value, grow: (parseInt(el('dtGrow').value) || 1) / 100, elderStacks: c.elder, primes: c.primes, mutations: c.mut }, '💾 Token aktualisiert', () => { dtTab = 'edit'; renderDtTab(); });
}

// ── PvP-Builds + Prime auf aktiven Dino (Staff) ─────────────────────────────
let ppBuilds = [], ppUsers = [], ppRoles = [], ppPrimeLabels = [], ppLoaded = false;
let ppGrantKind = 'user', ppPrimes = [];
async function ensurePvpLoaded() {
  if (!isStaff) return;
  if (ppLoaded) { renderPvpPrime(); return; }
  const body = el('ppBody'); if (body) body.innerHTML = '<div class="dt-muted">Lade…</div>';
  try {
    const [cfg, users, roles] = await Promise.all([
      fetch(`${config.tokenBase}/admin/pvp/config`, { headers: { Authorization: `Bearer ${sessionToken}` } }).then((r) => r.json()),
      fetch(`${config.tokenBase}/admin/users`, { headers: { Authorization: `Bearer ${sessionToken}` } }).then((r) => r.json()).catch(() => ({ users: [] })),
      isIngame ? fetch(`${config.tokenBase}/admin/roles`, { headers: { Authorization: `Bearer ${sessionToken}` } }).then((r) => r.json()).catch(() => ({ roles: [] })) : Promise.resolve({ roles: [] }),
    ]);
    if (cfg.error) throw new Error(cfg.error);
    ppBuilds = cfg.builds || []; ppPrimeLabels = cfg.primeLabels || []; ppUsers = users.users || []; ppRoles = roles.roles || []; ppLoaded = true;
  } catch (e) { const b = el('ppBody'); if (b) b.innerHTML = `<div style="color:#ef4444;font-size:13px">Konnte nicht laden: ${escapeHtml(e.message || '')}</div>`; return; }
  renderPvpPrime();
}
function renderPpPrimeChips() {
  const box = el('ppPrChips'); if (!box) return;
  box.innerHTML = ppPrimeLabels.map((lbl, i) => { const n = i + 1; const on = ppPrimes.includes(n); return `<span class="dt-chip${on ? ' on' : ''}" data-pp="${n}">${n}. ${escapeHtml(lbl)}</span>`; }).join('');
  box.querySelectorAll('[data-pp]').forEach((ch) => { ch.onclick = () => { const n = parseInt(ch.dataset.pp); const i = ppPrimes.indexOf(n); if (i >= 0) ppPrimes.splice(i, 1); else ppPrimes.push(n); const l = el('ppPrLbl'); if (l) l.textContent = `Prime-Bedingungen (${ppPrimes.length}/10)`; renderPpPrimeChips(); }; });
}
function renderPvpPrime() {
  const userOpts = ppUsers.map((u) => `<option value="${u.steamId}">${escapeHtml(u.name)}</option>`).join('');
  const roleOpts = ppRoles.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
  const buildOpts = ppBuilds.map((b) => `<option value="${b.key}">${escapeHtml(b.label)}</option>`).join('');
  el('ppBody').innerHTML = `
    <div class="dt-sec">🏆 PvP-Turnier-Builds</div>
    <div class="dt-form">
      <label>Ziel</label>
      <select id="ppKind" class="bf-select"><option value="user">👤 Spieler</option><option value="role">👥 Rolle (alle)</option><option value="online">🌐 Alle Online</option></select>
      <div id="ppTargetBox"></div>
      <label>Build</label><select id="ppBuild" class="bf-select">${buildOpts}</select>
      <div class="dt-row" style="margin-top:10px"><button id="ppGrant" style="flex:1;background:#16a34a">🏆 Build geben</button><button id="ppRemove" class="secondary" style="flex:1">🧹 Einsammeln</button></div>
      <div class="dt-muted" style="margin-top:4px">„Einsammeln" entfernt nur PvP-Build-Dinos (normale Garage bleibt).</div>
    </div>
    <div class="dt-sec" style="margin-top:18px">⭐ Prime auf aktiven Dino (live)</div>
    <div class="dt-form">
      <label>Spieler (muss ingame sein)</label><select id="ppPrUser" class="bf-select">${userOpts}</select>
      <label id="ppPrLbl">Prime-Bedingungen (${ppPrimes.length}/10)</label>
      <div class="dt-chips" id="ppPrChips"></div>
      <button id="ppPrApply" style="width:100%;margin-top:10px">⭐ Prime setzen</button>
    </div>`;
  const renderTarget = () => {
    ppGrantKind = el('ppKind').value;
    el('ppTargetBox').innerHTML = ppGrantKind === 'user' ? `<label>Spieler</label><select id="ppUser" class="bf-select">${userOpts}</select>`
      : ppGrantKind === 'role' ? `<label>Rolle</label><select id="ppRole" class="bf-select">${roleOpts}</select>`
        : '<div class="dt-muted" style="margin-top:6px">→ an alle aktuell online Spieler.</div>';
  };
  renderTarget(); el('ppKind').onchange = renderTarget;
  const grantBody = () => {
    const b = { targetKind: ppGrantKind };
    if (ppGrantKind === 'user') { const u = el('ppUser'); if (!u || !u.value) { showToast('Spieler wählen', 'error'); return null; } b.targetSteamId = u.value; }
    else if (ppGrantKind === 'role') { const r = el('ppRole'); if (!r || !r.value) { showToast('Rolle wählen', 'error'); return null; } b.roleId = r.value; }
    return b;
  };
  el('ppGrant').onclick = () => { const b = grantBody(); if (!b) return; b.buildKey = el('ppBuild').value; apiAction('/admin/pvp/grant', b, '🏆 PvP-Build vergeben', null); };
  el('ppRemove').onclick = () => { const b = grantBody(); if (!b) return; apiAction('/admin/pvp/remove', b, '🧹 PvP-Builds eingesammelt', null); };
  renderPpPrimeChips();
  el('ppPrApply').onclick = () => { const u = el('ppPrUser'); if (!u || !u.value) { showToast('Spieler wählen', 'error'); return; } apiAction('/admin/prime', { targetSteamId: u.value, primes: ppPrimes }, '⭐ Prime gesetzt', null); };
}

// ── Account-Verwaltung (nur Admin): Discord↔Steam Link / Find / Dupes ───────
function renderAccount() {
  el('acBody').innerHTML = `
    <div class="dt-sec">🔍 Verknüpfung suchen</div>
    <div class="dt-form">
      <label>Discord-ID ODER Steam-ID</label>
      <input id="acFindInput" class="tm-input" placeholder="Discord-ID oder SteamID64…">
      <button id="acFindBtn" style="width:100%;margin-top:6px">🔍 Suchen</button>
      <div id="acFindResult" style="margin-top:8px"></div>
    </div>
    <div class="dt-sec" style="margin-top:18px">🔗 Verknüpfung setzen</div>
    <div class="dt-form">
      <div class="dt-row"><div style="flex:1"><label>Discord-ID</label><input id="acLinkD" class="tm-input" placeholder="Discord-ID"></div><div style="flex:1"><label>Steam-ID</label><input id="acLinkS" class="tm-input" placeholder="7656119…"></div></div>
      <button id="acLinkBtn" style="width:100%;margin-top:8px;background:#16a34a">🔗 Verknüpfen</button>
      <div id="acLinkResult" class="dt-muted" style="margin-top:6px"></div>
    </div>
    <div class="dt-sec" style="margin-top:18px">🔁 Duplikate</div>
    <div class="dt-form">
      <button id="acDupBtn" style="width:100%">🔁 Duplikate suchen</button>
      <div id="acDupList" style="margin-top:8px"></div>
    </div>`;
  el('acFindBtn').onclick = acFind;
  el('acLinkBtn').onclick = acLink;
  el('acDupBtn').onclick = acDups;
}
const acHdr = () => ({ Authorization: `Bearer ${sessionToken}` });
function acLinkRow(r) {
  return `<div class="dt-slot"><span>${escapeHtml(r.name || r.discordId)} · 🆔 ${escapeHtml(r.discordId)}${r.steamId ? ` ↔ 🎮 ${escapeHtml(r.steamId)}` : ''}</span><button class="secondary" data-unlink="${escapeHtml(r.discordId)}" style="flex:none;width:auto;padding:5px 10px;color:#fca5a5">Lösen</button></div>`;
}
async function acFind() {
  const v = el('acFindInput').value.trim(); if (!v) { showToast('ID eingeben', 'error'); return; }
  const q = /^7656119\d{10}$/.test(v) ? `steamId=${encodeURIComponent(v)}` : `discordId=${encodeURIComponent(v)}`;
  const box = el('acFindResult'); box.innerHTML = '<div class="dt-muted">Suche…</div>';
  try {
    const d = await fetch(`${config.tokenBase}/admin/accounts/find?${q}`, { headers: acHdr() }).then((r) => r.json());
    if (d.error) throw new Error(d.error);
    box.innerHTML = d.results.length ? d.results.map(acLinkRow).join('') : '<div class="dt-muted">Keine Verknüpfung gefunden.</div>';
    box.querySelectorAll('[data-unlink]').forEach((b) => { b.onclick = () => apiAction('/admin/accounts/unlink', { discordId: b.dataset.unlink }, '🔗 Verknüpfung gelöst', acFind); });
  } catch (e) { box.innerHTML = `<div style="color:#ef4444;font-size:13px">${escapeHtml(e.message || '')}</div>`; }
}
async function acLink() {
  const did = el('acLinkD').value.trim(), sid = el('acLinkS').value.trim();
  if (!did || !sid) { showToast('Discord-ID + Steam-ID eingeben', 'error'); return; }
  const out = el('acLinkResult'); out.textContent = '…';
  try {
    const r = await fetch(`${config.tokenBase}/admin/accounts/link`, { method: 'POST', headers: { ...acHdr(), 'Content-Type': 'application/json' }, body: JSON.stringify({ discordId: did, steamId: sid }) });
    const d = await r.json(); if (!r.ok) throw new Error(apiErr(d));
    showToast('🔗 Verknüpft', 'success'); pollHud();
    let msg = '✅ Verknüpft.'; if (d.previous) msg += ` Vorher: ${d.previous}.`; if (d.alsoLinkedTo && d.alsoLinkedTo.length) msg += ` ⚠️ Diese SteamID ist auch verknüpft mit: ${d.alsoLinkedTo.join(', ')}.`;
    out.textContent = msg;
  } catch (e) { showToast(e.message, 'error'); out.textContent = '❌ ' + e.message; }
}
async function acDups() {
  const box = el('acDupList'); box.innerHTML = '<div class="dt-muted">Suche…</div>';
  try {
    const d = await fetch(`${config.tokenBase}/admin/accounts/dups`, { headers: acHdr() }).then((r) => r.json());
    if (d.error) throw new Error(d.error);
    if (!d.dups.length) { box.innerHTML = '<div class="dt-muted">Keine Duplikate. 👍</div>'; return; }
    box.innerHTML = d.dups.map((g) => `<div style="margin-bottom:10px"><div class="dt-muted">🎮 ${escapeHtml(g.steamId)} — ${g.accounts.length}× verknüpft</div>${g.accounts.map(acLinkRow).join('')}</div>`).join('');
    box.querySelectorAll('[data-unlink]').forEach((b) => { b.onclick = () => apiAction('/admin/accounts/unlink', { discordId: b.dataset.unlink }, '🔗 Verknüpfung gelöst', acDups); });
  } catch (e) { box.innerHTML = `<div style="color:#ef4444;font-size:13px">${escapeHtml(e.message || '')}</div>`; }
}

// ── Announce + Server-Steuerung (Staff: Announce/Status; Mod+: Wipe; Admin: Start/Stop/Restart) ──
async function svLoadStatus() {
  const box = el('svStatus'); if (!box) return; box.textContent = '…';
  try {
    const d = await fetch(`${config.tokenBase}/admin/server/status`, { headers: { Authorization: `Bearer ${sessionToken}` } }).then((r) => r.json());
    if (d.error) throw new Error(d.error);
    box.innerHTML = d.running ? '🟢 Server läuft' : '🔴 Server ist AUS';
  } catch (e) { box.innerHTML = `<span style="color:#ef4444">${escapeHtml(e.message || '')}</span>`; }
}
function svArmConfirm(btn, label, fn) {
  if (btn.dataset.armed) { fn(); return; }
  btn.dataset.armed = '1'; const t = btn.textContent; btn.textContent = label;
  setTimeout(() => { btn.textContent = t; delete btn.dataset.armed; }, 2500);
}
function renderServer() {
  let html = `
    <div class="dt-sec">📢 Ansage (ingame)</div>
    <div class="dt-form">
      <label>Nachricht an alle Spieler</label>
      <input id="svMsg" class="tm-input" placeholder="z.B. Event startet in 10 Min!">
      <button id="svAnnounce" style="width:100%;margin-top:8px">📢 Ansage senden</button>
    </div>
    <div class="dt-sec" style="margin-top:18px">📊 Server-Status</div>
    <div class="dt-form">
      <div id="svStatus" class="dt-muted">…</div>
      <button id="svStatusBtn" class="secondary" style="width:100%;margin-top:6px">🔄 Aktualisieren</button>
    </div>`;
  if (isIngame) html += `
    <div class="dt-sec" style="margin-top:18px">🧹 Wartung</div>
    <div class="dt-form"><button id="svWipe" style="width:100%">🧹 Kadaver leeren (wipecorpses)</button></div>`;
  if (isAdmin) html += `
    <div class="dt-sec" style="margin-top:18px">⚙️ Server-Steuerung (gefährlich)</div>
    <div class="dt-form"><div class="dt-row">
      <button id="svStart" style="flex:1;background:#16a34a">▶️ Start</button>
      <button id="svRestart" class="secondary" style="flex:1">🔁 Restart</button>
      <button id="svStop" style="flex:1;background:#b91c1c">⏹️ Stop</button>
    </div><div class="dt-muted" style="margin-top:4px">Stop/Restart trennt alle Spieler!</div></div>`;
  el('svBody').innerHTML = html;
  el('svAnnounce').onclick = () => { const m = el('svMsg').value.trim(); if (!m) { showToast('Nachricht eingeben', 'error'); return; } apiAction('/admin/server/announce', { message: m }, '📢 Ansage gesendet', () => { el('svMsg').value = ''; }); };
  el('svStatusBtn').onclick = svLoadStatus;
  if (el('svWipe')) el('svWipe').onclick = () => svArmConfirm(el('svWipe'), 'Sicher? Kadaver leeren', () => apiAction('/admin/server/wipecorpses', {}, '🧹 Kadaver geleert', null));
  if (el('svStart')) el('svStart').onclick = () => apiAction('/admin/server/control', { action: 'start' }, '▶️ Server-Start ausgelöst', svLoadStatus);
  if (el('svRestart')) el('svRestart').onclick = () => svArmConfirm(el('svRestart'), 'Sicher? Restart', () => apiAction('/admin/server/control', { action: 'restart' }, '🔁 Restart ausgelöst', svLoadStatus));
  if (el('svStop')) el('svStop').onclick = () => svArmConfirm(el('svStop'), 'Sicher? Stop', () => apiAction('/admin/server/control', { action: 'stop' }, '⏹️ Stop ausgelöst', svLoadStatus));
  svLoadStatus();
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
    { const im = el('di-img'); if (im) im.style.visibility = 'hidden'; }
    el('di-elder').innerHTML = '<span style="color:var(--muted);font-size:12px">—</span>';
    { const mu = el('di-mut'); if (mu) mu.innerHTML = '<span style="color:var(--muted);font-size:12px">—</span>'; }
    Object.keys(VITAL_TOKEN).forEach((k) => { const c = el(`di-tok-${k}`); if (c) c.innerHTML = ''; });
    DI_STATS.forEach((s) => { el(`di-${s.key}-f`).style.width = '0%'; el(`di-${s.key}-v`).textContent = '—'; });
    { const gf = el('di-grow-f'); if (gf) gf.style.width = '0%'; const gv = el('di-grow-v'); if (gv) gv.textContent = '—'; }
    lbCurGrowPct = 0;
    renderDiGrow(null); // offline: Grow-Menü-Hinweis
    checkPrimes(null);   // offline → Prime-Basis zurücksetzen
    return;
  }
  el('di-elder').innerHTML = elderHTML(d.primes);
  { const mu = el('di-mut'); if (mu) mu.innerHTML = mutHTML(d.mutations); }
  checkPrimes(d.primes, d.dino);   // schnellere Benachrichtigung solange F5 offen ist (2s)
  renderDinoTokens(d.tokens);
  el('di-dino').textContent = d.dino || 'Dino';
  el('di-name').textContent = `${d.gender || ''} · ${d.name || ''}`;
  { const im = el('di-img'); if (im) { const src = dinoImgSrc(d.dino); if (im.dataset.src !== src) { im.dataset.src = src; im.src = src; } im.style.visibility = 'visible'; } }
  const gp = Math.round((d.grow || 0) * 100);
  el('di-grow').textContent = `Wachstum ${gp}%`;
  { const gf = el('di-grow-f'); if (gf) gf.style.width = gp + '%'; const gv = el('di-grow-v'); if (gv) gv.textContent = gp + '%'; }
  lbCurGrowPct = gp;
  renderDiGrow(d.tokens); // Grow-Token-Seitenmenü aktualisieren

  DI_STATS.forEach((s) => {
    const pct = Math.max(0, Math.min(100, Math.round((d[s.key] ?? 0) * 100)));
    el(`di-${s.key}-f`).style.width = pct + '%';
    el(`di-${s.key}-v`).textContent = pct + '%';
  });
}

// Dock mit Blitz-Animation ein-/ausblenden. Öffnen-Keyframes werden zum
// Schließen exakt rückwärts abgespielt (.dock-closing). Nur bei echtem Übergang.
let dockShown = false;
let dockCloseTimer = null;
function setDockVisible(visible) {
  const d = el('dock'); if (!d) return;
  if (visible === dockShown) return;        // kein Zustandswechsel → keine Animation
  dockShown = visible;
  document.body.classList.toggle('dock-on', visible);   // animiertes Logo oben links ein-/ausblenden
  if (dockCloseTimer) { clearTimeout(dockCloseTimer); dockCloseTimer = null; }
  d.classList.remove('dock-opening', 'dock-closing');
  // reflow erzwingen, damit dieselbe Animation erneut starten kann
  // eslint-disable-next-line no-unused-expressions
  void d.offsetWidth;
  if (visible) {
    d.style.display = 'flex';
    d.classList.add('dock-opening');
    dockCloseTimer = setTimeout(() => { d.classList.remove('dock-opening'); dockCloseTimer = null; }, 520);
  } else {
    d.classList.add('dock-closing');         // Öffnen rückwärts
    dockCloseTimer = setTimeout(() => {
      d.classList.remove('dock-closing');
      if (!dockShown) d.style.display = 'none';
      dockCloseTimer = null;
    }, 520);
  }
}

function updateInteractive() {
  updateDockActive(); // Dock-Highlight immer am aktuellen Stand halten
  const anyPanel = settingsOpen || mapOpen || adminOpen || !!featureOpen;
  // Dock IMMER einblenden, sobald ein Panel offen ist (auch per Hotkey geöffnet), im „^"-Modus oder im Edit-Mode.
  setDockVisible(overlayMode || anyPanel || editMode);
  // Maus durchlassen nur wenn nichts offen ist (im Edit-Mode immer klickbar)
  window.bf.setInteractive(overlayMode || anyPanel || editMode);
  // Frisch geöffnete Panels im Edit-Mode sofort bearbeitbar machen (Resize-Griff)
  refreshEditAffordances();
  // Blitz-Rahmen an sichtbare Panels/Minimap anpassen (jetzt + nach Öffnen-Animation nachziehen)
  bfScheduleFrameSync();
}
let bfFrameSyncT = [];
function bfScheduleFrameSync() {
  syncLightningFrames();
  bfFrameSyncT.forEach(clearTimeout);
  bfFrameSyncT = [setTimeout(syncLightningFrames, 180), setTimeout(syncLightningFrames, 360)];
}

// ── Gezackte Blitz-Rahmen rund um Panels & Minimap ──────────────────────────
// Pro sichtbarem Ziel ein body-Element (#overflow-sicher) das exakt über dem Rand liegt;
// der SVG-Filter #bf-lightning verzerrt die Rahmenlinie zu flackernden Blitzen.
const bfFrames = new Map();
// Panel-Größe ändert sich (Inhalt lädt / Dino-Info/Gruppe/Profil aktualisiert sich) → Rahmen neu vermessen,
// sonst sitzt er auf der alten Größe (wirkt „mitten drin"). Debounced über rAF.
let bfRO = null, bfROqueued = false;
function bfEnsureRO() {
  if (bfRO || typeof ResizeObserver === 'undefined') return;
  bfRO = new ResizeObserver(() => {
    if (bfROqueued) return; bfROqueued = true;
    requestAnimationFrame(() => { bfROqueued = false; syncLightningFrames(); });
  });
}
function bfLightningTargets() {
  const out = [];
  document.querySelectorAll('.feature-panel').forEach((e) => out.push({ el: e, round: false }));
  for (const id of ['settings', 'adminPanel', 'bigMap']) { const e = el(id); if (e) out.push({ el: e, round: false }); }
  const ddBox = document.querySelector('#dinoDetail .box'); if (ddBox) out.push({ el: ddBox, round: false });
  const mm = el('minimap'); if (mm) out.push({ el: mm, round: true });
  return out;
}
function syncLightningFrames() {
  bfEnsureRO();
  for (const t of bfLightningTargets()) {
    let f = bfFrames.get(t.el);
    const shown = getComputedStyle(t.el).display !== 'none';
    const r = shown ? t.el.getBoundingClientRect() : null;
    if (!shown || !r || r.width < 6 || r.height < 6) { if (f) f.style.display = 'none'; continue; }
    if (bfRO) bfRO.observe(t.el);   // bei Größenänderung automatisch neu vermessen (idempotent)
    if (!f) {
      f = document.createElement('div');
      f.className = 'bf-bolt-frame' + (t.round ? ' round' : '');
      document.body.appendChild(f);
      bfFrames.set(t.el, f);
    }
    const pad = t.round ? 4 : 3;
    f.style.display = 'block';
    f.style.left = (r.left - pad) + 'px';
    f.style.top = (r.top - pad) + 'px';
    f.style.width = (r.width + pad * 2) + 'px';
    f.style.height = (r.height + pad * 2) + 'px';
  }
}
window.addEventListener('resize', syncLightningFrames);

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
  support:  dockSvg('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><path d="m4.93 4.93 4.24 4.24"/><path d="m14.83 9.17 4.24-4.24"/><path d="m14.83 14.83 4.24 4.24"/><path d="m9.17 14.83-4.24 4.24"/>'),
  dino:     dockSvg('<path d="M22 12h-2.5l-2 7-4-18-3 11H2"/>'),
  group:    dockSvg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  lexikon:  dockSvg('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'),
  garage:   dockSvg('<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'),
  market:   dockSvg('<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2 2h2l2.6 12.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L21.3 6H5.1"/>'),
  lootbox:  dockSvg('<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8S13 3 16.5 3a2.5 2.5 0 0 1 0 5"/>'),
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
  if (target === 'admin' && !isStaff) { showToast('Nur für Staff (Supporter/Moderator+)', 'error'); return; }
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
    if (zoneEditMode) { el('zonePanel').style.display = 'block'; renderZoneList(); syncZoneName(); updateZoneInfo(); }
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
  if (amDead) return false;                                // tot → niemand hört dich
  if (voiceMode === 'ptt') return pttHeld;                 // nur während Taste gehalten
  if (voiceMode === 'ptm') return micEnabled && !ptmHeld;  // an, außer Taste gehalten
  return micEnabled;                                       // offenes Mikro: an solange aktiviert
}

// Mikro-Sendezustand an den Voice-Modus angleichen
async function applyMic() {
  if (!room) return;
  // B-5: Fehler beim (De)Aktivieren nicht mehr verschlucken — sonst blieb „andere hören mich nicht"
  // komplett unsichtbar. Jetzt im DevTools-Log sichtbar.
  try { await room.localParticipant.setMicrophoneEnabled(isMicOn()); }
  catch (e) { console.error('[voice] Mikro (de)aktivieren fehlgeschlagen:', e); }
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
      // B-5: Ein suspendierter AudioContext liefert einen STUMMEN verarbeiteten Track → andere hören
      // einen nicht (Voice „einseitig") oder nur kurz, obwohl man verbunden ist. Kontext aufwecken und
      // aufgeweckt HALTEN (Browser suspendieren AudioContexts sonst wieder bei Inaktivität).
      const wake = () => { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); };
      wake();
      ctx.addEventListener('statechange', wake);
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
    isAdmin = !!data.admin;            // volle Config (Beschenken, Dino-Limits, Rollen)
    isIngame = !!data.ingame || isAdmin; // Ingame-Tools (Moderator+)
    isTeam = !!data.team || isAdmin;     // Owner/Admin/Support
    isStaff = isIngame || isTeam;        // sieht das Admin/Support-Panel (Support-Tools)
    { const ab = el('openAdminBtn'); if (ab) ab.style.display = isStaff ? 'block' : 'none'; }
    { const da = el('dockAdmin'); if (da) da.style.display = isStaff ? 'flex' : 'none'; }
    // Tickets/Events/Overlay-Gruppe laden + periodisch (Benachrichtigungen)
    loadMyTickets(); loadMyEvents(); loadOvGroup();
    if (!loadMyTickets._t) loadMyTickets._t = setInterval(loadMyTickets, 20000);
    if (!loadMyEvents._t) loadMyEvents._t = setInterval(loadMyEvents, 60000);
    if (!loadOvGroup._t) loadOvGroup._t = setInterval(loadOvGroup, 15000);
    // Kalibrierung & Zonen sind fertig (server-gespeichert) — Tools ausgeblendet,
    // damit niemand versehentlich etwas überschreibt. Bei Bedarf wieder einblendbar.
    el('calibBtn').style.display = 'none';
    el('zoneBtn').style.display = isStaff ? 'block' : 'none';
    renderHotkeys();
    if (data.name) el('hudName').textContent = data.name;
    setTier(data.tier);
    // Team/Admin bekommen die vollen Obsidian-Perks (Themes/Color-Picker/Zombie) — unabhängig vom
    // Abo bzw. falls die Discord-Rollen-Auflösung serverseitig mal nicht greift (sonst Schlösser für Teamler).
    setAboTier((data.team || data.admin) ? 'Obsidian' : data.aboTier);
    mySkinFree = !!data.skinFree;   // 🎨 Skin-Creator gratis (ab Knochen ODER Beta-Tester)
    setStaff(data.staff);
    pollHud();
    if (!pollHud._timer) pollHud._timer = setInterval(pollHud, 6000);
    if (!tickGrowTimer._timer) tickGrowTimer._timer = setInterval(tickGrowTimer, 1000);
    if (!pollGroupChat._timer) pollGroupChat._timer = setInterval(pollGroupChat, 4000);
    if (!pollVitals._timer) { pollVitals(); pollVitals._timer = setInterval(pollVitals, 500); }   // HP live (0,5s)
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
  room = new Room({
    adaptiveStream: false, dynacast: false, webAudioMix: true,
    // B-6: Auto-Gain-Control AUS — sonst regelt der Browser das Mikro über die Zeit selbstständig
    // leiser (mehrere Melder: „Mikro wird mit der Zeit leiser") und kämpft gegen den manuellen
    // Mic-Gain-Regler. Echo-Cancellation & Noise-Suppression bleiben an (LiveKit-Default).
    audioCaptureDefaults: { autoGainControl: false },
  });
  room
    .on(RoomEvent.Connected, () => { voiceConnected = true; refreshMicState(); el('connBtn').textContent = 'Trennen'; broadcastRange(); updateVoiceWarn(); setConnQuality(room.localParticipant.connectionQuality); startConnStats(); })
    .on(RoomEvent.Disconnected, () => { voiceConnected = false; el('connBtn').textContent = 'Verbinden'; setMicState('disconnected'); updateVoiceWarn(); stopConnStats(); renderConnInd(); _speakSeen.clear(); updateSpeakingBox(); })
    .on(RoomEvent.ConnectionQualityChanged, (q, p) => { if (room && p === room.localParticipant) setConnQuality(q); })
    .on(RoomEvent.ParticipantConnected, () => { broadcastRange(); if (settingsOpen) renderVoiceUsers(); })  // Neuer Teilnehmer lernt meine Reichweite
    .on(RoomEvent.ParticipantDisconnected, () => { if (settingsOpen) renderVoiceUsers(); })
    .on(RoomEvent.ActiveSpeakersChanged, (speakers) => updateSpeakingBox(speakers))   // wen man gerade hört
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
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => {
      // Audio-Elemente beim Verlassen wieder aus dem DOM nehmen (sonst Memory-Leak)
      if (track.kind === Track.Kind.Audio) {
        track.detach().forEach((el) => el.remove());
        updateProximityVolumes();
      }
    });
  try {
    await room.connect(url, token);
  } catch (e) {
    // Fehlversuch sauber zurückrollen, sonst bleibt ein toter Room hängen
    try { room.disconnect(); } catch {}
    room = null; voiceConnected = false;
    throw e;   // connectWithSession zeigt den Fehler-Toast
  }
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
  setMuteAllBtn();
}
function setDeafenBtn() {
  const b = el('deafenBtn'); if (!b) return;
  // „Ton an" leuchtet, „Ton aus" ist gedimmt (secondary) — synchron zum Mikro-Button.
  b.textContent = deafened ? '🔇 Ton aus' : '🔊 Ton an';
  b.classList.toggle('secondary', deafened);
  setMuteAllBtn();
}
function setMuteAllBtn() {
  const b = el('muteAllBtn'); if (!b) return;
  const both = !micEnabled && deafened;          // Ton UND Mikro stumm?
  b.textContent = both ? '🔔 Stumm aus' : '🔕 Alles stumm';
  b.classList.toggle('secondary', !both);        // hervorheben, wenn aktiv
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
  setDeafenBtn();
}

// Ein Klick = Ton UND Mikro stumm (bzw. beides wieder an).
async function toggleMuteAll() {
  const both = !micEnabled && deafened;
  if (both) { micEnabled = true; deafened = false; }
  else { micEnabled = false; deafened = true; }
  setMicBtn(); setDeafenBtn();                    // aktualisiert via setMuteAllBtn auch den Kombi-Button
  updateProximityVolumes();
  if (room) await applyMic();
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
// resize:true → zusätzlich skalierbar. Sonst nur verschiebbar (einheitliches Verhalten).
// HUD-Pille (oben mittig), Quest & Große Karte sind bewusst NICHT enthalten = nicht verschiebbar.
// resize: 'mini'|'scale'|true (true = Breite/Höhe). noMove: true → nur skalierbar, nicht verschiebbar.
// Große Karte (bigMap) ist bewusst NICHT enthalten = weder verschiebbar noch skalierbar.
const MOVABLE = [
  { id: 'minimapWrap', label: 'Minimap', resize: 'mini' },     // Part 3: verschiebbar + skalierbar
  { id: 'hudHeart',    label: 'Lebensanzeige', resize: 'scale' }, // Part 3b: Herz, verschiebbar + skalierbar
  { id: 'hudInfo',     label: 'Info-Boxen', resize: 'scale' }, // Part 4: entkoppelt verschiebbar + skalierbar
  { id: 'settings',    label: 'Einstellungen', resize: true },
  { id: 'dinoInfo',    label: 'Dino-Info (F5)', resize: true },
  { id: 'skinEditor',  label: 'Skin-Editor', resize: true },
  { id: 'garage',      label: 'Garage', resize: true },
  { id: 'market',      label: 'Markt', resize: true },
  { id: 'group',       label: 'Gruppe (F2)', resize: true },
  { id: 'profile',     label: 'Profil (F1)', resize: true },
  { id: 'lexikon',     label: 'Dino-Lexikon', resize: true },
  { id: 'quests',      label: 'Quests', resize: true },  // verschiebbar + skalierbar
];
let editMode = false;
function loadPositions() { try { return JSON.parse(localStorage.getItem('bf-layout')) || {}; } catch { return {}; } }
function savePositions(p) { localStorage.setItem('bf-layout', JSON.stringify(p)); }
function applySavedPositions() {
  const p = loadPositions();
  for (const m of MOVABLE) {
    const e = el(m.id), pos = p[m.id]; if (!e || !pos) continue;
    if (pos.scale) e.style.setProperty('--info-scale', pos.scale);        // Info-Boxen-Skalierung (vor transform setzen)
    if (pos.left) {
      e.style.left = pos.left; e.style.top = pos.top; e.style.right = 'auto'; e.style.bottom = 'auto';
      e.style.transform = (m.id === 'hudInfo' || m.id === 'hudHeart') ? 'scale(var(--info-scale,1))' : 'none';
    }
    if (pos.width) e.style.width = pos.width;
    if (pos.height) { e.style.height = pos.height; e.style.maxHeight = 'none'; }
    if (pos.miniSize) e.style.setProperty('--mini-size', pos.miniSize);   // Minimap-Größe
  }
}
function resetPositions() {
  localStorage.removeItem('bf-layout');
  for (const m of MOVABLE) {
    const e = el(m.id); if (!e) continue;
    e.style.left = ''; e.style.top = ''; e.style.right = ''; e.style.bottom = ''; e.style.transform = '';
    e.style.width = ''; e.style.height = ''; e.style.maxHeight = '';
    e.style.removeProperty('--mini-size');
    e.style.removeProperty('--info-scale');
  }
  showToast('Layout zurückgesetzt', 'success');
}
function setEditMode(on) {
  editMode = on;
  document.body.classList.toggle('bf-edit', on);
  if (!on) {
    // Edit-Mode aus → alle Bearbeitungs-Griffe entfernen
    for (const m of MOVABLE) {
      const e = el(m.id); if (!e) continue;
      e.classList.remove('bf-movable');
      removeResizeHandle(e);
    }
  }
  // Beim Einschalten KEINE Panels zwangsöffnen. Nur das, was gerade sichtbar ist
  // (HUD + Minimap, und später jedes geöffnete Panel), wird bearbeitbar.
  refreshEditAffordances();
  updateInteractive();   // Dock einblenden + Overlay klickbar machen
}
// Macht alle aktuell SICHTBAREN verschiebbaren Elemente bearbeitbar (Outline + Resize-Griff)
// und entfernt die Griffe von allem, was geschlossen ist. Wird bei jedem Panel-Öffnen/-Schließen
// aufgerufen, damit ein NEU geöffnetes Panel sofort anpassbar ist (fixt den Resize-Bug).
function refreshEditAffordances() {
  if (!editMode) return;
  for (const m of MOVABLE) {
    const e = el(m.id); if (!e) continue;
    const visible = getComputedStyle(e).display !== 'none';
    if (visible) {
      e.classList.add('bf-movable');
      e.dataset.editLabel = m.label;
      if (m.resize) addResizeHandle(e, m.id, m.resize); else removeResizeHandle(e);   // nur markierte Elemente skalierbar
    } else {
      e.classList.remove('bf-movable');
      removeResizeHandle(e);
    }
  }
}
function makeDraggable(elm, id) {
  let dragging = false, ox = 0, oy = 0;
  elm.addEventListener('mousedown', (e) => {
    if (!editMode) return;
    if (e.target.classList && e.target.classList.contains('bf-resize')) return; // Resize-Griff separat
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
    elm.style.right = 'auto'; elm.style.bottom = 'auto';
    // Skalierbare HUD-Elemente behalten ihren Transform; zentrierte Panels werden „entzentriert"
    elm.style.transform = (id === 'hudInfo' || id === 'hudHeart') ? 'scale(var(--info-scale,1))' : 'none';
    syncLightningFrames();   // Blitz-Rahmen mitziehen
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; elm.classList.remove('dragging');
    const p = loadPositions();
    p[id] = { ...(p[id] || {}), left: elm.style.left, top: elm.style.top };
    savePositions(p);
  });
}
// Resize-Griff unten rechts (nur im Edit-Mode). mode: 'mini' (quadratisch via --mini-size),
// 'scale' (Faktor via --info-scale, für die Info-Boxen), sonst Breite/Höhe.
function addResizeHandle(elm, id, mode) {
  if (elm.querySelector('.bf-resize')) return;
  const h = document.createElement('div'); h.className = 'bf-resize';
  let rz = false, sx = 0, sy = 0, sw = 0, sh = 0, ss = 0;
  const mv = (ev) => {
    if (!rz) return;
    if (mode === 'mini') {
      const d = Math.max(ev.clientX - sx, ev.clientY - sy);          // diagonal, bleibt quadratisch
      elm.style.setProperty('--mini-size', Math.max(140, Math.min(640, ss + d)) + 'px');
    } else if (mode === 'scale') {
      const d = Math.max(ev.clientX - sx, ev.clientY - sy);          // Faktor aus Diagonale
      elm.style.setProperty('--info-scale', Math.max(0.7, Math.min(2.2, ss + d / 220)).toFixed(3));
    } else {
      elm.style.width = Math.max(220, sw + (ev.clientX - sx)) + 'px';
      elm.style.height = Math.max(140, sh + (ev.clientY - sy)) + 'px';
      elm.style.maxHeight = 'none';
    }
    syncLightningFrames();   // Blitz-Rahmen mitskalieren
  };
  const up = () => {
    if (!rz) return; rz = false;
    window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
    const p = loadPositions();
    if (mode === 'mini') p[id] = { ...(p[id] || {}), miniSize: elm.style.getPropertyValue('--mini-size') };
    else if (mode === 'scale') p[id] = { ...(p[id] || {}), scale: elm.style.getPropertyValue('--info-scale') };
    else p[id] = { ...(p[id] || {}), width: elm.style.width, height: elm.style.height };
    savePositions(p);
  };
  h.addEventListener('mousedown', (e) => {
    if (!editMode) return;
    e.preventDefault(); e.stopPropagation();
    rz = true; const r = elm.getBoundingClientRect(); sx = e.clientX; sy = e.clientY; sw = r.width; sh = r.height;
    if (mode === 'mini') ss = parseInt(getComputedStyle(elm).getPropertyValue('--mini-size')) || el('minimap')?.getBoundingClientRect().width || r.width;
    else if (mode === 'scale') ss = parseFloat(getComputedStyle(elm).getPropertyValue('--info-scale')) || 1;
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  });
  elm.appendChild(h);
}
function removeResizeHandle(elm) { const h = elm.querySelector('.bf-resize'); if (h) h.remove(); }
function setupEditMode() {
  // HUD ist nicht mehr verschiebbar → evtl. alte gespeicherte Position entfernen, fix zentriert lassen
  { const p = loadPositions(); if (p.hud) { delete p.hud; savePositions(p); }
    const hudEl = el('hud'); if (hudEl) { hudEl.style.left = ''; hudEl.style.top = ''; hudEl.style.right = ''; hudEl.style.bottom = ''; hudEl.style.transform = ''; hudEl.style.width = ''; } }
  for (const m of MOVABLE) { const e = el(m.id); if (e && !m.noMove) makeDraggable(e, m.id); }
  applySavedPositions();
  el('editModeBtn').onclick = () => { setEditMode(true); toggleSettings(false); };
  el('editDoneBtn').onclick = () => { toggleSettings(true); setEditMode(false); };   // „Fertig" → zurück in die Einstellungen (Settings zuerst → kein Dock-Flackern)
  el('editResetBtn').onclick = () => resetPositions();
  const fxBtn = el('fxToggleBtn'); if (fxBtn) fxBtn.onclick = toggleFx;
  applyFx();
  const miniBtn = el('miniToggleBtn'); if (miniBtn) miniBtn.onclick = toggleMinimap;
  const blurBtn = el('blurToggleBtn'); if (blurBtn) blurBtn.onclick = toggleBlur;
  applyBlur();
  const lsBtn = el('lowSpecBtn'); if (lsBtn) lsBtn.onclick = toggleLowSpec;
  updateLowSpecBtn();
  applyMiniToggle();
  renderThemePicker();
  syncLightningFrames();   // Minimap-Blitzrahmen direkt anzeigen
}

init().then(() => setupEditMode());
