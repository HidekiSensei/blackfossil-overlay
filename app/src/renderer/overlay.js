import { Room, RoomEvent, Track, ParticipantEvent, AudioPresets } from 'livekit-client';
import { loadMapImage, drawFullMap, drawMinimap, drawHeatmap, normToWorld, worldToNorm, zoneAt, zonesAt, resetCal, solveAffine, getCal, setCalAffine, setZones, newZone, ZONES, ZONE_TYPES, ZONE_META, loadZoneLayer, setZoneLayer, isZoneLayerVisible, setGoldenZone, goldenZoneCenter, groupColorFor, setMarkerStyle, drawAiEncounters } from './map.js';
import { THEMES, makeTheme, aboIndex } from './shared/theme.js';
import { el, apiErr, makeApi, makeApiAction, armConfirm } from './shared/core.js';
import { baseClass, fmtGrow, escapeHtml, fmtTod } from './shared/format.js';
import { USER_POOLS, userLabel, warnItemUser, matchUser } from './shared/users.js';
import { DINO_LEXIKON, LEX_ORDER, lexOrderedNames } from './shared/lexikon.js';
import { HANDBUCH, HB_BADGE } from './shared/handbuch.js';

// Generischer Server-Panel-API-Call. tokenBase/sessionToken werden als Getter
// durchgereicht, weil beide erst asynchron gesetzt werden (siehe shared/core.js).
const svApi = makeApi({ tokenBase: () => config.tokenBase, token: () => sessionToken });
const svArmConfirm = armConfirm;
const svFmtTod = fmtTod;

// ── Color-Themes (Overlay personalisieren) ───────────────────────────────────
// Definition und Ableitungslogik liegen in shared/theme.js, damit die
// Companion dieselben Schemata anbietet. Hier bleibt nur, was overlay-eigen
// ist: der Picker (nutzt showToast/el) und die Minimap-Invalidierung.
const BF_THEMES = THEMES;
let mySkinFree = false;   // 🎨 Skin-Creator gratis (ab Knochen ODER Beta-Tester-Rolle) — aus /token
const bfTheme = makeTheme({
  storageKey: 'bf-theme',
  customKey: 'bf-custom',
  // Die Karte selbst folgt dem Theme nicht (map.js: Markerfarben sind
  // Bedeutungen). Neu gezeichnet wird trotzdem — Rahmen und Flaechen drumherum
  // haengen sehr wohl am Akzent.
  onApply: () => { minimapDirty = true; },
});
// Abo-Rang als Zahl — auch ausserhalb der Themes gebraucht (Skin-Creator,
// Geschlechtswechsel). Quelle ist derselbe Rang, den setAboTier gesetzt hat.
const myAboIdx = () => aboIndex(bfTheme.tier());
const themeUnlocked = (key) => bfTheme.unlocked(key);
const applyTheme = (key, persist) => bfTheme.apply(key, persist);
function setAboTier(tier) {
  bfTheme.setTier(tier);
  // Picker IMMER neu rendern, sobald der Rang da ist — sonst zeigen Schlösser + fehlender
  // Color-Input den veralteten Fossil-Stand (Settings ist ein eigenes Panel, nie featureOpen).
  renderThemePicker();
}
function renderThemePicker() {
  const box = el('themePicker'); if (!box) return;
  const currentTheme = bfTheme.current();
  box.innerHTML = Object.entries(BF_THEMES).map(([k, t]) => {
    const locked = !themeUnlocked(k);
    const tip = locked ? `${t.name} 🔒 ab ${bfTheme.minTierFor(k)}` : t.name;
    return `<button class="theme-sw${k === currentTheme ? ' on' : ''}${locked ? ' locked' : ''}" data-theme="${k}" title="${tip}" style="background:linear-gradient(135deg,${t.accent},${t.accentD})">${locked ? '🔒' : ''}</button>`;
  }).join('') + customThemeHTML();
  box.querySelectorAll('.theme-sw').forEach((b) => b.onclick = () => {
    const k = b.dataset.theme;
    if (!themeUnlocked(k)) { showToast(`🔒 „${BF_THEMES[k].name}" gibt's ab Rang ${bfTheme.minTierFor(k)}.`, 'error'); return; }
    applyTheme(k, true);
    box.querySelectorAll('.theme-sw,.theme-custom').forEach((x) => x.classList.toggle('on', x.dataset.theme === bfTheme.current()));
  });
  wireCustomTheme(box);
}
function customThemeHTML() {
  if (!bfTheme.unlocked('custom')) return `<div class="theme-custom locked" title="Eigene Akzentfarbe — exklusiv für Obsidian">🎨🔒 Eigene Farbe</div>`;
  return `<label class="theme-custom${bfTheme.current() === 'custom' ? ' on' : ''}" data-theme="custom" title="Eigene Akzentfarbe wählen">🎨 <input type="color" id="themeCustomInput" value="${bfTheme.customHex()}"></label>`;
}
function wireCustomTheme(box) {
  const inp = box.querySelector('#themeCustomInput'); if (!inp) return;
  inp.oninput = () => {
    bfTheme.setCustomHex(inp.value);
    box.querySelectorAll('.theme-sw,.theme-custom').forEach((x) => x.classList.toggle('on', x.dataset.theme === bfTheme.current()));
  };
}
applyTheme(bfTheme.current());   // sofort beim Laden anwenden (kein Flash; Rang folgt via setAboTier)

// ── Blitz-Effekte an/aus (Settings-Toggle, persistent) ──────────────────────
let fxOff = localStorage.getItem('bf-noblitz') === '1';
function applyFx() {
  document.body.classList.toggle('bf-noblitz', fxOff);
  const b = document.getElementById('fxToggleBtn');
  if (b) b.classList.toggle('secondary', fxOff);
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
  if (b) b.classList.toggle('secondary', blurOff);
  updateLowSpecBtn();
}
function toggleBlur() { blurOff = !blurOff; localStorage.setItem('bf-noblur', blurOff ? '1' : '0'); applyBlur(); }
document.addEventListener('DOMContentLoaded', applyBlur);

// Dialog-Transparenz (nur die über das Dock geöffneten Panels; kein HUD/Minimap/Kompass).
// Standard = AN (transparent). Aus => bf-solid-dialogs (blickdicht). In HUD-Sichtbarkeit als Switch.
let dialogTransparent = localStorage.getItem('bf-dialog-transparent') !== '0';
function applyDialogTransparency() {
  document.body.classList.toggle('bf-solid-dialogs', !dialogTransparent);
}
function toggleDialogTransparent() { dialogTransparent = !dialogTransparent; localStorage.setItem('bf-dialog-transparent', dialogTransparent ? '1' : '0'); applyDialogTransparency(); }
document.addEventListener('DOMContentLoaded', applyDialogTransparency);

// ── Master „Low-Spec-Modus" — schaltet Blur + Effekte in einem Rutsch ───────────────────────
function lowSpecActive() { return blurOff && fxOff; }
function updateLowSpecBtn() {
  const b = document.getElementById('lowSpecBtn');
  if (!b) return;
  const on = lowSpecActive();
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
document.addEventListener('DOMContentLoaded', initCompass);

// ── Karten-/Positions-State ─────────────────────────────────────────────────
let players = [];
let me = null;
let parkAt = 0; // PvE-Groß-Dino: Deadline (ms) fürs Auto-Einparken, kommt aus /positions; 0 = keine Warnung
let golden = null; // ⭐ Goldene Patrol-Zone: { phase, zoneId, remainingMs, progressMs, totalMs, paused, syncAt } aus /positions
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
let aiEncounters = [];    // AI-Dino-Encounter (Spawnpunkte/Patrouillen) — nur Team, große Karte
let aiLayerOn = true;     // Team-Kartenlayer für KI-Dinos an/aus (Standard an)
// Auto-Kalibrierung über ZONEN-Ecken: rohe Welt-Koordinaten der hinterlegten Zonen
// (PVP/PVE), gut über die Karte verteilt ausgewählt. Du erkennst die Ecken am Gelände
// und klickst sie an → solveAffine schiebt nur die DARSTELLUNG zurecht (kein Umrechnen
// der Teleport-Ziele!).
// Feste Kalibrier-Anker WEIT AUSSEN (Welt-Koordinaten). Ergänzen die Zonen-Ecken, damit die
// Auto-Kalibrierung die GANZE Karte aufspannt statt nur den zentralen Zonen-Bereich — weiter
// auseinanderliegende Punkte = genauere affine Abbildung. Liegt ein Anker über Wasser / ist die
// Stelle unklar → im Ablauf „Überspringen". Koordinaten bei Bedarf hier anpassen.
// Diese Anker liegen auf gut erkennbaren LAND-Features der Gateway-Karte (RaidAtlas-Render, gleiche
// Map durch die Partnerschaft) — rückgerechnet aus der globalen Kalibrierung. Die frühere Variante
// (±300000 in allen 4 Ecken) landete im Ozean und war nicht präzise anklickbar.
// Per Pixel-Sampling der Karte gewählt (nur Terrain-Farben, robust landeinwärts, max. verteilt) und
// round-trip verifiziert (Welt→Karte→Pixel = Land). Die frühere ±300000-Variante (und ein erster
// Augenmaß-Versuch) landete teils im Ozean → nicht anklickbar.
const CALIB_ANCHORS = [
  { x:  438354, y: -448498 }, // Nordost (Land)
  { x: -282295, y:  340635 }, // Südwest (Land)
  { x: -254486, y: -375970 }, // Nordwest (Land)
  { x:  268198, y:  101086 }, // Südost (Land)
  { x: -113187, y:  -17863 }, // West-Zentrum (Land)
  { x:  103283, y: -304763 }, // Nord-Zentrum (Land)
];
function pickCalibTargets(n) {
  // NUR die handverlesenen, pixel-verifizierten Land-Anker (CALIB_ANCHORS) — bereits gut über die
  // Insel verteilt und garantiert an Land.
  //
  // FRÜHER wurden zusätzlich ALLE Zonen-Ecken gemischt + Farthest-Point-Sampling gemacht. Das war der
  // Bug: die extremsten Zonen-Ecken liegen im OZEAN (Patrol/Migration-Zonen reichen bis über die
  // Küste), und FPS wählt genau die äußersten Punkte → 5 von 8 Kalibrier-Zielen landeten im Wasser,
  // und die Anker wurden nie ausgewählt. Deshalb hatte das Anpassen der Anker keine Wirkung.
  return CALIB_ANCHORS.slice(0, Math.max(n, CALIB_ANCHORS.length)).map((a) => ({ x: a.x, y: a.y }));
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
  const txt = `v${appVersion}${tpIsAdmin ? ' · Team ✓' : ''}`;
  const v = el('versionInfo');
  if (v) v.textContent = txt;
  const sv = el('swVersion');
  if (sv) sv.textContent = txt;
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
  } else if (updateState === 'error') {
    hint.style.display = 'block'; hint.textContent = `⚠️ Update fehlgeschlagen — manuell möglich`;
    if (info) info.textContent = 'Auto-Update wurde blockiert (meist vom Antivirus). Starte das Overlay einmal komplett neu und versuche es erneut — oder lade den Installer manuell herunter und führe ihn aus (deine Daten bleiben erhalten).';
    btn.textContent = '📥 Installer herunterladen'; btn.disabled = false;
  }
}
// Manueller Download-Fallback: eigene Backend-Download-Seite (folgt der API-Base) statt GitHub.
// URL wird zur Laufzeit aus config.tokenBase gebaut (config ist beim Modul-Eval evtl. noch leer).

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
// 3D-Stärke ist EINE persönliche Einstellung für alle, die man hört (globaler Regler
// `spatial3dStrength`) — bewusst KEIN Pro-Spieler-Override mehr (war zu fummelig).
// Master-Lautstärke für ALLE Spieler (0..2) — Regler über der Spielerliste.
let masterGain = (parseFloat(localStorage.getItem('bf-master-gain')) || 1);
// Eigene Mikrofon-Verstärkung (0..2) — wird per Web-Audio-GainNode auf den
// gesendeten Mikro-Track gelegt (siehe createMicGainProcessor).
let micGain = (parseFloat(localStorage.getItem('bf-mic-gain')) || 1);
// Erweiterte Audio-Einstellungen: PreGain + DynamicsCompressor VOR dem micGain-Node.
// Werte in „menschlichen" Einheiten (dB / :1 / ms); WebAudio bekommt ms→s umgerechnet.
const MIC_COMP_DEFAULTS = {
  // Kompressor
  on: false, preGain: 0, threshold: -24, ratio: 12, attack: 3, release: 250, knee: 30,
  // Noise Gate
  gateOn: false, gateThreshold: -50, gateAttack: 5, gateRelease: 150, gateHold: 200,
  // Low-Cut / High-Pass
  hpOn: false, hpFreq: 80,
  // Limiter
  limitOn: false, limitCeil: -3,
  // Rauschunterdrückung (browser-native)
  nsOn: false,
};
let micComp = (() => {
  try { return { ...MIC_COMP_DEFAULTS, ...JSON.parse(localStorage.getItem('bf-mic-comp') || '{}') }; }
  catch { return { ...MIC_COMP_DEFAULTS }; }
})();
function saveMicComp() { try { localStorage.setItem('bf-mic-comp', JSON.stringify(micComp)); } catch {} }
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
// Postfach-Kategorien: NUR diese landen im Benachrichtigungs-Verlauf. [BFT-181]
// Gruppen-Benachrichtigung, Admin-Benachrichtigung, Gruppeneinladung, Ticket-Antwort.
const NOTIF_MAILBOX_CATS = new Set(['group', 'admin', 'invite', 'ticket']);
// Server-Toast-Kategorie aus dem Emoji-Prefix ableiten (Backend liefert unstrukturierte Strings).
function serverToastCat(msg) {
  const s = String(msg);
  if (s.startsWith('💬')) return 'admin';   // Team → Spieler (/admin/toast)
  if (s.startsWith('⚠️')) return 'group';   // Gruppen-Warnung (Diät-Kick / aus Gruppe entfernt)
  return '';                                  // Sonstiges (Park 🅿️, Golden ⭐ …): nur transienter Popup, nicht ins Postfach
}
function showToast(msg, type = '', cat = '') {
  addNotif(msg, type, cat);   // ins Postfach protokollieren (nach Kategorie gefiltert; transienter Toast unten zeigt IMMER)
  const t = document.createElement('div');
  t.className = 'toast' + (type ? ' ' + type : '');
  t.textContent = msg;
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => { t.classList.add('fade'); setTimeout(() => t.remove(), 300); }, 3600);
}

// ── Benachrichtigungs-Postfach (Verlauf + sequenzielle Anzeige) ──────────────
// Jeder Toast landet im Verlauf (localStorage). Server-Toasts (Belohnungen etc.) stapeln sich
// bei geschlossenem Overlay im Backend und werden beim nächsten /positions-Poll geliefert —
// hier zeigen wir sie NACHEINANDER (nicht alle auf einmal) und man kann Verpasstes nachlesen.
let notifHistory = [];
try { notifHistory = JSON.parse(localStorage.getItem('bf-notif-history') || '[]'); } catch { notifHistory = []; }
let notifReadTs = Number(localStorage.getItem('bf-notif-read') || 0);
function addNotif(text, type, cat) {
  if (!NOTIF_MAILBOX_CATS.has(cat)) return; // nur die gewünschten Kategorien ins Postfach [BFT-181]
  notifHistory.push({ text: String(text), type: type || '', cat, ts: Date.now() });
  if (notifHistory.length > 60) notifHistory = notifHistory.slice(-60);
  try { localStorage.setItem('bf-notif-history', JSON.stringify(notifHistory)); } catch {}
  updateNotifBadge();
  if (featureOpen === 'notifications') renderNotifications();
}
function notifUnread() { return notifHistory.reduce((n, x) => n + (x.ts > notifReadTs ? 1 : 0), 0); }
function updateNotifBadge() {
  const btn = document.querySelector('.dock-btn[data-act="notifications"]'); if (!btn) return;
  let b = btn.querySelector('.chat-badge');
  const n = notifUnread();
  if (n > 0) {
    if (!b) { b = document.createElement('span'); b.className = 'chat-badge'; btn.appendChild(b); }
    b.textContent = n > 99 ? '99+' : String(n);
  } else if (b) { b.remove(); }
}
function notifRelTime(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'gerade eben';
  const m = Math.floor(s / 60); if (m < 60) return `vor ${m} Min`;
  const h = Math.floor(m / 60); if (h < 24) return `vor ${h} Std`;
  return `vor ${Math.floor(h / 24)} T`;
}
function renderNotifications() {
  const box = el('notifList'); if (!box) return;
  box.innerHTML = '';
  if (!notifHistory.length) {
    const p = document.createElement('p'); p.style.color = 'var(--muted)'; p.textContent = 'Noch keine Benachrichtigungen.';
    box.appendChild(p);
  } else {
    for (const n of notifHistory.slice().reverse()) {
      const item = document.createElement('div');
      item.className = 'notif-item' + (n.ts > notifReadTs ? ' unread' : '') + (n.type ? ' ' + n.type : '');
      const txt = document.createElement('div'); txt.className = 'notif-text'; txt.textContent = n.text;
      const tm = document.createElement('div'); tm.className = 'notif-time'; tm.textContent = notifRelTime(n.ts);
      item.appendChild(txt); item.appendChild(tm); box.appendChild(item);
    }
  }
  notifReadTs = Date.now();
  try { localStorage.setItem('bf-notif-read', String(notifReadTs)); } catch {}
  updateNotifBadge();
}
function clearNotifs() {
  notifHistory = [];
  try { localStorage.setItem('bf-notif-history', '[]'); } catch {}
  renderNotifications();
}

// Server-Toasts sequenziell durchreichen (nicht alle auf einmal), damit man bei einem Schwung
// gestauter Belohnungen jede einzeln lesen kann.
let _toastQueue = [];
let _toastPumping = false;
function enqueueServerToasts(list) {
  for (const t of list) _toastQueue.push(t);
  if (_toastPumping) return;
  _toastPumping = true;
  const step = () => {
    if (!_toastQueue.length) { _toastPumping = false; return; }
    const m = _toastQueue.shift();
    showToast(m, 'success', serverToastCat(m)); // Kategorie fürs Postfach ableiten [BFT-181]
    setTimeout(step, 1200);
  };
  step();
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
// Wird von pollVitals (1s, Slow-Cache) UND updateHud (/me, 6 s) aufgerufen — beide liefern
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
  { const v = document.getElementById('growVal'); if (v) v.textContent = online ? fmtGrow(grow) : '—'; }
  // GROW-RATE = Σ Nährstoffe (0..3) → Anzeige 0..300 %, Füllung /3.
  // Ab 75 % Grow stoppt das Wachstum (Adult) → Rate auf 0.
  const nut = (online && grow <= 0.75) ? ((d.carbs || 0) + (d.protein || 0) + (d.lipid || 0)) : 0;
  setHex(nut / 3, online ? '#e7cf7a' : gray, 'grE1', 'grF1', 'grF2');
  { const v = document.getElementById('rateVal'); if (v) v.textContent = online ? Math.round(nut * 100) + '%' : '—'; }
  // HP (Farbe nach Höhe). Füllung = Fraktion (%), Text = absoluter Current-Wert. [BFT-179]
  const hp = online && typeof d.health === 'number' ? Math.max(0, Math.min(100, Math.round(d.health * 100))) : 0;
  const hcol = !online ? gray : hp > 50 ? '#22c55e' : hp > 25 ? '#f59e0b' : '#ef4444';
  setHex(hp / 100, hcol, 'ghE1', 'ghF1', 'ghF2');
  { const v = document.getElementById('heartVal'); if (v) v.textContent = online ? (typeof d.healthCur === 'number' ? String(Math.round(d.healthCur)) : hp + '%') : '—'; }
}
// ── Kompass (verschiebbarer Balken oben) ────────────────────────────────────
// Himmelsrichtungen (N rot) + Wegpunkt 📍 + Golden-Zone ⭐ + Gruppenmitglieder (Kartenfarben)
// relativ zur Blickrichtung (Mitte = geradeaus). Verschiebbar über den Edit-Mode (MOVABLE).
const COMPASS_HALF_FOV = 80;   // ±80° um die Blickrichtung sichtbar
let COMPASS_NORTH_OFF = -90;   // Mod-Heading-Offset für die Himmelsrichtungen (in-game kalibriert)
let compassCtx = null;
let compassHd = null;   // gleitend interpolierte Anzeige-Blickrichtung (60fps) für ruckelfreie Drehung
let compassRAF = 0;
// 60fps-Render-Loop: gleitet die angezeigte Blickrichtung weich zur echten (die alle 100ms per Poll
// kommt) — so dreht sich der Kompass flüssig statt in 10fps-Stufen. Läuft rein clientseitig.
// Kompass an/aus (Settings-Toggle, persistent) + Auto-Aus im Fly-/Admin-Modus (keine Blickrichtung).
let compassHidden = localStorage.getItem('bf-hide-compass') === '1';
let compassHideState = null;
function compassSetHidden(h) { if (h === compassHideState) return; compassHideState = h; const w = el('compassWrap'); if (w) w.style.display = h ? 'none' : ''; }
function applyCompassToggle() {
  const b = el('compassToggleBtn');
  if (b) { b.textContent = compassHidden ? '🧭 Kompass: Aus' : '🧭 Kompass: An'; b.classList.toggle('secondary', compassHidden); }
  compassHideState = null; // beim nächsten Frame neu anwenden
}
function toggleCompass() { compassHidden = !compassHidden; localStorage.setItem('bf-hide-compass', compassHidden ? '1' : '0'); applyCompassToggle(); }
function compassLoop() {
  compassRAF = requestAnimationFrame(compassLoop);
  const online = me && typeof me.heading === 'number';
  const hide = compassHidden || (me && me.isSpectating); // Fly-Mode: keine Blickrichtung → Kompass aus
  compassSetHidden(hide);
  if (hide) { compassHd = null; return; }
  if (!online) { compassHd = null; renderCompass(); return; }
  if (compassHd == null) {
    compassHd = me.heading;
  } else {
    const d = ((me.heading - compassHd + 540) % 360) - 180; // kürzester Winkelweg (Wrap bei 360°)
    compassHd = cmpNorm(compassHd + d * 0.3);                // 0.3/Frame → weich, folgt aber schnell
  }
  renderCompass();
}
function initCompass() {
  const cv = el('compass'), wrap = el('compassWrap');
  if (!cv || !wrap) return;
  compassCtx = cv.getContext('2d');
  const p = loadPositions();
  if (!p.compassWrap || !p.compassWrap.left) { // Default: oben zentriert
    wrap.style.left = Math.round(window.innerWidth / 2 - cv.width / 2) + 'px';
    wrap.style.top = '10px';
  }
  if (!compassRAF) compassLoop();   // 60fps-Loop starten (rendert selbst, ersetzt den Poll-Aufruf)
}
const cmpNorm = (d) => ((d % 360) + 360) % 360;
const cmpRel = (target, heading) => { let a = cmpNorm(target - heading); if (a > 180) a -= 360; return a; };
// Welt-Delta → Peilung in Heading-Space (Umkehr von map.js: heading→(cos((h-90)°),sin((h-90)°)))
const cmpBearing = (dx, dy) => cmpNorm(Math.atan2(dy, dx) * 180 / Math.PI + 90);
function cmpRoundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function renderCompass() {
  if (!compassCtx) return;
  const ctx = compassCtx, cv = ctx.canvas, W = cv.width, H = cv.height, cx = W / 2;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(12,16,22,0.66)'; cmpRoundRect(ctx, 0, 12, W, H - 14, 9); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const online = me && typeof me.heading === 'number' && typeof me.x === 'number';
  if (!online) { ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.font = '11px sans-serif'; ctx.fillText('🧭 nicht im Spiel', cx, H / 2 + 2); return; }
  const hd = (compassHd != null ? compassHd : me.heading), halfW = W / 2 - 10;
  const xFor = (rel) => cx + (rel / COMPASS_HALF_FOV) * halfW;
  const vis = (rel) => Math.abs(rel) <= COMPASS_HALF_FOV;
  // Himmelsrichtungen + Zwischenrichtungen (N deutlich in Rot)
  for (const [lbl, deg] of [['N', 0], ['NO', 45], ['O', 90], ['SO', 135], ['S', 180], ['SW', 225], ['W', 270], ['NW', 315]]) {
    const rel = cmpRel(cmpNorm(deg + COMPASS_NORTH_OFF), hd); if (!vis(rel)) continue;
    const x = xFor(rel), major = lbl.length === 1, north = lbl === 'N';
    ctx.strokeStyle = north ? '#ef4444' : 'rgba(255,255,255,0.4)'; ctx.lineWidth = north ? 2 : 1;
    ctx.beginPath(); ctx.moveTo(x, 14); ctx.lineTo(x, major ? 24 : 20); ctx.stroke();
    ctx.fillStyle = north ? '#ef4444' : (major ? '#fff' : 'rgba(255,255,255,0.55)');
    ctx.font = north ? 'bold 14px sans-serif' : (major ? 'bold 12px sans-serif' : '9px sans-serif');
    ctx.fillText(lbl, x, 36);
  }
  // Marker relativ zur Blickrichtung
  const marks = [];
  const wp = waypoints[waypoints.length - 1]; if (wp) marks.push({ x: wp.x, y: wp.y, sym: '📍' });
  const g = goldenZoneCenter(); if (g) marks.push({ x: g.x, y: g.y, sym: '⭐' });
  const myG = me.groupId;
  for (const p of players) { if (!p.isYou && typeof p.x === 'number' && ((myG && p.groupId === myG) || p.ovgroup)) marks.push({ x: p.x, y: p.y, dot: groupColorFor(p.steamId) }); }
  for (const m of marks) {
    // Marker-Peilung braucht denselben Nord-Offset wie die Himmelsrichtungen (sonst 90° verschoben).
    const rel = cmpRel(cmpNorm(cmpBearing(m.x - me.x, m.y - me.y) + COMPASS_NORTH_OFF), hd); if (!vis(rel)) continue;
    const x = xFor(rel);
    if (m.dot) { ctx.beginPath(); ctx.arc(x, 8, 5, 0, 2 * Math.PI); ctx.fillStyle = m.dot; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.stroke(); }
    else if (m.sym) { ctx.font = '14px sans-serif'; ctx.fillText(m.sym, x, 8); }
  }
  // Zentrum = Blickrichtung (Pfeil + Mittellinie)
  ctx.fillStyle = '#00e5ff';
  ctx.beginPath(); ctx.moveTo(cx, 14); ctx.lineTo(cx - 5, 6); ctx.lineTo(cx + 5, 6); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(0,229,255,0.55)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, 15); ctx.lineTo(cx, H - 4); ctx.stroke();
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
  ensureTimerLayout('growTimer');   // nach display → Breite messbar (Rand-Klemmung)
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

// ── Event-Timer-Panel (server-weite Events mit Countdown) ────────────────────
let activeEventsList = []; // [{ key, name, expiresAtMs }]
async function loadActiveEvents() {
  if (!sessionToken) return;
  try {
    const r = await fetch(`${config.tokenBase}/events`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (r.ok) { const d = await r.json(); activeEventsList = d.events || []; }
  } catch {}
  renderEventPanel();
}
// Countdown in EINER Einheit (Tage → Stunden → Minuten), kein Mix.
function fmtEventCountdown(expiresAtMs) {
  if (!expiresAtMs) return '∞';
  const ms = expiresAtMs - Date.now();
  if (ms <= 0) return '0m';
  const min = Math.floor(ms / 60000);
  if (min >= 1440) return Math.floor(min / 1440) + ' Tage';   // ≥ 1 Tag
  if (min >= 60) return Math.floor(min / 60) + ' Std';        // ≥ 1 Stunde
  return Math.max(1, min) + ' Min';                           // sonst Minuten (min. 1)
}
function renderEventPanel() {
  const box = el('eventPanel'); if (!box) return;
  const evs = (activeEventsList || []).filter((e) => !e.expiresAtMs || e.expiresAtMs > Date.now()); // lokal abgelaufene raus
  if (!evs.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = 'block';
  box.innerHTML = `<div class="ev-head">🎉 Aktive Events</div>` + evs.map((e) =>
    `<div class="ev-row"><span class="ev-name">${escapeHtml(e.name || e.key)}</span><span class="ev-time">${fmtEventCountdown(e.expiresAtMs)}</span></div>`).join('');
  ensureTimerLayout('eventPanel'); // nach display → Breite messbar (Rand-Klemmung, wie growTimer)
}

// ── 🐾 Wander-Distanz-HUD ────────────────────────────────────────────────────
// Kleines Fenster, das aufplopt, wenn gerade Distanz dazukommt, und die aktuelle Lauf-/Schwimm-
// (bzw. Flug-/Schwimm-)Distanz des aktiven Dinos zeigt — damit man nicht ins Dock muss. Nach kurzer
// Ruhe blendet es sich aus. Ausblendbar über den Settings-Toggle (HIDEABLE 'distHud'), verschiebbar.
let distHudState = { cur: {}, delta: {}, prev: {}, categories: ['walk', 'swim'], name: '', lastGainAt: 0, seeded: false };
const DIST_HUD_IDLE_MS = 8000; // so lange nach dem letzten Zuwachs bleibt das HUD sichtbar
async function pollDistHud() {
  const box = el('distHud'); if (!box) return;
  if (!me || hiddenEls.has('distHud')) { box.style.display = 'none'; return; } // off-server / vom Spieler ausgeblendet
  let d;
  try { d = await svApi('GET', '/me/migration'); } catch { return; }
  const live = (d.live || []).reduce((m, c) => { m[c.category] = c; return m; }, {});
  distHudState.categories = (Array.isArray(d.categories) && d.categories.length) ? d.categories : ['walk', 'swim'];
  distHudState.name = d.dinoName || '';
  const cur = {};
  for (const k of distHudState.categories) cur[k] = (live[k] || {}).totalM || 0;
  const delta = {};
  if (distHudState.seeded) { // erster Poll setzt nur den Ausgangswert (kein Fehl-Plopp)
    for (const k of distHudState.categories) {
      const inc = cur[k] - (distHudState.prev[k] || 0);
      if (inc > 0.5) { delta[k] = inc; distHudState.lastGainAt = Date.now(); }
    }
  }
  distHudState.seeded = true;
  distHudState.prev = cur; distHudState.cur = cur; distHudState.delta = delta;
  renderDistHud();
}
function renderDistHud() {
  const box = el('distHud'); if (!box) return;
  if (!me || hiddenEls.has('distHud')) { box.style.display = 'none'; return; }
  if (Date.now() - distHudState.lastGainAt > DIST_HUD_IDLE_MS) { box.style.display = 'none'; return; } // Ruhe → ausblenden
  box.style.display = 'block';
  ensureTimerLayout('distHud');
  const rows = distHudState.categories.map((k) => {
    const m = LB_CATS.find((c) => c.key === k) || { icon: '', label: k };
    const inc = distHudState.delta[k] || 0;
    return `<div class="dh-row"><span class="dh-cat">${m.icon} ${m.label}</span>`
      + `<span class="dh-val">${lbFmtDist(distHudState.cur[k] || 0)}${inc > 0 ? ` <span class="dh-inc">+${Math.round(inc)} m</span>` : ''}</span></div>`;
  }).join('');
  const head = distHudState.name ? `🏷️ ${escapeHtml(distHudState.name)}` : '🐾 Wanderung';
  box.innerHTML = `<div class="dh-head">${head}</div>${rows}`;
}

let config = { hotkeys: {} };
let room = null;
let micEnabled = false;
let settingsOpen = false;
let deafened = false;                                   // eingehenden Ton stummschalten
let amDead = false;                                     // tot / kein Dino → Voice komplett aus (weder hören noch senden)
// Entprellung fuer amDead: der Rohwert kommt aus dem 0,1s-Positions-Poll und kann flattern.
// Jeder Wechsel republiziert den Mic-Track und reisst die 3D-Plugin-Kette der Sprecher mit —
// nach ein paar Zyklen bleibt die Voice-Session verbunden, aber tot. Erst DEAD_DEBOUNCE gleiche
// Polls in Folge schalten wirklich um (~0,3 s; fuer echten Tod/Respawn unerheblich).
const DEAD_DEBOUNCE = 3;
let deadStreak = 0;
let godVoiceId = '';                                    // steamId des aktiven Gottstimme-Sprechers ('' = keine Durchsage) — aus /positions
let godVoiceMine = false;                               // ob ICH gerade die Gottstimme sende (Admin-Button-Zustand)
let godVoiceReverbActive = false;                       // Himmels-Hall bei der AKTIVEN Durchsage an? (aus /positions, für alle konsistent)
let godVoiceReverbPref = localStorage.getItem('bf-godvoice-reverb') !== '0'; // Admin-Wahl beim Starten (Default an); wird mitgesendet
let micDeviceId = localStorage.getItem('bf-mic-dev') || '';   // gewähltes Mikrofon
let spkDeviceId = localStorage.getItem('bf-spk-dev') || '';   // gewähltes Ausgabegerät
// serverVoice (aus /token): Das Backend steuert die Proximity-Subscriptions selbst → Client verbindet
// mit autoSubscribe:false, „wer hört wen" liegt beim Backend. AUS = bisher (Client abonniert alle).
let serverVoice = false;
let aiSpawnMode = false;                                // Karten-Klick-Spawn aktiv
let encWpMode = false;                                  // Brain-Editor: Karten-Klick = Patrouillen-Wegpunkt anhängen
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
  document.querySelectorAll('#settingsTabs [data-sttab]').forEach((b) => { b.onclick = () => showSettingsTab(b.dataset.sttab); });
  el('heatBtn').onclick = () => {
    heatmapMode = !heatmapMode;
    el('heatBtn').style.background = heatmapMode ? 'var(--accent)' : 'var(--panel)';
    // Zonen-Layer-Toggles nur anbieten, wenn Heatmap aus ist
    el('zoneLayers').style.display = heatmapMode ? 'none' : 'flex';
    renderBigMap();
  };

  // Zonen-Layer-Toggles (Sanctuary/Patrol/Migration) — blenden die gezeichneten Umriss-Zonen ein/aus
  for (const key of ['sanctuary', 'patrol', 'migration']) {
    const btn = el('zl' + key[0].toUpperCase() + key.slice(1));
    if (!btn) continue;
    btn.style.background = isZoneLayerVisible(key) ? 'var(--accent)' : 'var(--panel)'; // Default sichtbar
    btn.onclick = () => {
      const on = !isZoneLayerVisible(key);
      setZoneLayer(key, on);
      btn.style.background = on ? 'var(--accent)' : 'var(--panel)';
      renderBigMap();
    };
  }
  el('calibCancelBtn').onclick = () => abortAutoCalib();
  { const sk = el('calibSkipBtn'); if (sk) sk.onclick = () => { if (autoCalib && autoCalib.resolveClick) { const r = autoCalib.resolveClick; autoCalib.resolveClick = null; r('skip'); } }; }  // aktuellen Kalibrier-Punkt überspringen
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
  { const b = el('zonePullBtn'); if (b) b.onclick = () => pullZones(); }

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
    else if (updateState === 'error') { window.bf.openExternal?.(String(config.tokenBase || '').includes('api-test') ? `${config.tokenBase}/overlay/` : 'https://github.com/HidekiSensei/blackfossil-overlay/releases/latest'); }   // manueller Download-Fallback (Test: Backend-Seite, Prod: GitHub-Releases)
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
    updateState = 'error'; renderUpdateUI();
    showToast(`Update-Fehler: ${msg} — Overlay neu starten oder Installer manuell laden (Einstellungen → Update).`, 'error');
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
  loadFreeGenderSwap();
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
  // Postfach: „Leeren"-Button + Ungelesen-Badge beim Start.
  { const nc = el('notifClearBtn'); if (nc) nc.onclick = () => clearNotifs(); }
  updateNotifBadge();

  // Admin-Panel (eigenständiges Modal, nur Admins) — Einstieg läuft übers Dock (Admin-Button)
  { const oab = el('openAdminBtn'); if (oab) oab.onclick = () => openAdminPanel(); }
  el('adminCloseBtn').onclick = () => closeAdminPanel();
  { const b = el('serverCloseBtn'); if (b) b.onclick = () => closeServerPanel(); }
  { const b = el('srvCloseBtn'); if (b) b.onclick = () => closeSrvPanel(); }
  document.querySelectorAll('#serverTabs [data-stab]').forEach((b) => { b.onclick = () => showServerTab(b.dataset.stab); });
  { const b = el('godVoiceBtn'); if (b) b.onclick = () => toggleGodVoice(); }
  { const c = el('godVoiceReverbChk'); if (c) { c.checked = godVoiceReverbPref; c.onchange = () => setGodVoiceReverbPref(c.checked); } }
  el('admUserLoad').onclick = () => admLoadUserInfo();
  el('admLightningBtn').onclick = () => admLightning();
  { const b = el('msgSendBtn'); if (b) b.onclick = () => admSendToast(); }
  { const b = el('followToggleBtn'); if (b) b.onclick = () => admToggleFollow(); }
  { const b = el('svAnnounce'); if (b) b.onclick = () => { const m = el('svMsg').value.trim(); if (!m) { showToast('Nachricht eingeben', 'error'); return; } apiAction('/admin/server/announce', { message: m }, '📢 Ansage gesendet', () => { el('svMsg').value = ''; }); }; }
  { const b = el('dutyToggleBtn'); if (b) b.onclick = () => toggleDuty(); }
  document.querySelectorAll('#adminTabs [data-atab]').forEach((b) => { b.onclick = () => showAdminTab(b.dataset.atab); });
  { const b = el('dtTabGive'); if (b) b.onclick = () => { dtTab = 'give'; renderDtTab(); }; }
  { const b = el('dtTabEdit'); if (b) b.onclick = () => { dtTab = 'edit'; renderDtTab(); }; }
  { const b = el('dtTabDel'); if (b) b.onclick = () => { dtTab = 'delete'; renderDtTab(); }; }
  el('giftTargetKind').onchange = () => updateGiftTarget();
  el('giftSubmit').onclick = () => admGift();
  el('adminCalibBtn').onclick = () => adminCalibrate();
  el('tpCreateBtn').onclick = () => createTp();
  el('tpConfirmYes').onclick = () => useTp();
  el('tpConfirmNo').onclick = () => { el('tpConfirm').style.display = 'none'; tpConfirmTarget = null; };
  el('centerBtn').onclick = () => centerOnMe();
  el('resetViewBtn').onclick = () => { mapZoom = 1; mapPanX = 0; mapPanY = 0; renderBigMap(); };
  { const c = el('clearWpBtn'); if (c) c.onclick = () => { waypoints = []; renderBigMap(); renderMinimap(); }; }
  { const b = el('aiEncBtn'); if (b) b.onclick = () => { aiLayerOn = !aiLayerOn; b.classList.toggle('secondary', !aiLayerOn); renderBigMap(); }; }

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
  initMicCompUI();   // Erweiterte Audio-Einstellungen (Kompressor)
  // Master-Lautstärke für alle Spieler
  const mv = el('masterGain');
  if (mv) { mv.value = String(Math.round(masterGain * 100)); mv.oninput = (e) => setMasterGain(parseInt(e.target.value)); }
  // 🧭 3D-Effektstärke
  const s3 = el('spatial3d');
  if (s3) { s3.value = String(Math.round(spatial3dStrength * 100)); s3.oninput = (e) => setSpatial3dStrength(parseInt(e.target.value)); }
  // 🎛️ Kill-Switch für die Effekt-Kette (3D/Unterwasser/Gottstimme-Effekt) [BFT-287]
  const fx = el('voiceFxChk');
  if (fx) { fx.checked = voiceEffectsOn; fx.onchange = () => setVoiceEffects(fx.checked); }

  // Maustasten als Hotkey (für Push-to-Talk/Mute): während des Neubelegens Klick fangen
  window.addEventListener('mousedown', onRebindMouse, true);

  // Feature-Panels schließen
  document.querySelectorAll('.closeFeature').forEach((b) => { b.onclick = () => closeAllFeatures(); });

  // Tastenbelegung
  await renderHotkeys();
  el('resetHkBtn').onclick = async () => { await window.bf.resetHotkeys(); await renderHotkeys(); };
  window.addEventListener('keydown', onRebindKey);

  // Minimap-Render: rAF-Loop (~30fps, Perf-Cap) mit Positions-Interpolation (minimapLoop) — flüssige
  // Bewegung entfernter Spieler statt 10fps-Stufen; Smart-Gating zeichnet nur bei echter Bewegung.
  if (!minimapRAF) minimapLoop();
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
    loadRoleUI();   // Rolle/Panels sofort laden → Team/Admin/Server auch off-server sichtbar (Voice bleibt server-only)
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
        godVoiceId = data.godVoice || ''; // Gottstimme-Durchsage aktiv? (steamId des Sprechers)
        godVoiceReverbActive = !!data.godVoiceReverb; // Himmels-Hall der aktiven Durchsage (server-gesynct)
        me = players.find((p) => p.isYou) || null;
        // Button-Zustand an die Server-Wahrheit angleichen (Reconnect / Fremd-Abschaltung).
        const gvMine = !!(godVoiceId && me && godVoiceId === me.steamId);
        if (gvMine !== godVoiceMine) { godVoiceMine = gvMine; if (serverOpen && serverTab === 'godvoice') renderGodVoice(); }
        // Tot / kein Dino → Voice komplett aus (weder hören noch senden). Wechsel → Mic umschalten + Hinweis.
        // Entprellt (s. DEAD_DEBOUNCE): ein einzelner Ausreisser im Poll darf die Voice-Kette nicht anfassen.
        const rawDead = !me || !!me.isDead;
        if (rawDead === amDead) deadStreak = 0;
        else if (++deadStreak >= DEAD_DEBOUNCE) {
          deadStreak = 0;
          amDead = rawDead;
          if (room) applyMic();                              // sofort aufhören/wieder senden
          if (amDead && voiceConnected) showToast('💀 Tot — Voice ist stumm bis zum Respawn.', 'warn');
          else if (!amDead && voiceConnected) showToast('🎙️ Wieder im Spiel — Voice aktiv.', 'success');
          refreshMicState();
        }
        // Health läuft separat über pollVitals() (1s, Slow-Cache; Combat-Stat nicht im Fast-Pull) — nicht über Positionen
        computeMoveAngles();   // Pfeil-Richtung aus tatsächlicher Karten-Bewegung
        minimapDirty = true;   // neue Positionen → Minimap neu zeichnen
        if (Array.isArray(data.toasts) && data.toasts.length) enqueueServerToasts(data.toasts);
        parkAt = Number(data.parkAt) || 0; updateParkWarn();
        golden = mergeGolden(golden, data.golden);
        // Zone nur während der AKTIV-Phase golden hervorheben (im Cooldown gibt es keine aktive Zone).
        setGoldenZone(golden && golden.phase === 'active' && golden.zoneId);
        updateGoldenHud();
        applyServerState();
        updateZoneBox();
        checkZoneChange();
        updateProximityVolumes();
        // Kompass rendert sich selbst per 60fps-rAF-Loop (compassLoop) mit weicher Heading-Interpolation.
        if (settingsOpen) renderVoiceUsers();
        if (mapOpen) renderBigMap();
        if (featureOpen === 'group') updateGroupLive();   // nur Mitglieder/Chat updaten, NICHT das Eingabefeld neu bauen
        if (featureOpen === 'profile') updateProfileServerDinos();   // Server-Dino-Zahlen live
        updateSpeakingBox();   // Sprecher-Namen aktualisieren/ausblenden
      }
    } catch {}
  };
  poll();
  // 0,1s ≈ Server-Tickrate: Position (Map + Voice) live. Läuft rein gegen den Backend-Cache
  // (der Backend-Poller hält /players im 0,1s-Takt warm), löst also keinen Game-Server-Call pro Poll aus. [BFT-178]
  setInterval(poll, 100);
  setInterval(updateParkWarn, 1000); // Countdown flüssig runterzählen (unabhängig vom Positions-Poll)
  setInterval(updateGoldenHud, 1000); // Golden-Timer flüssig zwischen den Polls interpolieren
  setInterval(pollDistHud, 2500);     // Wander-Distanz-HUD: plopt beim Sammeln auf, blendet bei Ruhe aus
  setInterval(renderDistHud, 1000);   // flüssiges Ausblenden zwischen den Polls
}

// PvE-Groß-Dino: bleibender Einpark-Countdown oben. parkAt (Deadline in ms) kommt aus /positions;
// solange gesetzt und in der Zukunft, zeigt es „Einparken in M:SS" + Balken. 0/abgelaufen → ausblenden.
const PARK_WARN_TOTAL_MS = 5 * 60 * 1000;
function updateParkWarn() {
  const box = document.getElementById('parkWarn');
  if (!box) return;
  const remain = parkAt - Date.now();
  if (!parkAt || remain <= 0) { if (box.style.display !== 'none') box.style.display = 'none'; return; }
  const secs = Math.ceil(remain / 1000);
  const mm = Math.floor(secs / 60), ss = String(secs % 60).padStart(2, '0');
  const pct = Math.max(0, Math.min(100, (remain / PARK_WARN_TOTAL_MS) * 100));
  if (box.style.display !== 'block') {
    box.innerHTML = '🅿️ Dein Dino wird in <span class="pw-time"></span> in der PvE-Zone eingeparkt — verlasse die Zone!<div class="pw-bar"><div class="pw-fill"></div></div>';
    box.style.display = 'block';
    ensureTimerLayout('parkWarn');
    reattachEditHandle('parkWarn');   // innerHTML hat den Resize-Griff entfernt
  }
  box.querySelector('.pw-time').textContent = `${mm}:${ss}`;
  box.querySelector('.pw-fill').style.width = pct + '%';
}

// ⭐ Goldene Patrol-Zone: HUD-Timer oben. Daten aus /positions (data.golden), lokal zwischen den
// Polls interpoliert. AKTIV+alle drin → Countdown „noch M:SS drin". AKTIV+pausiert → deutlicher
// „alle müssen rein"-Hinweis (Timer eingefroren). COOLDOWN → „Nächste goldene Zone in M:SS".
function fmtMMSS(ms) {
  const secs = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}
// Übernimmt den neuen Golden-State, behält aber die Interpolations-Basis (syncAt), solange die
// server-autoritativen Werte gleich bleiben (der Server tickt nur alle 10s). Sonst würde der Timer
// bei jedem 1,5s-Poll auf den unveränderten Serverwert zurückspringen → „läuft nicht rund".
function mergeGolden(prev, next) {
  if (!next) return null;
  const same = prev && prev.phase === next.phase && prev.paused === next.paused
    && prev.remainingMs === next.remainingMs && prev.progressMs === next.progressMs
    && prev.zoneId === next.zoneId && prev.engaged === next.engaged;
  return { ...next, syncAt: same ? prev.syncAt : Date.now() };
}
function updateGoldenHud() {
  const box = document.getElementById('goldenHud');
  if (!box) return;
  if (!golden) { if (box.style.display !== 'none') box.style.display = 'none'; return; }
  // In der AKTIV-Phase erst zeigen, wenn schon jemand (Gruppe/selbst) in der Zone war — sonst wäre
  // die „alle müssen rein"-Anzeige nur störend. Cooldown zeigt immer (folgt stets auf eine Auszahlung).
  if (golden.phase === 'active' && !golden.engaged) { if (box.style.display !== 'none') box.style.display = 'none'; return; }

  const total = Number(golden.totalMs) || (5 * 60 * 1000);
  const elapsed = Date.now() - (golden.syncAt || Date.now());
  let cls, html;
  if (golden.phase === 'cooldown') {
    const remain = Math.max(0, (Number(golden.remainingMs) || 0) - elapsed);
    cls = 'gh-cooldown';
    html = `⏳ Nächste goldene Zone in <span class="gh-time">${fmtMMSS(remain)}</span>`;
  } else if (golden.paused) {
    // Pausiert: Timer eingefroren anzeigen (nicht lokal weiterzählen).
    const remain = Math.max(0, Number(golden.remainingMs) || 0);
    cls = 'gh-paused';
    html = `⏸️ Goldene Zone <b>pausiert</b> — ALLE müssen in die Patrol-Zone, damit der Timer weiterläuft`
      + `<div class="gh-sub">Noch <span class="gh-time">${fmtMMSS(remain)}</span> drin · <span class="gh-frozen">eingefroren</span></div>`
      + `<div class="gh-bar"><div class="gh-fill" style="width:${Math.min(100, ((Number(golden.progressMs)||0)/total)*100)}%"></div></div>`;
  } else {
    // Aktiv + alle drin: lokal weiter runterzählen / Balken füllen.
    const remain = Math.max(0, (Number(golden.remainingMs) || 0) - elapsed);
    const progress = Math.min(total, (Number(golden.progressMs) || 0) + elapsed);
    cls = 'gh-active';
    html = `⭐ Goldene Zone — noch <span class="gh-time">${fmtMMSS(remain)}</span> drin`
      + `<div class="gh-bar"><div class="gh-fill" style="width:${(progress/total)*100}%"></div></div>`;
  }
  box.className = cls;
  box.innerHTML = html;              // wirft den Resize-Griff raus …
  box.style.display = 'block';
  ensureTimerLayout('goldenHud');
  reattachEditHandle('goldenHud');   // … deshalb im Edit-Modus neu anhängen
}

// ── Proximity: Lautstärke pro Spieler nach Distanz ──────────────────────────
// Volle Lautstärke bis zur halben Reichweite, dann linear auf 0 bei voller Reichweite.
// R = Reichweite des Sprechers (m). Rw = R*100 Welt-Einheiten. vol = clamp(2*(1 - d/Rw)).
function updateProximityVolumes() {
  if (!room) return;
  // STABIL: LiveKit-Wiedergabe (webAudioMix) + setVolume. Deafen/Tot über factor=0. Der 3D-Graph
  // (updateSpatial) ist vorerst deaktiviert — wird später sauber isoliert wieder aufgesetzt.
  // Gottstimme nur „aktiv", wenn der Sprecher WIRKLICH präsent ist (ich selbst = Sprecher, oder er ist
  // ein Remote-Teilnehmer) — sonst würde ein voreilig gesetztes Flag alle anderen grundlos ducken.
  const iAmGod = !!(godVoiceId && me && godVoiceId === me.steamId);
  const godActive = !!godVoiceId && (iAmGod || [...room.remoteParticipants.values()].some((rp) => rp.identity === godVoiceId));
  for (const p of room.remoteParticipants.values()) {
    const pos = players.find((pl) => pl.steamId === p.identity);
    let vol = 1;
    if (me && pos) {
      const Rw = (remoteRanges[p.identity] ?? DEFAULT_RANGE) * UNITS_PER_M;
      const d = Math.hypot(pos.x - me.x, pos.y - me.y);
      vol = Math.max(0, Math.min(1, 1 - d / Rw));
    }
    const g = userGain[p.identity] ?? 1;
    let out;
    if (godActive && p.identity === godVoiceId) {
      // Gottstimme: voll & reichweiten-unabhängig, durchdringt Deafen; respektiert Master + Tot.
      out = amDead ? 0 : GODVOICE_GAIN * masterGain;
    } else {
      const factor = (deafened || amDead) ? 0 : masterGain;
      out = vol * g * factor;
      if (godActive) out *= GODVOICE_DUCK; // während einer Durchsage alle anderen absenken
    }
    try { p.setVolume(out); } catch {}
  }
  updateSpatialPanners(); // 3D-Richtung + Unterwasser + Gottstimme-Effekt (hängt in LiveKits Kette; Gain macht setVolume oben)
}

// ── 🧭 Räumlicher Ton (IMMER an) ─────────────────────────────────────────────
// Je Sprecher ein eigener WebAudio-Graph: MediaStreamSource → PannerNode (Richtung aus Position+heading)
// → BiquadFilter (Lowpass = Unterwasser-Muffling des SPRECHERS) → perGain (Proximity/User) → spatialMaster
// (gemeinsamer Deafen-/Tot-/Master-Gate) → Ausgang. Der Raum verbindet mit webAudioMix:false.
let spatialCtx = null;                 // gemeinsamer AudioContext für alle Remote-Sprecher
let spatialMaster = null;              // gemeinsamer Master-GainNode: Deafen/Tot/Master-Lautstärke
const spatialNodes = new Map();        // identity → { src, panner, lowpass, gain }
const SPATIAL_SCALE = 0.001;           // Welt-Einheiten → Audio-Meter (nur Richtung zählt, Rolloff=0)
const SPATIAL_HEADING_OFF = 0;         // Grad: Blickrichtung→Panner. 0 (Test: +90 lag 90° zu weit rechts → 0°)
const UNDERWATER_HZ = 380;             // Lowpass-Grenzfrequenz unter Wasser — deutlich dumpf/gedämpft
const OPEN_HZ = 20000;                 // offen (keine Dämpfung)
// ── Gottstimme-Durchsage (Admin) ─────────────────────────────────────────────
const GODVOICE_GAIN = 0.5;             // Wiedergabe-Pegel des Durchsage-Sprechers (× Master) — bewusst leise + Limiter gegen Übersteuern
const GODVOICE_DUCK = 0.15;            // Faktor, auf den alle ANDEREN Sprecher während der Durchsage abgesenkt werden
// „Gott spricht vom Himmel": KEIN Verzerrer (klang übersteuert), sondern ein großer, weicher Hall.
// Umgesetzt als ConvolverNode-Impulsantwort, die das Direktsignal (Dry-Spike bei t=0) UND einen langen,
// exponentiell abklingenden Rausch-Schweif enthält → Reverb OHNE Parallel-Mix (passt in die Serien-Kette).
let godVoiceIR = null;   // Impulsantwort für den Himmels-Hall (lazy je AudioContext)
let identityIR = null;   // Ein-Sample-Impuls = Passthrough (Convolver „aus")
function ensureVoiceIRs(ctx) {
  if (godVoiceIR && identityIR) return;
  identityIR = ctx.createBuffer(1, 1, ctx.sampleRate);
  identityIR.getChannelData(0)[0] = 1; // trockener Durchlass
  const dur = 1.0, n = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const pre = Math.floor(ctx.sampleRate * 0.02); // ~20ms Predelay → Hauch von Weite („von oben")
  godVoiceIR = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = godVoiceIR.getChannelData(ch);
    d[0] = 0.95; // Direktsignal klar dominant → Stimme sauber
    // Schweif SEHR leise: die Energie summiert sich über zehntausende Taps auf, daher muss die
    // Pro-Sample-Amplitude winzig sein (~0.005), sonst wirkt der Hall viel zu „nass".
    for (let i = 1; i < n; i++) {
      if (i < pre) { d[i] = 0; continue; }
      const t = (i - pre) / (n - pre);
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3.0) * 0.005; // nur ein Hauch Raum
    }
  }
}
function spatialWake() { if (spatialCtx && spatialCtx.state === 'suspended') spatialCtx.resume().catch(() => {}); }
function ensureSpatialCtx() {
  if (!spatialCtx) {
    try {
      spatialCtx = new (window.AudioContext || window.webkitAudioContext)();
      spatialMaster = spatialCtx.createGain();
      spatialMaster.connect(spatialCtx.destination);
      // Autoplay-Policy: der Context startet „suspended" → per Geste entsperren und wach HALTEN,
      // sonst bleibt der ganze Graph stumm (man hört niemanden).
      spatialCtx.addEventListener('statechange', spatialWake);
      ['click', 'keydown', 'pointerdown'].forEach((ev) => window.addEventListener(ev, spatialWake, { passive: true }));
    } catch {}
  }
  spatialWake();
  return spatialCtx;
}
function spatialAttach(track, identity) {
  const ctx = ensureSpatialCtx(); if (!ctx || !identity) return;
  spatialDetach(identity); // evtl. alten Graph derselben identity räumen
  // track.attach() erzeugt ein <audio>-Element, das die WebRTC-Pipeline TREIBT; createMediaElementSource
  // leitet dessen Ton IN den Graph um (Element gibt dann nicht mehr direkt auf die Boxen). Reines
  // MediaStreamSource bleibt bei Remote-Tracks in Chromium oft still — daher der Element-Weg.
  const el = track.attach(); el.autoplay = true;
  document.body.appendChild(el);
  let src;
  try { src = ctx.createMediaElementSource(el); } catch { try { el.remove(); } catch {} return; }
  const panner = ctx.createPanner();
  panner.panningModel = 'HRTF'; panner.distanceModel = 'linear';
  panner.refDistance = 1; panner.maxDistance = 1e6; panner.rolloffFactor = 0; // Distanz-Gain macht perGain, nicht der Panner
  const lowpass = ctx.createBiquadFilter(); lowpass.type = 'lowpass'; lowpass.frequency.value = OPEN_HZ;
  const gain = ctx.createGain(); gain.gain.value = 0;
  src.connect(panner); panner.connect(lowpass); lowpass.connect(gain); gain.connect(spatialMaster);
  spatialNodes.set(identity, { el, src, panner, lowpass, gain });
  if (spkDeviceId && ctx.setSinkId) ctx.setSinkId(spkDeviceId).catch(() => {}); // Ausgabegerät (falls Browser es kann)
}
function spatialDetach(identity) {
  const n = identity && spatialNodes.get(identity);
  if (!n) return;
  try { n.src.disconnect(); n.panner.disconnect(); n.lowpass.disconnect(); n.gain.disconnect(); } catch {}
  try { if (n.el) n.el.remove(); } catch {}
  spatialNodes.delete(identity);
}
function updateSpatial() {
  const ctx = spatialCtx; if (!ctx || !spatialMaster) return;
  const now = ctx.currentTime;
  // Deafen/Tot = HARTER Master-Gate (unabhängig davon, wen der Server subscribed); sonst Master-Lautstärke.
  const master = (deafened || amDead) ? 0 : masterGain;
  try { spatialMaster.gain.setTargetAtTime(master, now, 0.03); } catch { spatialMaster.gain.value = master; }
  // Blickrichtung von „mir" → Welt-Forward/Right-Basis (gleiche -90°-Konvention wie Karte/Kompass).
  const hr = ((me && me.heading != null ? me.heading : 0) + SPATIAL_HEADING_OFF) * Math.PI / 180;
  const fx = Math.cos(hr), fy = Math.sin(hr);   // Forward (Welt)
  const rx = -fy, ry = fx;                        // Right = Forward um +90° (L/R gespiegelt: vorn/hinten stimmte, links/rechts war getauscht)
  const dbg = [`me:${me ? `x${me.x | 0} y${me.y | 0} h${Math.round(me.heading || 0)}` : 'NULL'} ctx:${ctx.state} master:${master.toFixed(2)} spk:${spatialNodes.size}`];
  for (const [identity, n] of spatialNodes) {
    const pos = players.find((pl) => pl.steamId === identity);
    // Richtung relativ zu meiner Blickrichtung (WebAudio: +x rechts, -z vorn, +y oben).
    let px = 0, pz = -1, dU = 0;
    if (me && pos) {
      const dx = pos.x - me.x, dy = pos.y - me.y;
      const fwd = dx * fx + dy * fy, right = dx * rx + dy * ry;
      px = right * SPATIAL_SCALE; pz = -fwd * SPATIAL_SCALE;
      dU = Math.hypot(dx, dy);
    }
    try { n.panner.positionX.setValueAtTime(px, now); n.panner.positionY.setValueAtTime(0, now); n.panner.positionZ.setValueAtTime(pz, now); }
    catch { try { n.panner.setPosition(px, 0, pz); } catch {} }
    // Unterwasser-Muffling des Sprechers (weicher Übergang, kein Klick).
    const targetHz = (pos && pos.isUnderwater) ? UNDERWATER_HZ : OPEN_HZ;
    try { n.lowpass.frequency.setTargetAtTime(targetHz, now, 0.08); } catch { n.lowpass.frequency.value = targetHz; }
    // Proximity-Gain je Sprecher (Deafen/Master liegt im spatialMaster).
    let vol = 1;
    if (me && pos) {
      const Rw = (remoteRanges[identity] ?? DEFAULT_RANGE) * UNITS_PER_M;
      vol = Math.max(0, Math.min(1, 1 - dU / Rw));
    }
    const g = userGain[identity] ?? 1;
    try { n.gain.gain.setTargetAtTime(vol * g, now, 0.05); } catch { n.gain.gain.value = vol * g; }
    const nm = (pos && (pos.name || pos.playerName)) || String(identity).slice(-4);
    const side = px > 0.05 ? 'R' : px < -0.05 ? 'L' : 'C';
    const frb = pz < -0.05 ? 'F' : pz > 0.05 ? 'B' : '·';
    dbg.push(`${pos ? '' : '?'}${nm}  d=${Math.round(dU / UNITS_PER_M)}m vol=${vol.toFixed(2)} pan=${side}${frb}(${px.toFixed(2)})${(pos && pos.isUnderwater) ? ' UW' : ''}`);
  }
  renderVoiceDbg(dbg);
}
// F9-Debug-Panel: exakte Zahlen (Distanz/Gain/Pan je Sprecher) zum Tunen von Reichweite & 3D.
let voiceDbgOn = false; // NUR für Admins, per F9 einblendbar — normale Spieler sehen das Panel NIE
function renderVoiceDbg(rows) {
  const box = el('voiceDbg'); if (!box) return;
  if (!voiceDbgOn || !voiceConnected || !isAdmin) { box.style.display = 'none'; return; } // Admin-Gate
  box.style.display = 'block';
  box.textContent = rows.join('\n');
}
window.addEventListener('keydown', (e) => {
  if (e.key !== 'F9' || !isAdmin) return; // F9-Toggle nur für Admins
  voiceDbgOn = !voiceDbgOn;
  const b = el('voiceDbg'); if (b && !voiceDbgOn) b.style.display = 'none';
});

// ── 🧭 Räumlicher Ton v2 (weniger invasiv) ───────────────────────────────────
// webAudioMix BLEIBT AN (stabil, kein Rauschen). Wir hängen NUR einen PannerNode + Lowpass über
// LiveKits offizielle setWebAudioPlugins-API in die bestehende Kette:
//   source → [panner → lowpass] → gainNode(setVolume) → out
// Kein eigener Graph, kein eigenes Element, keine Autoplay-Bastelei — LiveKit managt Quelle/Gain/
// Lifecycle. LiveKit nutzt UNSEREN AudioContext (voiceCtx), damit die Nodes zusammenpassen.
let voiceCtx = null;
const spatialPlugins = new Map(); // identity → { panner, lowpass }
// 3D-Effektstärke (0 = mono/mittig, 1 = normal, bis 1.5 überzeichnet). Skaliert die Panner-Auslenkung.
let spatial3dStrength = (() => { const v = parseFloat(localStorage.getItem('bf-voice-3d-strength')); return isNaN(v) ? 1 : v; })();
function setSpatial3dStrength(pct) {
  spatial3dStrength = Math.max(0, Math.min(1.5, pct / 100));
  try { localStorage.setItem('bf-voice-3d-strength', String(spatial3dStrength)); } catch {}
  const lbl = el('spatial3dVal'); if (lbl) lbl.textContent = `${Math.round(spatial3dStrength * 100)}%`;
  updateProximityVolumes(); // sofort wirksam (kein Neuverbinden)
}
// ── Gottstimme-Durchsage (Admin, im Admin-Tab „📣 Gottstimme") ────────────────
// Startet/beendet die server-weite Durchsage über POST /voice/godvoice. Der echte Zustand kommt über
// /positions (data.godVoice) zurück und steuert bei allen Clients Effekt + Ducken (updateProximityVolumes).
async function setGodVoice(on) {
  if (!sessionToken) return;
  if (on && !voiceConnected) { showToast('⚠️ Erst dem Voice beitreten — sonst hört dich niemand.', 'warn'); return; }
  try {
    const res = await fetch(`${config.tokenBase}/voice/godvoice`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: !!on, reverb: godVoiceReverbPref }),
    });
    if (!res.ok) { showToast('Gottstimme fehlgeschlagen', 'error'); return; }
    const data = await res.json().catch(() => ({}));
    godVoiceMine = !!data.on;          // optimistisch; der nächste /positions-Poll bestätigt
    renderGodVoice();
    showToast(godVoiceMine ? '📣 Gottstimme AN — alle hören dich.' : 'Gottstimme aus.', godVoiceMine ? 'success' : 'info');
  } catch { showToast('Gottstimme fehlgeschlagen', 'error'); }
}
function toggleGodVoice() { setGodVoice(!godVoiceMine); }
// Himmels-Hall an/aus (Admin-Wahl). Läuft gerade MEINE Durchsage, sofort server-seitig nachziehen.
function setGodVoiceReverbPref(on) {
  godVoiceReverbPref = !!on;
  try { localStorage.setItem('bf-godvoice-reverb', godVoiceReverbPref ? '1' : '0'); } catch {}
  if (godVoiceMine) setGodVoice(true); // aktualisiert reverb server-seitig (alle Hörer sofort)
  renderGodVoice();
}
function renderGodVoice() {
  const btn = el('godVoiceBtn'); if (!btn) return;
  btn.textContent = godVoiceMine ? '⏹️ Gottstimme beenden' : '📣 Gottstimme starten';
  btn.classList.toggle('secondary', godVoiceMine);
  const chk = el('godVoiceReverbChk'); if (chk) chk.checked = godVoiceReverbPref;
  const hint = el('godVoiceHint');
  if (hint) hint.textContent = !voiceConnected
    ? '⚠️ Nicht im Voice verbunden — die Durchsage wird nicht übertragen.'
    : (godVoiceMine ? '● Läuft — du wirst server-weit gehört.' : '');
}
function ensureVoiceCtx() {
  if (!voiceCtx) {
    try {
      voiceCtx = new (window.AudioContext || window.webkitAudioContext)();
      // 🔊 Ausgabegerät auf den CONTEXT setzen: bei webAudioMix läuft der Ton über den AudioContext,
      // setSinkId auf den <audio>-Elementen ist wirkungslos. Ohne das hörten User mit Nicht-Standard-
      // Ausgabegerät (Headset) nichts bzw. auf dem falschen Gerät. [BFT-287]
      if (spkDeviceId && voiceCtx.setSinkId) voiceCtx.setSinkId(spkDeviceId).catch(() => {});
      // Autoplay-Gate: bleibt der Context „suspended" (startAudio fehlgeschlagen), wäre ALLES dauerhaft
      // stumm. Per Geste + statechange entsperren und wach halten. [BFT-287]
      voiceCtx.addEventListener('statechange', voiceCtxWake);
      ['click', 'keydown', 'pointerdown'].forEach((ev) => window.addEventListener(ev, voiceCtxWake, { passive: true }));
    } catch {}
  }
  voiceCtxWake();
  return voiceCtx;
}
function voiceCtxWake() { if (voiceCtx && voiceCtx.state === 'suspended') voiceCtx.resume().catch(() => {}); }
// 🔀 Kill-Switch für die ganze Effekt-Kette (3D/Unterwasser/Gottstimme-Effekt). Default AN.
// AUS = pures LiveKit-Playback wie vor 1.9 (Diagnose-/Rettungsschalter bei Knistern/Audio-Problemen).
let voiceEffectsOn = localStorage.getItem('bf-voice-effects') !== '0';
function setVoiceEffects(on) {
  voiceEffectsOn = !!on;
  try { localStorage.setItem('bf-voice-effects', voiceEffectsOn ? '1' : '0'); } catch {}
  if (!voiceEffectsOn) {
    for (const [, pl] of spatialPlugins) { try { pl.track.setWebAudioPlugins([]); } catch {} } // Ketten leeren → plain
    spatialPlugins.clear();
  } else if (room) {
    for (const p of room.remoteParticipants.values()) {   // Ketten für alle aktiven Tracks neu aufbauen
      for (const pub of p.audioTrackPublications.values()) { if (pub.track) attachSpatialPlugins(pub.track, p.identity); }
    }
  }
  updateProximityVolumes();
}
function attachSpatialPlugins(track, identity) {
  const ctx = voiceCtx; if (!voiceEffectsOn || !ctx || !identity || typeof track.setWebAudioPlugins !== 'function') return;
  // 'equalpower' statt HRTF: HRTF ist eine Faltung PRO QUELLE — bei ~36 Sprechern neben dem laufenden
  // Spiel führte das zu Audio-Underruns (Knistern). equalpower liefert weiter klares L/R-Panning bei
  // einem Bruchteil der CPU. [BFT-287]
  const panner = ctx.createPanner();
  panner.panningModel = 'equalpower'; panner.distanceModel = 'linear';
  panner.refDistance = 1; panner.maxDistance = 1e6; panner.rolloffFactor = 0; // Distanz-Gain macht setVolume, nicht der Panner
  const lowpass = ctx.createBiquadFilter(); lowpass.type = 'lowpass'; lowpass.frequency.value = OPEN_HZ;
  // Normale Sprecher = MINIMAL-Kette (nur Panner+Lowpass). Reverb+Limiter existieren NUR in der
  // Gottstimme-Kette (godChain unten) — statt 36× Convolver+Compressor im Signalweg. [BFT-287]
  try { track.setWebAudioPlugins([panner, lowpass]); } catch { return; } // source→panner→lowpass→gain
  spatialPlugins.set(identity, { track, panner, lowpass, god: false, reverb: null, limiter: null });
}
// Gottstimme-Kette nur für den aktiven Durchsage-Sprecher ein-/aushängen (Reverb + Limiter).
function setGodChain(pl, on) {
  if (pl.god === on) return;
  const ctx = voiceCtx; if (!ctx) return;
  if (on && !pl.limiter) {
    ensureVoiceIRs(ctx);
    pl.reverb = ctx.createConvolver(); pl.reverb.normalize = false; pl.reverb.buffer = identityIR;
    // Brick-Wall-Limiter: die Gottstimme läuft mit vollem Pegel ohne Distanz-Abschwächung → Spitzen
    // nahe 0 dBFS abfangen, damit nichts übersteuert.
    pl.limiter = ctx.createDynamicsCompressor();
    pl.limiter.threshold.value = -2; pl.limiter.knee.value = 0; pl.limiter.ratio.value = 20; pl.limiter.attack.value = 0.003; pl.limiter.release.value = 0.12;
  }
  try {
    pl.track.setWebAudioPlugins(on ? [pl.panner, pl.lowpass, pl.reverb, pl.limiter] : [pl.panner, pl.lowpass]);
    pl.god = on;
  } catch {}
}
// Panner-Richtung (z+heading) + Unterwasser-Lowpass je Sprecher aktualisieren. Gain/Deafen macht weiter setVolume.
function updateSpatialPanners() {
  const ctx = voiceCtx; if (!ctx) { renderVoiceDbg([]); return; }
  if (!voiceEffectsOn) { renderVoiceDbg(['3D/Effekte AUS (Audio-Einstellungen)']); return; }
  const now = ctx.currentTime;
  const hr = ((me && me.heading != null ? me.heading : 0) + SPATIAL_HEADING_OFF) * Math.PI / 180;
  const fx = Math.cos(hr), fy = Math.sin(hr);   // Forward (Welt)
  const rx = -fy, ry = fx;                        // Right = Forward um +90° (L/R gespiegelt: vorn/hinten stimmte, links/rechts war getauscht)
  const meUW = !!(me && me.isUnderwater); // ICH untergetaucht → ich höre ALLE gedämpft
  const dbg = [`me:${me ? `h${Math.round(me.heading || 0)}${meUW ? ' UW' : ''}` : 'NULL'} ctx:${ctx.state} spk:${spatialPlugins.size}`];
  for (const [identity, pl] of spatialPlugins) {
    const pos = players.find((p) => p.steamId === identity);
    const isGod = !!godVoiceId && identity === godVoiceId; // Gottstimme: zentriert, offen, verzerrt — ohne Richtung/Muffling
    let px = 0, pz = -1, dU = 0;
    if (me && pos && !isGod) {
      const dx = pos.x - me.x, dy = pos.y - me.y;
      const fwd = dx * fx + dy * fy, right = dx * rx + dy * ry;
      const s = spatial3dStrength; // eine persönliche 3D-Stärke für alle, die man hört
      px = right * SPATIAL_SCALE * s;
      pz = (-fwd * SPATIAL_SCALE) * s - (1 - s); // s→0 blendet nach (0,0,-1) = geradeaus
      dU = Math.hypot(dx, dy);
    }
    // Weich zur neuen Position gleiten (setTargetAtTime) statt harter 100-ms-Sprünge (setValueAtTime):
    // die Sprünge erzeugten hörbare Klick-/Zipper-Artefakte bei sich bewegenden Sprechern. [BFT-287]
    try { pl.panner.positionX.setTargetAtTime(px, now, 0.05); pl.panner.positionY.setTargetAtTime(0, now, 0.05); pl.panner.positionZ.setTargetAtTime(pz, now, 0.05); }
    catch { try { pl.panner.setPosition(px, 0, pz); } catch {} }
    // Unterwasser-Muffel BEIDSEITIG: gedämpft, wenn ICH untergetaucht bin ODER der Sprecher es ist.
    // Gottstimme durchdringt Wasser (bleibt offen).
    const spkUW = !!(pos && pos.isUnderwater);
    const uw = !isGod && (meUW || spkUW);
    const hz = isGod ? OPEN_HZ : (uw ? UNDERWATER_HZ : OPEN_HZ);
    try { pl.lowpass.frequency.setTargetAtTime(hz, now, 0.08); } catch { pl.lowpass.frequency.value = hz; }
    setGodChain(pl, isGod); // Reverb+Limiter NUR am Durchsage-Sprecher (Ein-/Aushängen bei Statuswechsel)
    if (pl.reverb) { const want = (isGod && godVoiceReverbActive) ? godVoiceIR : identityIR; if (pl.reverb.buffer !== want) pl.reverb.buffer = want; } // Himmels-Hall nur bei Durchsage + wenn eingeschaltet
    const nm = (pos && (pos.name || pos.playerName)) || String(identity).slice(-4);
    const side = isGod ? '👑' : (px > 0.05 ? 'R' : px < -0.05 ? 'L' : 'C');
    dbg.push(`${pos ? '' : '?'}${nm} d=${Math.round(dU / UNITS_PER_M)}m pan=${side}(${px.toFixed(2)})${isGod ? ' GOD' : uw ? ' UW' : ''}`);
  }
  renderVoiceDbg(dbg);
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
    vol = Math.max(0, Math.min(1, 1 - d / Rw));
  }
  const g = userGain[steamId] ?? 1;
  const factor = (deafened || amDead) ? 0 : masterGain;
  return vol * g * factor;
}
const OBSIDIAN_HEX = '#c4b5fd'; // Obsidian-Tier-Textfarbe (vgl. .tier-Obsidian in overlay.html)
const DUTY_RED = '#ff3b3b';    // Teamler im Dienst-Modus → rot (klar als Admin/Dienst erkennbar)
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
    const nm = pl && (pl.name || pl.playerName);              // name = RP-Name falls gesetzt; bei onDuty erzwingt das Backend den echten Namen
    if (nm) items.push({ nm, color: pl.roleColor, team: !!pl.team, onDuty: !!pl.onDuty });
  }
  if (!items.length) { box.style.display = 'none'; return; }
  box.style.display = '';
  // Farb-/Namensregel für Teamler (sonst stechen sie durch ihre Rollenfarbe sofort heraus):
  // • Im Dienst-Modus (pinker Admin-Skin) → Klarname (Backend liefert bei onDuty schon den echten
  //   Namen) in ROT → klar als Admin/Dienst erkennbar.
  // • Außer Dienst → RP-Name (sonst echter Name) in Obsidian-Lila → wirkt wie ein normaler
  //   Top-Abonnent, die auffällige Team-Rollenfarbe wird verborgen.
  // • Alle anderen → Name in ihrer Discord-Rollenfarbe wie gehabt.
  box.innerHTML = `🔊 ${items.map(({ nm, color, team, onDuty }) => {
    let hex = (color && color > 0) ? '#' + (color >>> 0).toString(16).padStart(6, '0') : null;
    if (team && onDuty) hex = DUTY_RED;                      // im Dienst: rot (Admin/Dienst)
    else if (team && !onDuty) hex = OBSIDIAN_HEX;            // außer Dienst: Rollenfarbe durch Obsidian ersetzen
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
    row.style.cssText = 'margin-bottom:8px';
    row.innerHTML =
      `<div style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:3px">👤 ${name}</div>` +
      `<div style="display:flex;align-items:center;gap:6px">` +
        `<span title="Lautstärke" style="width:16px">🔊</span>` +
        `<input class="u-vol" type="range" min="0" max="200" step="5" value="${Math.round(g * 100)}" style="flex:1;accent-color:var(--accent)">` +
        `<span class="u-vol-l" style="width:40px;text-align:right;font-size:11px;color:var(--muted)">${Math.round(g * 100)}%</span>` +
      `</div>`;
    const uv = row.querySelector('.u-vol'), uvl = row.querySelector('.u-vol-l');
    uv.addEventListener('input', () => { uvl.textContent = `${uv.value}%`; setUserGain(p.identity, parseInt(uv.value) / 100); });
    box.appendChild(row);
  }
}

// ── Sprechreichweite ─────────────────────────────────────────────────────────
function updateRangeDisplay() {
  const rb = document.getElementById('rangeBox'); if (rb) rb.textContent = `🔊 Reichweite: ${myRange} m`;
  document.querySelectorAll('#rangeBtns [data-range]').forEach((b) => { b.className = parseFloat(b.dataset.range) === myRange ? 'active' : 'secondary'; });
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
  const box = el('zoneBox');
  if (!me) { box.textContent = 'Zone: —'; box.style.color = '#b3a9cc'; return; }
  // Zonen sind NICHT exklusiv → alle aktuellen als Liste zeigen (z. B. „Patrol · Migration").
  const zs = zonesAt(me.x, me.y);
  const text = zs.length ? zs.map((z) => z.label).join(' · ') : 'Realismus';
  const coords = `X ${(me.x / 1000) | 0}k  Y ${(me.y / 1000) | 0}k`;
  box.innerHTML = `Zone: ${text}<br><span style="font-size:11px;opacity:0.7">${coords}</span>`;
  const hasPvp = zs.some((z) => z.type === 'pvp');
  const hasPve = zs.some((z) => z.type === 'pve');
  box.style.color = hasPvp ? '#ef4444' : hasPve ? '#22c55e' : '#b3a9cc';
}

// Toast beim Betreten der PvP-/PvE-Zone (Umriss-Zonen lösen bewusst keinen Toast aus → kein Spam)
let currentZone;
function checkZoneChange() {
  if (!me) return;
  const zs = zonesAt(me.x, me.y);
  const z = zs.some((x) => x.type === 'pvp') ? 'PVP' : zs.some((x) => x.type === 'pve') ? 'PVE' : 'Realismus';
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
let minimapDirty = true;   // erzwingt einen Redraw bei Zoom/Theme (Bewegung erkennt der rAF-Loop selbst)
let miniDisp = {};         // steamId → {x,y} gleitend interpolierte Anzeige-Position
let minimapRAF = 0;
let miniFrame = 0;
// rAF-Loop (~30fps, Perf-Cap): zieht die angezeigten Positionen weich zu den echten (100ms-Poll) nach
// → entfernte Spieler gleiten statt in 10 Stufen/s zu springen. Smart-Gating: kein Redraw, wenn nichts
// in Bewegung ist (Minimap zeichnet Karte+Zonen → nur so oft neu wie nötig).
function minimapLoop() {
  minimapRAF = requestAnimationFrame(minimapLoop);
  if (!me) return;                                   // off-server → nichts zu zeichnen
  const mw = el('minimapWrap');
  if (mw && mw.style.display === 'none') return;      // Minimap ausgeblendet
  if (miniFrame++ & 1) return;                        // ~30fps: nur jeden 2. Frame (flüssig genug, halbe Last)
  let moving = false;
  const seen = {};
  for (const p of players) {
    if (typeof p.x !== 'number') continue;
    seen[p.steamId] = true;
    const d = miniDisp[p.steamId];
    if (!d) { miniDisp[p.steamId] = { x: p.x, y: p.y }; continue; }
    const dx = p.x - d.x, dy = p.y - d.y;
    if (Math.hypot(dx, dy) > 8000) { d.x = p.x; d.y = p.y; moving = true; continue; } // Teleport → snappen
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) { d.x += dx * 0.35; d.y += dy * 0.35; moving = true; }
  }
  for (const sid in miniDisp) { if (!seen[sid]) delete miniDisp[sid]; } // weg vom Server → raus
  if (!moving && !minimapDirty) return;              // nichts geändert → CPU sparen
  minimapDirty = false;
  renderMinimap();
}
function setMiniZoom(z) {
  miniZoom = Math.min(6, Math.max(0.5, z));
  localStorage.setItem('bf-mini-zoom', miniZoom.toFixed(2));
  renderMinimap();
}
function renderMinimap() {
  const cv = el('minimap');
  const ctx = cv.getContext('2d');
  const { w, h } = fitCanvasDPR(cv, ctx);
  // Interpolierte Anzeige-Positionen (miniDisp) statt der roh-100ms-Sprünge; Fallback = echte Position.
  const iplayers = players.map((p) => { const d = miniDisp[p.steamId]; return d ? { ...p, x: d.x, y: d.y } : p; });
  const dme = me && miniDisp[me.steamId];
  const ime = dme ? { ...me, x: dme.x, y: dme.y } : me;
  drawMinimap({ ctx, w, h }, iplayers, ime, myRange * UNITS_PER_M, waypoints, miniZoom);
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
  if (!heatmapMode && isTeam && aiLayerOn) drawAiEncounters(ctx, cv.width, cv.height, 1 / mapZoom, aiEncounters, baseClass);
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

// ── KI-Dino-Encounter-Layer (nur Team) ───────────────────────────────────────
// Zeichnet die vom Game-Server (/ai/encounters) gelieferten Spawnpunkte (rote Rauten) und
// Patrouillen (gestrichelte Linien) auf die große Karte. Platzhalter-Einträge mit Spawn {0,0}
// (noch nicht platziert) werden übersprungen. sc = 1/mapZoom hält Marker/Text zoom-konstant.
// Encounters vom Backend holen (staff-gated). Statische Konfig → ein Fetch pro Karten-Öffnen reicht.
async function loadAiEncounters() {
  if (!isTeam || !sessionToken) return;
  try {
    const res = await fetch(`${config.tokenBase}/ai/encounters`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!res.ok) return;
    const d = await res.json();
    aiEncounters = Array.isArray(d.encounters) ? d.encounters : [];
    if (mapOpen) renderBigMap();
  } catch {}
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

  // Encounter-Wegpunkt-Modus (Brain-Editor): jeder Klick hängt einen Patrouillen-Punkt an.
  // z=0 = „Boden am Laufzeitpunkt suchen" (der Brain snappt/pathet selbst). [BFT-294]
  if (encWpMode && svEncDraft) {
    (svEncDraft.patrol = svEncDraft.patrol || []).push({ x: Math.round(w.x), y: Math.round(w.y), z: 0 });
    showToast(`🗺️ Wegpunkt ${svEncDraft.patrol.length} gesetzt`, 'success');
    renderEncEditor();
    renderBigMap();
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
function calibPrompt(text, showCancel, showSkip) {
  const p = el('calibPrompt'); if (!p) return;
  p.style.display = 'block';
  el('calibPromptText').textContent = text;
  el('calibCancelBtn').style.display = showCancel ? 'inline-block' : 'none';
  const sk = el('calibSkipBtn'); if (sk) sk.style.display = showSkip ? 'inline-block' : 'none';
}
function endAutoCalib() { autoCalib = null; const p = el('calibPrompt'); if (p) p.style.display = 'none'; }
function waitForCalibClick() { return new Promise((resolve) => { autoCalib.resolveClick = resolve; }); }

async function startAutoCalibration() {
  if (autoCalib) return;
  if (!me) { showToast('Kalibrierung nur auf dem Server möglich', 'error'); return; }
  autoCalib = { startPos: { x: me.x, y: me.y, z: me.z }, pairs: [], resolveClick: null };
  toggleSettings(false);
  toggleMap(true);
  const targets = pickCalibTargets(8);
  if (targets.length < 3) {
    showToast('Zu wenige Kalibrier-Punkte — Kalibrierung nicht möglich', 'error');
    endAutoCalib();
    return;
  }
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    calibPrompt(`Punkt ${i + 1}/${targets.length} — du wirst über den Punkt teleportiert…`, true, false);
    try { await calibTeleport(t.x, t.y, CALIB_HOVER_Z); } // hoch über dem Punkt → kein Aufprall
    catch (e) { showToast(`Punkt ${i + 1} übersprungen (Teleport: ${e.message})`, 'error'); continue; }
    if (!autoCalib) return; // abgebrochen
    // Schweben: regelmäßig wieder hochteleportieren → man fällt nie auf, kein Schaden
    const hover = setInterval(() => { calibTeleport(t.x, t.y, CALIB_HOVER_Z).catch(() => {}); }, 800);
    calibPrompt(`Punkt ${i + 1}/${targets.length} — du schwebst über dem Punkt. Klicke auf der Karte GENAU dort, wo du bist. (Über Wasser/unklar? → Überspringen)`, true, true);
    const norm = await waitForCalibClick();
    clearInterval(hover);
    if (!autoCalib) return;
    if (norm === 'skip') continue;                 // diesen Punkt auslassen (z. B. Anker über Wasser)
    if (!norm) { await abortAutoCalib(); return; } // Abbrechen
    autoCalib.pairs.push({ world: { x: t.x, y: t.y }, norm });
  }
  calibPrompt('Zurück zur Startposition…', false);
  try { await calibTeleport(autoCalib.startPos.x, autoCalib.startPos.y, autoCalib.startPos.z); } catch {}
  const count = autoCalib.pairs.length;
  if (count < 3) {
    showToast(`Zu wenige Punkte (${count}/${targets.length}) — bitte erneut versuchen`, 'error');
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
    const water = !!t.water;
    const row = document.createElement('div');
    row.style.cssText = `padding:6px 8px;margin-bottom:4px;border-radius:8px;cursor:pointer;border:1px solid ${hot ? 'var(--accent)' : (water ? 'rgba(56,189,248,0.55)' : 'transparent')};background:${hot ? 'rgba(var(--accent-rgb),0.20)' : (water ? 'rgba(56,189,248,0.13)' : 'rgba(255,255,255,0.04)')}`;
    row.innerHTML =
      `<div style="display:flex;justify-content:space-between;gap:6px"><b>${water ? '💧 ' : ''}#${t.number} ${escapeHtml(t.name)}</b>` +
      `<span style="color:var(--muted)">${t.price > 0 ? t.price + ' Pkt' : 'gratis'}</span></div>` +
      (water ? '<div style="color:#38bdf8;font-size:11px">🌊 Wasser-Teleport</div>' : '') +
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
let serverOpen = false;
let adminUserMap = new Map();   // Option-Text → { steamId, discordId, name }
let adminUsers = [];            // volle User-Liste (für robuste Suche/Filter)
let admSelectedSteamId = null;

// ── User-Suchfelder: robust + skalierend ─────────────────────────────────────
// filterDatalist befüllt das zum Input gehörende <datalist> mit den Top-Treffern zur aktuellen
// Eingabe (Name/SteamID/DiscordID, Teilstring, case-insensitive), gedeckelt auf 50.
function filterDatalist(inp) {
  const listId = inp.getAttribute('list');
  if (!listId) return;
  const dl = document.getElementById(listId);
  if (!dl) return;
  const users = USER_POOLS[inp.id] || adminUsers || [];
  const q = (inp.value || '').trim().toLowerCase();
  // Substring über alle drei Namen: das Label enthält RP+Steam+Discord, deshalb reicht ein
  // includes() auf dem Label (+ SteamID/DiscordID fürs Copy-Paste).
  const hits = (q
    ? users.filter((u) => userLabel(u).toLowerCase().includes(q) || (u.steamId || '').includes(q) || (u.discordId || '').includes(q))
    : users
  ).slice(0, 50);
  const seen = new Set();
  dl.innerHTML = hits.map((u) => {
    let key = userLabel(u);
    if (seen.has(key)) key = `${key} (…${(u.steamId || u.discordId || '').slice(-4)})`;
    seen.add(key);
    return `<option value="${escapeHtml(key)}"></option>`;
  }).join('');
}

// Delegiert: jedes User-Suchfeld (in USER_POOLS registriert) filtert beim Tippen UND beim Fokus.
document.addEventListener('input', (e) => { const t = e.target; if (t && t.id && USER_POOLS[t.id]) filterDatalist(t); });
document.addEventListener('focusin', (e) => { const t = e.target; if (t && t.id && USER_POOLS[t.id]) filterDatalist(t); });

function openAdminPanel() {
  if (!isStaff) { showToast('Nur für Staff (Supporter/Moderator+)', 'error'); return; }
  adminOpen = true;
  el('adminPanel').style.display = 'flex';
  // Spalten nach Rang einblenden: admin-only nur Admin, ingame-only nur Moderator+.
  // Supporter (Team) sehen Spieler-Verwaltung (Info/Lightning) + Dino-Token-Tools.
  document.querySelectorAll('#adminPanel .admin-only').forEach((c) => { c.style.display = isAdmin ? '' : 'none'; });
  document.querySelectorAll('#adminPanel .ingame-only').forEach((c) => { c.style.display = isIngame ? '' : 'none'; });
  updateInteractive();
  ensureGiftTypeOptions();
  loadAdminUsers();
  loadDutyState();                        // async → setzt dutyOn + zieht das Gate nach
  if (isIngame) loadAdminRoles();         // Gift-Rollen-Dropdown — nur Moderator+ (Beschenken)
  applyModerationGate();                  // Tabs je nach Dienst-Modus/Admin ein-/ausblenden
}
// Moderation-Panel: für Moderatoren/Supporter sind alle Tabs (außer Handbuch) NUR sichtbar, wenn
// der Dienst-Modus an ist. Admins sehen immer alles. Handbuch ist immer da.
function applyModerationGate() {
  if (!adminOpen) return;
  const active = isAdmin || dutyOn;
  document.querySelectorAll('#adminTabs [data-atab]').forEach((b) => {
    const t = b.dataset.atab;
    if (t === 'handbuch') { b.style.display = ''; return; } // Handbuch immer
    let vis = active;
    if (b.classList.contains('admin-only') && !isAdmin) vis = false; // account/lootbox bleiben admin-only
    b.style.display = vis ? '' : 'none';
  });
  const cur = document.querySelector(`#adminTabs [data-atab="${adminTab}"]`);
  if (!cur || cur.style.display === 'none') showAdminTab(active ? 'tools' : 'handbuch');
}
// Admin-Panel-Tabs (Tools / Dino-Token / künftige Staff-Chunks)
let adminTab = 'tools';
function showAdminTab(t) {
  const btn = document.querySelector(`#adminTabs [data-atab="${t}"]`);
  if (btn && btn.style.display === 'none') { // gesperrter Tab → auf Tools, sonst Handbuch (immer da)
    const toolsBtn = document.querySelector('#adminTabs [data-atab="tools"]');
    t = (toolsBtn && toolsBtn.style.display !== 'none') ? 'tools' : 'handbuch';
  }
  adminTab = t;
  document.querySelectorAll('#adminTabs [data-atab]').forEach((b) => b.classList.toggle('secondary', b.dataset.atab !== t));
  document.querySelectorAll('#adminPanel .admin-pane').forEach((p) => { p.hidden = p.dataset.pane !== t; });
  if (t === 'dtoken') ensureDtLoaded();
  else if (t === 'pvp') ensurePvpLoaded();
  else if (t === 'account') renderAccount();
  else if (t === 'lootbox') ensureLootboxCfgLoaded();
  else if (t === 'warn') renderWarnPane();
  else if (t === 'audit') renderAudit();
  else if (t === 'handbuch') renderHandbuch();
  bfScheduleFrameSync && bfScheduleFrameSync();
}

// ── Player-Audit: Dino-Aktions-Log (nur Owner/Admin/Developer) ───────────────
// Das Backend (/admin/player-audit) filtert, sortiert und paginiert SERVERSEITIG und gated
// selbst auf einen echten Menschen mit Rang aus ADMIN_RANKS — hier ist nur UI. Die Filterleiste
// wird EINMAL gebaut und danach nie neu gezeichnet (sonst verlöre man beim Nachladen Fokus und
// Eingaben); neu gerendert wird ausschliesslich die Tabelle + der Fuss.
// Sensible Aktionen, die im Filter-Dropdown nur Admins sehen (Moderatoren nicht).
const PA_ADMIN_ACTIONS = new Set(['duty_on', 'duty_off']);
const PA_COLS = [ // key = Sort-Whitelist des Backends; null = nicht sortierbar
  { key: 'time', label: 'Zeit', w: '86px' },
  { key: 'name', label: 'Spieler' },
  { key: 'steam', label: 'SteamID', w: '130px' },
  { key: 'action', label: 'Aktion', w: '120px' },
  { key: 'dino', label: 'Dino', w: '110px' },
  { key: null, label: 'Via', w: '96px' },
  { key: null, label: 'Details' },
];
const PA_VIA = { overlay: ['🎮', 'Spieler'], staff: ['🛡️', 'Staff'], system: ['⚙️', 'System'], service: ['🤖', 'Bot'] };
let paState = { built: false, items: [], total: 0, sort: 'time', order: 'desc', limit: 100, offset: 0, loading: false, fromMs: 0, toMs: 0 };
// Aktion-Filter: durchsuchbares Multi-Select-Popup statt <select multiple>.
let paActionSel = new Set();   // aktuell gewählte Aktionen
let paAllActions = [];         // alle verfügbaren Aktionen (vom Backend)
function paUpdateActionBtn() {
  const b = el('paActionBtn'); if (!b) return;
  const n = paActionSel.size;
  b.textContent = (n === 0 ? 'Alle Aktionen' : n === 1 ? [...paActionSel][0] : `${n} Aktionen gewählt`) + ' ▾';
  b.classList.toggle('active', n > 0);
  const c = el('paActionCount'); if (c) c.textContent = n ? `${n} gewählt` : '';
}
function paRenderActionList(filter) {
  const wrap = el('paActionList'); if (!wrap) return;
  const q = (filter || '').trim().toLowerCase();
  const list = paAllActions.filter((a) => !q || a.toLowerCase().includes(q));
  wrap.innerHTML = list.length
    ? list.map((a) => `<label class="pa-msel-opt"><input type="checkbox" value="${escapeHtml(a)}"${paActionSel.has(a) ? ' checked' : ''}><span>${escapeHtml(a)}</span></label>`).join('')
    : '<div class="pa-msel-empty">Keine Treffer</div>';
  wrap.querySelectorAll('input[type=checkbox]').forEach((c) => {
    c.onchange = () => { if (c.checked) paActionSel.add(c.value); else paActionSel.delete(c.value); paUpdateActionBtn(); paLoad(true); };
  });
}
function paToggleActionPop(show) {
  const pop = el('paActionPop'); if (!pop) return;
  const open = show !== undefined ? show : pop.hidden;
  pop.hidden = !open;
  if (open) { const s = el('paActionSearch'); if (s) { s.value = ''; } paRenderActionList(''); if (s) s.focus(); }
}

const paVal = (id) => (el(id)?.value || '').trim();
// ms -> Wert für <input type="datetime-local"> (lokale Zeit, nicht UTC)
function paToLocalInput(ms) {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}
function paQuery() {
  const p = new URLSearchParams();
  const acts = [...paActionSel].filter(Boolean);
  if (acts.length) p.set('action', acts.join(',')); // Backend nimmt mehrere Aktionen als CSV
  for (const [id, key] of [['paName', 'name'], ['paSteam', 'steamId'], ['paDino', 'dinoClass'], ['paVia', 'via']]) {
    if (paVal(id)) p.set(key, paVal(id));
  }
  for (const [id, key] of [['paFrom', 'from'], ['paTo', 'to']]) {
    const ms = Date.parse(paVal(id));
    if (!isNaN(ms)) p.set(key, String(ms));
  }
  p.set('sort', paState.sort); p.set('order', paState.order);
  p.set('limit', String(paState.limit)); p.set('offset', String(paState.offset));
  return p.toString();
}
function paDetails(d) {
  if (!d || typeof d !== 'object') return '';
  return Object.entries(d)
    .map(([k, v]) => `${k}=${v && typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' · ');
}
async function paLoad(resetOffset) {
  if (!sessionToken) return;
  if (resetOffset) paState.offset = 0;
  paState.loading = true; paRenderTable();
  try {
    const r = await fetch(`${config.tokenBase}/admin/player-audit?${paQuery()}`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!r.ok) throw new Error(r.status === 403 ? 'Nicht berechtigt — nur Owner/Admin/Developer.' : `Fehler ${r.status}`);
    const d = await r.json();
    paState.items = d.items || []; paState.total = d.total || 0;
    paState.limit = d.limit || paState.limit; paState.offset = d.offset || 0;
    paState.fromMs = d.fromMs || 0; paState.toMs = d.toMs || 0; // vom Server normalisiert
  } catch (e) {
    paState.items = []; paState.total = 0;
    showToast(e.message, 'error');
  }
  paState.loading = false;
  paRenderTable();
}
function paSort(key) {
  if (paState.sort === key) paState.order = paState.order === 'asc' ? 'desc' : 'asc';
  else { paState.sort = key; paState.order = key === 'time' ? 'desc' : 'asc'; }
  paLoad(true);
}
function paRenderTable() {
  const box = el('paTableWrap'); if (!box) return;
  if (paState.loading) {
    box.innerHTML = '<div class="dt-muted" style="padding:12px">Lade…</div>';
  } else if (!paState.items.length) {
    box.innerHTML = '<div class="dt-muted" style="padding:12px">Keine Einträge für diese Filter.</div>';
  } else {
    const th = (c) => {
      const base = `padding:6px 8px;text-align:left;color:var(--muted);font-weight:600;white-space:nowrap${c.w ? `;width:${c.w}` : ''}`;
      if (!c.key) return `<th style="${base}">${c.label}</th>`;
      const on = paState.sort === c.key;
      return `<th data-pasort="${c.key}" title="Nach ${c.label} sortieren" style="${base};cursor:pointer;${on ? 'color:#eee' : ''}">${c.label}${on ? (paState.order === 'asc' ? ' ▲' : ' ▼') : ' <span style="opacity:.35">↕</span>'}</th>`;
    };
    const rows = paState.items.map((it) => {
      const t = new Date(it.createdAtMs);
      const zeit = t.toLocaleTimeString('de-DE', { hour12: false });
      const datum = t.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
      const [ico, lbl] = PA_VIA[it.via] || ['•', it.via || ''];
      const det = paDetails(it.details);
      // actorSteam ist nur gesetzt, wenn jemand ANDERES gehandelt hat (Staff, oder Combat-Angreifer
      // /-Killer). Namen statt roher SteamID: Discord → In-Game → SteamID (Rest im Tooltip).
      const actorLabel = it.actorDiscordName || it.actorName || it.actorSteam;
      const actorTip = [it.actorSteam && 'Steam: ' + it.actorSteam, it.actorName && 'Ingame: ' + it.actorName].filter(Boolean).join(' · ');
      const actor = it.actorSteam
        ? `<div style="font-size:10px;opacity:.7" title="${escapeHtml(actorTip)}">durch ${escapeHtml(actorLabel)}${it.actorDiscordName ? ' 🎮' : ''}</div>`
        : '';
      const td = 'padding:5px 8px;vertical-align:top';
      return `<tr style="border-top:1px solid var(--border)">
        <td style="${td};white-space:nowrap" title="${escapeHtml(t.toLocaleString('de-DE'))}">${zeit}<div style="font-size:10px;opacity:.6">${datum}</div></td>
        <td style="${td};max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="Steam: ${escapeHtml(it.playerName || '')}${it.discordName ? ' · Discord: ' + escapeHtml(it.discordName) : ''}">${escapeHtml(it.playerName || '—')}${it.discordName ? `<div style="font-size:10px;color:var(--muted);overflow:hidden;text-overflow:ellipsis">🎮 ${escapeHtml(it.discordName)}</div>` : ''}</td>
        <td style="${td};font-family:monospace;font-size:11px;white-space:nowrap">${escapeHtml(it.steamId || '')}</td>
        <td style="${td};white-space:nowrap"><span style="background:rgba(255,255,255,.07);padding:2px 6px;border-radius:6px">${escapeHtml(it.action || '')}</span></td>
        <td style="${td};white-space:nowrap">${escapeHtml(it.dinoClass || '—')}</td>
        <td style="${td};white-space:nowrap" title="${escapeHtml(it.via || '')}">${ico} ${escapeHtml(lbl)}${actor}</td>
        <td style="${td};max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;opacity:.85" title="${escapeHtml(det)}">${escapeHtml(det)}</td>
      </tr>`;
    }).join('');
    box.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="position:sticky;top:0;background:#1c1c22;z-index:1">${PA_COLS.map(th).join('')}</tr></thead>
      <tbody>${rows}</tbody></table>`;
    box.querySelectorAll('[data-pasort]').forEach((h) => { h.onclick = () => paSort(h.dataset.pasort); });
  }
  // Fuss: Trefferbereich + effektiver Zeitraum (der Server kappt/defaultet ihn) + Blättern
  const foot = el('paFoot'); if (!foot) return;
  const von = paState.offset + 1, bis = paState.offset + paState.items.length;
  const zeitraum = paState.fromMs && paState.toMs
    ? `${new Date(paState.fromMs).toLocaleString('de-DE')} – ${new Date(paState.toMs).toLocaleString('de-DE')}` : '';
  foot.innerHTML = `<span>${paState.total ? `${von}–${bis} von ${paState.total}` : '0 Treffer'}${zeitraum ? ` · Zeitraum: ${escapeHtml(zeitraum)}` : ''}</span>
    <span style="display:flex;gap:6px">
      <button id="paPrev" class="secondary" style="width:auto;padding:3px 9px;font-size:11px" ${paState.offset <= 0 ? 'disabled' : ''}>← Zurück</button>
      <button id="paNext" class="secondary" style="width:auto;padding:3px 9px;font-size:11px" ${bis >= paState.total ? 'disabled' : ''}>Weiter →</button>
    </span>`;
  const pv = el('paPrev'), nx = el('paNext');
  if (pv) pv.onclick = () => { paState.offset = Math.max(0, paState.offset - paState.limit); paLoad(false); };
  if (nx) nx.onclick = () => { paState.offset += paState.limit; paLoad(false); };
}
async function renderAudit() {
  const box = el('paBody'); if (!box) return;
  if (paState.built) { paLoad(true); return; }

  // Aktions-/Via-Listen vom Backend holen, damit die Filter bei neuen Aktionen nicht auseinanderlaufen.
  let actions = [], vias = [];
  try {
    const r = await fetch(`${config.tokenBase}/admin/player-audit/actions`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (r.ok) { const d = await r.json(); actions = d.actions || []; vias = d.via || []; }
  } catch {}
  // Sensible Aktionen nur für Admins im Filter zeigen (Moderatoren sehen sie nicht).
  if (!isAdmin) actions = actions.filter((a) => !PA_ADMIN_ACTIONS.has(a));

  const lab = 'font-size:11px;color:var(--muted);display:block;margin-bottom:2px';
  const inp = 'width:100%;box-sizing:border-box;padding:7px 8px;border-radius:8px;border:1px solid var(--border);background:var(--input-bg);color:#eee;font-size:12px';
  box.innerHTML = `
    <div style="font-weight:600;font-size:14px">📋 Player-Audit <span style="font-weight:400;font-size:11px;color:var(--muted)">— jede Aktion, die einen Dino verändert</span></div>
    <div style="font-size:11px;color:var(--muted);margin:2px 0 8px">Alle Filter lassen sich frei kombinieren. Spaltenüberschrift klicken = sortieren.</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-bottom:6px">
      <div style="flex:1;min-width:120px"><label style="${lab}">Spieler-Name</label><input id="paName" style="${inp}" placeholder="Teil des Namens"></div>
      <div style="flex:1;min-width:130px"><label style="${lab}">SteamID</label><input id="paSteam" style="${inp}" placeholder="7656…"></div>
      <div style="flex:1;min-width:110px"><label style="${lab}">Dino</label><input id="paDino" style="${inp}" placeholder="Teil, z. B. Allo"></div>
      <div style="min-width:110px"><label style="${lab}">Via</label><select id="paVia" style="${inp}"><option value="">alle</option>${vias.map((v) => `<option value="${escapeHtml(v)}">${(PA_VIA[v] || ['', v])[1]}</option>`).join('')}</select></div>
      <div style="min-width:170px"><label style="${lab}">Aktion</label>
        <div class="pa-msel" id="paActionMsel">
          <button type="button" id="paActionBtn" class="pa-msel-btn">Alle Aktionen ▾</button>
          <div id="paActionPop" class="pa-msel-pop" hidden>
            <input id="paActionSearch" class="pa-msel-search" placeholder="🔍 Aktion suchen…">
            <div class="pa-msel-bar"><span id="paActionCount" class="pa-msel-count"></span><button type="button" id="paActionClear" class="pa-msel-clear">Alle abwählen</button></div>
            <div id="paActionList" class="pa-msel-list"></div>
          </div>
        </div></div>
      <div style="min-width:158px"><label style="${lab}">Von</label><input id="paFrom" type="datetime-local" style="${inp}"></div>
      <div style="min-width:158px"><label style="${lab}">Bis</label><input id="paTo" type="datetime-local" style="${inp}"></div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:8px">
      <span style="font-size:11px;color:var(--muted)">Schnell:</span>
      <button class="secondary" data-parange="1" style="width:auto;padding:4px 9px;font-size:11px">1 h</button>
      <button class="secondary" data-parange="24" style="width:auto;padding:4px 9px;font-size:11px">24 h</button>
      <button class="secondary" data-parange="168" style="width:auto;padding:4px 9px;font-size:11px">7 Tage</button>
      <span style="flex:1"></span>
      <button id="paApply" style="width:auto;padding:5px 12px;font-size:12px">🔍 Filtern</button>
      <button id="paReset" class="secondary" style="width:auto;padding:5px 12px;font-size:12px">Zurücksetzen</button>
    </div>
    <div id="paTableWrap" style="max-height:46vh;overflow:auto;border:1px solid var(--border);border-radius:8px;background:rgba(0,0,0,.18)"></div>
    <div id="paFoot" style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:6px;font-size:11px;color:var(--muted)"></div>`;

  el('paApply').onclick = () => paLoad(true);
  el('paReset').onclick = () => {
    ['paName', 'paSteam', 'paDino', 'paFrom', 'paTo'].forEach((id) => { const e = el(id); if (e) e.value = ''; });
    el('paVia').value = '';
    paActionSel.clear(); paUpdateActionBtn(); paRenderActionList('');
    paState.sort = 'time'; paState.order = 'desc';
    paLoad(true);
  };
  box.querySelectorAll('[data-parange]').forEach((b) => {
    b.onclick = () => {
      const now = Date.now();
      el('paTo').value = paToLocalInput(now);
      el('paFrom').value = paToLocalInput(now - Number(b.dataset.parange) * 3600_000);
      paLoad(true);
    };
  });
  ['paName', 'paSteam', 'paDino'].forEach((id) => {
    const e = el(id); if (e) e.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); paLoad(true); } };
  });
  ['paVia', 'paFrom', 'paTo'].forEach((id) => { const e = el(id); if (e) e.onchange = () => paLoad(true); });

  // Aktion-Multi-Select-Popup initialisieren
  paAllActions = actions.slice();
  paActionSel.clear();
  paUpdateActionBtn();
  paRenderActionList('');
  el('paActionBtn').onclick = (ev) => { ev.stopPropagation(); paToggleActionPop(); };
  el('paActionSearch').oninput = () => paRenderActionList(el('paActionSearch').value);
  el('paActionSearch').onkeydown = (ev) => { if (ev.key === 'Escape') paToggleActionPop(false); };
  el('paActionClear').onclick = () => { paActionSel.clear(); paUpdateActionBtn(); paRenderActionList(el('paActionSearch').value); paLoad(true); };
  document.addEventListener('click', (ev) => {
    const m = el('paActionMsel'), pop = el('paActionPop');
    if (m && pop && !pop.hidden && !m.contains(ev.target)) paToggleActionPop(false);
  });

  paState.built = true;
  paLoad(true);
}

// ── Team-Audit: Staff-Aktions-Log (dieselben Daten wie der Discord-Audit-Channel) ────────────
// Backend /admin/staff-audit filtert + paginiert serverseitig und gated selbst auf Staff. Nur UI.
const TA_SRC = { overlay: ['🎮', 'Overlay'], discord: ['💬', 'Discord'] };
let taState = { built: false, items: [], total: 0, limit: 100, offset: 0, loading: false, fromMs: 0, toMs: 0 };
function taQuery() {
  const p = new URLSearchParams();
  for (const [id, key] of [['taActor', 'actor'], ['taAction', 'action'], ['taSource', 'source']]) {
    const v = (el(id)?.value || '').trim();
    if (v) p.set(key, v);
  }
  for (const [id, key] of [['taFrom', 'from'], ['taTo', 'to']]) {
    const ms = Date.parse((el(id)?.value || '').trim());
    if (!isNaN(ms)) p.set(key, String(ms));
  }
  p.set('limit', String(taState.limit)); p.set('offset', String(taState.offset));
  return p.toString();
}
async function taLoad(resetOffset) {
  if (resetOffset) taState.offset = 0;
  taState.loading = true; taRenderTable();
  try {
    const r = await fetch(`${config.tokenBase}/admin/staff-audit?${taQuery()}`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!r.ok) throw new Error(r.status === 403 ? 'Nicht berechtigt — nur Staff.' : `Fehler ${r.status}`);
    const d = await r.json();
    taState.items = d.items || []; taState.total = d.total || 0;
    taState.limit = d.limit || taState.limit; taState.offset = d.offset || 0;
    taState.fromMs = d.fromMs || 0; taState.toMs = d.toMs || 0;
  } catch (e) {
    taState.items = []; taState.total = 0;
    showToast(e.message, 'error');
  }
  taState.loading = false;
  taRenderTable();
}
function taRenderTable() {
  const box = el('taTableWrap'); if (!box) return;
  if (taState.loading) {
    box.innerHTML = '<div class="dt-muted" style="padding:12px">Lade…</div>';
  } else if (!taState.items.length) {
    box.innerHTML = '<div class="dt-muted" style="padding:12px">Keine Einträge für diese Filter.</div>';
  } else {
    const td = 'padding:5px 8px;vertical-align:top';
    const rows = taState.items.map((it) => {
      const t = new Date(it.createdAtMs);
      const zeit = t.toLocaleTimeString('de-DE', { hour12: false });
      const datum = t.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
      const [ico, lbl] = TA_SRC[it.source] || ['•', it.source || ''];
      const who = it.actorName || it.actorDiscord || it.actorSteam || '—';
      const whoTip = [it.actorSteam && 'Steam: ' + it.actorSteam, it.actorDiscord && 'Discord-ID: ' + it.actorDiscord].filter(Boolean).join(' · ');
      const det = paDetails(it.details);
      return `<tr style="border-top:1px solid var(--border)">
        <td style="${td};white-space:nowrap" title="${escapeHtml(t.toLocaleString('de-DE'))}">${zeit}<div style="font-size:10px;opacity:.6">${datum}</div></td>
        <td style="${td};max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(whoTip)}">${escapeHtml(who)}</td>
        <td style="${td}"><span style="background:rgba(255,255,255,.07);padding:2px 6px;border-radius:6px;font-family:monospace;font-size:11px">${escapeHtml(it.action || '')}</span>${it.method && it.method !== 'POST' ? `<span style="font-size:10px;opacity:.6;margin-left:4px">${escapeHtml(it.method)}</span>` : ''}</td>
        <td style="${td};white-space:nowrap" title="${escapeHtml(it.source || '')}">${ico} ${escapeHtml(lbl)}</td>
        <td style="${td};max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;opacity:.85" title="${escapeHtml(det)}">${escapeHtml(det)}</td>
      </tr>`;
    }).join('');
    const th = (l, w) => `<th style="padding:6px 8px;text-align:left;color:var(--muted);font-weight:600;white-space:nowrap${w ? `;width:${w}` : ''}">${l}</th>`;
    box.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="position:sticky;top:0;background:#1c1c22;z-index:1">${th('Zeit', '86px')}${th('Wer', '150px')}${th('Aktion', '200px')}${th('Quelle', '96px')}${th('Details')}</tr></thead>
      <tbody>${rows}</tbody></table>`;
  }
  const foot = el('taFoot'); if (!foot) return;
  const von = taState.offset + 1, bis = taState.offset + taState.items.length;
  const zeitraum = taState.fromMs && taState.toMs
    ? `${new Date(taState.fromMs).toLocaleString('de-DE')} – ${new Date(taState.toMs).toLocaleString('de-DE')}` : '';
  foot.innerHTML = `<span>${taState.total ? `${von}–${bis} von ${taState.total}` : '0 Treffer'}${zeitraum ? ` · Zeitraum: ${escapeHtml(zeitraum)}` : ''}</span>
    <span style="display:flex;gap:6px">
      <button id="taPrev" class="secondary" style="width:auto;padding:3px 9px;font-size:11px" ${taState.offset <= 0 ? 'disabled' : ''}>← Zurück</button>
      <button id="taNext" class="secondary" style="width:auto;padding:3px 9px;font-size:11px" ${bis >= taState.total ? 'disabled' : ''}>Weiter →</button>
    </span>`;
  const pv = el('taPrev'), nx = el('taNext');
  if (pv) pv.onclick = () => { taState.offset = Math.max(0, taState.offset - taState.limit); taLoad(false); };
  if (nx) nx.onclick = () => { taState.offset += taState.limit; taLoad(false); };
}
function renderTeamAudit() {
  const box = el('taBody'); if (!box) return;
  if (taState.built) { taLoad(true); return; }
  const lab = 'font-size:11px;color:var(--muted);display:block;margin-bottom:2px';
  const inp = 'width:100%;box-sizing:border-box;padding:7px 8px;border-radius:8px;border:1px solid var(--border);background:var(--input-bg);color:#eee;font-size:12px';
  box.innerHTML = `
    <div style="font-weight:600;font-size:14px">🛡️ Team-Audit <span style="font-weight:400;font-size:11px;color:var(--muted)">— jede verändernde Staff-Aktion (Overlay + Discord)</span></div>
    <div style="font-size:11px;color:var(--muted);margin:2px 0 8px">Dieselben Einträge wie im Discord-Audit-Channel.</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-bottom:6px">
      <div style="flex:1;min-width:130px"><label style="${lab}">Wer (Name)</label><input id="taActor" style="${inp}" placeholder="Teil des Namens"></div>
      <div style="flex:1;min-width:140px"><label style="${lab}">Aktion</label><input id="taAction" style="${inp}" placeholder="z. B. gift, ban"></div>
      <div style="min-width:120px"><label style="${lab}">Quelle</label><select id="taSource" style="${inp}"><option value="">alle</option><option value="overlay">🎮 Overlay</option><option value="discord">💬 Discord</option></select></div>
      <div style="min-width:158px"><label style="${lab}">Von</label><input id="taFrom" type="datetime-local" style="${inp}"></div>
      <div style="min-width:158px"><label style="${lab}">Bis</label><input id="taTo" type="datetime-local" style="${inp}"></div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:8px">
      <span style="font-size:11px;color:var(--muted)">Schnell:</span>
      <button class="secondary" data-tarange="24" style="width:auto;padding:4px 9px;font-size:11px">24 h</button>
      <button class="secondary" data-tarange="168" style="width:auto;padding:4px 9px;font-size:11px">7 Tage</button>
      <button class="secondary" data-tarange="720" style="width:auto;padding:4px 9px;font-size:11px">30 Tage</button>
      <span style="flex:1"></span>
      <button id="taApply" style="width:auto;padding:5px 12px;font-size:12px">🔍 Filtern</button>
      <button id="taReset" class="secondary" style="width:auto;padding:5px 12px;font-size:12px">Zurücksetzen</button>
    </div>
    <div id="taTableWrap" style="max-height:46vh;overflow:auto;border:1px solid var(--border);border-radius:8px;background:rgba(0,0,0,.18)"></div>
    <div id="taFoot" style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:6px;font-size:11px;color:var(--muted)"></div>`;

  el('taApply').onclick = () => taLoad(true);
  el('taReset').onclick = () => {
    ['taActor', 'taAction', 'taFrom', 'taTo'].forEach((id) => { const e = el(id); if (e) e.value = ''; });
    el('taSource').value = '';
    taLoad(true);
  };
  box.querySelectorAll('[data-tarange]').forEach((b) => {
    b.onclick = () => {
      const now = Date.now();
      el('taTo').value = paToLocalInput(now);
      el('taFrom').value = paToLocalInput(now - Number(b.dataset.tarange) * 3600_000);
      taLoad(true);
    };
  });
  ['taActor', 'taAction'].forEach((id) => {
    const e = el(id); if (e) e.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); taLoad(true); } };
  });
  ['taSource', 'taFrom', 'taTo'].forEach((id) => { const e = el(id); if (e) e.onchange = () => taLoad(true); });

  taState.built = true;
  taLoad(true);
}

// ── Verwarnungen (Staff) ─────────────────────────────────────────────────────
function renderWarnPane() {
  const box = el('warnBody'); if (!box) return;
  const inp = 'width:100%;box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--input-bg);color:#eee;margin-top:4px';
  box.innerHTML = `
    <div style="font-weight:600;font-size:14px;margin-bottom:4px">⚠️ User verwarnen</div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:8px">Discord-ID, Steam-ID ODER Ingame-Name reicht — die anderen werden automatisch verknüpft. Die laufende Nummer (1./2./3. …) zählt das System.</div>
    <div style="display:flex;gap:8px">
      <div style="flex:1"><label style="font-size:11px;color:var(--muted)">Discord-ID</label><input id="wnDiscord" placeholder="z. B. 4785…" style="${inp}"></div>
      <div style="flex:1"><label style="font-size:11px;color:var(--muted)">Steam-ID</label><input id="wnSteam" placeholder="7656…" style="${inp}"></div>
    </div>
    <label style="font-size:11px;color:var(--muted);margin-top:8px;display:block">oder Name <span style="opacity:.7">(RP-, Ingame- oder Discord-Name — wird automatisch zu Steam aufgelöst)</span></label>
    <input id="wnIngame" list="wnIngameList" autocomplete="off" placeholder="z. B. Complex-Slayer" style="${inp}">
    <datalist id="wnIngameList"></datalist>
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

  // Server-Spielersuche (RP/Ingame/Discord) → Live-Vorschläge im Label "RP (Steam, Discord)".
  let wnIngTimer = null;
  el('wnIngame').oninput = () => {
    const q = el('wnIngame').value.trim();
    clearTimeout(wnIngTimer);
    if (q.length < 2) return;
    wnIngTimer = setTimeout(async () => {
      try {
        const d = await fetch(`${config.tokenBase}/admin/players/search?q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${sessionToken}` } }).then((r) => r.json());
        const dl = el('wnIngameList'); if (!dl) return;
        dl.innerHTML = (d.items || []).slice(0, 15).map((p) => `<option value="${escapeHtml(userLabel(warnItemUser(p)))}">`).join('');
      } catch {}
    }, 300);
  };

  el('wnSubmit').onclick = async () => {
    const discordId = el('wnDiscord').value.trim();
    let steamId = el('wnSteam').value.trim();
    const ingame = el('wnIngame').value.trim();
    const ruleParagraph = el('wnPara').value.trim();
    const reason = el('wnReason').value.trim();
    if (!ruleParagraph || !reason) { showToast('Paragraph und Grund sind Pflicht', 'error'); return; }
    // Name (RP/Ingame/Discord) → Steam auflösen (nur wenn keine ID direkt angegeben).
    if (!discordId && !steamId && ingame) {
      try {
        const d = await fetch(`${config.tokenBase}/admin/players/search?q=${encodeURIComponent(ingame)}`, { headers: { Authorization: `Bearer ${sessionToken}` } }).then((r) => r.json());
        const items = d.items || [];
        const pick = matchUser(ingame, items.map(warnItemUser));
        if (!pick) { showToast(items.length ? 'Mehrere Treffer — bitte genauer tippen oder SteamID nutzen' : 'Name nicht gefunden (war der Spieler online?)', 'error'); return; }
        steamId = pick.steamId;
      } catch { showToast('Name konnte nicht aufgelöst werden', 'error'); return; }
    }
    if (!discordId && !steamId) { showToast('Discord-/Steam-ID oder Ingame-Name nötig', 'error'); return; }
    await apiAction('/admin/warnings', { discordId, steamId, reason, ruleParagraph }, '⚠️ Verwarnung erfasst', () => {
      el('wnDiscord').value = ''; el('wnSteam').value = ''; el('wnIngame').value = ''; el('wnPara').value = ''; el('wnReason').value = '';
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
// HB_BADGE + HANDBUCH liegen jetzt in shared/handbuch.js (von Overlay UND Companion genutzt).
function hbCanDo(need) {
  if (need === 'admin') return isAdmin;
  if (need === 'ingame') return isIngame;
  if (need === 'staff') return isTeam;
  return isStaff;
}
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

// ── Server-Panel (nur Admin): Welt / AI / Polymorph / Objekte / Server ───────
// Alle Aktionen laufen über admin-only Backend-Proxies (/admin/world/*, /admin/players/{id}/
// polymorph, /admin/mod-ai/*, /admin/ai/*), die 1:1 an die mod-API bzw. den control-server gehen.
function openServerPanel() {
  if (!isAdmin) { showToast('Nur für Admins', 'error'); return; }
  serverOpen = true;
  el('serverPanel').style.display = 'flex';
  updateInteractive();
  showServerTab('welt');
}
function closeServerPanel() {
  serverOpen = false;
  el('serverPanel').style.display = 'none';
  updateInteractive();
}

// ── 🖥️ Server-Steuerung: eigenständiger Dock-Bereich (aus dem Admin-Untermenü herausgelöst) ──
// Aufgeteilt in Tabs: 📊 Übersicht (Status + Last-Kacheln + 24h-Auslastungskurve + Subsystem-Matrix),
// 👥 Spieler, 🦖 Limits, ⚙️ Steuerung. Alle Daten kommen aus vorhandenen Endpunkten
// (/admin/server/status, /admin/ops/health, /admin/ops/metrics/players, /public/status).
let srvOpen = false;
let srvTab = 'overview';
function openSrvPanel() {
  if (!isAdmin) { showToast('Nur für Admins', 'error'); return; }
  srvOpen = true;
  el('srvPanel').style.display = 'flex';
  updateInteractive();
  renderSrv();
  // Aktiven Tab alle 8 s aktualisieren, nur solange offen (Selbstabschaltung).
  if (!openSrvPanel._t) openSrvPanel._t = setInterval(() => {
    if (!srvOpen) { clearInterval(openSrvPanel._t); openSrvPanel._t = null; return; }
    srvRefreshTab();
  }, 8000);
}
function closeSrvPanel() {
  srvOpen = false;
  el('srvPanel').style.display = 'none';
  updateInteractive();
}
// Verdrahtet Tab-Buttons + Steuer-Aktionen (einmalig) und zeigt den aktiven Tab.
function renderSrv() {
  if (!renderSrv._wired) {
    renderSrv._wired = 1;
    document.querySelectorAll('#srvTabs [data-srvt]').forEach((b) => { b.onclick = () => srvShowTab(b.dataset.srvt); });
    const s = el('srvPlayerSearch'); if (s) s.oninput = () => renderSrvPlayers();
  }
  { const b = el('srvAnnounce'); if (b && !b._w) { b._w = 1; b.onclick = () => { const m = el('srvMsg').value.trim(); if (!m) { showToast('Nachricht eingeben', 'error'); return; } apiAction('/admin/server/announce', { message: m }, '📢 Ansage gesendet', () => { el('srvMsg').value = ''; }); }; } }
  { const b = el('srvWipe'); if (b && !b._w) { b._w = 1; b.onclick = () => svArmConfirm(b, 'Sicher? Kadaver leeren', () => apiAction('/admin/server/wipecorpses', {}, '🧹 Kadaver geleert', null)); } }
  { const b = el('srvStart'); if (b && !b._w) { b._w = 1; b.onclick = () => apiAction('/admin/server/control', { action: 'start' }, '▶️ Server-Start ausgelöst', srvLoadStatus); } }
  { const b = el('srvRestart'); if (b && !b._w) { b._w = 1; b.onclick = () => svArmConfirm(b, 'Sicher? Restart', () => apiAction('/admin/server/control', { action: 'restart' }, '🔁 Restart ausgelöst', srvLoadStatus)); } }
  { const b = el('srvStop'); if (b && !b._w) { b._w = 1; b.onclick = () => svArmConfirm(b, 'Sicher? Stop', () => apiAction('/admin/server/control', { action: 'stop' }, '⏹️ Stop ausgelöst', srvLoadStatus)); } }
  srvShowTab(srvTab || 'overview');
}
function srvShowTab(t) {
  srvTab = t;
  document.querySelectorAll('#srvTabs [data-srvt]').forEach((b) => b.classList.toggle('secondary', b.dataset.srvt !== t));
  document.querySelectorAll('#srvPanel .admin-pane[data-srvp]').forEach((p) => { p.hidden = p.dataset.srvp !== t; });
  // Voll-Render beim Wechsel (inkl. Limits/Betrieb — die werden EINMAL geladen, nicht im Poll).
  if (t === 'overview') srvRenderOverview();
  else if (t === 'players') renderSrvPlayers();
  else if (t === 'limits') svRenderClassLimits();
  else if (t === 'betrieb') srvRenderBetrieb();
  bfScheduleFrameSync && bfScheduleFrameSync();
}
// 8s-Poll: nur Live-Tabs auffrischen. Limits/Steuerung bleiben stehen (kein Überschreiben von Eingaben).
function srvRefreshTab() {
  if (srvTab === 'overview') srvRenderOverview();
  else if (srvTab === 'players') renderSrvPlayers();
}

// ── 📊 Übersicht: Status + Last-Kacheln + Auslastungskurve + Subsystem-Matrix ──
async function srvRenderOverview() {
  srvLoadStatus();
  let health = null, pub = null;
  try { health = await svApi('GET', '/admin/ops/health'); } catch {}
  try { pub = await svApi('GET', '/public/status'); } catch {}
  srvRenderTiles(health, pub);
  srvRenderHealth(health);
  srvRenderSpark();
}
function srvChk(health, id) { return ((health && health.checks) || []).find((c) => c.id === id) || null; }
// Farbe für eine Health-Prüfung: rot (down) / gelb (warn) / grün (ok).
function srvDotColor(c) { return !c ? 'var(--muted)' : (!c.ok ? '#f87171' : (c.warn ? '#fbbf24' : '#4ade80')); }
function srvRenderTiles(health, pub) {
  const box = el('srvTiles'); if (!box) return;
  const gp = srvChk(health, 'game_process'), cs = srvChk(health, 'control_server');
  const db = srvChk(health, 'db'), mod = srvChk(health, 'mod_api'), lk = srvChk(health, 'livekit');
  const online = (pub && typeof pub.online === 'number') ? pub.online : (players || []).filter((p) => p.steamId).length;
  const max = (pub && pub.max) ? pub.max : null;
  const pct = max ? Math.min(100, Math.round((online / max) * 100)) : null;
  const loadCol = pct == null ? 'var(--accent)' : (pct >= 90 ? '#f87171' : pct >= 70 ? '#fbbf24' : '#4ade80');
  const diskGB = (cs && cs.detail && (cs.detail.match(/([\d.]+)\s*GB/) || [])[1]) || null;
  const tile = (accent, icon, label, val, sub) =>
    `<div class="srv-tile" style="border-left-color:${accent}"><div class="srv-tile-h">${icon} ${escapeHtml(label)}</div>` +
    `<div class="srv-tile-v">${val}</div>${sub ? `<div class="srv-tile-s">${sub}</div>` : ''}</div>`;
  const tiles = [];
  // Spieler-Auslastung (der Kern von „Server-Last")
  tiles.push(tile(loadCol, '👥', 'Spieler online',
    `${online}${max ? ` <span style="font-size:12px;color:var(--muted)">/ ${max}</span>` : ''}`,
    pct == null ? 'Auslastung unbekannt'
      : `<div class="srv-bar"><i style="width:${pct}%;background:${loadCol}"></i></div><span>${pct}% ausgelastet</span>`));
  // Disk der Game-Box
  tiles.push(tile(srvDotColor(cs), '💾', 'Speicher (Game-Box)',
    diskGB != null ? `${diskGB} <span style="font-size:12px;color:var(--muted)">GB frei</span>` : '—',
    cs && cs.warn ? '⚠️ wenig frei' : (cs && !cs.ok ? 'control-server offline' : 'ok')));
  // DB-Latenz
  tiles.push(tile(srvDotColor(db), '🗄️', 'Datenbank',
    db ? `${db.latencyMs} <span style="font-size:12px;color:var(--muted)">ms</span>` : '—',
    db && !db.ok ? 'Fehler' : 'Ping'));
  // Mod-Poller-Frische
  tiles.push(tile(srvDotColor(mod), '📡', 'Mod-Poller',
    mod ? (mod.ok ? (mod.warn ? 'träge' : 'frisch') : 'stockt') : '—',
    mod && mod.detail ? escapeHtml(mod.detail) : ''));
  // Voice
  tiles.push(tile(srvDotColor(lk), '🎧', 'Voice (LiveKit)',
    lk ? (lk.ok ? 'online' : 'offline') : '—', lk ? `${lk.latencyMs} ms` : 'kein Check'));
  box.innerHTML = tiles.join('');
}
// Subsystem-Matrix (identische Quelle wie der Betrieb-Tab: /admin/ops/health).
function srvRenderHealth(health) {
  const box = el('srvHealth'); if (!box) return;
  if (!health) { box.innerHTML = '<span style="color:#f87171">Health nicht ladbar.</span>'; return; }
  const dot = (c) => (c.ok ? (c.warn ? '🟡' : '🟢') : '🔴');
  const label = { db: 'Datenbank', mod_api: 'Mod-API (Poller)', game_process: 'Game-Server', control_server: 'Game-Box (control)', livekit: 'Voice (LiveKit)', peer_backend: 'Peer-Backend' };
  box.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:6px">` +
    (health.checks || []).map((c) =>
      `<div style="border:1px solid var(--border);border-radius:8px;padding:7px 9px;font-size:12px">${dot(c)} <b>${escapeHtml(label[c.id] || c.id)}</b>` +
      `<span style="color:var(--muted)"> ${c.latencyMs} ms</span>` +
      (c.detail ? `<div style="color:var(--muted);font-size:11px;margin-top:2px">${escapeHtml(c.detail)}</div>` : '') + `</div>`
    ).join('') + `</div>`;
  const meta = el('srvHealthMeta'); if (meta) meta.textContent = `Umgebung: ${health.env || '?'} · ${new Date().toLocaleTimeString()}`;
}
// 24h-Auslastungskurve (Spielerzahl) — gleiche Metrik wie der Betrieb-Tab.
async function srvRenderSpark() {
  const cv = el('srvSpark'); if (!cv) return;
  try {
    const d = await svApi('GET', '/admin/ops/metrics/players?hours=24');
    const pts = d.points || [];
    const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, cv.width, cv.height);
    if (!pts.length) { ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.font = '12px sans-serif'; ctx.fillText('Noch keine Daten', 10, cv.height / 2); return; }
    const maxN = Math.max(5, ...pts.map((p) => p.n));
    const t0 = new Date(pts[0].t).getTime(), t1 = new Date(pts[pts.length - 1].t).getTime() || t0 + 1;
    const px = (p) => ((new Date(p.t).getTime() - t0) / Math.max(1, t1 - t0)) * (cv.width - 8) + 4;
    const py = (p) => cv.height - 8 - (p.n / maxN) * (cv.height - 22);
    // Flächenfüllung unter der Kurve
    ctx.beginPath(); ctx.moveTo(px(pts[0]), cv.height);
    pts.forEach((p) => ctx.lineTo(px(p), py(p)));
    ctx.lineTo(px(pts[pts.length - 1]), cv.height); ctx.closePath();
    ctx.fillStyle = 'rgba(125,211,252,0.12)'; ctx.fill();
    ctx.strokeStyle = '#7dd3fc'; ctx.lineWidth = 1.5; ctx.beginPath();
    pts.forEach((p, i) => { i ? ctx.lineTo(px(p), py(p)) : ctx.moveTo(px(p), py(p)); });
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.font = '10px sans-serif';
    ctx.fillText(`max ${maxN}`, 6, 12);
    ctx.fillText(`aktuell ${pts[pts.length - 1].n}`, cv.width - 72, 12);
  } catch {}
}
// Live-Status-Banner: Prozess-Zustand (läuft/AUS/unbekannt).
async function srvLoadStatus() {
  const box = el('srvStatus'); if (!box) return;
  let running = null, detail = '';
  try { const d = await svApi('GET', '/admin/server/status'); running = !!d.running; } catch { detail = ' · Status nicht abrufbar'; }
  const dot = running === null ? '⚪' : (running ? '🟢' : '🔴');
  const txt = running === null ? 'unbekannt' : (running ? 'läuft' : 'AUS');
  const col = running ? 'rgba(74,222,128,0.10)' : (running === false ? 'rgba(248,113,113,0.10)' : 'rgba(255,255,255,0.04)');
  box.innerHTML = `<div style="font-size:14px;padding:9px 12px;border:1px solid var(--border);border-radius:10px;background:${col}">${dot} <b>Server ${txt}</b><span style="color:var(--muted);font-size:12px">${detail}</span></div>`;
}
// Online-Spieler aus dem laufenden Positions-Poll (read-only Liste + Suche).
function renderSrvPlayers() {
  const box = el('srvPlayers'), cnt = el('srvPlayerCount'); if (!box) return;
  const list = (players || []).filter((p) => p.steamId);
  if (cnt) cnt.textContent = String(list.length);
  if (!list.length) { box.innerHTML = '<div class="dt-muted">Keine Spieler online (oder Game-Server nicht erreichbar).</div>'; return; }
  const q = ((el('srvPlayerSearch') && el('srvPlayerSearch').value) || '').trim().toLowerCase();
  let rows = list.slice().sort((a, b) => (a.name || a.playerName || '').localeCompare(b.name || b.playerName || ''));
  if (q) rows = rows.filter((p) => `${p.name || p.playerName || p.steamId} ${p.dino || ''}`.toLowerCase().includes(q));
  if (!rows.length) { box.innerHTML = '<div class="dt-muted">Kein Treffer.</div>'; return; }
  box.innerHTML = rows.map((p) => {
    const nm = p.name || p.playerName || p.steamId;
    const dino = p.dino ? ` <span style="color:var(--muted)">· ${escapeHtml(p.dino)}</span>` : '';
    return `<div style="padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.06)">👤 ${escapeHtml(nm)}${dino}${p.isDead ? ' <span style="color:#f87171">†</span>' : ''}</div>`;
  }).join('');
}
let serverTab = 'welt';
function showServerTab(t) {
  serverTab = t;
  document.querySelectorAll('#serverTabs [data-stab]').forEach((b) => b.classList.toggle('secondary', b.dataset.stab !== t));
  document.querySelectorAll('#serverPanel .admin-pane').forEach((p) => { p.hidden = p.dataset.pane !== t; });
  if (t === 'welt') renderSvWelt();
  else if (t === 'ai') renderSvAi();
  else if (t === 'polymorph') renderSvPoly();
  else if (t === 'objects') renderSvObjects();
  else if (t === 'karte') { loadTeleports(); renderAdminTpList(); }
  else if (t === 'godvoice') renderGodVoice();
  else if (t === 'teamaudit') renderTeamAudit();
  else if (t === 'evrima') renderEvrima();
  bfScheduleFrameSync && bfScheduleFrameSync();
}

// ── 🛠️ Betrieb (Ops-Interface): Versionen/Branches + Log-Viewer ─────────────────────────────
// Read-only-Diagnose ohne SSH: Backend /admin/ops/* (admin-gated). Sitzt jetzt als Tab im
// Server-Panel (Status-Matrix + Auslastung stehen im Übersichts-Tab). Der Log-Follow-Poll läuft
// nur, solange der Betrieb-Tab offen ist (Guard schaltet sich selbst ab).
let opsLogState = { name: '', nextByte: null, lines: [] }; // Follow-Zustand je gewähltem Log
const OPS_LOG_MAX_LINES = 4000;

function srvBetriebActive() { return srvOpen && srvTab === 'betrieb'; }

function srvRenderBetrieb() {
  renderOpsVersions(); opsInitLogs();
  // Log-Follow-Poll (2s), nur solange der Betrieb-Tab offen ist (Selbstabschaltung über Guard).
  if (!srvRenderBetrieb._logTimer) {
    srvRenderBetrieb._logTimer = setInterval(() => {
      if (!srvBetriebActive()) { clearInterval(srvRenderBetrieb._logTimer); srvRenderBetrieb._logTimer = null; return; }
      const f = el('opsLogFollow');
      if (f && f.checked) opsLoadLog(false); // inkrementell (fromByte)
    }, 2000);
  }
}

async function renderOpsVersions() {
  const box = el('opsVersions'); if (!box) return;
  try {
    const [v, br] = await Promise.all([svApi('GET', '/admin/ops/version'), svApi('GET', '/admin/ops/branches')]);
    const short = (s) => (s ? String(s).slice(0, 7) : '—');
    const rows = [];
    const be = v.backend || {};
    rows.push(`<tr><td>⚙️ Backend (${escapeHtml(v.env || '?')})</td><td><code>${short(be.sha)}</code>${be.modified ? ' <span style="color:#fbbf24">+lokal</span>' : ''}</td><td>${escapeHtml(be.builtAt || '—')}</td></tr>`);
    if (v.mod) rows.push(`<tr><td>🧩 Mod (.asi)</td><td><code>${short(v.mod.sha)}</code> ${escapeHtml(v.mod.branch || '')}</td><td>${escapeHtml(v.mod.builtAt || '—')}</td></tr>`);
    else rows.push(`<tr><td>🧩 Mod (.asi)</td><td colspan="2" style="color:var(--muted)">keine Selbstauskunft (älterer Build oder Box offline)</td></tr>`);
    if (v.control && v.control.controlServer) rows.push(`<tr><td>🎛️ control-server</td><td colspan="2">seit ${escapeHtml(v.control.controlServer.startedAt || '?')}${v.control.mod && v.control.mod.exists ? ` · .asi ${escapeHtml((v.control.mod.sha256 || '').slice(0, 10))} (${escapeHtml(v.control.mod.mtime || '')})` : ''}</td></tr>`);
    const verd = (t) => {
      if (t.component === 'backend') {
        if (t.deployed) return '<span style="color:#4ade80">✅ deployt</span>';
        if (t.behind > 0) return `<span style="color:#fbbf24">${t.behind} Commit(s) hinterm Tip</span>`;
      }
      return '';
    };
    const brRows = (br.branches || []).map((t) =>
      `<tr><td>${escapeHtml(t.component)}/${escapeHtml(t.branch)}</td><td><code>${short(t.sha)}</code>${t.err ? ' <span style="color:#f87171">API-Fehler</span>' : ''}</td><td>${escapeHtml((t.date || '').slice(0, 16).replace('T', ' '))} ${verd(t)}</td></tr>`
    ).join('');
    box.innerHTML = `<table style="width:100%;font-size:12px;border-collapse:collapse">` +
      `<tr style="color:var(--muted)"><th style="text-align:left">Komponente</th><th style="text-align:left">Stand</th><th style="text-align:left">Zeit</th></tr>` +
      rows.join('') + brRows + `</table>`;
  } catch (e) { box.innerHTML = `<span style="color:#f87171">Versionen nicht ladbar: ${escapeHtml(e.message || '?')}</span>`; }
}

// ── Log-Viewer ───────────────────────────────────────────────────────────────
async function opsInitLogs() {
  const sel = el('opsLogSel'); if (!sel) return;
  if (!opsInitLogs._wired) {
    opsInitLogs._wired = true;
    sel.onchange = () => opsLoadLog(true);
    el('opsLogReload').onclick = () => opsLoadLog(true);
    el('opsLogFilter').oninput = () => opsRenderLog();
    el('opsLogCopy').onclick = () => { try { navigator.clipboard.writeText(opsLogState.lines.join('\n')); showToast('Log kopiert', 'success'); } catch {} };
  }
  try {
    const d = await svApi('GET', '/admin/ops/logs');
    const names = { backend: '⚙️ Backend', game: '🦖 Game-Server', mod: '🧩 Mod', inject: '💉 Inject', control: '🎛️ control-server' };
    const cur = sel.value;
    sel.innerHTML = (d.logs || []).map((l) =>
      `<option value="${escapeHtml(l.name)}"${l.exists ? '' : ' disabled'}>${escapeHtml(names[l.name] || l.name)}${l.exists ? '' : ' (fehlt)'}</option>`
    ).join('');
    if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
    if (!opsLogState.name || opsLogState.name !== sel.value) opsLoadLog(true);
  } catch {}
}

async function opsLoadLog(reset) {
  const sel = el('opsLogSel'); if (!sel || !sel.value) return;
  const name = sel.value;
  if (reset || opsLogState.name !== name) opsLogState = { name, nextByte: null, lines: [] };
  try {
    const q = opsLogState.nextByte != null ? `&fromByte=${opsLogState.nextByte}` : '';
    const d = await svApi('GET', `/admin/ops/logs/tail?name=${encodeURIComponent(name)}${q}`);
    if (d.exists === false) { opsLogState.lines = ['(Datei existiert nicht)']; opsRenderLog(); return; }
    // Rotation: Server setzte vorn neu auf → Ansicht zurücksetzen, sonst doppelte Zeilen.
    if (opsLogState.nextByte != null && d.fromByte < opsLogState.nextByte) opsLogState.lines = [];
    opsLogState.nextByte = d.nextByte;
    if (d.data) {
      opsLogState.lines.push(...String(d.data).split('\n').filter((l) => l !== ''));
      if (opsLogState.lines.length > OPS_LOG_MAX_LINES) opsLogState.lines = opsLogState.lines.slice(-OPS_LOG_MAX_LINES);
    }
    opsRenderLog();
  } catch (e) { const box = el('opsLogBox'); if (box) box.textContent = `Log nicht ladbar: ${e.message || '?'}`; }
}

function opsRenderLog() {
  const box = el('opsLogBox'); if (!box) return;
  const q = (el('opsLogFilter') && el('opsLogFilter').value.trim().toLowerCase()) || '';
  const lines = q ? opsLogState.lines.filter((l) => l.toLowerCase().includes(q)) : opsLogState.lines;
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30; // am Ende? → weiter ans Ende springen
  box.textContent = lines.join('\n');
  if (stick) box.scrollTop = box.scrollHeight;
}

// ── Evrima-Versionen (Steam-Build-Infos, vom Backend gecacht — Quelle steamcmd.net/PICS) ──────
// Der öffentliche evrima-Branch trägt keinen Semver → wir zeigen die Steam-Build-ID (wie SteamDB)
// plus Last-Updated. Refresh bei jeder Tab-Anzeige (Backend cached 5 min).
function evrimaAgo(unixSec) {
  if (!unixSec) return '—';
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `vor ${d} Tag${d === 1 ? '' : 'en'}`;
  if (h > 0) return `vor ${h} Std`;
  if (m > 0) return `vor ${m} Min`;
  return 'gerade eben';
}
async function renderEvrima() {
  const box = el('evrimaBody'); if (!box) return;
  box.innerHTML = '<div class="dt-muted" style="padding:12px">Lade…</div>';
  let d;
  try {
    const r = await fetch(`${config.tokenBase}/evrima-versions`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!r.ok) throw new Error(r.status === 403 ? 'Nicht berechtigt.' : `Fehler ${r.status}`);
    d = await r.json();
  } catch (e) {
    box.innerHTML = `<div class="dt-muted" style="padding:12px">Konnte Versionen nicht laden: ${escapeHtml(e.message)}</div>`;
    return;
  }
  const td = 'padding:8px 10px;vertical-align:top';
  const th = (l) => `<th style="padding:6px 10px;text-align:left;color:var(--muted);font-weight:600;white-space:nowrap">${l}</th>`;
  const row = (label, icon, b) => {
    const build = b && b.buildId ? b.buildId : '—';
    const upd = b && b.updated ? new Date(b.updated * 1000) : null;
    const tip = upd ? escapeHtml(upd.toLocaleString('de-DE')) : 'unbekannt';
    const desc = b && b.desc ? `<div style="font-size:10px;opacity:.6">${escapeHtml(b.desc)}</div>` : '';
    // Server hat i. d. R. eine lesbare ProjectVersion (0.21.738); Game nur die Steam-Build-ID.
    const ver = b && b.version
      ? `<b style="font-size:14px">${escapeHtml(b.version)}</b> <span style="font-family:monospace;opacity:.55;font-size:11px">Build ${escapeHtml(build)}</span>`
      : `<span style="font-family:monospace">${escapeHtml(build)}</span>`;
    return `<tr style="border-top:1px solid var(--border)">
      <td style="${td}">${icon} <b>${label}</b>${desc}</td>
      <td style="${td}">${ver}</td>
      <td style="${td};white-space:nowrap" title="${tip}">${evrimaAgo(b && b.updated)}</td>
    </tr>`;
  };
  const stand = d && d.fetchedAt ? `zuletzt geprüft ${evrimaAgo(d.fetchedAt)}` : 'noch nicht abgerufen';
  box.innerHTML = `
    <div class="sec-title">🏷️ Evrima — aktuelle Builds</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin:8px 0">
      <thead><tr>${th('')}${th('Version / Build')}${th('Zuletzt aktualisiert')}</tr></thead>
      <tbody>
        ${row('Server', '🖥️', d && d.server)}
        ${row('Game', '🎮', d && d.game)}
      </tbody>
    </table>
    <div class="dt-muted" style="font-size:11px;margin-top:6px">Server-Version = laufende ProjectVersion; Steam liefert nur die Build-ID (der evrima-Branch hat keinen Versionsnamen). Quelle: steamcmd.net (Steam PICS) + Server-Status · ${stand}</div>
    <button id="evrimaRefresh" class="secondary" style="width:auto;padding:4px 12px;font-size:12px;margin-top:10px">🔄 Aktualisieren</button>`;
  const rb = el('evrimaRefresh'); if (rb) rb.onclick = () => renderEvrima();
}
// Class-Limits im Server-Tab (dieselben /dino-limits-Endpoints wie das Admin-Panel; das Admin-Panel
// bleibt unangetastet — hier eine eigene Ansicht in #svClassBody).
async function svRenderClassLimits() {
  const box = el('svClassBody'); if (!box) return;
  box.innerHTML = '<div class="sec-title">🦖 Class-Limits</div><div class="dt-muted">Lade…</div>';
  await fetchDinoLimits();
  box.innerHTML = `
    <div class="sec-title">🦖 Class-Limits <span class="dt-muted">— Spezies-Obergrenzen (über Limit → jüngster Dino wird nach 90 s eingeparkt)</span></div>
    <div id="svClassList" style="max-height:300px;overflow:auto;margin:8px 0">${dinoLimitSpecies.map((sp) => `<div class="dlimit-row"><span>${escapeHtml(sp)}</span><input type="number" min="0" data-sp="${escapeHtml(sp)}" value="${dinoLimits[sp] || 0}" class="bf-select"></div>`).join('')}</div>
    <button id="svClassSave" style="width:100%">💾 Class-Limits speichern</button>
    <div id="svClassResult" class="dt-muted" style="margin-top:6px"></div>`;
  el('svClassSave').onclick = async () => {
    const limits = {};
    box.querySelectorAll('#svClassList input[data-sp]').forEach((inp) => { const v = parseInt(inp.value, 10); if (v > 0) limits[inp.dataset.sp] = v; });
    const res = el('svClassResult'); if (res) res.textContent = 'Speichere…';
    try {
      const r = await fetch(`${config.tokenBase}/admin/dino-limits`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ limits }) });
      const d = await r.json(); if (!r.ok) throw new Error(apiErr(d));
      dinoLimits = d.limits || {};
      if (res) res.textContent = '✅ Gespeichert.';
      showToast('🦖 Class-Limits gespeichert', 'success');
    } catch (e) { if (res) res.textContent = '⚠️ ' + e.message; showToast(e.message, 'error'); }
  };
}

// 🌍 Welt: Zeit / Wetter / Grow-Stop
async function renderSvWelt() {
  const box = el('svWeltBody'); if (!box) return;
  box.innerHTML = '<div class="dt-muted">Lade…</div>';
  const [time, weather, grow, fgs] = await Promise.all([
    svApi('GET', '/admin/world/time').catch(() => ({})),
    svApi('GET', '/admin/world/weather').catch(() => ({})),
    svApi('GET', '/admin/world/growth-stop').catch(() => ({})),
    svApi('GET', '/free-gender-swap').catch(() => ({})),
  ]);
  const presets = weather.presets || weather.weathers || weather.list || weather.items || ['clear', 'clouds', 'rain', 'storm', 'fog', 'snow', 'auto'];
  const tod = (typeof time.timeOfDay === 'number') ? time.timeOfDay : 12;
  box.innerHTML = `
    <div class="sec-title">🕑 Tageszeit</div>
    <div style="display:flex;align-items:center;gap:10px;margin:8px 0">
      <input id="svTod" type="range" min="0" max="24" step="0.25" value="${tod}" style="flex:1;accent-color:var(--accent)">
      <span id="svTodVal" style="width:52px;text-align:right">${svFmtTod(tod)}</span>
      <button id="svTodApply" style="width:auto;padding:6px 12px">Setzen</button>
    </div>
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:14px"><input id="svPause" type="checkbox" ${time.paused ? 'checked' : ''}> Zeit einfrieren (Tag/Nacht-Zyklus anhalten)</label>
    <div class="sec-title">🌦️ Wetter</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 14px">${presets.map((p) => `<button class="secondary" data-weather="${escapeHtml(String(p))}" style="width:auto;padding:6px 12px">${escapeHtml(String(p))}</button>`).join('')}</div>
    <div class="sec-title">🌱 Wachstum</div>
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin:8px 0"><input id="svGrow" type="checkbox" ${grow.enabled ? 'checked' : ''}> Grow-Stop (Wachstum aller Dinos einfrieren)</label>
    <div class="sec-title">🎉 Events</div>
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin:8px 0"><input id="svFreeGender" type="checkbox" ${fgs.enabled ? 'checked' : ''}> Free Gender Swap — ALLE wechseln kostenlos${fgs.enabled && fgs.expiresAtMs ? ` <span class="dt-muted">(noch ${fmtEventCountdown(fgs.expiresAtMs)})</span>` : ''}</label>
    <div style="display:flex;align-items:center;gap:8px;margin:2px 0 8px">
      <span class="dt-muted">Dauer:</span>
      <input id="svFreeGenderHours" type="number" min="0" step="1" value="24" style="width:70px;padding:6px;border-radius:6px;border:1px solid var(--border);background:var(--input-bg);color:#eee">
      <span class="dt-muted">Stunden (0 = unbegrenzt). Läuft danach automatisch ab.</span>
    </div>`;
  el('svTod').oninput = () => { el('svTodVal').textContent = svFmtTod(parseFloat(el('svTod').value)); };
  el('svTodApply').onclick = async () => { try { await svApi('POST', '/admin/world/time', { timeOfDay: parseFloat(el('svTod').value) }); showToast('🕑 Tageszeit gesetzt', 'success'); } catch (e) { showToast(e.message, 'error'); } };
  el('svPause').onchange = async () => { try { await svApi('POST', '/admin/world/time', { paused: el('svPause').checked }); showToast(el('svPause').checked ? '⏸️ Zeit eingefroren' : '▶️ Zeit läuft', 'success'); } catch (e) { showToast(e.message, 'error'); } };
  box.querySelectorAll('[data-weather]').forEach((b) => b.onclick = async () => { try { await svApi('POST', '/admin/world/weather', { weather: b.dataset.weather }); showToast('🌦️ Wetter: ' + b.dataset.weather, 'success'); } catch (e) { showToast(e.message, 'error'); } });
  el('svGrow').onchange = async () => { try { await svApi('POST', '/admin/world/growth-stop', { enabled: el('svGrow').checked }); showToast(el('svGrow').checked ? '🌱 Grow-Stop AN' : '🌱 Grow-Stop AUS', 'success'); } catch (e) { el('svGrow').checked = !el('svGrow').checked; showToast(e.message, 'error'); } };
  const applyFreeGender = async () => {
    const on = el('svFreeGender').checked;
    const hours = on ? Math.max(0, parseFloat(el('svFreeGenderHours').value) || 0) : 0;
    try {
      await svApi('POST', '/free-gender-swap', { enabled: on, durationHours: hours });
      freeGenderSwap = on;
      showToast(on ? (hours ? `⚧️ Free Gender Swap AN — ${hours} Std` : '⚧️ Free Gender Swap AN — unbegrenzt') : '⚧️ Free Gender Swap AUS', 'success');
      loadActiveEvents();          // Event-Timer-HUD sofort aktualisieren
      if (serverTab === 'welt') renderSvWelt(); // Restzeit-Anzeige im Tab aktualisieren
    } catch (e) { el('svFreeGender').checked = !on; showToast(e.message, 'error'); }
  };
  el('svFreeGender').onchange = applyFreeGender;
  el('svFreeGenderHours').onchange = () => { if (el('svFreeGender').checked) applyFreeGender(); }; // Dauer ändern → neu setzen
}

// 🤖 AI: mod-eigenes /ai/encounters-Framework — Master + read-only Liste + Detail-Editor
const SV_ARCHETYPES = ['territorial_guard', 'pack_hunter', 'herd', 'ambush', 'skittish_prey', 'scavenger', 'nomad', 'apex_solo'];
const svArchOpts = (sel) => SV_ARCHETYPES.map((a) => `<option value="${a}"${a === sel ? ' selected' : ''}>${a}</option>`).join('');
let svEncEditId = null, svEncDraft = null;

async function renderSvAi() {
  const box = el('svAiBody'); if (!box) return;
  box.innerHTML = '<div class="dt-muted">Lade…</div>';
  const [st, list, brain] = await Promise.all([
    svApi('GET', '/admin/mod-ai/encounters/status').catch(() => ({})),
    svApi('GET', '/admin/mod-ai/encounters').catch(() => ({ encounters: [] })),
    svApi('GET', '/admin/mod-ai/encounters/brain').catch(() => null), // älterer Mod-Build → Zeile ausblenden
  ]);
  const enabled = !!(st.ai_encounters_enabled != null ? st.ai_encounters_enabled : st.enabled);
  const encs = list.encounters || [];
  const statusDot = (e) => e.enabled !== false ? '<span style="color:#22c55e">● aktiv</span>' : '<span style="color:var(--muted)">○ aus</span>';
  const rows = encs.map((e) => `
    <div style="display:flex;align-items:center;gap:10px;border:1px solid var(--border);border-radius:8px;padding:6px 10px;margin-bottom:6px">
      <div style="flex:1;min-width:0"><b>${escapeHtml(e.name || e.id)}</b><div class="dt-muted" style="font-size:12px">${escapeHtml(e.archetype || '')} · ${escapeHtml(e.species || '')} · ×${e.count || 1}</div></div>
      <div style="font-size:12px;white-space:nowrap">${statusDot(e)}</div>
      <button class="secondary sv-enc-edit" data-eid="${escapeHtml(e.id)}" style="width:auto;padding:4px 12px">✏️ Bearbeiten</button>
    </div>`).join('') || '<div class="dt-muted">Keine Encounters angelegt.</div>';
  box.innerHTML = `
    <div class="sec-title">🤖 AI-Encounters</div>
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin:8px 0 6px"><input id="svAiMaster" type="checkbox" ${enabled ? 'checked' : ''}> Encounter-System aktiv (Master-Schalter)</label>
    ${brain ? `<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin:0 0 14px" title="Steuert Patrouille/Territorial/Rudel/Schlafen. Kill-Switch: aus = Dinos stehen nur (wie bisher).">
      <input id="svAiBrain" type="checkbox" ${brain.brainEnabled ? 'checked' : ''}> 🧠 Verhaltens-Engine aktiv
      <span style="color:var(--muted);font-size:11px">(max ${brain.maxTotalPawns} Pawns · Tick ${brain.tickMs} ms)</span>
    </label>` : ''}
    <div class="sec-title">Encounters (${encs.length})</div>
    <div id="svEncList" style="margin:6px 0 6px">${rows}</div>
    <div id="svEncEditor"></div>
    <div class="sec-title" style="margin-top:12px">➕ Neuer Encounter</div>
    <div class="dt-form" style="margin-top:6px">
      <label>Name</label><input id="svEncName" class="tm-input" placeholder="Rex-Wache Nord">
      <label>Spezies (Blueprint, z. B. BP_Allosaurus_C)</label><input id="svEncSpecies" class="tm-input" placeholder="BP_Allosaurus_C">
      <div style="display:flex;gap:10px">
        <div style="flex:1"><label>Archetyp</label><select id="svEncArch" class="bf-select">${svArchOpts('territorial_guard')}</select></div>
        <div style="flex:1"><label>Anzahl (1–20)</label><input id="svEncCount" type="number" min="1" max="20" value="1" class="tm-input"></div>
      </div>
      <label style="display:flex;align-items:center;gap:8px;margin-top:6px"><input id="svEncAtMe" type="checkbox" checked> Spawnpunkt = meine Position</label>
    </div>
    <button id="svEncCreate" style="width:100%;margin-top:8px">➕ Encounter anlegen</button>`;
  { const b = el('svAiBrain'); if (b) b.onchange = async () => {
    try { await svApi('POST', '/admin/mod-ai/encounters/brain', { enabled: b.checked }); showToast(b.checked ? '🧠 Verhaltens-Engine AN' : '🧠 Verhaltens-Engine AUS', 'success'); }
    catch (e) { b.checked = !b.checked; showToast(e.message, 'error'); }
  }; }
  el('svAiMaster').onchange = async () => {
    try { await svApi('PATCH', '/admin/mod-ai/encounters/status', { ai_encounters_enabled: el('svAiMaster').checked }); showToast(el('svAiMaster').checked ? '🤖 AI-Encounters AN' : '🤖 AI-Encounters AUS', 'success'); }
    catch (e) { el('svAiMaster').checked = !el('svAiMaster').checked; showToast(e.message, 'error'); }
  };
  box.querySelectorAll('.sv-enc-edit').forEach((b) => b.onclick = () => {
    const e = encs.find((x) => x.id === b.dataset.eid); if (!e) return;
    svEncEditId = e.id; svEncDraft = JSON.parse(JSON.stringify(e));
    renderEncEditor();
    const ed = el('svEncEditor'); if (ed) ed.scrollIntoView({ block: 'nearest' });
  });
  el('svEncCreate').onclick = async () => {
    const species = el('svEncSpecies').value.trim(); if (!species) { showToast('Spezies angeben', 'error'); return; }
    const body = { name: el('svEncName').value.trim() || species, species, archetype: el('svEncArch').value, count: Math.max(1, Math.min(20, parseInt(el('svEncCount').value) || 1)), enabled: true };
    if (el('svEncAtMe').checked && me && typeof me.x === 'number') body.spawn = { x: me.x, y: me.y, z: me.z || 0 };
    try { await svApi('POST', '/admin/mod-ai/encounters', body); showToast('➕ Encounter angelegt', 'success'); renderSvAi(); } catch (e) { showToast(e.message, 'error'); }
  };
  renderEncEditor(); // Editor nach Refetch synchron halten (offen nur, wenn svEncDraft gesetzt)
}

// Liest die aktuellen Editor-Feldwerte in svEncDraft zurück (vor jedem Teil-Re-Render der Patrouille).
function svEncSyncDraft() {
  const box = el('svEncEditor'); if (!box || !svEncDraft) return;
  const q = (c) => box.querySelector(c);
  if (q('.ee-name')) svEncDraft.name = q('.ee-name').value.trim();
  if (q('.ee-species')) svEncDraft.species = q('.ee-species').value.trim();
  if (q('.ee-arch')) svEncDraft.archetype = q('.ee-arch').value;
  if (q('.ee-count')) svEncDraft.count = Math.max(1, Math.min(20, parseInt(q('.ee-count').value) || 1));
  if (q('.ee-enabled')) svEncDraft.enabled = q('.ee-enabled').checked;
  if (q('.ee-respawn')) { const v = parseInt(q('.ee-respawn').value); svEncDraft.respawnDelaySec = (v >= 0 && !isNaN(v)) ? v : undefined; }
  const sx = q('.ee-sx'), sy = q('.ee-sy'), sz = q('.ee-sz');
  if (sx && sy && sz) svEncDraft.spawn = { x: parseFloat(sx.value) || 0, y: parseFloat(sy.value) || 0, z: parseFloat(sz.value) || 0 };
  const pts = [];
  box.querySelectorAll('.ee-pt').forEach((r) => pts.push({ x: parseFloat(r.querySelector('.pt-x').value) || 0, y: parseFloat(r.querySelector('.pt-y').value) || 0, z: parseFloat(r.querySelector('.pt-z').value) || 0 }));
  svEncDraft.patrol = pts;
  // 🧠 Verhaltens-Felder (Brain, BFT-294). UI in Metern/Sekunden — Mod speichert Welt-Einheiten (×100).
  const num = (c) => { const e = q(c); if (!e || e.value === '') return undefined; const v = parseFloat(e.value); return isNaN(v) ? undefined : v; };
  const m = (c) => { const v = num(c); return v === undefined ? undefined : Math.round(v * UNITS_PER_M); };
  svEncDraft.homeRadius = m('.ee-homer'); svEncDraft.leashRadius = m('.ee-leash');
  svEncDraft.packCohesionRadius = m('.ee-packc'); svEncDraft.packAssistRadius = m('.ee-packa');
  svEncDraft.chaseTimeoutSec = num('.ee-chase'); svEncDraft.patrolPauseSec = num('.ee-ppause');
  if (q('.ee-dayactive')) {
    svEncDraft.schedule = {
      dayActive: q('.ee-dayactive').checked,
      sleepFromHour: Math.max(0, Math.min(23, parseInt(q('.ee-sleepfrom').value) || 21)),
      wakeHour: Math.max(0, Math.min(23, parseInt(q('.ee-wake').value) || 6)),
    };
  }
}

// Detail-Editor eines Encounters (Koordinaten + Patrouillen-Pfad). Rendert nur aus svEncDraft,
// ohne Refetch — Patrouillen-Änderungen re-rendern nur diesen Block.
function renderEncEditor() {
  const box = el('svEncEditor'); if (!box) return;
  if (!svEncDraft) { box.innerHTML = ''; return; }
  const d = svEncDraft, sp = d.spawn || {}, patrol = d.patrol || [];
  box.innerHTML = `
    <div style="border:1px solid var(--accent);border-radius:8px;padding:10px;margin:8px 0">
      <div class="sec-title">✏️ Bearbeiten: ${escapeHtml(d.id)}</div>
      <div class="dt-form">
        <div style="display:flex;gap:8px;align-items:center">
          <input class="tm-input ee-name" style="flex:1" value="${escapeHtml(d.name || '')}" placeholder="Name">
          <label style="font-size:12px;display:flex;align-items:center;gap:4px"><input type="checkbox" class="ee-enabled" ${d.enabled !== false ? 'checked' : ''}> aktiv</label>
        </div>
        <div style="display:flex;gap:8px;margin-top:6px">
          <input class="tm-input ee-species" style="flex:2" value="${escapeHtml(d.species || '')}" placeholder="Spezies (BP_…)">
          <select class="bf-select ee-arch" style="flex:1">${svArchOpts(d.archetype)}</select>
          <input type="number" min="1" max="20" class="tm-input ee-count" style="width:64px" value="${d.count || 1}">
        </div>
        <label style="margin-top:8px">Spawn-Koordinaten (x / y / z)</label>
        <div style="display:flex;gap:6px;align-items:center">
          <input type="number" class="tm-input ee-sx" style="flex:1" value="${sp.x || 0}" placeholder="x">
          <input type="number" class="tm-input ee-sy" style="flex:1" value="${sp.y || 0}" placeholder="y">
          <input type="number" class="tm-input ee-sz" style="flex:1" value="${sp.z || 0}" placeholder="z">
          <button class="secondary ee-spawn-me" style="width:auto;padding:6px 10px">📍 hier</button>
        </div>
        <label style="margin-top:8px">Patrouillen-Pfad (${patrol.length} Punkte)</label>
        <div class="ee-patrol">${patrol.map((p, i) => `
          <div class="ee-pt" style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
            <span class="dt-muted" style="width:18px;text-align:right">${i + 1}</span>
            <input type="number" class="tm-input pt-x" style="flex:1" value="${p.x || 0}" placeholder="x">
            <input type="number" class="tm-input pt-y" style="flex:1" value="${p.y || 0}" placeholder="y">
            <input type="number" class="tm-input pt-z" style="flex:1" value="${p.z || 0}" placeholder="z">
            <button class="secondary ee-pt-del" data-i="${i}" style="width:auto;padding:4px 8px">✕</button>
          </div>`).join('')}</div>
        <div style="display:flex;gap:6px;margin-top:4px">
          <button class="secondary ee-pt-add" style="flex:1">➕ Punkt</button>
          <button class="secondary ee-pt-addme" style="flex:1">📍 Punkt an meiner Position</button>
          <button class="secondary ee-pt-map" style="flex:1${encWpMode ? ';border-color:var(--accent);color:var(--accent)' : ''}">🗺️ ${encWpMode ? 'Karten-Modus beenden' : 'Auf Karte klicken'}</button>
        </div>
        <label style="margin-top:8px">Respawn-Delay (Sek, optional)</label>
        <input type="number" min="0" class="tm-input ee-respawn" value="${d.respawnDelaySec != null ? d.respawnDelaySec : ''}" placeholder="—">
        <div class="sec-title" style="margin-top:12px">🧠 Verhalten (Brain)</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:6px">Wirkt nur bei aktivierter Verhaltens-Engine (Kill-Switch im AI-Tab). Leer = Standardwerte. Angaben in Metern/Sekunden.</div>
        <div style="display:flex;gap:6px">
          <div style="flex:1"><label>Heimat-Radius (m)</label><input type="number" min="1" class="tm-input ee-homer" value="${d.homeRadius != null ? Math.round(d.homeRadius / UNITS_PER_M) : ''}" placeholder="—"></div>
          <div style="flex:1"><label>Leine (m)</label><input type="number" min="1" class="tm-input ee-leash" value="${d.leashRadius != null ? Math.round(d.leashRadius / UNITS_PER_M) : ''}" placeholder="1,5×Aggro"></div>
          <div style="flex:1"><label>Jagd-Timeout (s)</label><input type="number" min="3" class="tm-input ee-chase" value="${d.chaseTimeoutSec != null ? d.chaseTimeoutSec : ''}" placeholder="—"></div>
        </div>
        <div style="display:flex;gap:6px;margin-top:6px">
          <div style="flex:1"><label>Rudel-Zusammenhalt (m)</label><input type="number" min="1" class="tm-input ee-packc" value="${d.packCohesionRadius != null ? Math.round(d.packCohesionRadius / UNITS_PER_M) : ''}" placeholder="—"></div>
          <div style="flex:1"><label>Rudel-Beistand (m)</label><input type="number" min="1" class="tm-input ee-packa" value="${d.packAssistRadius != null ? Math.round(d.packAssistRadius / UNITS_PER_M) : ''}" placeholder="—"></div>
          <div style="flex:1"><label>Patrouillen-Pause (s)</label><input type="number" min="0" class="tm-input ee-ppause" value="${d.patrolPauseSec != null ? d.patrolPauseSec : ''}" placeholder="—"></div>
        </div>
        <div style="display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap">
          <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer"><input type="checkbox" class="ee-dayactive" ${!d.schedule || d.schedule.dayActive !== false ? 'checked' : ''}> ☀️ Tagaktiv (ruht nachts)</label>
          <span style="font-size:12px">😴 ab <input type="number" min="0" max="23" class="tm-input ee-sleepfrom" style="width:52px" value="${d.schedule && d.schedule.sleepFromHour != null ? d.schedule.sleepFromHour : 21}"> Uhr</span>
          <span style="font-size:12px">⏰ wach ab <input type="number" min="0" max="23" class="tm-input ee-wake" style="width:52px" value="${d.schedule && d.schedule.wakeHour != null ? d.schedule.wakeHour : 6}"> Uhr</span>
        </div>
      </div>
      <div style="display:flex;gap:6px;margin-top:10px">
        <button class="ee-save" style="flex:1">💾 Speichern</button>
        <button class="secondary ee-cancel" style="width:auto;padding:6px 12px">Abbrechen</button>
        <button class="secondary ee-del" style="width:auto;padding:6px 12px;color:#ef4444">🗑️ Löschen</button>
      </div>
    </div>`;
  box.querySelector('.ee-spawn-me').onclick = () => { svEncSyncDraft(); if (me && typeof me.x === 'number') svEncDraft.spawn = { x: me.x, y: me.y, z: me.z || 0 }; else showToast('Position unbekannt', 'error'); renderEncEditor(); };
  box.querySelector('.ee-pt-add').onclick = () => { svEncSyncDraft(); (svEncDraft.patrol = svEncDraft.patrol || []).push({ x: 0, y: 0, z: 0 }); renderEncEditor(); };
  box.querySelector('.ee-pt-addme').onclick = () => { svEncSyncDraft(); if (me && typeof me.x === 'number') (svEncDraft.patrol = svEncDraft.patrol || []).push({ x: me.x, y: me.y, z: me.z || 0 }); else showToast('Position unbekannt', 'error'); renderEncEditor(); };
  box.querySelectorAll('.ee-pt-del').forEach((b) => b.onclick = () => { svEncSyncDraft(); svEncDraft.patrol.splice(parseInt(b.dataset.i), 1); renderEncEditor(); });
  box.querySelector('.ee-pt-map').onclick = () => {
    svEncSyncDraft();
    encWpMode = !encWpMode;
    if (encWpMode) { if (!mapOpen) toggleMap(true); showToast('🗺️ Karte: jeder Klick = Wegpunkt. Button erneut = beenden.', 'info'); }
    renderEncEditor();
  };
  box.querySelector('.ee-cancel').onclick = () => { svEncEditId = null; svEncDraft = null; encWpMode = false; renderEncEditor(); };
  box.querySelector('.ee-del').onclick = () => svArmConfirm(box.querySelector('.ee-del'), 'Encounter löschen', async () => {
    try { await svApi('DELETE', `/admin/mod-ai/encounters/${encodeURIComponent(svEncEditId)}`); showToast('🗑️ Encounter gelöscht', 'success'); svEncEditId = null; svEncDraft = null; renderSvAi(); } catch (e) { showToast(e.message, 'error'); }
  });
  box.querySelector('.ee-save').onclick = async () => {
    svEncSyncDraft();
    if (!svEncDraft.species) { showToast('Spezies angeben', 'error'); return; }
    const body = { name: svEncDraft.name, species: svEncDraft.species, archetype: svEncDraft.archetype, count: svEncDraft.count, enabled: svEncDraft.enabled, spawn: svEncDraft.spawn, patrol: svEncDraft.patrol };
    if (svEncDraft.respawnDelaySec != null) body.respawnDelaySec = svEncDraft.respawnDelaySec;
    // Brain-Felder nur mitsenden, wenn gesetzt (undefined-Werte fallen bei JSON.stringify weg).
    for (const k of ['homeRadius', 'leashRadius', 'packCohesionRadius', 'packAssistRadius', 'chaseTimeoutSec', 'patrolPauseSec', 'schedule']) {
      if (svEncDraft[k] !== undefined) body[k] = svEncDraft[k];
    }
    try { await svApi('PATCH', `/admin/mod-ai/encounters/${encodeURIComponent(svEncEditId)}`, body); showToast('💾 Encounter gespeichert', 'success'); svEncEditId = null; svEncDraft = null; encWpMode = false; renderSvAi(); } catch (e) { showToast(e.message, 'error'); }
  };
}

// 🦖 Polymorph: Spieler in NPC-Tier verwandeln
async function renderSvPoly() {
  const box = el('svPolyBody'); if (!box) return;
  box.innerHTML = '<div class="dt-muted">Lade…</div>';
  await loadAdminUsers();
  box.innerHTML = `
    <div class="sec-title">🦖 Polymorph <span class="dt-muted">— Spieler per Respawn in ein NPC-Tier verwandeln</span></div>
    <div class="dt-form" style="margin-top:6px">
      ${userSearchHTML('svPolyUser', adminUsers, 'Spieler', 'RP/Steam/Discord tippen…')}
      <label>Ziel-Dino (Blueprint/Kurzname, z. B. Boar, Chicken, Deer)</label>
      <input id="svPolyClass" class="tm-input" placeholder="Chicken">
      <div style="display:flex;gap:10px">
        <div style="flex:1"><label>Scale</label><input id="svPolyScale" type="number" step="0.1" min="0.1" value="1" class="tm-input"><div class="dt-muted" style="margin-top:3px">grösser 1 ist noch nicht funktional</div></div>
        <div style="flex:1"><label>maxHealth (optional)</label><input id="svPolyHp" type="number" step="100" placeholder="—" class="tm-input"></div>
      </div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 6px">
      <button class="secondary" data-poly="Chicken|1|10000" style="width:auto;padding:6px 12px">🐔 Kampf-Huhn</button>
      <button class="secondary" data-poly="Boar|1|2000" style="width:auto;padding:6px 12px">🐗 Panzer-Boar</button>
      <button class="secondary" data-poly="Rabbit|0.3|" style="width:auto;padding:6px 12px">🐇 Mini-Hase</button>
    </div>
    <button id="svPolyApply" style="width:100%;margin-top:6px">🦖 Polymorph anwenden</button>`;
  box.querySelectorAll('[data-poly]').forEach((b) => b.onclick = () => { const [c, s, h] = b.dataset.poly.split('|'); el('svPolyClass').value = c; el('svPolyScale').value = s || ''; el('svPolyHp').value = h || ''; });
  el('svPolyApply').onclick = async () => {
    const u = resolveUserInput('svPolyUser', adminUsers);
    if (!u) { showToast('Spieler aus der Liste wählen', 'error'); return; }
    const cls = (el('svPolyClass').value || '').trim(); if (!cls) { showToast('Ziel-Dino angeben', 'error'); return; }
    const body = { dinoClass: cls };
    const sc = parseFloat(el('svPolyScale').value); if (sc > 0) body.scale = sc;
    const hp = parseFloat(el('svPolyHp').value); if (hp > 0) body.maxHealth = hp;
    try { await svApi('POST', `/admin/players/${u.steamId}/polymorph`, body); showToast(`🦖 ${u.ingameName || u.name || 'Spieler'} → ${cls}`, 'success'); } catch (e) { showToast(e.message, 'error'); }
  };
}

// 🧱 Objekte: platzieren / auflisten / löschen (mod In-Memory-Registry, überlebt keinen Restart)
async function renderSvObjects() {
  const box = el('svObjBody'); if (!box) return;
  box.innerHTML = '<div class="dt-muted">Lade…</div>';
  let list = { actors: [] };
  try { list = await svApi('GET', '/admin/world/objects'); } catch {}
  const actors = list.actors || [];
  const rows = actors.map((o) => `<tr><td style="padding:2px 6px">${escapeHtml(o.tag || '')}</td><td style="padding:2px 6px" class="dt-muted">${escapeHtml(o.id || '')}</td><td style="padding:2px 6px" class="dt-muted">${escapeHtml(o.kind || '')}</td><td style="padding:2px 6px">${Math.round(o.x)}, ${Math.round(o.y)}, ${Math.round(o.z)}</td><td style="padding:2px 6px"><button class="secondary" data-obj-del="${escapeHtml(o.id || '')}" style="width:auto;padding:2px 8px">✕</button></td></tr>`).join('') || '<tr><td colspan="5" class="dt-muted" style="padding:6px">Keine Objekte platziert.</td></tr>';
  box.innerHTML = `
    <div class="sec-title">🧱 Objekt platzieren <span class="dt-muted">— überlebt KEINEN Server-Restart</span></div>
    <div class="dt-form" style="margin-top:6px">
      <label>Modell (BP_… / SM_… / NS_… oder /Game/…-Pfad)</label>
      <input id="svObjModel" class="tm-input" placeholder="BP_Rock_C">
      <label>Tag (Gruppenname zum späteren Löschen)</label>
      <input id="svObjTag" class="tm-input" placeholder="deko1">
      <label>Scale</label>
      <input id="svObjScale" type="number" step="0.5" value="1" class="tm-input">
      <label style="display:flex;align-items:center;gap:8px;margin-top:8px"><input id="svObjAtMe" type="checkbox" checked> An meiner Position platzieren</label>
    </div>
    <button id="svObjSpawn" style="width:100%;margin:8px 0 4px">🧱 Platzieren</button>
    <button id="svObjAssets" class="secondary" style="width:100%;margin-bottom:12px">📋 Spawnbare Assets anzeigen</button>
    <div id="svObjAssetList"></div>
    <div class="sec-title" style="margin-top:10px">Platzierte Objekte (${actors.length})</div>
    <div style="max-height:220px;overflow:auto;margin-top:6px"><table style="width:100%;border-collapse:collapse;font-size:12px"><tbody>${rows}</tbody></table></div>`;
  el('svObjSpawn').onclick = async () => {
    const model = (el('svObjModel').value || '').trim(); if (!model) { showToast('Modell angeben', 'error'); return; }
    const entry = { tag: (el('svObjTag').value || '').trim() || 'obj', model, scale: parseFloat(el('svObjScale').value) || 1 };
    if (el('svObjAtMe').checked) { if (!me || typeof me.x !== 'number') { showToast('Deine Position unbekannt', 'error'); return; } entry.location = { x: me.x, y: me.y, z: me.z || 0 }; }
    try { await svApi('POST', '/admin/world/objects', entry); showToast('🧱 Objekt platziert', 'success'); renderSvObjects(); } catch (e) { showToast(e.message, 'error'); }
  };
  el('svObjAssets').onclick = async () => {
    const t = el('svObjAssetList'); t.innerHTML = '<div class="dt-muted">Lade Assets…</div>';
    try {
      const a = await svApi('GET', '/admin/world/objects/all');
      const bp = (a.blueprints && a.blueprints.items) || [];
      t.innerHTML = `<div class="dt-muted" style="margin:6px 0">Blueprints (${(a.blueprints && a.blueprints.count) || 0}) — Klick übernimmt ins Modell-Feld:</div>` + bp.slice(0, 200).map((m) => `<button class="secondary" data-asset="${escapeHtml(m)}" style="width:auto;padding:2px 8px;margin:2px">${escapeHtml(m)}</button>`).join('');
      t.querySelectorAll('[data-asset]').forEach((b) => b.onclick = () => { el('svObjModel').value = b.dataset.asset; });
    } catch (e) { t.innerHTML = `<span style="color:#ef4444">${escapeHtml(e.message)}</span>`; }
  };
  box.querySelectorAll('[data-obj-del]').forEach((b) => b.onclick = async () => { try { await svApi('DELETE', `/admin/world/objects/id/${encodeURIComponent(b.dataset.objDel)}`); showToast('🗑️ Objekt gelöscht', 'success'); renderSvObjects(); } catch (e) { showToast(e.message, 'error'); } });
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
    adminUsers = d.users || [];
    // Die drei Admin-Suchfelder teilen sich admUserList und durchsuchen die volle User-Liste.
    // Das Datalist wird NICHT mehr mit allen ~1000 Optionen vorbefüllt (Chromium zeigt die dann
    // nicht zuverlässig) — filterDatalist füllt es beim Tippen/Fokus mit den Top-Treffern.
    for (const id of ['admUserSearch', 'msgUserSearch', 'giftUserSearch', 'followUserSearch']) USER_POOLS[id] = adminUsers;
    adminUserMap = new Map(); // nur noch Back-Compat; Auflösung läuft über matchUser
    for (const u of adminUsers) adminUserMap.set(u.name, u);
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
  return matchUser(el(inputId)?.value, USER_POOLS[inputId] || adminUsers);
}

// ── Wiederverwendbar: Discord-User-Suchfeld (Name selbst tippen + Vorschläge unten) ──
// Ersetzt <select>-Dropdowns überall im Admin-Overlay durch ein Text-Input mit Datalist.
function userSearchHTML(inputId, users, label, placeholder) {
  const listId = inputId + '_dl';
  // User-Pool für dieses Feld registrieren; filterDatalist (delegierter input/focusin-Handler)
  // befüllt das Datalist beim Tippen mit den Top-Treffern. Kein Vorabdump aller Optionen mehr.
  USER_POOLS[inputId] = users || [];
  return `<label>${escapeHtml(label || 'Spieler')}</label>` +
    `<input id="${inputId}" list="${listId}" class="tm-input" placeholder="${escapeHtml(placeholder || 'Discord-Name/SteamID tippen…')}" autocomplete="off">` +
    `<datalist id="${listId}"></datalist>`;
}
// Löst den getippten Wert robust zum User auf (Name-Teilstring/Case/SteamID) — siehe matchUser.
function resolveUserInput(inputId, users) {
  return matchUser(el(inputId)?.value, users || USER_POOLS[inputId]);
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
      ? `${escapeHtml(d.dino.dinoClass || '?')} · ${fmtGrow(d.dino.grow || 0)}${d.dino.elderReplicationStacks ? ` · 🪦${d.dino.elderReplicationStacks}` : ''}`
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

// ── Dienst-Modus (Staff): Vitals einfrieren + Admin-Skin ──────────────────────
let dutyOn = false;
function updateDutyBtn(on) {
  dutyOn = !!on;
  document.body.classList.toggle('on-duty', dutyOn); // Lebensanzeige aus + weitere Dienst-Modus-Styles
  const g = el('dutyGlow'); if (g) g.classList.toggle('on', dutyOn); // pinker Rand-Glow
  updateWindowBounds(); // Fenster im Dienst-Modus auf Vollbild halten → Glow rundum sichtbar
  const b = el('dutyToggleBtn');
  if (b) {
    b.textContent = on ? '🩷 Dienst-Modus AUSschalten (Skin zurück)' : '🩷 Dienst-Modus einschalten';
    b.style.background = on ? '#db2777' : '';
  }
  applyModerationGate(); // Tabs nachziehen (no-op wenn Panel zu)
}
async function loadDutyState() {
  const blk = el('dutyBlock');
  if (!sessionToken || !isStaff) { if (blk) blk.style.display = 'none'; return; }
  if (blk) blk.style.display = '';
  try {
    const d = await fetch(`${config.tokenBase}/me/duty`, { headers: { Authorization: `Bearer ${sessionToken}` } }).then((r) => r.json());
    updateDutyBtn(!!d.on);
  } catch {}
}
async function toggleDuty() {
  const b = el('dutyToggleBtn'); if (b) b.disabled = true;
  try {
    const res = await fetch(`${config.tokenBase}/me/duty`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` } });
    const d = await res.json(); if (!res.ok) throw new Error(apiErr(d));
    updateDutyBtn(!!d.on);
    showToast(d.on ? '🩷 Dienst-Modus AN — Vitals eingefroren, Admin-Skin aktiv' : '✅ Dienst-Modus aus — Skin zurückgesetzt', 'success');
  } catch (e) { showToast(e.message || 'Fehler', 'error'); }
  finally { if (b) b.disabled = false; }
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

// Staff-Toast: Nachricht an einen Spieler (wird ihm im Overlay als Toast angezeigt).
async function admSendToast() {
  const u = resolveAdminUser('msgUserSearch');
  if (!u) { showToast('Bitte einen Spieler aus den Vorschlägen wählen', 'error'); return; }
  const text = (el('msgText').value || '').trim();
  if (!text) { showToast('Nachricht fehlt', 'error'); return; }
  try {
    const res = await fetch(`${config.tokenBase}/admin/toast`, {
      method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetSteamId: u.steamId, text }),
    });
    const d = await res.json(); if (!res.ok) throw new Error(apiErr(d));
    showToast(`💬 Nachricht an ${escapeHtml(u.name || 'Spieler')} gesendet`, 'success');
    el('msgText').value = ''; el('msgUserSearch').value = '';
  } catch (e) { showToast(e.message, 'error'); }
}

// Follow-Overwatch: Toggle. Startet (POST) bzw. stoppt (DELETE) /admin/follow.
// Der folgende Admin ist server-seitig der Actor (SteamID aus dem JWT) — wir senden
// nur das Ziel. Auto-Stop im Mod (Ziel disconnect/tot) wird hier nicht gespiegelt.
let followingSteamId = null;
function updateFollowBtn(on) {
  const b = el('followToggleBtn'); if (!b) return;
  b.textContent = on ? '🎯 Follow stoppen' : '🎯 Follow starten';
  b.style.background = on ? '#dc2626' : '';
}
async function admToggleFollow() {
  const stop = !!followingSteamId;
  let target = followingSteamId, name = '';
  if (!stop) {
    const u = resolveAdminUser('followUserSearch');
    if (!u) { showToast('Bitte einen Spieler aus den Vorschlägen wählen', 'error'); return; }
    target = u.steamId; name = u.name || 'Spieler';
  }
  try {
    const res = await fetch(`${config.tokenBase}/admin/follow`, {
      method: stop ? 'DELETE' : 'POST',
      headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
      body: stop ? undefined : JSON.stringify({ targetSteamId: target }),
    });
    const d = await res.json().catch(() => ({})); if (!res.ok) throw new Error(apiErr(d));
    followingSteamId = stop ? null : target;
    updateFollowBtn(!!followingSteamId);
    showToast(stop ? '🎯 Follow gestoppt' : `🎯 Folge ${escapeHtml(name)}`, 'success');
    if (!stop) el('followUserSearch').value = '';
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
    row.innerHTML = `<span>${t.water ? '💧 ' : ''}#${t.number} ${escapeHtml(t.name)} <span style="color:var(--muted)">${t.price}P</span></span>`;
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
  const water = !!(el('tpWater') && el('tpWater').checked);
  if (!name) { showToast('Name fehlt', 'error'); return; }
  try {
    const res = await fetch(`${config.tokenBase}/teleports`, {
      method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, price, cooldownMin, water }),
    });
    const d = await res.json(); if (!res.ok) throw new Error(apiErr(d));
    showToast(`📍 TP-Punkt "${name}"${water ? ' 💧' : ''} erstellt`, 'success');
    el('tpName').value = ''; el('tpPrice').value = ''; el('tpCooldown').value = '';
    if (el('tpWater')) el('tpWater').checked = false;
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
  closeAllPanels(); // Kalibrierung läuft auf der Karte → offenes Modal (Administration/Moderation) schließen
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

// Manueller Pull: aktuelle Server-Zonen NACHLADEN (mergen) — fügt Zonen dazu, die andere gespeichert
// haben (per ID), OHNE deine eigenen ungespeicherten Zeichnungen zu überschreiben. Fürs gemeinsame
// Zonen-Ziehen: vor dem Speichern einmal pullen, damit du auf dem aktuellen Stand aufbaust.
async function pullZones() {
  try {
    const res = await fetch(`${config.tokenBase}/zones`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!res.ok) throw new Error('Laden fehlgeschlagen');
    const d = await res.json();
    const server = Array.isArray(d.zones) ? d.zones : [];
    const have = new Set(ZONES.map((z) => z.id));
    let added = 0;
    for (const z of server) {
      if (z.id && !have.has(z.id)) {
        ZONES.push({ id: z.id, type: ZONE_TYPES.includes(z.type) ? z.type : 'pvp', name: z.name || '', points: Array.isArray(z.points) ? z.points : [] });
        added++;
      }
    }
    renderZoneList(); updateZoneInfo(); if (mapOpen) renderBigMap();
    showToast(added ? `🔄 ${added} Zone(n) vom Server nachgeladen` : '🔄 Du bist aktuell — keine neuen Zonen', 'success');
  } catch (e) { showToast('Zonen-Pull fehlgeschlagen — später erneut versuchen', 'error'); }
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
// Free-Gender-Swap-Event: server-weites Flag (Administration→Welt). Aktiv → alle dürfen kostenlos
// das Geschlecht wechseln (Skin-Editor überspringt dann die Rang-Grenze).
let freeGenderSwap = false;
async function loadFreeGenderSwap() {
  try {
    const res = await fetch(`${config.tokenBase}/free-gender-swap`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (res.ok) { const d = await res.json(); freeGenderSwap = !!d.enabled; }
  } catch {}
}
async function loadServerCalibration() {
  try {
    // WICHTIG: GET /calibration braucht Auth (RequireActor). Ohne Header → 401 → globale
    // Kalibrierung wird nie geladen (alle blieben auf dem Default hängen). Das war der Grund,
    // warum die global gespeicherte Kalibrierung bei den anderen nie ankam.
    const res = await fetch(`${config.tokenBase}/calibration`, { headers: { Authorization: `Bearer ${sessionToken}` } });
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
  else if (id === 'notifications') renderNotifications();
  else if (id === 'leaderboard') renderLeaderboard();
  el(id).style.display = 'block';
  updateInteractive();
}
function closeAllFeatures(skipInteractive) {
  // Fossil: unbestätigte Live-Vorschau beim Schließen des Skin-Editors zurücksetzen.
  if (featureOpen === 'skinEditor' && skinPays && skinPreviewed && !skinConfirmed) {
    revertSkinPreview();
    showToast('🎨 Vorschau verworfen — Skin zurückgesetzt', '');
  }
  ['dinoInfo', 'skinEditor', 'garage', 'market', 'group', 'profile', 'lexikon', 'quests', 'leaderboard', 'lootbox', 'support', 'notifications'].forEach((id) => { el(id).style.display = 'none'; });
  const tc = el('ticketChat'); if (tc) tc.style.display = 'none';   // Ticket-Chat mit schließen
  stopQuestPoll();
  stopSupportPoll();
  if (featureOpen === 'dinoInfo') stopDinoInfo();
  featureOpen = null;
  if (!skipInteractive) updateInteractive();
}

// ── 🐾 Wandern: persönliche Wander-Statistik + Custom-Name + Leaderboard ──────
// Frisch-bereiste Distanz je Kategorie (Backend: /leaderboard/migration, /me/migration,
// /me/dino/name). Top-3 hervorgehoben; Kategorie- + Woche/Gesamt-Umschalter.
const LB_CATS = [
  { key: 'walk', icon: '🏃', label: 'Laufen' },
  { key: 'flight', icon: '🦅', label: 'Fliegen' },
  { key: 'swim', icon: '🌊', label: 'Schwimmen' },
];
let lbState = { cat: 'walk', scope: 'weekly' };

function lbFmtDist(m) {
  m = m || 0;
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

function renderLeaderboard() {
  const panel = el('leaderboard');
  panel.classList.remove('pf-wide');
  const catBtns = LB_CATS.map((c) => `<button class="lb-tab${c.key === lbState.cat ? '' : ' secondary'}" data-lbcat="${c.key}">${c.icon} ${c.label}</button>`).join('');
  panel.innerHTML = `<h2>🐾 Wandern <span style="font-weight:400;font-size:12px;color:var(--muted)">— frisch bereiste Distanz</span></h2>
    <div id="lbMine" style="margin-bottom:14px"><div class="lb-muted">Lädt…</div></div>
    <div class="lb-controls">
      <div class="lb-tabs" id="lbCatTabs">${catBtns}</div>
      <div style="flex:1"></div>
      <div class="lb-tabs">
        <button class="lb-tab${lbState.scope === 'weekly' ? '' : ' secondary'}" data-lbscope="weekly">📅 Woche</button>
        <button class="lb-tab${lbState.scope === 'total' ? '' : ' secondary'}" data-lbscope="total">🏆 Gesamt</button>
      </div>
    </div>
    <div id="lbBoard"><div class="lb-muted">Lädt…</div></div>
    <button class="closeFeature secondary" style="margin-top:12px">Schließen</button>`;
  const cb = panel.querySelector('.closeFeature'); if (cb) cb.onclick = () => closeAllFeatures();
  panel.querySelectorAll('[data-lbcat]').forEach((b) => { b.onclick = () => { lbState.cat = b.dataset.lbcat; renderLeaderboard(); }; });
  panel.querySelectorAll('[data-lbscope]').forEach((b) => { b.onclick = () => { lbState.scope = b.dataset.lbscope; renderLeaderboard(); }; });
  lbLoadMine();
  lbLoadBoard();
}

async function lbLoadMine() {
  const box = el('lbMine'); if (!box) return;
  let d;
  try { d = await svApi('GET', '/me/migration'); }
  catch (e) { box.innerHTML = `<div class="lb-muted">Meine Wanderung nicht ladbar (${escapeHtml(e.message)}).</div>`; return; }
  const live = (d.live || []).reduce((m, c) => { m[c.category] = c; return m; }, {});
  const recs = (d.records || []).reduce((m, r) => { m[r.category] = r; return m; }, {});
  // Die fürs aktive Dino relevanten Kategorien (Lauf+Schwimm bzw. Flug+Schwimm) — vom Backend.
  const cats = (Array.isArray(d.categories) && d.categories.length) ? d.categories : ['walk', 'swim'];
  const activeName = d.dinoName ? `🏷️ ${escapeHtml(d.dinoName)}` : '<span class="lb-muted">unbenannt</span>';
  const tiles = cats.map((k) => {
    const m = LB_CATS.find((c) => c.key === k) || { icon: '', label: k };
    const c = live[k] || {}, r = recs[k];
    return `<div class="lb-stat">
      <div class="lb-stat-l">${m.icon} ${m.label}</div>
      <div class="lb-stat-v">${lbFmtDist(c.totalM)}</div>
      <div class="lb-muted" style="margin-top:2px">Woche ${lbFmtDist(c.weeklyM)}${r ? ` · 🏆 ${lbFmtDist(r.distanceM)}` : ''}</div>
    </div>`;
  }).join('');
  box.innerHTML = `
    <div class="lb-mine">
      <div class="lb-mine-name">
        <div class="lb-muted" style="margin-bottom:4px">🦖 Aktiver Dino</div>
        <div style="font-weight:600">${activeName}</div>
        <div class="lb-muted" style="margin-top:4px">Namen vergibst du in der <b>Garage</b> — sie sind an den jeweiligen Dino gebunden.</div>
      </div>
      <div class="lb-mine-stats">${tiles}</div>
    </div>`;
}

async function lbLoadBoard() {
  const box = el('lbBoard'); if (!box) return;
  let d;
  try { d = await svApi('GET', `/leaderboard/migration?scope=${lbState.scope}&category=${lbState.cat}`); }
  catch (e) { box.innerHTML = `<div class="lb-muted">Leaderboard nicht ladbar (${escapeHtml(e.message)}).</div>`; return; }
  const rows = d.rows || [];
  if (!rows.length) { box.innerHTML = '<div class="lb-muted">Noch keine Einträge — geh wandern! 🐾</div>'; return; }
  const medal = (r) => r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `<span class="lb-rank">${r}</span>`;
  box.innerHTML = `<div class="lb-list">${rows.map((r) => {
    const nm = r.discordName || r.dinoName || r.steamId;
    const dn = r.dinoName ? `<span class="lb-dino">🦖 ${escapeHtml(r.dinoName)}</span>` : '';
    return `<div class="lb-row${r.rank <= 3 ? ' lb-top' : ''}">
      <div class="lb-medal">${medal(r.rank)}</div>
      <div class="lb-who"><div class="lb-name">${escapeHtml(nm)}</div>${dn}</div>
      <div class="lb-dist">${lbFmtDist(r.distanceM)}</div>
    </div>`;
  }).join('')}</div>`;
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
      showToast(`💬 ${last.name || 'Gruppe'}: ${String(last.text).slice(0, 80)}`, '', 'group'); // Gruppen-Chat → Postfach 'group' [BFT-181]
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
let ovInviteSearch = '';   // Suchtext der Einladen-Tabelle (nach Spielername)
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
    // Overlay-Gruppen-Lead-Infos (BFT-182): Krone am Lead, Entfernen-Button nur für den Lead.
    const ovMembers = new Set((ovGroupState.members || []).map((m) => m.steamId));
    const lead = ovGroupState.lead || null;
    const meLead = !!ovGroupState.meLead;
    html = members.map((p) => {
      const you = !!p.isYou;
      const partner = me.partnerSteamId && p.steamId === me.partnerSteamId;
      const grow = fmtGrow(p.grow);
      const dist = (!you && me) ? `${Math.round(Math.hypot(p.x - me.x, p.y - me.y) / UNITS_PER_M)} m` : '';
      const crown = (lead && p.steamId === lead) ? ' 👑' : '';
      const tag = you ? ' <span style="color:var(--accent-2)">(Du)</span>' : (partner ? ' 💞' : (p.ovgroup ? ' 🔗' : ''));
      const rmBtn = (meLead && !you && ovMembers.has(p.steamId)) ? `<button data-rm="${p.steamId}" title="Aus Gruppe entfernen" class="secondary" style="width:auto;padding:3px 8px;font-size:11px;flex:none">✕</button>` : '';
      return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 10px;margin-bottom:6px;border-radius:9px;background:${you ? 'rgba(var(--accent-rgb),0.18)' : 'rgba(255,255,255,0.04)'};border:1px solid ${you ? 'var(--accent)' : 'transparent'}">
        <span style="font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p.name || '?')}${crown}${tag}</span>
        <span style="color:var(--muted);font-size:12px;flex:none">${escapeHtml(p.dino || '—')}${grow ? ' · ' + grow : ''}</span>
        <span style="color:var(--accent-2);font-size:12px;flex:none;min-width:42px;text-align:right">${dist}</span>
        ${rmBtn}
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
  c.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => ovRemove(b.dataset.rm); }); // Handler nach Live-Rerender neu binden [BFT-182]
  const cnt = el('grpCount'); if (cnt) cnt.textContent = mem.count > 1 ? ` · ${mem.count} Mitglieder` : '';
  renderGroupChat();
}

function renderGroup() {
  const panel = el('group');
  // Chat-Eingabefeld über das (seltene) volle Re-Render retten
  const _ci = el('grpChatInput');
  const _chat = _ci ? { val: _ci.value, focused: document.activeElement === _ci, s: _ci.selectionStart, e: _ci.selectionEnd } : null;
  // Such-Feld der Einladen-Tabelle ebenso retten (renderGroup läuft auch beim Gruppen-Poll)
  const _si = el('ovInviteSearch');
  const _srch = _si ? { focused: document.activeElement === _si, s: _si.selectionStart, e: _si.selectionEnd } : null;
  const mem = groupMembersHtml();
  const body = mem.html;

  const inv = (ovGroupState.invites || []).map((i) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 8px;margin-bottom:5px;background:rgba(34,197,94,0.12);border:1px solid var(--border);border-radius:8px">
    <span style="font-size:12px">📨 Einladung von <b>${escapeHtml(i.fromName || '?')}</b></span>
    <span style="display:flex;gap:6px;flex:none">
      <button data-acc="${i.gid}" style="width:auto;padding:5px 10px;font-size:12px">Beitreten</button>
      <button data-dec="${i.gid}" class="secondary" style="width:auto;padding:5px 10px;font-size:12px">Ablehnen</button>
    </span></div>`).join('');
  let invitable = '';
  if (ovInviteOpen) {
    // Das Backend (/ovgroup/invitable) liefert bereits NUR berechtigte Spieler: gleiche Diät,
    // lebend, online, nicht man selbst, nicht schon in der eigenen Gruppe. Hier wird nur noch
    // nach Namen gefiltert.
    const q = ovInviteSearch.trim().toLowerCase();
    const list = q ? ovInvitable.filter((p) => (p.name || '').toLowerCase().includes(q)) : ovInvitable;
    const rows = list.map((p) => `<tr style="border-top:1px solid var(--border)">
        <td style="padding:5px 8px;max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</td>
        <td style="padding:5px 8px;color:var(--muted);white-space:nowrap">${escapeHtml(p.dino || '')}</td>
        <td style="padding:4px 6px;text-align:right"><button data-inv="${p.steamId}" style="width:auto;padding:4px 9px;font-size:11px;white-space:nowrap">＋ Einladen</button></td>
      </tr>`).join('');
    const empty = ovInvitable.length
      ? `Kein Treffer für „${escapeHtml(ovInviteSearch)}".`
      : 'Keine einladbaren Spieler (gleiche Diät, online).';
    invitable = `
      <input id="ovInviteSearch" value="${escapeHtml(ovInviteSearch)}" maxlength="32" placeholder="🔍 Spieler suchen…"
             style="width:100%;margin:6px 0;padding:7px 9px;border-radius:8px;border:1px solid var(--border);background:var(--input-bg);color:#eee;font-size:12px;box-sizing:border-box">
      <div style="max-height:30vh;overflow:auto;border:1px solid var(--border);border-radius:8px;background:rgba(0,0,0,0.18)">
        ${list.length ? `<table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="position:sticky;top:0;background:#1c1c22;z-index:1">
            <th style="text-align:left;padding:6px 8px;color:var(--muted);font-weight:600">Spieler</th>
            <th style="text-align:left;padding:6px 8px;color:var(--muted);font-weight:600">Dino</th>
            <th style="width:1%;padding:6px 8px"></th>
          </tr></thead>
          <tbody>${rows}</tbody></table>`
        : `<div style="color:var(--muted);font-size:12px;padding:10px">${empty}</div>`}
      </div>
      <div style="color:var(--muted);font-size:11px;margin-top:4px">${list.length} von ${ovInvitable.length} einladbar</div>`;
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
  const tgl = el('ovInviteToggle'); if (tgl) tgl.onclick = () => { ovInviteOpen = !ovInviteOpen; ovInviteSearch = ''; if (ovInviteOpen) loadOvInvitable(); else renderGroup(); };
  { const si = el('ovInviteSearch');
    if (si) {
      si.oninput = () => { ovInviteSearch = si.value; renderGroup(); };
      if (_srch && _srch.focused) { si.focus(); try { si.setSelectionRange(_srch.s, _srch.e); } catch {} }
    } }
  panel.querySelectorAll('[data-acc]').forEach((b) => { b.onclick = () => ovAccept(b.dataset.acc); });
  panel.querySelectorAll('[data-dec]').forEach((b) => { b.onclick = () => ovDecline(b.dataset.dec); }); // Einladung ablehnen [BFT-182]
  panel.querySelectorAll('[data-inv]').forEach((b) => { b.onclick = () => ovInvite(b.dataset.inv); });
  panel.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => ovRemove(b.dataset.rm); }); // Lead entfernt Mitglied [BFT-182]
  const lv = el('ovLeave'); if (lv) lv.onclick = () => ovLeave();
}

async function loadOvGroup() {
  if (!sessionToken) return;
  try {
    const r = await fetch(`${config.tokenBase}/ovgroup`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!r.ok) return;
    ovGroupState = await r.json();
    for (const i of (ovGroupState.invites || [])) {
      if (!ovInviteSeen.has(i.gid)) { ovInviteSeen.add(i.gid); showToast(`📨 Gruppen-Einladung von ${i.fromName || '?'}`, 'success', 'invite'); }
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
// Lead entfernt ein Mitglied [BFT-182]
async function ovRemove(sid) {
  try {
    const r = await fetch(`${config.tokenBase}/ovgroup/remove`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ steamId: sid }) });
    const d = await r.json(); if (!r.ok) throw new Error(apiErr(d));
    showToast('Mitglied entfernt', ''); loadOvGroup();
  } catch (e) { showToast(e.message, 'error'); }
}
// Gruppeneinladung ablehnen [BFT-182]
async function ovDecline(gid) {
  try { await fetch(`${config.tokenBase}/ovgroup/decline`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ gid }) }); showToast('Einladung abgelehnt', ''); loadOvGroup(); } catch {}
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
    ? `${escapeHtml(d.dino || '?')} · ${d.gender === 'Female' ? '♀' : '♂'} · ${fmtGrow(d.grow || 0)}${tags.length ? ' · ' + tags.join(' · ') : ''}`
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
        showToast(`💬 Neue Support-Antwort — Ticket #${t.ticketId}`, 'success', 'ticket'); // → Postfach 'ticket' [BFT-181]
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

function supCat(id) { return (supCfg && supCfg.categories && supCfg.categories.find((c) => c.id === id)) || { id, label: id || '', emoji: '🎫' }; }
function supCatLabel(id) { return supCat(id).label || id || ''; }

function renderSupTicketList() {
  const box = el('supTickets'); if (!box) return;
  if (!supTickets.length) { box.innerHTML = '<div class="sup-empty">Keine Tickets.<br>Öffne oben ein neues.</div>'; return; }
  const supRow = (t) => {
    const sel = t.channelId === supSel ? ' sel' : '';
    const inBearb = t.status === 'in_bearbeitung';
    const stCol = inBearb ? '#22c55e' : '#f59e0b';
    const stTxt = inBearb ? `In Bearbeitung${t.handler ? ' · ' + escapeHtml(t.handler) : ''}` : 'Offen';
    const neu = t.lastFromOther ? '<span class="sup-dot"></span>' : '';
    const roleTag = t.role === 'handler' ? '🛠️' : (t.role === 'available' ? '🆕' : '');
    const who = (t.role !== 'opener' && t.openerName) ? ` · von ${escapeHtml(t.openerName)}` : '';
    return `<div class="sup-trow${sel}" data-ch="${escapeHtml(t.channelId)}">
      <div class="sup-trow-top"><b>#${t.ticketId}</b> ${roleTag}${neu}</div>
      <div class="sup-trow-sub" style="color:${stCol}">${stTxt}${who}</div>
    </div>`;
  };
  // Nach Kategorie gruppieren (Reihenfolge wie in der Config) — leichter zu unterteilen. [BFT-180]
  const order = ((supCfg && supCfg.categories) || []).map((c) => c.id);
  const groups = {};
  for (const t of supTickets) { (groups[t.category] = groups[t.category] || []).push(t); }
  const catIds = Object.keys(groups).sort((a, b) => { const ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
  box.innerHTML = catIds.map((cid) => {
    const c = supCat(cid);
    return `<div class="sup-cat-head" style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin:10px 2px 4px">${c.emoji || '🎫'} ${escapeHtml(c.label)} <span style="opacity:.7">· ${groups[cid].length}</span></div>${groups[cid].map(supRow).join('')}`;
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
  // Nur selbst öffenbare Kategorien anbieten (Bewerbungen laufen über Discord, open=false). [BFT-180]
  const cats = ((supCfg && supCfg.categories) || [{ id: 'help', label: 'Frage / Hilfe', emoji: '❓' }, { id: 'report', label: 'Spieler melden', emoji: '🚨' }]).filter((c) => c.open !== false);
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
    <div style="margin-top:8px">${userSearchHTML('supFwUser', users, 'oder an Person', 'Discord-Name tippen…')}</div>
    <button id="supFwGo" style="margin-top:14px">Weiterleiten</button>`;
  el('supPkClose').onclick = supCloseModal;
  el('supFwRole').onchange = () => { if (el('supFwRole').value) el('supFwUser').value = ''; };
  el('supFwUser').oninput = () => { if (el('supFwUser').value) el('supFwRole').value = ''; };
  el('supFwGo').onclick = async () => {
    const roleId = el('supFwRole').value;
    const uSel = resolveUserInput('supFwUser', users);
    const userId = uSel ? uSel.discordId : '';
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
      + `<span class="q-chip ${growOk ? 'ok' : 'no'}">📈 ${fmtGrow(p.grow || 0)} / ${target}%</span>`
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
const DIET_LABEL = { carni: '🥩 Fleischfresser', herbi: '🌿 Pflanzenfresser', both: '🍽️ Allesfresser' };
const DIET_DOT = { carni: '#ef4444', herbi: '#22c55e', both: '#f59e0b' };
let lexSel = null;

// Lexikon-Reihenfolge (für „Durchblättern"): nach Diät, dann alphabetisch
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
    <div class="di-scroll">
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
  Austroraptor: 'carni', Baryonyx: 'carni',
  Diabloceratops: 'herbi', Dryosaurus: 'herbi', Hypsilophodon: 'herbi', Kentrosaurus: 'herbi', Maiasaura: 'herbi', Maiasaurus: 'herbi',
  Pachycephalosaurus: 'herbi', Stegosaurus: 'herbi', Tenontosaurus: 'herbi', Triceratops: 'herbi',
  Beipiaosaurus: 'both', Gallimimus: 'both', Oviraptor: 'both',
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
  // Custom-Name (Garage): als Titel, Spezies+Wachstum als Untertitel. Sonst wie bisher Spezies-Titel.
  const title = card._name ? `🏷️ ${escapeHtml(card._name)}` : `${escapeHtml(card.dino || '')}${card.isElder ? ' 👑' : ''}`;
  const sub = card._name
    ? `${escapeHtml(card.dino || '')}${card.isElder ? ' 👑' : ''} · ${fmtGrow(card.grow || 0)}`
    : `${card.gender || ''} · ${fmtGrow(card.grow || 0)}`;
  d.innerHTML = dinoPreview(card) + `<div class="body"><div class="nm">${title}</div><div class="mt">${sub}</div></div>` + paletteHTML(card.colors);
  d.onclick = onClick; return d;
}
// Garage/Markt-Dino-Info: gespeicherte Dino-Karten → Vitals als Prozent (kein Cur/Max-Kontext).
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
  const isMut = (x) => x && x !== 'None'; // "None"-Platzhalter (feste Mod-Slots) nicht anzeigen
  const groups = [['Basis', m?.base || []], ['Eltern', m?.parent || []], ['Elder', m?.elder || []]];
  const total = groups.reduce((n, [, arr]) => n + arr.filter(isMut).length, 0);
  if (!total) return '<span style="color:var(--muted);font-size:12px">Keine Mutationen</span>';
  return '<div class="mut-tbl">' + groups.map(([label, arr]) => {
    const items = (arr || []).filter(isMut);
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
    // Dino-gebundener Custom-Name (an DIESEN Garagen-Dino gebunden, im Leaderboard genutzt).
    const nameRow = `<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
      <input id="ddName" class="lb-input" maxlength="24" placeholder="🏷️ Dino benennen…" value="${escapeHtml(card._name || '')}" style="flex:1">
      <button id="ddNameSave" class="secondary" style="flex:none;width:auto;padding:8px 12px">Speichern</button>
    </div>`;
    action = nameRow + unparkBtn + swapBtn
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
        <div style="font-size:12px;color:var(--muted);margin:3px 0 9px">${fmtGrow(card.grow || 0)} Wachstum</div>
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
  { const ni = box.querySelector('#ddNameSave'), nf = box.querySelector('#ddName');
    if (ni && nf) ni.onclick = async () => {
      try { const r = await svApi('POST', `/me/garage/${card.id}/name`, { name: nf.value.trim() }); card._name = r.name || ''; garageNames[card.id] = card._name; showToast('🏷️ Dino-Name gespeichert', 'success'); loadGarage(); }
      catch (e) { showToast(e.message, 'error'); }
    }; }
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
const apiAction = makeApiAction({ api: svApi, toast: (m, k) => showToast(m, k), after: () => pollHud() });
const unparkById = (id) => apiAction('/garage/unpark', { slotId: id }, '⬆️ {dino} ausgeparkt', loadGarage);
const buyOfferId = (id) => apiAction('/market/buy', { offerId: id }, '🦖 {dino} gekauft!', loadMarket);

// ── Garage (Karten-Grid) ─────────────────────────────────────────────────────
let garageCooldowns = {}; // zuletzt geladene Cooldowns (park/unpark/swap) — für die Swap-Sperre im Dino-Detail (B-7)
let garageNames = {};     // slotId → Custom-Dino-Name (dino-gebunden an den geparkten Dino)
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
    // Dino-gebundene Custom-Namen (pro Slot) fürs Anzeigen auf der Karte laden.
    try { const nm = await svApi('GET', '/me/garage/names'); garageNames = nm.names || {}; } catch { garageNames = {}; }
    grid.innerHTML = slots.length ? '' : '<div style="color:var(--muted);font-size:13px">Garage leer.</div>';
    for (const s of slots) { s._name = garageNames[s.id] || ''; grid.appendChild(dinoCardEl(s, () => showDinoDetail(s, { mode: 'garage' }))); }
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
let skinConfirmed = false;  // Fossil-Vorschau: wurde „Bestätigen" gedrückt? (sonst Reset beim Schließen)
let skinPreviewed = false;  // Fossil: läuft gerade eine unbestätigte Live-Vorschau?
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
  btn.textContent = cost > 0 ? `✅ Bestätigen (${cost} Pkt)` : (dirty ? '✅ Bestätigen (gratis)' : '✅ Bestätigt');
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
  await loadFreeGenderSwap(); // aktuellen Event-Stand holen → Geschlechts-Buttons entsprechend
  if (!me || !me.online) {
    panel.innerHTML = '<h2>🎨 Skin Editor</h2><p>Du musst im Spiel sein (auf einem Dino), um den Skin zu ändern.</p><button class="closeFeature secondary" style="width:100%">Schließen</button>';
    panel.querySelector('.closeFeature').onclick = closeAllFeatures; return;
  }
  const sk = me.skin || {};
  skinState = { skinVariation: sk.skinVariation || 0, patternIndex: sk.patternIndex || 0, themeIndex: sk.themeIndex || 0, gender: me.gender === 'Female' ? 'Female' : 'Male', colors: {} };
  for (const [k] of SKIN_GROUPS) skinState.colors[k] = (sk.colors && sk.colors[k]) ? sk.colors[k] : [0.5, 0.5, 0.5];
  setSkinBaseline();
  skinPays = !mySkinFree;                    // Free (Fossil) = gratis Live-Vorschau + „Bestätigen" zahlt; ab Knochen/Beta-Tester live & gratis
  skinConfirmed = false; skinPreviewed = false;   // neue Editier-Sitzung: nichts bestätigt/vorschau
  const obsidian = myAboIdx() >= 3;
  const canGender = freeGenderSwap || myAboIdx() >= 2; // Event aktiv → für alle frei, sonst ab Bernstein
  const genderTip = canGender ? 'Geschlecht wechseln (Respawn)' : '🔒 Geschlechtswechsel ist ab Rang Bernstein freigeschaltet';
  // Aktuellen Rollplay-Namen aus den Live-Positionen vorbelegen (globales `players`, NICHT das
  // hier lokal geshadowte `me`). realName ist nur gesetzt, wenn ein RP-Name aktiv ist → dann ist
  // name der RP-Name.
  const selfPos = (typeof players !== 'undefined' && Array.isArray(players)) ? players.find((p) => p.isYou) : null;
  const rpPrefillName = (selfPos && selfPos.realName) ? (selfPos.name || '') : '';

  const swatches = SKIN_GROUPS.map(([k, l]) => `<label style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 8px;background:rgba(255,255,255,0.04);border-radius:8px;font-size:13px;cursor:pointer"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l}</span><input type="color" data-col="${k}" value="${linToHex(skinState.colors[k])}" style="width:40px;height:26px;border:0;background:none;cursor:pointer;flex:none"></label>`).join('');
  const liveMsg = skinPays
    ? '🟢 Live-Vorschau — mit „Bestätigen" wird der Skin übernommen (50 Pkt/Farbe). Schließen ohne Bestätigen setzt zurück.'
    : '🟢 Änderungen werden live im Spiel übernommen';
  panel.innerHTML = `<h2>🎨 Skin Editor — ${me.dino}</h2>
    <div id="skLive" style="font-size:12px;color:${skinPays ? '#f59e0b' : '#22c55e'};margin:2px 0 14px">${liveMsg}</div>
    <div class="sec-title">🎭 Rollplay-Name</div>
    <div style="font-size:11px;color:var(--muted);margin:2px 0 8px">Andere Spieler sehen diesen Namen statt deines Steam-Namens. Leer speichern = zurücksetzen.</div>
    <div style="display:flex;gap:6px;margin-bottom:14px">
      <input id="rpName" maxlength="24" placeholder="Rollplay-Name…" value="${escapeHtml(rpPrefillName)}" style="flex:1;min-width:0;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--input-bg);color:#eee">
      <button id="rpSave" style="width:auto;padding:8px 12px">💾 Speichern</button>
      <button id="rpClear" class="secondary" style="width:auto;padding:8px 12px">Zurücksetzen</button>
    </div>
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
    ${skinPays ? `<button id="skApply" disabled style="width:100%;margin:10px 0 4px;opacity:.5">✅ Bestätigt</button>
    <div style="font-size:11px;color:var(--muted);margin-bottom:8px">Du siehst die Änderungen live. Erst „Bestätigen" bucht sie ab & behält sie — Schließen ohne Bestätigen setzt den Skin zurück.</div>` : ''}
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
  el('rpSave').onclick = () => saveRpName();
  el('rpClear').onclick = () => { el('rpName').value = ''; saveRpName(); };
  el('skTplSave').onclick = () => saveSkinTemplate();
  el('skShare').onclick = () => copySkinCode();
  el('skImportBtn').onclick = () => importSkinCode(el('skImport').value);
  if (skinPays) el('skApply').onclick = () => commitSkin();
  loadSkinTemplates();
  updateSkinPreview();
  // Fossil: Live-Vorschau (gratis) nach kurzer Pause + Kosten-Button aktualisieren. Ab Knochen: live-commit.
  const onEdit = () => { if (skinPays) { updateApplyCost(); scheduleSkinPreview(); } else scheduleSkinApply(); };
  panel.querySelectorAll('[data-col]').forEach((inp) => inp.oninput = () => { skinState.colors[inp.dataset.col] = hexToLin(inp.value); updateSkinPreview(); onEdit(); });
  panel.querySelectorAll('[data-pat]').forEach((b) => b.onclick = () => { skinState.patternIndex = parseInt(b.dataset.pat); panel.querySelectorAll('[data-pat]').forEach((x) => x.className = x === b ? '' : 'secondary'); onEdit(); });
  el('skVar').oninput = () => { skinState.skinVariation = parseInt(el('skVar').value) || 0; onEdit(); };
  panel.querySelectorAll('[data-gender]').forEach((b) => b.onclick = () => changeGender(b.dataset.gender, panel));
  // 🧟 Zombie-Slider (Obsidian) — debounced; sonst Upsell.
  const zin = el('skZombie');
  if (obsidian) zin.oninput = () => { el('skZombieVal').textContent = Math.round(zin.value * 100) + '%'; clearTimeout(zombieTimer); zombieTimer = setTimeout(() => setZombie(parseFloat(zin.value)), 500); };
  else zin.onclick = () => showToast('🧟 Der Zombie-Look ist exklusiv für Obsidian.', 'error');
}
// Rollplay-Namen setzen/löschen (leerer Name = zurücksetzen). Das Backend ersetzt damit den
// angezeigten Namen für alle Spieler; Staff/Mods sehen zusätzlich den echten Namen.
async function saveRpName() {
  const name = (el('rpName')?.value || '').trim();
  const btn = el('rpSave'); if (btn) btn.disabled = true;
  try {
    const r = await fetch(`${config.tokenBase}/me/rpname`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const d = await r.json(); if (!r.ok) throw new Error(apiErr(d));
    showToast(d.set ? `🎭 Rollplay-Name: ${d.name}` : '🎭 Rollplay-Name zurückgesetzt', 'success');
  } catch (e) { showToast(e.message || 'Fehler', 'error'); }
  finally { if (btn) btn.disabled = false; }
}
// Geschlecht wechseln: The Isle kann das nur per Respawn → /me/gender (selber Dino,
// selbes Wachstum, neues Geschlecht), danach Skin erneut anwenden (Farben behalten).
async function changeGender(gender, panel) {
  if (!skinState || skinState.gender === gender) return;
  if (!freeGenderSwap && myAboIdx() < 2) { showToast('🔒 Geschlechtswechsel gibt es ab Rang Bernstein.', 'error'); return; }
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

// ── Fossil: gratis Live-Vorschau → „Bestätigen" (zahlt) / Schließen-ohne-Bestätigen = Reset ──
let skinPreviewTimer = null;
function scheduleSkinPreview() {
  clearTimeout(skinPreviewTimer);
  setSkinLive('… Vorschau wird geladen', '#f59e0b');
  skinPreviewTimer = setTimeout(() => previewSkin(), 550);
}
async function previewSkin() {
  try {
    const body = { skinVariation: skinState.skinVariation, patternIndex: skinState.patternIndex, themeIndex: skinState.themeIndex, ...skinState.colors, preview: true };
    const res = await fetch(`${config.tokenBase}/skin`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await res.json(); if (!res.ok) throw new Error(apiErr(d));
    skinPreviewed = true; skinConfirmed = false;
    setSkinLive('🟢 Live-Vorschau — noch nicht bestätigt', '#22c55e');
  } catch (err) { setSkinLive('⚠️ ' + err.message, '#ef4444'); showToast(err.message, 'error'); }
}
async function commitSkin() {
  setSkinLive('… wird übernommen', '#f59e0b');
  try {
    const body = { skinVariation: skinState.skinVariation, patternIndex: skinState.patternIndex, themeIndex: skinState.themeIndex, gender: skinState.gender, ...skinState.colors };
    const send = () => fetch(`${config.tokenBase}/skin`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let res = await send();
    if (res.status === 502) { await new Promise((r) => setTimeout(r, 1200)); res = await send(); }
    const d = await res.json(); if (!res.ok) throw new Error(apiErr(d));
    if (typeof d.points === 'number') setPointsHud(d.points);
    skinConfirmed = true; skinPreviewed = false;
    setSkinBaseline(); updateApplyCost();
    setSkinLive(d.charged ? `🟢 Bestätigt (−${d.charged} Pkt)` : '🟢 Bestätigt', '#22c55e');
    showToast(d.charged ? `🎨 Skin übernommen — ${d.charged} Punkte abgebucht` : '🎨 Skin übernommen', 'success');
  } catch (err) { setSkinLive('⚠️ ' + err.message, '#ef4444'); showToast(err.message, 'error'); }
}
// Unbestätigte Vorschau beim Schließen zurücksetzen (Server spielt die gemerkte Baseline zurück).
async function revertSkinPreview() {
  if (!skinPreviewed || skinConfirmed) return;
  skinPreviewed = false;
  try {
    await fetch(`${config.tokenBase}/skin`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ revert: true }) });
  } catch {}
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
    if (skinPays) { scheduleSkinPreview(); showToast('🎨 Vorschau geladen — mit „Bestätigen" übernehmen (50 Pkt/Farbe)', 'success'); }
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
  // Server-Ankaufspreis ist spezies-abhängig (kommt pro Slot vom Backend als serverPrice) — NICHT
  // fest 500. Grow-Gate wie in der Garage-Ansicht: Verkauf erst ab sellMinGrow (Standard 75 %).
  const price = card.serverPrice ?? 0;
  const minG = card.sellMinGrow ?? 0.75, growPct = Math.round((card.grow || 0) * 100), minPct = Math.round(minG * 100);
  const canSell = (card.grow || 0) >= minG;
  const serverBtn = canSell
    ? `<button id="sdServer" style="width:100%;margin-bottom:8px">💰 An Server verkaufen (+${price.toLocaleString('de-DE')})</button>`
    : `<button id="sdServer" style="width:100%;margin-bottom:8px;opacity:.55;cursor:not-allowed" disabled title="Verkauf erst ab ${minPct}% Wachstum — aktuell ${growPct}%.">💰 An Server verkaufen (ab ${minPct}%)</button>`;
  box.innerHTML = `<div style="display:flex;gap:14px;align-items:center;margin-bottom:14px">${dinoPreview(card, 'dd')}<div><div style="font-size:18px;font-weight:700">${card.dino}${card.isElder ? ' 👑' : ''}</div><div style="font-size:12px;color:var(--muted)">${card.gender || ''} · ${fmtGrow(card.grow || 0)}</div></div></div>
    ${serverBtn}
    <div style="display:flex;gap:6px;margin-bottom:8px">
      <input id="sdPrice" type="number" min="1" placeholder="Preis in Punkten" style="flex:1;padding:9px;border-radius:8px;border:1px solid var(--border);background:var(--input-bg);color:#eee;font-size:13px">
      <button id="sdPlayer" style="flex:none;padding:9px 14px">An Spieler listen</button>
    </div>
    <button class="secondary" id="sdClose" style="width:100%">Abbrechen</button>`;
  el('dinoDetail').style.display = 'flex';
  box.querySelector('#sdClose').onclick = closeDinoDetail;
  const ss = box.querySelector('#sdServer');
  if (ss && !ss.disabled) ss.onclick = () => { closeDinoDetail(); apiAction('/market/sell-server', { slotId: card.id }, `💰 An Server verkauft (+${price})`, loadMarket); };
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
let dtMutSearchVal = '';            // Mutations-Suchfilter (bleibt über Re-Renders erhalten)

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
  const _dtMutScroll = box.querySelector('.dt-mlist') ? box.querySelector('.dt-mlist').scrollTop : 0;
  const c = dtSel, diet = dtDiet(), gender = c.gender;
  const isFemale = gender === 'female' || gender === 'Female';
  // Vollständiger Mutations-Katalog (MUT_CATALOG), gefiltert nach Diät + Geschlecht, alphabetisch.
  const list = MUT_CATALOG
    .filter((m) => (m.d === 'both' || m.d === diet) && (!m.f || isFemale))
    .map((m) => ({ value: m.v, label: m.l, desc: m.x || '', hidden: !!m.h }))
    .sort((a, b) => a.label.localeCompare(b.label));
  // Slot-Regeln: BASE hängt an Prime (4 wenn Prime erreicht = ≥5 Bedingungen, sonst 3).
  // PARENT/ELDER hängen an den Elder-Stacks (Entomben): 1× → Parent (4), 2× → Elder (4), 3× → Elder (8).
  const primeCount = c.primes.length, stacks = c.elder || 0;
  const baseMax = primeCount >= 5 ? 4 : 3;
  const parentMax = stacks >= 1 ? 4 : 0;
  const elderMax = stacks >= 3 ? 8 : stacks >= 2 ? 4 : 0;
  const caps = { base: baseMax, parent: parentMax, elder: elderMax };
  const valid = new Set(list.map((m) => m.value));
  c.mut.base = c.mut.base.filter((v) => valid.has(v)).slice(0, baseMax);
  c.mut.parent = parentMax ? c.mut.parent.filter((v) => valid.has(v)).slice(0, parentMax) : [];
  c.mut.elder = elderMax ? c.mut.elder.filter((v) => valid.has(v)).slice(0, elderMax) : [];
  const genLbl = { base: 'B', parent: 'P', elder: 'E' };
  const genTitle = { base: 'Base', parent: 'Parent', elder: 'Elder' };
  const capTxt = (gen) => caps[gen] === 0 ? '🔒' : `${c.mut[gen].length}/${caps[gen]}`;
  const counts = `Base ${capTxt('base')} · Parent ${capTxt('parent')} · Elder ${capTxt('elder')}`;
  const rows = list.map((m) => {
    const inGen = ['base', 'parent', 'elder'].find((g) => c.mut[g].includes(m.value));
    const btn = (gen) => {
      const on = inGen === gen;
      const disabled = caps[gen] === 0 || (inGen && inGen !== gen);
      return `<button class="dt-mgen${on ? ' on' : ''}" data-mut="${escapeHtml(m.value)}" data-gen="${gen}" title="${genTitle[gen]}"${disabled ? ' disabled' : ''}>${genLbl[gen]}</button>`;
    };
    return `<div class="dt-mrow" data-search="${escapeHtml((m.label + ' ' + m.desc).toLowerCase())}">` +
      `<div class="dt-mtxt"><span class="dt-mname">${escapeHtml(m.label)}${m.hidden ? ' <span title="Selten / versteckt">★</span>' : ''}</span><span class="dt-mdesc">${escapeHtml(m.desc)}</span></div>` +
      `<div class="dt-mbtns">${btn('base')}${btn('parent')}${btn('elder')}</div></div>`;
  }).join('');
  box.innerHTML = `
    <div class="dt-sec">🧬 Mutationen <span style="font-weight:400;color:var(--muted)">— ${counts}</span></div>
    <input id="dtMutSearch" class="tm-input" placeholder="🔎 Mutation suchen…" autocomplete="off" style="margin-bottom:6px">
    <div class="dt-mlist">${rows || '<div class="dt-muted" style="padding:8px">Keine Mutationen für diese Auswahl.</div>'}</div>
    <div class="dt-muted" style="font-size:10.5px;margin-top:4px">B = Base (4 bei Prime ≥5, sonst 3) · P = Parent (ab 1× Elder-Stack) · E = Elder (ab 2×, 8 bei 3×) · ★ = selten. Jede Mutation zählt in nur eine Generation.</div>`;
  box.querySelectorAll('.dt-mgen').forEach((b) => { b.onclick = () => {
    const val = b.dataset.mut, gen = b.dataset.gen, arr = c.mut[gen], i = arr.indexOf(val);
    if (i >= 0) arr.splice(i, 1);
    else { if (arr.length >= caps[gen]) { showToast(`Max. ${caps[gen]} in ${genTitle[gen]}`, 'error'); return; } arr.push(val); }
    renderDtMut();
  }; });
  const s = el('dtMutSearch');
  const applyFilter = () => { const q = (dtMutSearchVal || '').trim().toLowerCase(); box.querySelectorAll('.dt-mrow').forEach((r) => { r.style.display = !q || r.dataset.search.includes(q) ? '' : 'none'; }); };
  if (s) { s.value = dtMutSearchVal; s.oninput = () => { dtMutSearchVal = s.value; applyFilter(); }; applyFilter(); }
  { const _nl = box.querySelector('.dt-mlist'); if (_nl) _nl.scrollTop = _dtMutScroll; }
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
        <div style="flex:1;min-width:0"><label>Geschlecht</label><select id="dtGender" class="bf-select"><option value="Male"${c.gender === 'Male' ? ' selected' : ''}>♂ Male</option><option value="Female"${c.gender === 'Female' ? ' selected' : ''}>♀ Female</option></select></div>
        <div style="flex:1;min-width:0"><label>Wachstum %</label><input id="dtGrow" type="number" min="1" max="100" value="${c.grow}" class="bf-select" style="box-sizing:border-box"></div>
        <div style="flex:1;min-width:0"><label>Elder-Stacks</label><select id="dtElder" class="bf-select">${[0, 1, 2, 3].map((n) => `<option value="${n}"${c.elder === n ? ' selected' : ''}>${n}×</option>`).join('')}</select></div>
      </div>
      <label id="dtPrimeLbl">Prime-Bedingungen (${c.primes.length}/10)</label>
      <div class="dt-chips" id="dtPrime"></div>
      <div id="dtMut"></div>
      <button id="dtGiveSubmit" style="width:100%;margin-top:14px;background:#16a34a">🎁 Token geben</button>
    </div>`;
  const renderTarget = () => {
    c.targetKind = el('dtKind').value;
    el('dtTargetBox').innerHTML = c.targetKind === 'user'
      ? userSearchHTML('dtUser', dtUsers, 'Spieler', 'Discord-Name tippen…')
      : c.targetKind === 'role'
        ? `<label>Rolle</label><select id="dtRole" class="bf-select">${roleOpts}</select>`
        : '<div class="dt-muted" style="margin-top:6px">→ an alle aktuell online Spieler.</div>';
  };
  renderTarget();
  el('dtKind').onchange = renderTarget;
  el('dtSpecies').onchange = (e) => { c.species = e.target.value; renderDtMut(); };
  el('dtGender').onchange = (e) => { c.gender = e.target.value; renderDtMut(); };
  el('dtGrow').oninput = (e) => { c.grow = e.target.value; };
  el('dtElder').onchange = (e) => { c.elder = parseInt(e.target.value); renderDtMut(); };
  renderDtPrime(); renderDtMut();
  el('dtGiveSubmit').onclick = () => {
    const body = { targetKind: c.targetKind, dino: c.species, gender: el('dtGender').value, grow: (parseInt(el('dtGrow').value) || 25) / 100, elderStacks: c.elder, primes: c.primes, mutations: c.mut };
    if (c.targetKind === 'user') { const u = resolveUserInput('dtUser', dtUsers); if (!u) { showToast('Bitte einen Spieler aus den Vorschlägen wählen', 'error'); return; } body.targetSteamId = u.steamId; }
    else if (c.targetKind === 'role') { const r = el('dtRole'); if (!r || !r.value) { showToast('Rolle wählen', 'error'); return; } body.roleId = r.value; }
    apiAction('/admin/dino-token/create', body, '🎁 Dino-Token vergeben', () => { c.primes = []; c.mut = { base: [], parent: [], elder: [] }; renderDtPrime(); renderDtMut(); const l = el('dtPrimeLbl'); if (l) l.textContent = 'Prime-Bedingungen (0/10)'; });
  };
}
function renderDtEditDelete() {
  el('dtBody').innerHTML = `
    <div class="dt-form">
      ${userSearchHTML('dtEdUser', dtUsers, `Spieler (${dtTab === 'delete' ? 'Token löschen' : 'Token bearbeiten'})`, 'Discord-Name tippen…')}
      <button id="dtEdLoad" style="width:100%;margin-top:8px">📋 Garage laden</button>
    </div>
    <div id="dtEdList" style="margin-top:12px"></div>`;
  el('dtEdLoad').onclick = dtLoadGarage;
}
async function dtLoadGarage() {
  const u = resolveUserInput('dtEdUser', dtUsers); if (!u) { showToast('Bitte einen Spieler aus den Vorschlägen wählen', 'error'); return; }
  const sid = u.steamId;
  const box = el('dtEdList'); box.innerHTML = '<div class="dt-muted">Lade…</div>';
  try {
    const d = await fetch(`${config.tokenBase}/admin/dino-token/garage?steamId=${encodeURIComponent(sid)}`, { headers: { Authorization: `Bearer ${sessionToken}` } }).then((r) => r.json());
    if (d.error) throw new Error(d.error);
    const slots = d.slots || [];
    if (!slots.length) { box.innerHTML = '<div class="dt-muted">Garage leer.</div>'; return; }
    box.innerHTML = slots.map((s) => `<div class="dt-slot"><span>${escapeHtml(s.dinoClass || s.label || '?')} · ${fmtGrow(s.grow || 0)} · ${escapeHtml(s.gender || '')}${(s.elderStacks || 0) > 0 ? ' 👑' : ''}${(s.primes || []).length >= 5 ? ' ⭐' : ''}</span>${dtTab === 'delete' ? `<button class="secondary" data-del="${s.id}" style="flex:none;width:auto;padding:5px 10px;color:#fca5a5">🗑️</button>` : `<button data-edit="${s.id}" style="flex:none;width:auto;padding:5px 10px">✏️</button>`}</div>`).join('');
    box.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { if (b.dataset.armed) { apiAction('/admin/dino-token/delete', { targetSteamId: sid, slotId: b.dataset.del }, '🗑️ Token gelöscht', dtLoadGarage); } else { b.dataset.armed = '1'; b.textContent = 'Sicher?'; setTimeout(() => { b.textContent = '🗑️'; delete b.dataset.armed; }, 2500); } }; });
    box.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => dtOpenEdit(sid, slots.find((s) => s.id === b.dataset.edit)); });
  } catch (e) { box.innerHTML = `<div style="color:#ef4444;font-size:13px">${escapeHtml(e.message || '')}</div>`; }
}
function dtOpenEdit(steamId, slot) {
  if (!slot) return;
  const c = dtSel;
  c.species = slot.dinoClass; c.gender = slot.gender || 'Male'; c.grow = Math.round((slot.grow || 0) * 100);
  c.elder = slot.elderStacks || 0; c.primes = (slot.primes || []).slice();
  c.mut = { base: (slot.mutations?.base || []).filter(Boolean), parent: (slot.mutations?.parent || []).filter(Boolean), elder: (slot.mutations?.elder || []).filter(Boolean) };
  el('dtBody').innerHTML = `
    <div class="dt-form">
      <div class="dt-sec">✏️ ${escapeHtml(slot.dinoClass || slot.label || 'Dino')} bearbeiten</div>
      <div class="dt-row">
        <div style="flex:1;min-width:0"><label>Geschlecht</label><select id="dtGender" class="bf-select"><option value="Male"${c.gender === 'Male' ? ' selected' : ''}>♂ Male</option><option value="Female"${c.gender === 'Female' ? ' selected' : ''}>♀ Female</option></select></div>
        <div style="flex:1;min-width:0"><label>Wachstum %</label><input id="dtGrow" type="number" min="1" max="100" value="${c.grow}" class="bf-select" style="box-sizing:border-box"></div>
        <div style="flex:1;min-width:0"><label>Elder-Stacks</label><select id="dtElder" class="bf-select">${[0, 1, 2, 3].map((n) => `<option value="${n}"${c.elder === n ? ' selected' : ''}>${n}×</option>`).join('')}</select></div>
      </div>
      <label id="dtPrimeLbl">Prime-Bedingungen (${c.primes.length}/10)</label>
      <div class="dt-chips" id="dtPrime"></div>
      <div id="dtMut"></div>
      <div class="dt-row" style="margin-top:14px"><button id="dtSave" style="flex:1;background:#16a34a">💾 Speichern</button><button id="dtBack" class="secondary" style="flex:none">Zurück</button></div>
    </div>`;
  el('dtGender').onchange = (e) => { c.gender = e.target.value; renderDtMut(); };
  el('dtGrow').oninput = (e) => { c.grow = e.target.value; };
  el('dtElder').onchange = (e) => { c.elder = parseInt(e.target.value); renderDtMut(); };
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
      ${userSearchHTML('ppPrUser', ppUsers, 'Spieler (muss ingame sein)', 'Discord-Name tippen…')}
      <label id="ppPrLbl">Prime-Bedingungen (${ppPrimes.length}/10)</label>
      <div class="dt-chips" id="ppPrChips"></div>
      <button id="ppPrApply" style="width:100%;margin-top:10px">⭐ Prime setzen</button>
    </div>`;
  const renderTarget = () => {
    ppGrantKind = el('ppKind').value;
    el('ppTargetBox').innerHTML = ppGrantKind === 'user' ? userSearchHTML('ppUser', ppUsers, 'Spieler', 'Discord-Name tippen…')
      : ppGrantKind === 'role' ? `<label>Rolle</label><select id="ppRole" class="bf-select">${roleOpts}</select>`
        : '<div class="dt-muted" style="margin-top:6px">→ an alle aktuell online Spieler.</div>';
  };
  renderTarget(); el('ppKind').onchange = renderTarget;
  const grantBody = () => {
    const b = { targetKind: ppGrantKind };
    if (ppGrantKind === 'user') { const u = resolveUserInput('ppUser', ppUsers); if (!u) { showToast('Bitte einen Spieler aus den Vorschlägen wählen', 'error'); return null; } b.targetSteamId = u.steamId; }
    else if (ppGrantKind === 'role') { const r = el('ppRole'); if (!r || !r.value) { showToast('Rolle wählen', 'error'); return null; } b.roleId = r.value; }
    return b;
  };
  el('ppGrant').onclick = () => { const b = grantBody(); if (!b) return; b.buildKey = el('ppBuild').value; apiAction('/admin/pvp/grant', b, '🏆 PvP-Build vergeben', null); };
  el('ppRemove').onclick = () => { const b = grantBody(); if (!b) return; apiAction('/admin/pvp/remove', b, '🧹 PvP-Builds eingesammelt', null); };
  renderPpPrimeChips();
  el('ppPrApply').onclick = () => { const u = resolveUserInput('ppPrUser', ppUsers); if (!u) { showToast('Bitte einen Spieler aus den Vorschlägen wählen', 'error'); return; } apiAction('/admin/prime', { targetSteamId: u.steamId, primes: ppPrimes }, '⭐ Prime gesetzt', null); };
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
function renderServer() {
  let html = `
    <div class="dt-sec">📊 Server-Status</div>
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
    el(`di-${s.key}-f`).style.width = pct + '%'; // Balken bleibt Fraktion
    // Vitals mit absolutem Current/Max (aus /me: healthCur/Max …); Nährstoffe ohne Cur/Max → %. [BFT-179]
    const cur = d[s.key + 'Cur'], max = d[s.key + 'Max'];
    el(`di-${s.key}-v`).textContent = (typeof cur === 'number' && typeof max === 'number') ? `${Math.round(cur)} / ${Math.round(max)}` : pct + '%';
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
  const anyPanel = settingsOpen || mapOpen || adminOpen || serverOpen || !!featureOpen;
  // Dock IMMER einblenden, sobald ein Panel offen ist (auch per Hotkey geöffnet), im „^"-Modus oder im Edit-Mode.
  setDockVisible(overlayMode || anyPanel || editMode);
  // Maus durchlassen nur wenn nichts offen ist (im Edit-Mode immer klickbar)
  window.bf.setInteractive(overlayMode || anyPanel || editMode);
  // Frisch geöffnete Panels im Edit-Mode sofort bearbeitbar machen (Resize-Griff)
  refreshEditAffordances();
  // Blitz-Rahmen an sichtbare Panels/Minimap anpassen (jetzt + nach Öffnen-Animation nachziehen)
  bfScheduleFrameSync();
  updateWindowBounds();   // Idle → Fenster schrumpfen, Dock/Panel offen → Vollbild
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
  for (const id of ['settings', 'adminPanel', 'serverPanel', 'srvPanel', 'bigMap']) { const e = el(id); if (e) out.push({ el: e, round: false }); }
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
  if (serverOpen) closeServerPanel();
  if (srvOpen) closeSrvPanel();
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
  server:   dockSvg('<rect x="2" y="3" width="20" height="6" rx="1"/><rect x="2" y="12" width="20" height="6" rx="1"/><path d="M6 6h.01M6 15h.01"/>'),
  srvctl:   dockSvg('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'),
  quests:   dockSvg('<path d="M4 22V4a1 1 0 0 1 1-1h12l-2 4 2 4H6"/><line x1="4" y1="22" x2="4" y2="15"/>'),
  leaderboard: dockSvg('<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>'),
  notifications: dockSvg('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
  close:    dockSvg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
};

// Welches Dock-Ziel ist gerade offen? (für das Highlight im Dock)
function activeNav() {
  if (settingsOpen) return 'settings';
  if (mapOpen) return 'map';
  if (serverOpen) return 'server';
  if (srvOpen) return 'srvctl';
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
  if ((target === 'server' || target === 'srvctl') && !isAdmin) { showToast('Nur für Admins', 'error'); return; }
  const wasActive = activeNav() === target;
  closeAllPanels();
  if (!wasActive) {
    if (target === 'map') toggleMap(true);
    else if (target === 'settings') toggleSettings(true);
    else if (target === 'server') openServerPanel();
    else if (target === 'srvctl') openSrvPanel();
    else if (target === 'admin') openAdminPanel();
    else if (target === 'skin') toggleFeature('skinEditor');
    else if (target === 'dino') toggleFeature('dinoInfo');
    else toggleFeature(target); // profile | group | lexikon | garage | market
  }
  updateInteractive();
}

let settingsTab = 'audio';
function showSettingsTab(t) {
  settingsTab = t;
  document.querySelectorAll('#settingsTabs [data-sttab]').forEach((b) => b.classList.toggle('secondary', b.dataset.sttab !== t));
  document.querySelectorAll('#settings .settings-pane').forEach((p) => { p.hidden = p.dataset.pane !== t; });
  if (t === 'ui') renderHudToggles();
  if (t === 'software') loadSoftwareTab();
}

// Software-Tab: Version + letzte Release-Notes vom eigenen Backend (folgt der API-Base → test zeigt
// api-test-Notes, prod api-Notes). Format: [{ version, date, notes, channel }], neueste zuerst.
let _swNotesLoaded = false;
function mdLinkLabel(u) {
  if (/\/compare\//.test(u)) return 'Vergleich ansehen ↗';
  try { return new URL(u).hostname + ' ↗'; } catch { return u; }
}
function mdInline(text) {
  // Zuerst escapen (XSS), dann Inline-Markup: Links, dann bare URLs, dann **fett**.
  let s = text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => `<a class="sw-lnk" data-href="${u}">${t}</a>`);
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s)<]+)/g, (m, pre, u) => `${pre}<a class="sw-lnk" data-href="${u}">${mdLinkLabel(u)}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return s;
}
function mdLiteToHtml(md) {
  // Minimaler Markdown-Renderer für unsere eigenen Release-Bodies.
  const lines = md.replace(/\r/g, '').split('\n');
  let html = '', inList = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
    if (/^#{1,6}\s+/.test(line)) { closeList(); html += `<div class="sw-md-h">${mdInline(line.replace(/^#{1,6}\s+/, ''))}</div>`; }
    else if (/^[-*]\s+/.test(line)) { if (!inList) { html += '<ul class="sw-md-ul">'; inList = true; } html += `<li>${mdInline(line.replace(/^[-*]\s+/, ''))}</li>`; }
    else if (line === '') { closeList(); }
    else { closeList(); html += `<div class="sw-md-p">${mdInline(line)}</div>`; }
  }
  if (inList) html += '</ul>';
  return html;
}
async function loadSoftwareTab() {
  updateVersionInfo();          // aktuelle Version in #swVersion spiegeln
  if (_swNotesLoaded) return;
  const meta = el('swRelMeta'), notes = el('swRelNotes');
  if (!notes) return;
  const dateDe = (v) => { try { return new Date(v).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return ''; } };
  try {
    let metaText = '', notesMd = '';
    // NUR Test zieht die Notes vom Backend; Prod bleibt (vorerst) beim GitHub-Releases-API — unverändert.
    if (String(config.tokenBase || '').includes('api-test')) {
      const list = await (await fetch(`${config.tokenBase}/overlay/releases.json`, { headers: { Accept: 'application/json' } })).json();
      const d = Array.isArray(list) ? list[0] : null;
      if (!d) throw new Error('leere Release-Liste');
      const ds = dateDe(d.date);
      metaText = `v${d.version || '?'}${ds ? ' · ' + ds : ''}`;
      notesMd = String(d.notes || '').trim();
    } else {
      const r = await fetch('https://api.github.com/repos/HidekiSensei/blackfossil-overlay/releases/latest', { headers: { Accept: 'application/vnd.github+json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      const ds = dateDe(d.published_at);
      metaText = `${d.name || d.tag_name || ''}${ds ? ' · ' + ds : ''}`;
      notesMd = String(d.body || '').trim();
    }
    if (meta) meta.textContent = metaText;
    notes.innerHTML = mdLiteToHtml(notesMd || 'Keine Notizen.');
    notes.querySelectorAll('.sw-lnk').forEach((a) => { a.onclick = (e) => { e.preventDefault(); const h = a.dataset.href; if (h) { try { window.bf.openExternal?.(h); } catch {} } }; });
    _swNotesLoaded = true;
  } catch (e) {
    if (meta) meta.textContent = '';
    notes.textContent = 'Release-Notes konnten nicht geladen werden (offline?).';
  }
}
function toggleSettings(force) {
  settingsOpen = force !== undefined ? force : !settingsOpen;
  el('settings').style.display = settingsOpen ? 'flex' : 'none';
  if (settingsOpen) { renderVoiceUsers(); renderThemePicker(); showSettingsTab(settingsTab); }   // frisch rendern + Tab syncen
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
    { const b = el('aiEncBtn'); if (b) { b.style.display = isTeam ? 'block' : 'none'; b.classList.toggle('secondary', !aiLayerOn); } }
    if (isTeam) loadAiEncounters();   // KI-Dino-Spawnpunkte/Patrouillen (Team-Layer)
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
  let src = null, pre = null, hp = null, gateNode = null, comp = null, limiter = null, gain = null, dest = null;
  let analyser = null, gateBuf = null, gateTimer = null, gateLastOpen = 0, srcTrack = null;
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
      srcTrack = opts.track;
      src = ctx.createMediaStreamSource(new MediaStream([opts.track]));
      pre = ctx.createGain();                    // Vorverstärkung
      hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 20; hp.Q.value = 0.707; // Low-Cut
      gateNode = ctx.createGain();               // Noise Gate (per Pegel-Erkennung gesteuert)
      comp = ctx.createDynamicsCompressor();     // Kompressor
      limiter = ctx.createDynamicsCompressor();  // Limiter (Brickwall)
      gain = ctx.createGain();                   // bestehende Mikrofon-Lautstärke
      gain.gain.value = micGain;
      dest = ctx.createMediaStreamDestination();
      analyser = ctx.createAnalyser(); analyser.fftSize = 1024; gateBuf = new Float32Array(analyser.fftSize);
      // Kette: Source → PreGain → High-Pass → Gate → Kompressor → Limiter → micGain → Track
      src.connect(pre); pre.connect(hp); hp.connect(gateNode); gateNode.connect(comp);
      comp.connect(limiter); limiter.connect(gain); gain.connect(dest);
      hp.connect(analyser);   // Pegel-Tap fürs Gate (nach dem Filter, vor dem Gate)
      proc.processedTrack = dest.stream.getAudioTracks()[0];
      proc._ctx = ctx;
      proc.applyAudio();
      proc.applyNS();
      // Gate-Detektionsschleife (setInterval läuft auch bei nicht-fokussiertem Overlay, anders als rAF).
      gateTimer = setInterval(() => {
        if (!gateNode || !proc._ctx) return;
        const t = proc._ctx.currentTime;
        if (!micComp.gateOn) { gateNode.gain.setTargetAtTime(1, t, 0.01); return; }
        analyser.getFloatTimeDomainData(gateBuf);
        let sum = 0; for (let i = 0; i < gateBuf.length; i++) sum += gateBuf[i] * gateBuf[i];
        const db = 20 * Math.log10(Math.sqrt(sum / gateBuf.length) || 1e-8);
        const now = Date.now();
        if (db > micComp.gateThreshold) gateLastOpen = now;
        const open = (now - gateLastOpen) < micComp.gateHold;   // Hold hält kurz offen → kein Zerhacken
        const tc = open ? Math.max(0.001, micComp.gateAttack / 1000) : Math.max(0.005, micComp.gateRelease / 1000);
        gateNode.gain.setTargetAtTime(open ? 1 : 0, t, tc);
      }, 30);
    },
    async restart(opts) { await proc.destroy(); await proc.init(opts); },
    async destroy() {
      if (gateTimer) { clearInterval(gateTimer); gateTimer = null; }
      [src, pre, hp, gateNode, comp, limiter, gain, dest, analyser].forEach((n) => { try { n && n.disconnect(); } catch {} });
    },
    setGain(v) { if (gain && proc._ctx) gain.gain.setTargetAtTime(v, proc._ctx.currentTime, 0.05); },
    // Alle Filter-/Dynamik-Parameter live setzen. Jede Sektion „aus" = neutral (durchlässig).
    applyAudio() {
      if (!proc._ctx || !pre) return;
      const t = proc._ctx.currentTime, on = !!micComp.on;
      pre.gain.setTargetAtTime(on ? Math.pow(10, micComp.preGain / 20) : 1, t, 0.03);
      hp.frequency.setTargetAtTime(micComp.hpOn ? Math.max(20, micComp.hpFreq) : 20, t, 0.03);  // aus = 20 Hz ≈ kein Cut
      comp.threshold.setValueAtTime(on ? micComp.threshold : 0, t);
      comp.ratio.setValueAtTime(on ? micComp.ratio : 1, t);
      comp.attack.setValueAtTime(on ? micComp.attack / 1000 : 0.003, t);
      comp.release.setValueAtTime(on ? micComp.release / 1000 : 0.25, t);
      comp.knee.setValueAtTime(on ? micComp.knee : 0, t);
      limiter.threshold.setValueAtTime(micComp.limitOn ? micComp.limitCeil : 0, t);
      limiter.ratio.setValueAtTime(micComp.limitOn ? 20 : 1, t);           // 20:1 + schneller Attack = Brickwall
      limiter.attack.setValueAtTime(micComp.limitOn ? 0.002 : 0.003, t);
      limiter.release.setValueAtTime(micComp.limitOn ? 0.05 : 0.25, t);
      limiter.knee.setValueAtTime(0, t);
    },
    // Browser-native Rauschunterdrückung auf dem Quell-Track an/aus.
    applyNS() {
      if (!srcTrack || !srcTrack.applyConstraints) return;
      try { srcTrack.applyConstraints({ noiseSuppression: !!micComp.nsOn }); } catch {}
    },
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
function applyMicComp() { if (micProc) { if (micProc.applyAudio) micProc.applyAudio(); if (micProc.applyNS) micProc.applyNS(); } }

// Slider (id ↔ micComp-Key ↔ Wert-Formatierung) und Toggles (id ↔ Key ↔ optionale Sektion zum Ausgrauen).
const MIC_SLIDERS = [
  { id: 'micPreGain',       key: 'preGain',       fmt: (v) => `${v > 0 ? '+' : ''}${v} dB` },
  { id: 'micThreshold',     key: 'threshold',     fmt: (v) => `${v} dB` },
  { id: 'micRatio',         key: 'ratio',         fmt: (v) => `${v}:1` },
  { id: 'micAttack',        key: 'attack',        fmt: (v) => `${v} ms` },
  { id: 'micRelease',       key: 'release',       fmt: (v) => `${v} ms` },
  { id: 'micKnee',          key: 'knee',          fmt: (v) => `${v} dB` },
  { id: 'micGateThreshold', key: 'gateThreshold', fmt: (v) => `${v} dB` },
  { id: 'micGateAttack',    key: 'gateAttack',    fmt: (v) => `${v} ms` },
  { id: 'micGateRelease',   key: 'gateRelease',   fmt: (v) => `${v} ms` },
  { id: 'micGateHold',      key: 'gateHold',      fmt: (v) => `${v} ms` },
  { id: 'micHpFreq',        key: 'hpFreq',        fmt: (v) => `${v} Hz` },
  { id: 'micLimitCeil',     key: 'limitCeil',     fmt: (v) => `${v} dB` },
];
const MIC_TOGGLES = [
  { id: 'micNsOn',    key: 'nsOn' },
  { id: 'micHpOn',    key: 'hpOn',    ctrls: 'micHpCtrls' },
  { id: 'micGateOn',  key: 'gateOn',  ctrls: 'micGateCtrls' },
  { id: 'micCompOn',  key: 'on',      ctrls: 'micCompCtrls' },
  { id: 'micLimitOn', key: 'limitOn', ctrls: 'micLimitCtrls' },
];
function refreshMicCompLabels() {
  for (const s of MIC_SLIDERS) { const e = el(s.id + 'V'); if (e) e.textContent = s.fmt(micComp[s.key]); }
  for (const t of MIC_TOGGLES) { if (t.ctrls) { const c = el(t.ctrls); if (c) c.classList.toggle('off', !micComp[t.key]); } }
}
// Einmalig beim Init: Inputs auf gespeicherte Werte setzen + Handler binden.
function initMicCompUI() {
  for (const t of MIC_TOGGLES) {
    const chk = el(t.id); if (!chk) continue;
    chk.checked = !!micComp[t.key];
    chk.onchange = () => { micComp[t.key] = chk.checked; saveMicComp(); applyMicComp(); refreshMicCompLabels(); };
  }
  for (const s of MIC_SLIDERS) {
    const inp = el(s.id); if (!inp) continue;
    inp.value = String(micComp[s.key]);
    inp.oninput = () => { micComp[s.key] = parseInt(inp.value, 10); saveMicComp(); applyMicComp(); refreshMicCompLabels(); };
  }
  const reset = el('micCompReset');
  if (reset) reset.onclick = () => {
    // Nur die Regler-Werte zurücksetzen; die An/Aus-Schalter behalten.
    const keep = {}; for (const t of MIC_TOGGLES) keep[t.key] = micComp[t.key];
    micComp = { ...MIC_COMP_DEFAULTS, ...keep };
    saveMicComp();
    for (const s of MIC_SLIDERS) { const inp = el(s.id); if (inp) inp.value = String(micComp[s.key]); }
    applyMicComp(); refreshMicCompLabels();
  };
  refreshMicCompLabels();
}

function refreshMicState() {
  if (!room) { setMicState('disconnected'); return; }
  if (!isMicOn()) { setMicState('muted'); return; }
  if (room.localParticipant.isSpeaking) { setMicState('speaking'); return; }
  setMicState('idle');
}

// Rollen/Rechte beim Overlay-Start laden — ENTKOPPELT vom Voice-Connect (der bleibt server-only,
// siehe applyServerState/toggleConnect). Blendet Team/Admin/Server-Dock + Panels sofort ein, auch
// wenn man (noch) nicht auf dem Spielserver ist. Startet KEIN Voice, KEINE Ingame-Poller — das
// macht weiterhin connectWithSession beim Server-Join. /token liefert die Rolle Discord-basiert,
// unabhängig von der Spielserver-Präsenz.
async function loadRoleUI() {
  if (!sessionToken) return;
  try {
    const res = await fetch(`${config.tokenBase}/token`, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (res.status === 401) { window.bf.logout(); return; }
    if (!res.ok) return;
    const data = await res.json();
    isAdmin = !!data.admin;
    isIngame = !!data.ingame || isAdmin;
    isTeam = !!data.team || isAdmin;
    isStaff = isIngame || isTeam;
    { const ab = el('openAdminBtn'); if (ab) ab.style.display = isStaff ? 'block' : 'none'; }
    { const da = el('dockAdmin'); if (da) da.style.display = isStaff ? 'flex' : 'none'; }
    { const ds = el('dockServer'); if (ds) ds.style.display = isAdmin ? 'flex' : 'none'; }
    { const dsc = el('dockSrvCtl'); if (dsc) dsc.style.display = isAdmin ? 'flex' : 'none'; }
    { const zb = el('zoneBtn'); if (zb) zb.style.display = isStaff ? 'block' : 'none'; }
    if (data.name) el('hudName').textContent = data.name;
    setTier(data.tier);
    setAboTier((data.team || data.admin) ? 'Obsidian' : data.aboTier);
    mySkinFree = !!data.skinFree;
    setStaff(data.staff);
    applyModerationGate();
    if (isStaff) loadDutyState();
  } catch {}
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
    { const ds = el('dockServer'); if (ds) ds.style.display = isAdmin ? 'flex' : 'none'; }
    { const dsc = el('dockSrvCtl'); if (dsc) dsc.style.display = isAdmin ? 'flex' : 'none'; }
    if (isStaff) loadDutyState(); // Dienst-Status beim Start holen → Rand-Glow ohne Panel-Öffnen
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
    serverVoice = !!data.serverVoice; // Backend steuert Proximity-Subscriptions → autoSubscribe:false
    setStaff(data.staff);
    pollHud();
    if (!pollHud._timer) pollHud._timer = setInterval(pollHud, 6000);
    if (!tickGrowTimer._timer) tickGrowTimer._timer = setInterval(tickGrowTimer, 1000);
    if (!pollGroupChat._timer) pollGroupChat._timer = setInterval(pollGroupChat, 4000);
    if (!pollVitals._timer) { pollVitals(); pollVitals._timer = setInterval(pollVitals, 1000); }   // Vitals aus Slow-Cache (1s); Position/Kompass laufen separat mit 100ms über /positions
    loadTeleports();
    if (!loadTeleports._timer) loadTeleports._timer = setInterval(() => { if (mapOpen) loadTeleports(); }, 4000);
    await connect(data);
  } catch (err) {
    setMicState('disconnected', `Fehler: ${err.message}`);
  }
}

async function connect({ token, url }) {
  setMicState('connecting');
  ensureVoiceCtx(); // eigener AudioContext für webAudioMix — Panner/Lowpass hängen später hier ein
  // webAudioMix: leitet alle Remote-Audios über einen gemeinsamen AudioContext +
  //   GainNodes → setVolume kann >1.0 (Einzel- & Master-Regler wirken wirklich) und
  //   der Context wird auch auf den lokalen Teilnehmer gesetzt (Mikro-Gain-Processor).
  // adaptiveStream/dynacast: nur für Video sinnvoll; für reines Audio aus (vermeidet
  //   pausierte Subscriptions → Cutouts).
  room = new Room({
    // webAudioMix AN (stabil): LiveKit mischt alle Remote-Audios über UNSEREN AudioContext + GainNodes →
    // setVolume (Proximity/Deafen) wirkt zuverlässig, und wir hängen je Track Panner+Lowpass via
    // setWebAudioPlugins in die Kette (3D + Unterwasser), ohne LiveKits stabile Pipeline zu ersetzen.
    adaptiveStream: false, dynacast: false, webAudioMix: voiceCtx ? { audioContext: voiceCtx } : true,
    // 🎧 Bandbreite senken (Voice-Server-Fanout war ~5 Mbit/s/User → Jitter/„roboterhaft"):
    //  • red:false  — keine redundanten Audio-Kopien (halbiert die Audio-Bitrate; Paketverlust ist
    //                 ohnehin minimal, RED bringt hier kaum was).
    //  • dtx:true   — bei Stille wird nicht gesendet (spart nochmal viel).
    //  • speech-Preset (~20 kbps) statt Default → klare Sprache bei ~⅓–¼ der bisherigen Bandbreite.
    publishDefaults: { red: false, dtx: true, audioPreset: AudioPresets.speech },
    // AGC WIEDER AN (Hotfix v1.6.1): B-6 hatte Auto-Gain-Control ausgeschaltet → seit v1.6.0 waren
    // ALLE unfassbar leise (leise Mikros wurden nicht mehr angehoben) UND die „Sprecher in der Nähe"-
    // Anzeige blieb leer (LiveKit erkennt aktive Sprecher über den Audio-Pegel → zu leise = keine
    // Erkennung → #speakingBox bleibt versteckt). AGC an stellt beides wieder her. Der manuelle
    // Mic-Gain-Regler ist ein separater Web-Audio-GainNode auf dem gesendeten Track und wirkt
    // unabhaengig davon weiter. (Falls „Mikro wird ueber Zeit leiser" erneut auftritt: gezielter
    // ueber den Mic-Gain-Regler / Zielpegel loesen statt AGC global aus.)
    audioCaptureDefaults: { autoGainControl: true },
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
    .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind === Track.Kind.Audio) {
        // webAudioMix: LiveKit spielt über den gemeinsamen Context; Lautstärke/Deafen via setVolume.
        const a = track.attach(); a.autoplay = true;
        if (spkDeviceId && a.setSinkId) a.setSinkId(spkDeviceId).catch(() => {});
        document.body.appendChild(a);
        attachSpatialPlugins(track, participant && participant.identity); // Panner+Lowpass in die Kette (3D)
        updateProximityVolumes();
      }
    })
    .on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
      if (track.kind === Track.Kind.Audio) {
        if (participant) spatialPlugins.delete(participant.identity);
        track.detach().forEach((el) => el.remove());
        updateProximityVolumes();
      }
    });
  try {
    // autoSubscribe:false, wenn das Backend die Proximity-Subscriptions steuert (serverVoice) → der
    // Server abonniert je Hörer nur die In-Range-Nachbarn. Sonst (Prod/Flag AUS) wie bisher: alle abonnieren.
    await room.connect(url, token, { autoSubscribe: !serverVoice });
  } catch (e) {
    // Fehlversuch sauber zurückrollen, sonst bleibt ein toter Room hängen
    try { room.disconnect(); } catch {}
    room = null; voiceConnected = false;
    throw e;   // connectWithSession zeigt den Fehler-Toast
  }
  // LiveKit-Audio + unseren Mix-Context entsperren (Autoplay-Policy).
  try { await room.startAudio(); } catch {}
  try { if (voiceCtx && voiceCtx.state === 'suspended') await voiceCtx.resume(); } catch {}
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
  // webAudioMix: der Ton läuft über den AudioContext → Gerätewechsel MUSS auch dort ankommen. [BFT-287]
  try { if (voiceCtx && voiceCtx.setSinkId && id) voiceCtx.setSinkId(id).catch(() => {}); } catch {}
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
  { id: 'compassWrap', label: 'Kompass' },                      // Kompass-Balken oben, verschiebbar
  { id: 'minimapWrap', label: 'Minimap', resize: 'mini' },     // Part 3: verschiebbar + skalierbar
  { id: 'hudHeart',    label: 'Lebensanzeige', resize: 'scale' }, // Part 3b: Herz, verschiebbar + skalierbar
  { id: 'hudInfo',     label: 'Info-Boxen', resize: 'scale' }, // Part 4: entkoppelt verschiebbar + skalierbar
  // Timer-Anzeigen: Standard rechts neben der Punkte-Anzeige (HUD-Pille), verschiebbar + skalierbar.
  { id: 'growTimer',   label: 'Grow-Timer', resize: 'scale' },
  { id: 'eventPanel',  label: 'Event-Timer', resize: 'scale' },
  { id: 'distHud',     label: 'Wander-Distanz', resize: 'scale' },
  { id: 'goldenHud',   label: 'Goldene-Zone-Timer', resize: 'scale' },
  { id: 'parkWarn',    label: 'PvE-Park-Countdown', resize: 'scale' },
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

// Elemente im 'scale'-Modus behalten beim Verschieben ihren Skalier-Transform;
// zentrierte Panels werden dagegen „entzentriert" (transform: none).
const SCALE_IDS = new Set(MOVABLE.filter((m) => m.resize === 'scale').map((m) => m.id));
function movTransform(id) { return SCALE_IDS.has(id) ? 'scale(var(--info-scale,1))' : 'none'; }

// ── Timer-Anzeigen (Grow · Goldene Zone · PvE-Park) ─────────────────────────
// Standard-Layout: rechts neben der HUD-Pille (Punkte-Anzeige), vertikal gestapelt.
// Sobald der Spieler sie verschiebt, gewinnt die gespeicherte Position (bf-layout).
const TIMER_IDS = ['growTimer', 'eventPanel', 'distHud', 'goldenHud', 'parkWarn'];
function ensureTimerLayout(id) {
  const e = el(id), hud = el('hud');
  if (!e || !hud) return;
  const pos = loadPositions()[id];
  if (pos && pos.left) return;            // vom Spieler platziert → nichts überschreiben
  const r = hud.getBoundingClientRect();
  if (!r.width) return;                   // HUD-Pille noch nicht gerendert → später erneut
  const i = Math.max(0, TIMER_IDS.indexOf(id));
  // Breite erst messbar, wenn sichtbar (Aufruf erfolgt nach display:block); sonst Schätzwert.
  const w = e.offsetWidth || 220;
  e.style.left = Math.round(Math.max(8, Math.min(r.right + 12, window.innerWidth - w - 8))) + 'px';
  e.style.top = Math.round(r.top + i * 54) + 'px';
  e.style.right = 'auto'; e.style.bottom = 'auto';
  e.style.transform = 'scale(var(--info-scale,1))';   // entzentriert + sofort skalierbar
}
// innerHTML-Neuaufbau (goldenHud/parkWarn) wirft den Resize-Griff raus → im Edit-Modus neu anhängen.
function reattachEditHandle(id) {
  if (!editMode) return;
  const e = el(id), m = MOVABLE.find((x) => x.id === id);
  if (e && m && m.resize) addResizeHandle(e, id, m.resize);
}
// Im Edit-Modus die (evtl. inaktiven) Timer als Vorschau einblenden — sonst könnte man sie
// nur platzieren, während gerade ein Timer läuft. Sichtbarkeit erzwingt CSS (body.bf-edit).
function setTimerEditPreview(on) {
  for (const id of TIMER_IDS) ensureTimerLayout(id);
  if (!on) { renderGrowTimer(); updateGoldenHud(); updateParkWarn(); renderDistHud(); return; }  // echten Zustand zurück
  { const dh = el('distHud'); if (dh && !dh.innerHTML) dh.innerHTML = '<div class="dh-head">🐾 Wanderung</div><div class="dh-row"><span class="dh-cat">🏃 Laufen</span><span class="dh-val">1.20 km</span></div><div class="dh-row"><span class="dh-cat">🌊 Schwimmen</span><span class="dh-val">340 m</span></div>'; }
  const g = el('goldenHud');
  if (g && !golden) {
    g.className = 'gh-active';
    g.innerHTML = '⭐ Goldene Zone — noch <span class="gh-time">7:30</span> drin<div class="gh-bar"><div class="gh-fill" style="width:50%"></div></div>';
  }
  const p = el('parkWarn');
  if (p && !parkAt) {
    p.innerHTML = '🅿️ Dein Dino wird in <span class="pw-time">2:30</span> in der PvE-Zone eingeparkt — verlasse die Zone!<div class="pw-bar"><div class="pw-fill" style="width:50%"></div></div>';
  }
}

// ── Einzelne HUD-Elemente aus-/einblenden (im Edit-Mode) ────────────────────
// Dauer-sichtbare HUD-Cluster, die der Spieler wegblenden kann (Übersicht + Performance:
// weniger sichtbares HUD = kleinere Fläche fürs Idle-Window-Shrink). Persistiert in
// localStorage['bf-hidden-els']. Ausgeblendete Elemente bleiben im Edit-Mode gedimmt
// sichtbar (zum Wieder-Einblenden), erst außerhalb des Edit-Mode sind sie wirklich weg.
const HIDEABLE = [
  { id: 'hud',         label: 'Vitalanzeige' },
  { id: 'hudHeart',    label: 'Lebensanzeige' },
  { id: 'minimapWrap', label: 'Minimap' },
  { id: 'hudInfo',     label: 'Voice-Infos' },   // Mikrofon / Reichweite / Zone
  { id: 'eventPanel',  label: 'Aktive Events' },
  { id: 'distHud',     label: 'Wander-Distanz' },
  { id: 'growTimer',   label: 'Grow-Timer' },
  { id: 'goldenHud',   label: 'Goldene Zone' },
];

// Einheitliche HUD-Sichtbarkeits-Toggles im Settings→UI-Tab. Minimap/Kompass haben eigene
// Persistenz (miniHidden/compassHidden); der Rest läuft über das HIDEABLE-System (toggleHidden).
const HUD_TOGGLES_UI = [
  { id: 'minimapWrap', label: 'Minimap',       desc: 'Kleine Karte mit Spielern in deiner Nähe.',            hidden: () => miniHidden,                  toggle: toggleMinimap },
  { id: 'compassWrap', label: 'Kompass',       desc: 'Himmelsrichtungs-Leiste am oberen Rand.',              hidden: () => compassHidden,               toggle: toggleCompass },
  { id: 'eventPanel',  label: 'Aktive Events', desc: 'Laufende Server-Events mit Countdown.',                hidden: () => hiddenEls.has('eventPanel'), toggle: () => toggleHidden('eventPanel') },
  { id: 'distHud',     label: 'Wander-Distanz', desc: 'Plopt auf, wenn du Distanz sammelst — zeigt Lauf/Schwimm/Flug.', hidden: () => hiddenEls.has('distHud'), toggle: () => toggleHidden('distHud') },
  { id: 'hudHeart',    label: 'Lebensanzeige', desc: 'Dein Herz-/Lebens-Balken.',                            hidden: () => hiddenEls.has('hudHeart'),   toggle: () => toggleHidden('hudHeart') },
  { id: 'hudInfo',     label: 'Infoboxen',     desc: 'Status-Boxen (Sprechreichweite, Zone …).',            hidden: () => hiddenEls.has('hudInfo'),    toggle: () => toggleHidden('hudInfo') },
  { id: 'growTimer',   label: 'Grow-Timer',    desc: 'Fortschritt deines Dino-Wachstums.',                  hidden: () => hiddenEls.has('growTimer'),  toggle: () => toggleHidden('growTimer') },
  { id: 'goldenHud',   label: 'Goldene Zone',  desc: 'Anzeige der aktiven Goldenen Zone.',                   hidden: () => hiddenEls.has('goldenHud'),  toggle: () => toggleHidden('goldenHud') },
  { id: 'dialogTransp', label: 'Dialog-Transparenz', desc: 'Menü-Dialoge durchscheinend (aus = blickdicht).', hidden: () => !dialogTransparent,         toggle: toggleDialogTransparent },
];
function renderHudToggles() {
  const box = el('hudVisToggles'); if (!box) return;
  box.innerHTML = HUD_TOGGLES_UI.map((t) => {
    const on = !t.hidden();   // sichtbar = Switch AN
    return `<div class="bf-toggle-row"><div class="bf-tg-txt"><span class="bf-tg-lbl">${escapeHtml(t.label)}</span>`
      + `${t.desc ? `<span class="bf-tg-desc">${escapeHtml(t.desc)}</span>` : ''}</div>`
      + `<button class="bf-switch${on ? '' : ' secondary'}" data-hudvis="${t.id}" role="switch" aria-checked="${on}" aria-label="${escapeHtml(t.label)}"></button></div>`;
  }).join('');
  box.querySelectorAll('[data-hudvis]').forEach((b) => b.onclick = () => {
    const t = HUD_TOGGLES_UI.find((x) => x.id === b.dataset.hudvis); if (t) { t.toggle(); renderHudToggles(); }
  });
}
let hiddenEls = new Set();
try { hiddenEls = new Set(JSON.parse(localStorage.getItem('bf-hidden-els') || '[]')); } catch { hiddenEls = new Set(); }
function saveHiddenEls() { try { localStorage.setItem('bf-hidden-els', JSON.stringify([...hiddenEls])); } catch {} }
function applyHidden() {
  for (const h of HIDEABLE) {
    const hidden = hiddenEls.has(h.id);
    // Ausblenden nur außerhalb des Edit-Mode; im Edit-Mode bleibt es (gedimmt) sichtbar
    document.body.classList.toggle('bf-hide-' + h.id, hidden && !editMode);
    const e = el(h.id); if (!e) continue;
    e.classList.toggle('bf-ghost', hidden && editMode);
    const btn = e.querySelector('.bf-hide-toggle');
    if (btn) { btn.textContent = hidden ? '🚫' : '👁'; btn.title = hidden ? 'Wieder einblenden' : 'Ausblenden'; }
  }
}
function toggleHidden(id) {
  if (hiddenEls.has(id)) hiddenEls.delete(id); else hiddenEls.add(id);
  saveHiddenEls();
  applyHidden();
  syncLightningFrames();   // Blitz-Rahmen an geänderte Sichtbarkeit anpassen
  updateWindowBounds();    // weniger/mehr sichtbares HUD → Shrink-Höhe neu berechnen
}
function addHideToggle(elm, id) {
  if (elm.querySelector('.bf-hide-toggle')) return;
  const b = document.createElement('div');
  b.className = 'bf-hide-toggle';
  const hidden = hiddenEls.has(id);
  b.textContent = hidden ? '🚫' : '👁';
  b.title = hidden ? 'Wieder einblenden' : 'Ausblenden';
  b.addEventListener('mousedown', (e) => { if (!editMode) return; e.preventDefault(); e.stopPropagation(); toggleHidden(id); });
  elm.appendChild(b);
}
function removeHideToggle(elm) { const b = elm.querySelector('.bf-hide-toggle'); if (b) b.remove(); }

// ── Idle-Window-Shrink (Performance-Setting, experimentell) ─────────────────
// Meldet dem Main-Prozess die gewünschte Overlay-Fenstergröße. Im Idle (Dock/Panel zu)
// schrumpft das Fenster auf die HÖHE der sichtbaren, oben verankerten HUD-Elemente (volle
// Breite, Ursprung oben links) → über dem großen unteren Spielbereich liegt kein Overlay-
// Fenster mehr → Windows kann dem Spiel eher den schnellen Vollbild-Pfad zurückgeben (FPS).
// Bei offenem Dock/Panel wieder Vollbild. Default AUS (Wirkung ist GPU-/treiberabhängig).
let windowShrink = localStorage.getItem('bf-window-shrink') === '1';
let shrinkTimer = null;
let lastSentH = -1;   // zuletzt gesendete Höhe (0 = Vollbild) — vermeidet redundante Resizes
const IDLE_HUD_IDS = ['hud', 'hudHeart', 'minimapWrap', 'hudInfo', 'growTimer', 'eventPanel', 'serverBanner', 'toasts', 'voiceWarn', 'updateHint', 'calibPrompt', 'parkWarn', 'goldenHud'];
function computeIdleHudBottom() {
  let bottom = 0;
  for (const id of IDLE_HUD_IDS) {
    const e = el(id); if (!e) continue;
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') === 0) continue;
    const r = e.getBoundingClientRect();
    if (r.height <= 0 || r.bottom <= 0) continue;
    if (r.bottom > bottom) bottom = r.bottom;
  }
  return bottom;
}
function updateWindowBounds() {
  if (!window.bf || !window.bf.setOverlayBounds) return;
  if (shrinkTimer) { clearTimeout(shrinkTimer); shrinkTimer = null; }
  const interactive = overlayMode || settingsOpen || mapOpen || adminOpen || !!featureOpen || editMode;
  if (!windowShrink || interactive || dutyOn) { // dutyOn → Vollbild halten, damit der Rand-Glow rundum passt
    if (lastSentH !== 0) { lastSentH = 0; window.bf.setOverlayBounds({ full: true }); }   // Vollbild (sofort)
    return;
  }
  // Erst nach kurzer Idle-Ruhe schrumpfen → kein Thrashing beim schnellen Dock-Toggeln,
  // und Panel-Schließen findet noch das Vollbild-Fenster (kein Umbruch-Flackern).
  shrinkTimer = setTimeout(() => {
    shrinkTimer = null;
    const h = Math.max(120, Math.min(window.screen.height, Math.ceil(computeIdleHudBottom()) + 24));
    if (Math.abs(h - lastSentH) >= 2) { lastSentH = h; window.bf.setOverlayBounds({ height: h }); }
  }, 300);
}
function updateShrinkBtn() { const b = el('shrinkToggleBtn'); if (b) b.classList.toggle('secondary', !windowShrink); }

// ── Bug melden (Overlay → Backend → Dev-Board) ──────────────────────────────
// Button unten links (nur bei offenem Dock). Titel + Beschreibung + optionaler Screenshot
// (Bild, keine Clips). Fail-Safe bleibt der Discord-Melde-Button im Dev-Board.
let bugImageBlob = null;
function openBugModal() { const m = el('bugModal'); if (m) m.classList.add('open'); }
function closeBugModal() {
  const m = el('bugModal'); if (m) m.classList.remove('open');
  bugImageBlob = null;
  const s = el('bugShot'); if (s) { s.style.display = 'none'; if (s.src.startsWith('blob:')) URL.revokeObjectURL(s.src); s.src = ''; }
  if (el('bugTitle')) el('bugTitle').value = '';
  if (el('bugBody')) el('bugBody').value = '';
}
function setBugShot(blob) {
  bugImageBlob = blob;
  const s = el('bugShot'); if (!s) return;
  if (s.src.startsWith('blob:')) URL.revokeObjectURL(s.src);
  s.src = URL.createObjectURL(blob); s.style.display = 'block';
}
async function bugTakeScreenshot() {
  try {
    const dataUrl = await window.bf.captureScreen();
    if (!dataUrl) { showToast('Screenshot fehlgeschlagen', 'error'); return; }
    setBugShot(await (await fetch(dataUrl)).blob());
  } catch { showToast('Screenshot fehlgeschlagen', 'error'); }
}
async function submitBugReport() {
  const title = (el('bugTitle')?.value || '').trim();
  const body = (el('bugBody')?.value || '').trim();
  if (!title) { showToast('Bitte einen kurzen Titel angeben', 'error'); return; }
  const fd = new FormData();
  fd.append('title', title); fd.append('body', body);
  if (bugImageBlob) fd.append('image', bugImageBlob, 'screenshot.png');
  const btn = el('bugSubmit'); if (btn) btn.disabled = true;
  try {
    const res = await fetch(`${config.tokenBase}/me/bugreport`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` }, body: fd });
    if (!res.ok) throw new Error('Fehler ' + res.status);
    showToast('🐛 Bug gemeldet — danke!', 'success');
    closeBugModal();
  } catch (e) { showToast('Melden fehlgeschlagen: ' + e.message, 'error'); }
  finally { if (btn) btn.disabled = false; }
}
function setupBugReport() {
  const on = (id, fn, ev = 'onclick') => { const e = el(id); if (e) e[ev] = fn; };
  on('bugReportBtn', openBugModal);
  on('bugCancel', closeBugModal);
  on('bugSubmit', submitBugReport);
  on('bugShotBtn', bugTakeScreenshot);
  on('bugFileBtn', () => el('bugFile')?.click());
  on('bugFile', (e) => { const f = e.target.files && e.target.files[0]; if (f) setBugShot(f); }, 'onchange');
}
function toggleWindowShrink() {
  windowShrink = !windowShrink;
  localStorage.setItem('bf-window-shrink', windowShrink ? '1' : '0');
  updateShrinkBtn();
  updateWindowBounds();
}
function applySavedPositions() {
  const p = loadPositions();
  for (const m of MOVABLE) {
    const e = el(m.id), pos = p[m.id]; if (!e || !pos) continue;
    if (pos.scale) e.style.setProperty('--info-scale', pos.scale);        // Info-Boxen-Skalierung (vor transform setzen)
    if (pos.left) {
      e.style.left = pos.left; e.style.top = pos.top; e.style.right = 'auto'; e.style.bottom = 'auto';
      e.style.transform = movTransform(m.id);
    }
    if (pos.zoom) e.style.zoom = pos.zoom;                                 // Panel-Skalierung (Layout + Text)
    if (!pos.zoom && pos.width) e.style.width = pos.width;
    if (!pos.zoom && pos.height) { e.style.height = pos.height; e.style.maxHeight = 'none'; }
    if (pos.miniSize) e.style.setProperty('--mini-size', pos.miniSize);   // Minimap-Größe
  }
}
function resetPositions() {
  localStorage.removeItem('bf-layout');
  for (const m of MOVABLE) {
    const e = el(m.id); if (!e) continue;
    e.style.left = ''; e.style.top = ''; e.style.right = ''; e.style.bottom = ''; e.style.transform = '';
    e.style.width = ''; e.style.height = ''; e.style.maxHeight = ''; e.style.zoom = '';
    e.style.removeProperty('--mini-size');
    e.style.removeProperty('--info-scale');
  }
  for (const id of TIMER_IDS) ensureTimerLayout(id);   // Timer zurück neben die Punkte-Anzeige
  hiddenEls.clear(); saveHiddenEls(); applyHidden();   // ausgeblendete HUD-Elemente wieder einblenden
  refreshEditAffordances();                            // Auge-Buttons/Ghost-Zustand auffrischen
  showToast('Layout zurückgesetzt', 'success');
}
function setEditMode(on) {
  editMode = on;
  document.body.classList.toggle('bf-edit', on);
  setTimerEditPreview(on);   // Timer im Edit-Modus als Vorschau zeigen (sonst nicht platzierbar)
  if (!on) {
    // Edit-Mode aus → alle Bearbeitungs-Griffe entfernen
    for (const m of MOVABLE) {
      const e = el(m.id); if (!e) continue;
      e.classList.remove('bf-movable');
      removeResizeHandle(e);
    }
    for (const h of HIDEABLE) { const e = el(h.id); if (e) { removeHideToggle(e); e.classList.remove('bf-ghost'); } }
  }
  applyHidden();   // Edit an → Ghosts sichtbar; Edit aus → als ausgeblendet markierte Cluster wirklich verstecken
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
  // Ausblenden-Umschalter an die dauer-sichtbaren HUD-Cluster (auch die, die nicht verschiebbar sind, z. B. HUD-Pille)
  for (const h of HIDEABLE) {
    const e = el(h.id); if (!e) continue;
    const shown = getComputedStyle(e).display !== 'none' || hiddenEls.has(h.id);
    if (shown) addHideToggle(e, h.id); else removeHideToggle(e);
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
    elm.style.transform = movTransform(id);
    syncLightningFrames();   // Blitz-Rahmen mitziehen
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; elm.classList.remove('dragging');
    const p = loadPositions();
    p[id] = { ...(p[id] || {}), left: elm.style.left, top: elm.style.top };
    savePositions(p);
    updateWindowBounds();   // verschobenes HUD → Shrink-Höhe neu berechnen
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
      // Panel skalieren statt nur die Box zu vergrößern → Text & Anzeigen wachsen mit (CSS zoom).
      const d = Math.max(ev.clientX - sx, ev.clientY - sy);
      elm.style.zoom = Math.max(0.6, Math.min(2.2, ss + d / 300)).toFixed(3);
      elm.style.width = ''; elm.style.height = ''; elm.style.maxHeight = '';
    }
    syncLightningFrames();   // Blitz-Rahmen mitskalieren
  };
  const up = () => {
    if (!rz) return; rz = false;
    window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
    const p = loadPositions();
    if (mode === 'mini') p[id] = { ...(p[id] || {}), miniSize: elm.style.getPropertyValue('--mini-size') };
    else if (mode === 'scale') p[id] = { ...(p[id] || {}), scale: elm.style.getPropertyValue('--info-scale') };
    else { const np = { ...(p[id] || {}), zoom: elm.style.zoom }; delete np.width; delete np.height; p[id] = np; }
    savePositions(p);
    updateWindowBounds();   // skaliertes HUD → Shrink-Höhe neu berechnen
  };
  h.addEventListener('mousedown', (e) => {
    if (!editMode) return;
    e.preventDefault(); e.stopPropagation();
    rz = true; const r = elm.getBoundingClientRect(); sx = e.clientX; sy = e.clientY; sw = r.width; sh = r.height;
    if (mode === 'mini') ss = parseInt(getComputedStyle(elm).getPropertyValue('--mini-size')) || el('minimap')?.getBoundingClientRect().width || r.width;
    else if (mode === 'scale') ss = parseFloat(getComputedStyle(elm).getPropertyValue('--info-scale')) || 1;
    else ss = parseFloat(getComputedStyle(elm).zoom) || 1;
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
  applyHidden();   // gespeicherte Ausblendungen beim Start anwenden
  el('editModeBtn').onclick = () => { setEditMode(true); toggleSettings(false); };
  el('editDoneBtn').onclick = () => { toggleSettings(true); setEditMode(false); };   // „Fertig" → zurück in die Einstellungen (Settings zuerst → kein Dock-Flackern)
  el('editResetBtn').onclick = () => resetPositions();
  const fxBtn = el('fxToggleBtn'); if (fxBtn) fxBtn.onclick = toggleFx;
  applyFx();
  const miniBtn = el('miniToggleBtn'); if (miniBtn) miniBtn.onclick = toggleMinimap;
  const compassBtn = el('compassToggleBtn'); if (compassBtn) compassBtn.onclick = toggleCompass;
  const blurBtn = el('blurToggleBtn'); if (blurBtn) blurBtn.onclick = toggleBlur;
  applyBlur();
  applyDialogTransparency();
  const lsBtn = el('lowSpecBtn'); if (lsBtn) lsBtn.onclick = toggleLowSpec;
  updateLowSpecBtn();
  const shBtn = el('shrinkToggleBtn'); if (shBtn) shBtn.onclick = toggleWindowShrink;
  updateShrinkBtn();
  const raBtn = el('mapAttribution'); if (raBtn) raBtn.onclick = () => { try { window.bf.openExternal('https://raidatlas.app/'); } catch {} };  // RaidAtlas-Disclaimer
  setupBugReport();
  updateWindowBounds();                        // Anfangszustand ans Fenster melden
  setInterval(updateWindowBounds, 1500);       // transiente HUD-Änderungen (Toasts/Banner) nachziehen
  loadActiveEvents(); setInterval(loadActiveEvents, 15000); // Event-Timer: Liste holen + Countdown auffrischen
  applyMiniToggle();
  applyCompassToggle();
  renderThemePicker();
  syncLightningFrames();   // Minimap-Blitzrahmen direkt anzeigen
}

init().then(() => setupEditMode());
