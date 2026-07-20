// BlackFossil Companion — Renderer.
//
// Laeuft OHNE Spiel und ohne eigenen Dino: es gibt kein `isYou` in /positions,
// keine Vitals, keine Voice. Alles hier ist rein backend-getrieben.
import { el, makeApi } from './shared/core.js';
import { decoratePositions, buildUserDir } from './shared/players.js';
import { usersFrom } from './shared/users.js';
import { makePerms, can } from './shared/perms.js';
import { openPlayerList, closePlayerList, isPlayerListOpen } from './companion/playerlist.js';
import {
  loadMapImage, drawFullMap, drawHeatmap, drawAiEncounters, setZones, setCalAffine,
  ZONE_LAYERS, ZONE_META, setZoneLayer, isZoneLayerVisible,
} from './map.js';
import { baseClass, escapeHtml } from './shared/format.js';
import { initServer, renderServer, stopServer } from './companion/panels/server.js';
import { initAdmin, renderAdmin } from './companion/panels/admin.js';
import { initTeam, renderTeam } from './companion/panels/team.js';
import { initSupport, renderSupport, stopSupport } from './companion/panels/support.js';
import { initLexikon, renderLexikon } from './companion/panels/lexikon.js';

let config = { tokenBase: '' };
let sessionToken = null;
let perms = makePerms({});

// ── Beta-Riegel ────────────────────────────────────────────────────────────
// Die App ist so gebaut, dass auch normale Spieler sie oeffnen koennen: die
// Navigation filtert ueber Faehigkeiten (shared/perms.js), und spielerbezogene
// Ansichten haengen an `online`. Fuer die Beta bleibt sie dennoch dem Team
// vorbehalten.
//
// ZUM OEFFNEN FUER ALLE: diese eine Konstante auf false setzen. Sonst nichts —
// die Rechte-Logik darunter ist bereits vollstaendig.
const BETA_STAFF_ONLY = true;

const api = makeApi({ tokenBase: () => config.tokenBase, token: () => sessionToken });

// ── Toasts ─────────────────────────────────────────────────────────────────
function toast(msg, kind = '') {
  const box = el('cpToasts'); if (!box) return;
  const d = document.createElement('div');
  d.className = 'cp-toast' + (kind ? ' cp-toast-' + kind : '');
  d.textContent = msg;
  box.appendChild(d);
  setTimeout(() => d.remove(), 4200);
}

// ── Karte ──────────────────────────────────────────────────────────────────
let players = [];
let userDir = new Map();
let zoom = 1, panX = 0, panY = 0;
let teleports = [];
let encounters = [];
let showTp = localStorage.getItem('bf-cp-tp') !== '0';
let showAi = localStorage.getItem('bf-cp-ai') !== '0';
let showHeat = localStorage.getItem('bf-cp-heat') === '1';
const MAX_ZOOM = 10;

// Die Canvas fuellt den verfuegbaren Bereich; das Kartenbild ist quadratisch.
// baseScale bildet die 1000x1000-Karte so ab, dass sie den Bereich VOLLSTAENDIG
// bedeckt (cover, nicht contain) — sonst blieben bei einem breiten Fenster
// links und rechts tote Balken. Was ueber den Rand laeuft, erreicht man per Pan.
const MAP_SIZE = 1000;
let cw = MAP_SIZE, ch = MAP_SIZE;   // Canvas-Groesse in CSS-Pixeln
function baseScale() { return Math.max(cw / MAP_SIZE, ch / MAP_SIZE); }
function totalScale() { return baseScale() * zoom; }
let dirty = true;             // Dirty-Flag: neu zeichnen nur bei Poll oder Pan/Zoom
// Aus der localStorage wiederhergestellt, aber nach dem Login gegen die Rechte
// geprueft — sonst behielte ein herabgestufter Staff seine Overwatch-Ansicht.
let showAll = localStorage.getItem('bf-cp-showall') === '1';
let labelMinZoom = Number(localStorage.getItem('bf-cp-labelzoom') || 1.6);
let lastStat = { total: 0, drawn: 0, belowZoom: false };
let hits = [];                    // Cluster aus dem letzten Zeichnen (Karten-Koordinaten)
let highlight = new Set();        // hervorgehobene SteamIDs (Spielerliste)
let plList = null;                // offene Spielerliste (zum Nachziehen beim Poll)

function render() {
  const cv = el('cpMapCanvas');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const sc = totalScale();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  // DPR zuerst, dann Karten-Transform — so bleibt alles in CSS-Pixeln gerechnet
  // und die Karte ist auf HiDPI-Schirmen trotzdem scharf.
  ctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * panX, dpr * panY);

  const view = {
    x0: -panX / sc, y0: -panY / sc,
    x1: (cw - panX) / sc, y1: (ch - panY) / sc,
  };

  // Heatmap ersetzt die Einzeldarstellung: sie zeigt nur Ansammlungen (ab 4
  // Dinos) und keine exakten Positionen — dafuer gaebe es sonst zwei
  // widerspruechliche Ebenen uebereinander. Kein `me`, die Companion hat
  // keinen eigenen Dino.
  if (showHeat) {
    drawHeatmap({ ctx, w: MAP_SIZE, h: MAP_SIZE }, players, null);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    lastStat = { total: 0, drawn: 0, belowZoom: false, heat: true };
    updateMapStat();
    return;
  }

  drawFullMap({ ctx, w: MAP_SIZE, h: MAP_SIZE }, players, [], showTp ? teleports : [], null, 1 / sc, {
    showAll,
    zoom,
    labelMinZoom,
    maxLabels: 60,
    centerX: (view.x0 + view.x1) / 2,
    centerY: (view.y0 + view.y1) / 2,
    viewX0: view.x0, viewY0: view.y0, viewX1: view.x1, viewY1: view.y1,
    highlight,
    onLabelStats: (s) => { lastStat = s; },
    onHits: (h) => { hits = h; },
  });
  if (showAi && encounters.length) drawAiEncounters(ctx, MAP_SIZE, MAP_SIZE, 1 / sc, encounters, baseClass);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  updateMapStat();
}

// Canvas an den Container anpassen (CSS-Pixel + DPR fuer scharfe Darstellung).
function resizeCanvas() {
  const cv = el('cpMapCanvas'), wrap = el('cpMapWrap');
  if (!cv || !wrap) return;
  const r = wrap.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return;
  const dpr = window.devicePixelRatio || 1;
  cw = r.width; ch = r.height;
  cv.width = Math.round(cw * dpr);
  cv.height = Math.round(ch * dpr);
  cv.style.width = cw + 'px';
  cv.style.height = ch + 'px';
  clampPan();
  dirty = true;
}

function updateMapStat() {
  const s = el('cpMapStat');
  if (!s) return;
  const alive = players.filter((p) => !p.isDead).length;
  if (showHeat) { s.textContent = `${alive} online · Heatmap (nur Ansammlungen ab 4)`; return; }
  if (!showAll) { s.textContent = `${alive} online`; return; }
  s.textContent = lastStat.belowZoom
    ? `${alive} online · Namen ab ${labelMinZoom.toFixed(1)}× Zoom`
    : `${alive} online · ${lastStat.drawn}/${lastStat.total} Namen`;
}

function frame() {
  if (dirty) { dirty = false; render(); }
  requestAnimationFrame(frame);
}

// 1 s statt der 100 ms des Overlays: dort haengt Proximity-Voice und die
// Minimap-Interpolation daran, hier nicht. Fuer eine Staff-Karte ist
// Sub-Sekunden-Frische wertlos — das spart 10x Netz und CPU.
async function pollPositions() {
  try {
    const d = await api('GET', '/positions');
    players = decoratePositions(d.players || [], userDir);
    // Spieler-Ansichten haengen daran, ob der eigene Dino gerade auf dem Server
    // ist. Aendert sich das, muss die Navigation nachziehen.
    const online = players.some((p) => p.isYou) || !!(d.you && d.you.steamId);
    if (online !== perms.online) { perms.online = online; applyNavPermissions(); }
    // Die offene Spielerliste lebt von denselben Daten.
    if (plList && isPlayerListOpen()) plList.refresh();
    dirty = true;
  } catch (err) {
    const s = el('cpMapStat');
    if (s) s.textContent = 'Positionen nicht abrufbar: ' + err.message;
  }
}

async function loadUserDir() {
  try { userDir = buildUserDir(usersFrom(await api('GET', '/admin/users'))); }
  catch { /* Karte bleibt nutzbar, nur ohne Discord-Namen im Tag */ }
}

async function loadCalibration() {
  // Die global geteilte Kalibrierung kommt vom Server und gilt fuer Overlay UND
  // Companion — hier ist nichts eigenes zu kalibrieren.
  //
  // ACHTUNG: Die Antwort ist { by, affine: {a..f} } — die Matrix liegt
  // VERSCHACHTELT. Ein Check auf c.a laeuft still ins Leere und die Karte
  // bleibt auf den Defaults stehen (Marker sichtbar verschoben). Genau das war
  // hier der Fall; das Overlay prueft korrekt auf data.affine.a.
  try {
    const c = await api('GET', '/calibration');
    if (c && c.affine && typeof c.affine.a === 'number') setCalAffine(c.affine);
  } catch { /* Default-Kalibrierung */ }
}

async function loadZones() {
  try { setZones(await api('GET', '/zones')); } catch { /* Karte ohne Zonen */ }
  dirty = true;
}

async function loadTeleports() {
  try { const d = await api('GET', '/teleports'); teleports = d.teleports || d || []; dirty = true; }
  catch { /* Teleports optional */ }
}

async function loadEncounters() {
  // Staff-gated und statische Konfiguration — einmal beim Start reicht.
  try { const d = await api('GET', '/ai/encounters'); encounters = d.encounters || d || []; dirty = true; }
  catch { /* Encounter optional */ }
}

// ── Karten-Interaktion ─────────────────────────────────────────────────────
function initMapInteraction() {
  const cv = el('cpMapCanvas');
  let dragging = false, lastX = 0, lastY = 0;

  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    // Um den Cursor zoomen, nicht um die Ecke — sonst verliert man beim
    // Reinzoomen sofort die Stelle, die man ansehen wollte.
    const r = cv.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;   // CSS-Pixel
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const nz = Math.min(MAX_ZOOM, Math.max(1, zoom * f));
    if (nz === zoom) return;
    const k = nz / zoom;
    panX = cx - (cx - panX) * k;
    panY = cy - (cy - panY) * k;
    zoom = nz;
    clampPan();
    dirty = true;
  }, { passive: false });

  cv.addEventListener('mousedown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; hideTip(); });
  cv.addEventListener('mouseleave', hideTip);
  cv.addEventListener('mousemove', (e) => {
    if (dragging) return;
    const r = cv.getBoundingClientRect();
    const c = hitAt(e.clientX - r.left, e.clientY - r.top);
    if (c) showTip(c, e.clientX - r.left, e.clientY - r.top); else hideTip();
  });
  window.addEventListener('mouseup', () => { dragging = false; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    panX += e.clientX - lastX;
    panY += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    clampPan();
    dirty = true;
  });
}

// Pan begrenzen — aber mit Spielraum ueber den Rand hinaus, damit sich auch die
// Kartenkante mittig legen laesst. Der dabei entstehende leere Bereich ist
// gewollt; ohne den Spielraum klebt der Rand immer am Fensterrand.
const PAN_MARGIN = 0.45;   // Anteil der Ansichtsgroesse, den man ueberziehen darf
function clampPan() {
  const sc = totalScale();
  const mapW = MAP_SIZE * sc, mapH = MAP_SIZE * sc;
  const mx = cw * PAN_MARGIN, my = ch * PAN_MARGIN;
  panX = Math.min(mx, Math.max(cw - mapW - mx, panX));
  panY = Math.min(my, Math.max(ch - mapH - my, panY));
}

// Karten- -> Bildschirmkoordinaten (CSS-Pixel im Wrapper)
function toScreen(mx, my) {
  const sc = totalScale();
  return { x: mx * sc + panX, y: my * sc + panY };
}

function hitAt(sx, sy) {
  const sc = totalScale();
  let best = null, bestD = Infinity;
  for (const c of hits) {
    const s0 = toScreen(c.px, c.py);
    const d = Math.hypot(s0.x - sx, s0.y - sy);
    // Trefferradius mindestens 12 px, damit auch einzelne Punkte gut zu treffen sind
    const r = Math.max(12, (c.items.length > 1 ? 13 : 7) * 1 + 4);
    if (d <= r && d < bestD) { best = c; bestD = d; }
  }
  return best;
}

function showTip(c, sx, sy) {
  const tip = el('cpMapTip');
  if (!tip) return;
  const names = c.items.map((it) => it.p.label1 || it.p.name || it.p.steamId);
  const sub = c.items.length === 1 ? (c.items[0].p.label2 || '') : `${c.items.length} Spieler`;
  tip.innerHTML = `<div class="cp-tip-head">${escapeHtml(sub)}</div>`
    + names.slice(0, 20).map((n) => `<div class="cp-tip-row">${escapeHtml(n)}</div>`).join('')
    + (names.length > 20 ? `<div class="cp-tip-more">und ${names.length - 20} weitere…</div>` : '');
  tip.hidden = false;
  // Am Rand nach innen kippen, damit der Tooltip nicht aus dem Fenster laeuft
  const r = tip.getBoundingClientRect();
  const wrap = el('cpMapWrap').getBoundingClientRect();
  let x = sx + 14, y = sy + 14;
  if (x + r.width > wrap.width) x = sx - r.width - 14;
  if (y + r.height > wrap.height) y = sy - r.height - 14;
  tip.style.left = Math.max(4, x) + 'px';
  tip.style.top = Math.max(4, y) + 'px';
}

function hideTip() { const t = el('cpMapTip'); if (t) t.hidden = true; }

// Auf einen Spieler zentrieren (Alt-Klick in der Spielerliste).
function centerOnPlayer(steamId) {
  const p = players.find((x) => x.steamId === steamId);
  if (!p) return;
  const c = hits.find((h) => h.items.some((it) => it.p.steamId === steamId));
  const mx = c ? c.px : null;
  if (mx === null) return;
  const sc = totalScale();
  panX = cw / 2 - c.px * sc;
  panY = ch / 2 - c.py * sc;
  clampPan();
  dirty = true;
}

function resetView() {
  zoom = 1;
  // Bei cover ist eine Achse groesser als der Bereich — mittig ausrichten.
  const sc = totalScale();
  panX = (cw - MAP_SIZE * sc) / 2;
  panY = (ch - MAP_SIZE * sc) / 2;
  dirty = true;
}

// ── Panels ─────────────────────────────────────────────────────────────────
// Ein ctx statt globaler Zugriffe: die Panels kennen weder window.bf noch den
// Session-Token. Was sie brauchen, steht hier — und nur das.
let currentView = 'map';
const panelCtx = {
  api,
  toast,
  perms: () => perms,
  can: (c) => can(perms, c),
  players: () => players,
  isActive: (v) => currentView === v,
};
const PANELS = {
  team: renderTeam,
  admin: renderAdmin,
  server: renderServer,
  support: renderSupport,
  lexikon: renderLexikon,
};

// Sichtbarkeit der Navigationspunkte. `cap` ist die schwaechste Faehigkeit, die
// im Panel ueberhaupt etwas zeigt — die Feinheiten (einzelne Tabs, Buttons)
// entscheiden die Panels selbst ueber dieselbe can()-Pruefung.
// `needsOnline` markiert Ansichten, die ohne eigenen Dino auf dem Server leer
// waeren; Staff-Werkzeuge haengen bewusst NICHT daran.
const NAV = {
  map:      { cap: null,            needsOnline: false },
  team:     { cap: 'team.users',    needsOnline: false },
  admin:    { cap: 'world.read',    needsOnline: false },
  server:   { cap: 'server.status', needsOnline: false },
  support:  { cap: 'support.read',  needsOnline: false },
  lexikon:  { cap: null,            needsOnline: false },
  settings: { cap: null,            needsOnline: false },
};

function applyNavPermissions() {
  for (const [view, def] of Object.entries(NAV)) {
    const btn = document.querySelector(`.cp-nav-btn[data-view="${view}"]`);
    if (!btn) continue;
    const allowed = (!def.cap || can(perms, def.cap)) && (!def.needsOnline || perms.online);
    btn.hidden = !allowed;
  }
}

// ── Legende & Layer ────────────────────────────────────────────────────────
// Zonen-Sichtbarkeit lebt in map.js (ZONE_LAYERS), damit Karte und Legende nicht
// auseinanderlaufen. Hier steht nur die Bedienung — der Zustand wird zusaetzlich
// in der localStorage gehalten, damit er einen Neustart ueberlebt.
function renderLegend() {
  const box = el('cpLegend');
  if (!box) return;
  // Toggle-Buttons statt Checkboxen: aria-pressed traegt den Zustand, die Optik
  // kommt aus .cp-tgl. Ein Button reagiert auf die ganze Flaeche, nicht nur auf
  // ein 13px-Kaestchen — auf einer Karte, die man nebenbei bedient, zaehlt das.
  const tgl = (attr, key, swatch, label, on, disabled) =>
    `<button type="button" class="cp-tgl" ${attr}="${key}" aria-pressed="${on ? 'true' : 'false'}"${disabled ? ' disabled' : ''}>`
    + `<span class="cp-leg-swatch" style="${swatch}"></span><span>${label}</span></button>`;

  const zones = Object.keys(ZONE_LAYERS).map((k) => {
    const meta = ZONE_META[k] || {};
    return tgl('data-zone', k, `background:${meta.color || '#888'}`, meta.label || k, isZoneLayerVisible(k), false);
  }).join('');

  box.innerHTML = `<div class="cp-leg-title">Zonen</div><div class="cp-leg-grid">${zones}</div>`
    + `<div class="cp-leg-title" style="margin-top:var(--cp-s3)">Marker</div><div class="cp-leg-grid">`
    + tgl('data-marker', 'tp', '', 'Teleports', showTp, showHeat)
    + (can(perms, 'map.encounters') ? tgl('data-marker', 'ai', '', 'KI-Encounter', showAi, showHeat) : '')
    + (can(perms, 'map.showAll') ? tgl('data-marker', 'players', '', 'Spieler', showAll, showHeat) : '')
    + (can(perms, 'map.showAll') ? tgl('data-marker', 'heat', '', 'Heatmap', showHeat, false) : '')
    + `</div>`;
  // Marker-Farbtupfer per Klasse (die Zonen tragen ihre Farbe inline)
  for (const [k, cls] of [['tp', 'cp-leg-tp'], ['ai', 'cp-leg-ai'], ['players', 'cp-leg-player'], ['heat', 'cp-leg-heat']]) {
    const sw = box.querySelector(`[data-marker="${k}"] .cp-leg-swatch`);
    if (sw) sw.classList.add(cls);
  }

  const press = (btn, on) => btn.setAttribute('aria-pressed', on ? 'true' : 'false');

  box.querySelectorAll('[data-zone]').forEach((b) => {
    b.onclick = () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      press(b, on);
      setZoneLayer(b.dataset.zone, on);
      localStorage.setItem('bf-cp-zone-' + b.dataset.zone, on ? '1' : '0');
      dirty = true;
    };
  });
  box.querySelectorAll('[data-marker]').forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.marker;
      const on = b.getAttribute('aria-pressed') !== 'true';
      press(b, on);
      if (k === 'tp') { showTp = on; localStorage.setItem('bf-cp-tp', on ? '1' : '0'); }
      else if (k === 'ai') { showAi = on; localStorage.setItem('bf-cp-ai', on ? '1' : '0'); }
      else if (k === 'heat') {
        showHeat = on;
        localStorage.setItem('bf-cp-heat', on ? '1' : '0');
        // Die uebrigen Marker sind im Heatmap-Modus wirkungslos — sperren,
        // statt sie anklickbar zu lassen und nichts zu tun.
        renderLegend();
      }
      else { showAll = on; localStorage.setItem('bf-cp-showall', on ? '1' : '0'); }
      dirty = true;
    };
  });
}

// Gespeicherte Layer-Zustaende beim Start in map.js zurueckspielen.
function restoreZonePrefs() {
  for (const k of Object.keys(ZONE_LAYERS)) {
    const v = localStorage.getItem('bf-cp-zone-' + k);
    if (v !== null) setZoneLayer(k, v === '1');
  }
}

// ── Navigation ─────────────────────────────────────────────────────────────
function navTo(view) {
  // Polls haengen am offenen Panel — beim Wegnavigieren abstellen.
  if (view !== 'server') stopServer();
  if (view !== 'support') stopSupport();
  currentView = view;
  document.querySelectorAll('.cp-nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.cp-view').forEach((s) => { s.hidden = s.dataset.view !== view; });
  if (view === 'map') dirty = true;
  const render = PANELS[view];
  if (render) {
    try { render(document.querySelector(`.cp-view[data-view="${view}"]`)); }
    catch (err) { toast('Panel-Fehler: ' + err.message, 'error'); }
  }
  localStorage.setItem('bf-cp-view', view);
}

// ── Start ──────────────────────────────────────────────────────────────────
function showGate(msg, withLogin) {
  el('cpApp').hidden = true;
  el('cpGate').hidden = false;
  el('cpGateMsg').textContent = msg;
  el('cpGateBtn').hidden = !withLogin;
}

async function boot() {
  config = await window.bf.getConfig();
  sessionToken = await window.bf.getSession();
  el('cpGateBtn').onclick = () => window.bf.openLogin();
  window.bf.onSessionChanged(() => location.reload());
  window.bf.onLoginError((m) => showGate(m, true));

  if (!sessionToken) { showGate('Bitte mit Discord anmelden.', true); return; }

  let t;
  try { t = await api('GET', '/token'); }
  catch (err) { showGate('Anmeldung abgelaufen oder Backend nicht erreichbar: ' + err.message, true); return; }

  perms = makePerms(t);

  if (BETA_STAFF_ONLY && !perms.staff) {
    showGate('Die Companion-App ist noch in der Beta und derzeit dem Team vorbehalten. '
      + 'Schau später wieder vorbei — sie kommt für alle.', false);
    return;
  }

  el('cpGate').hidden = true;
  el('cpApp').hidden = false;
  el('cpWhoName').textContent = perms.name;
  el('cpWhoRank').textContent = perms.rank;
  el('cpSetWho').textContent = perms.name;
  el('cpSetRank').textContent = perms.rank;
  initTeam(panelCtx); initAdmin(panelCtx); initServer(panelCtx);
  initSupport(panelCtx); initLexikon(panelCtx);
  window.bf.getVersion().then((v) => { el('cpVersion').textContent = v; });
  el('cpLogout').onclick = () => window.bf.logout();

  document.querySelectorAll('.cp-nav-btn').forEach((b) => { b.onclick = () => navTo(b.dataset.view); });
  // Nicht erlaubte Punkte ausblenden statt deaktivieren — tote Buttons verrotten.
  applyNavPermissions();

  const lz = el('cpLabelZoom');
  lz.value = String(labelMinZoom);
  el('cpLabelZoomVal').textContent = labelMinZoom.toFixed(1) + '×';
  lz.oninput = () => {
    labelMinZoom = Number(lz.value);
    el('cpLabelZoomVal').textContent = labelMinZoom.toFixed(1) + '×';
    localStorage.setItem('bf-cp-labelzoom', String(labelMinZoom));
    dirty = true;
  };
  el('cpMapReset').onclick = resetView;

  // Spielerliste (Team-only) — dieselbe Bedingung wie die Overwatch-Ansicht.
  const plBtn = el('cpPlayersBtn');
  if (plBtn) {
    plBtn.hidden = !can(perms, 'map.showAll');
    plBtn.onclick = () => {
      if (isPlayerListOpen()) { closePlayerList(); plBtn.setAttribute('aria-pressed', 'false'); return; }
      plList = openPlayerList({
        players: () => players,
        highlight,
        onChange: () => { dirty = true; },
        onFocus: (steamId) => centerOnPlayer(steamId),
      });
      plBtn.setAttribute('aria-pressed', 'true');
    };
  }

  if (!can(perms, 'map.showAll')) { showAll = false; showHeat = false; }
  restoreZonePrefs();
  renderLegend();
  navTo(localStorage.getItem('bf-cp-view') || 'map');
  initMapInteraction();
  resizeCanvas();
  resetView();
  // Fenstergroesse und Panel-Wechsel aendern die verfuegbare Flaeche.
  new ResizeObserver(() => resizeCanvas()).observe(el('cpMapWrap'));

  // Kalibrierung ZUERST: sie ist ein kleiner API-Call, das Kartenbild sind
  // 2,7 MB. Andersherum zeichnet die Karte die erste Zeit mit Default-Affine
  // und alle Marker sitzen sichtbar falsch, bis sie nachtraeglich springen.
  await loadCalibration();
  await loadMapImage('assets/map.jpg');
  dirty = true;
  loadZones();
  if (can(perms, 'map.teleports')) loadTeleports();
  if (can(perms, 'map.encounters')) loadEncounters();
  if (can(perms, 'team.users')) await loadUserDir();
  await pollPositions();
  setInterval(pollPositions, 1000);
  setInterval(loadUserDir, 5 * 60 * 1000);
  requestAnimationFrame(frame);
}

boot().catch((e) => showGate('Startfehler: ' + e.message, false));
