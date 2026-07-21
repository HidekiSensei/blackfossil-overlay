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
  initEditor, openCreateMenu, openEdit, isPlacing, placingKind, placingPoints,
  addPlacementPoint, cancelPlacing, editingZone, setZonePoints, closeEditor,
  editingEncounter, setEncounterGeom, editingTeleport, setTeleportPos,
  insertZonePoint, removeZonePoint,
  insertPatrolPoint, removePatrolPoint, appendPatrolPoint,
  isDrawingPatrol, stopDrawingPatrol,
} from './companion/editor.js';
import {
  loadMapImage, drawFullMap, drawHeatmap, drawAiEncounters, setZones, setCalAffine,
  ZONE_LAYERS, ZONE_META, setZoneLayer, isZoneLayerVisible,
  normToWorld, worldToNorm, zoneObjectAt, encounterHandles, zoneMidpoints, encounterMidpoints,
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
const MAX_ZOOM = 15;

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
let highlight = new Set();        // dauerhaft hervorgehoben (Spielerliste)
let hoverIds = new Set();         // gerade unter dem Zeiger (Spieler oder Ansammlung)
let plList = null;                // offene Spielerliste (zum Nachziehen beim Poll)

// Spuren: die letzten TRAIL_LEN Positionen je Spieler. Bewusst NUR im Speicher —
// nichts davon wird gespeichert oder ans Backend geschickt, und beim Neustart ist
// die Spur weg. Pro Spieler einzeln, auch innerhalb einer Gruppe.
// Gestaffelte Aufloesung: je aelter, desto grober. Die Spur reicht dadurch weit
// zurueck, ohne fuer jede Abfrage einen Punkt zu halten.
//
// Ergibt rund 50 Punkte je Spieler ueber gut 13 Minuten Verlauf.
//
// Wo liegt die Grenze? NICHT beim Speicher: 80 Spieler x 50 Punkte sind ~4000
// Objekte, also deutlich unter 200 KB. Der begrenzende Faktor ist das Zeichnen
// — jede Spur wird zweimal gestrichen (dunkler Saum + Linie), das sind hier
// ~8000 Segmente je Bild. Canvas verkraftet ein Vielfaches davon, zumal nur bei
// Aenderung neu gezeichnet wird (Dirty-Flag). Unangenehm wuerde es erst im
// Bereich einiger Hunderttausend Segmente, also etwa ab 1000 Punkten je Spieler.
const TRAIL_TIERS = [
  { maxAge: 10, step: 1 },     // letzte 10 s: jede Abfrage
  { maxAge: 60, step: 5 },     // bis 1 min:   jede 5.
  { maxAge: 200, step: 10 },   // bis gut 3 min: jede 10.
  { maxAge: 800, step: 40 },   // bis gut 13 min: jede 40.
];
const TRAIL_MAX_AGE = TRAIL_TIERS[TRAIL_TIERS.length - 1].maxAge;
const trails = new Map();         // steamId -> [{x,y,t}, …]
let pollTick = 0;                 // Abfragezaehler als Zeitbasis
let showTrails = localStorage.getItem('bf-cp-trail') === '1';

// Behalten? Punkt bleibt, wenn er im Raster seiner Altersstufe liegt.
function trailKeep(age, t) {
  for (const tier of TRAIL_TIERS) {
    if (age <= tier.maxAge) return t % tier.step === 0;
  }
  return false;
}

function pushTrail(list) {
  pollTick++;
  const seen = new Set();
  for (const p of list) {
    if (p.isDead || !p.steamId) continue;
    seen.add(p.steamId);
    const t = trails.get(p.steamId) || [];
    const last = t[t.length - 1];
    // Nur bei echter Bewegung anhaengen, sonst fuellt Stillstand die Spur mit
    // identischen Punkten und die Linie zeigt nichts mehr.
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 150) {
      t.push({ x: p.x, y: p.y, t: pollTick });
    }
    // Ausduennen nach Alter — laeuft auch ohne neuen Punkt, damit die Spur
    // waehrend eines Stillstands weiter vergroebert statt einzufrieren.
    const pruned = t.filter((pt) => trailKeep(pollTick - pt.t, pt.t));
    trails.set(p.steamId, pruned.length ? pruned : t.slice(-1));
  }
  // Offline gegangene Spieler nicht ewig mitschleppen.
  for (const id of trails.keys()) if (!seen.has(id)) trails.delete(id);
}

// Beim Bearbeiten darf das Original NICHT zusaetzlich gezeichnet werden — sonst
// stehen der gespeicherte und der gezogene Stand gleichzeitig auf der Karte,
// und die Trefferpruefung faende weiter den alten. Genau das passierte bei den
// KI-Encountern (alte Route blieb stehen und blieb als einzige anklickbar).
function visibleTeleports() {
  const et = editingTeleport();
  return et ? teleports.filter((t) => t.id !== et.id) : teleports;
}
function visibleEncounters() {
  const en = editingEncounter();
  return en ? encounters.filter((e) => e.id !== en.id) : encounters;
}

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

  drawFullMap({ ctx, w: MAP_SIZE, h: MAP_SIZE }, players, [], showTp ? visibleTeleports() : [], null, 1 / sc, {
    showAll,
    zoom,
    labelMinZoom,
    maxLabels: 60,
    centerX: (view.x0 + view.x1) / 2,
    centerY: (view.y0 + view.y1) / 2,
    viewX0: view.x0, viewY0: view.y0, viewX1: view.x1, viewY1: view.y1,
    // Auswahl UND Hover teilen sich dieselbe Hervorhebung — die Spur des
    // Spielers unter dem Zeiger leuchtet damit automatisch mit.
    highlight: activeHighlight(),
    editZone: editingZone(),
    editEnc: editingEncounter(),
    editTp: editingTeleport(),
    editHandle: geomDrag ? geomDrag.index : -1,
    trails: (showTrails && showAll) ? trails : null,
    onLabelStats: (s) => { lastStat = s; },
    onHits: (h) => { hits = h; },
  });
  { const list = visibleEncounters();
    if (showAi && list.length) drawAiEncounters(ctx, MAP_SIZE, MAP_SIZE, 1 / sc, list, baseClass); }
  drawPlacement(ctx, 1 / sc);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  updateMapStat();
}

// Vorschau der bereits gesetzten Punkte, damit man beim Aufziehen einer Zone
// sieht, was man tut.
function drawPlacement(ctx, scale) {
  if (!isPlacing()) return;
  const pts = placingPoints();
  if (!pts.length) return;
  const p2 = pts.map((p) => {
    const n = worldToNorm(p.x, p.y);
    return { x: n.nx * MAP_SIZE, y: n.ny * MAP_SIZE };
  });
  // Gummiband zum Zeiger — zeigt die Kante, die der naechste Klick erzeugt.
  const cur = placeCursor && placingKind() === 'zone' ? (() => {
    const n = worldToNorm(placeCursor.x, placeCursor.y);
    return { x: n.nx * MAP_SIZE, y: n.ny * MAP_SIZE };
  })() : null;
  if (cur && p2.length) {
    ctx.beginPath();
    ctx.moveTo(p2[p2.length - 1].x, p2[p2.length - 1].y);
    ctx.lineTo(cur.x, cur.y);
    if (p2.length >= 2) ctx.lineTo(p2[0].x, p2[0].y);
    ctx.setLineDash([4 * scale, 4 * scale]);
    ctx.lineWidth = 1.5 * scale; ctx.strokeStyle = 'rgba(245,158,11,0.55)'; ctx.stroke();
    ctx.setLineDash([]);
  }
  if (p2.length > 1) {
    ctx.beginPath();
    p2.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (placingKind() === 'zone' && p2.length > 2) ctx.closePath();
    ctx.setLineDash([6 * scale, 4 * scale]);
    ctx.lineWidth = 2 * scale; ctx.strokeStyle = '#f59e0b'; ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const p of p2) {
    ctx.beginPath(); ctx.arc(p.x, p.y, 5 * scale, 0, Math.PI * 2);
    ctx.fillStyle = '#f59e0b'; ctx.fill();
    ctx.lineWidth = 1.5 * scale; ctx.strokeStyle = '#fff'; ctx.stroke();
  }
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

// ── Zonen-Bearbeitung: Anfasser ziehen ─────────────────────────────────────
// Gezogener Anfasser — teilt sich Zone und Encounter, weil das Ziehen identisch
// ist und nur die Quelle der Punkte sich unterscheidet.
let geomDrag = null;   // { index } — index -1 = ganze Zone verschieben

// Bearbeiten-Modus. Ohne ihn reagiert der Rechtsklick nicht und "Erstellen" ist
// nicht sichtbar — sonst oeffnet ein versehentlicher Rechtsklick beim Anschauen
// der Karte einen Editor. Bewusst NICHT gespeichert: nach einem Neustart ist
// man wieder im Ansichts-Modus.
let editMode = false;

// Welcher Eckpunkt liegt unter dem Zeiger? Trefferflaeche etwas grosszuegiger
// als das gezeichnete Quadrat, sonst muss man pixelgenau treffen.
// Trefferradius bewusst identisch zu objectAt (14 px). Vorher waren es +-10:
// man konnte per Rechtsklick etwas oeffnen, dessen Anfasser man an derselben
// Stelle nicht mehr greifen konnte — der Punkt lag im 14er-Kreis, aber
// ausserhalb des 10er-Quadrats.
const HANDLE_HIT = 14;
function handleAt(points, sx, sy) {
  const sc = totalScale();
  let best = -1, bestD = Infinity;
  for (let i = 0; i < (points || []).length; i++) {
    const n = worldToNorm(points[i].x, points[i].y);
    const x = n.nx * MAP_SIZE * sc + panX, y = n.ny * MAP_SIZE * sc + panY;
    const d = Math.hypot(x - sx, y - sy);
    if (d <= HANDLE_HIT && d < bestD) { best = i; bestD = d; }
  }
  return best;
}

// Punkt-in-Polygon gegen die BEARBEITETE Kopie, nicht gegen den gespeicherten
// Stand — sonst spraenge die Flaeche beim Verschieben zurueck.
function pointInZone(zone, wx, wy) {
  const pts = zone.points || [];
  if (pts.length < 3) return false;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if ((yi > wy) !== (yj > wy) && wx < ((xj - xi) * (wy - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ── Rechteck-Auswahl (Strg + Ziehen) ───────────────────────────────────────
let marquee = null;   // { x0,y0,x1,y1 } in Bildschirm-Pixeln des Karten-Wrappers
let placeCursor = null;   // Weltkoordinate unter dem Zeiger waehrend des Zeichnens

function drawMarquee() {
  const box = el('cpMarquee');
  if (!box || !marquee) return;
  const x = Math.min(marquee.x0, marquee.x1), y = Math.min(marquee.y0, marquee.y1);
  const w = Math.abs(marquee.x1 - marquee.x0), h = Math.abs(marquee.y1 - marquee.y0);
  box.style.left = x + 'px'; box.style.top = y + 'px';
  box.style.width = w + 'px'; box.style.height = h + 'px';
  box.hidden = false;
}

function finishMarquee() {
  const box = el('cpMarquee');
  if (box) box.hidden = true;
  const m = marquee;
  marquee = null;
  if (!m) return;
  // Ein versehentlicher Strg-Klick ohne Ziehen soll nichts auswaehlen.
  if (Math.abs(m.x1 - m.x0) < 4 && Math.abs(m.y1 - m.y0) < 4) return;

  const sc = totalScale();
  // Bildschirm- -> Kartenkoordinaten, damit der Vergleich zoomunabhaengig ist.
  const mx0 = (Math.min(m.x0, m.x1) - panX) / sc, mx1 = (Math.max(m.x0, m.x1) - panX) / sc;
  const my0 = (Math.min(m.y0, m.y1) - panY) / sc, my1 = (Math.max(m.y0, m.y1) - panY) / sc;

  // Ueber die EINZELNEN Spieler pruefen, nicht ueber die Ansammlungs-Mittelpunkte:
  // sonst faellt eine Ansammlung ganz rein oder ganz raus, obwohl sie am Rand
  // des Rechtecks liegt.
  const ids = [];
  for (const c of hits) {
    for (const it of c.items) {
      if (it.px >= mx0 && it.px <= mx1 && it.py >= my0 && it.py <= my1) ids.push(it.p.steamId);
    }
  }
  selectFromMap(ids, m.add);
}

// Auswahl per Karten-Klick. Ohne Shift ersetzt sie die bisherige Auswahl —
// dasselbe Verhalten wie beim Anklicken einer Gruppe in der Liste.
function selectFromMap(ids, add) {
  if (!can(perms, 'map.showAll')) return;
  if (!add) highlight.clear();
  for (const id of ids) highlight.add(id);
  if (!isPlayerListOpen()) {
    const btn = el('cpPlayersBtn');
    if (btn) { btn.click(); return; }   // click() rendert die Liste bereits
  }
  if (plList) plList.refresh();
  dirty = true;
}

// Karten-Objekte nachladen, damit Aenderungen anderer Admins (Companion ODER
// Overlay) hier ankommen.
//
// Waehrend eines eigenen Bearbeitens wird NICHT nachgeladen — sonst zoege der
// Server einem die Punkte unter der Maus weg.
function refreshMapObjects() {
  if (currentView !== 'map') return;
  if (isPlacing() || editingZone() || editingEncounter() || editingTeleport()) return;
  loadZones();
  if (can(perms, 'map.teleports')) loadTeleports();
  if (can(perms, 'map.encounters')) loadEncounters();
}

function setEditMode(on) {
  editMode = !!on && can(perms, 'world.write');
  const em = el('cpEditMode'), cb = el('cpCreateBtn');
  if (em) em.setAttribute('aria-checked', editMode ? 'true' : 'false');
  if (cb) cb.hidden = !editMode;
  // Beim Verlassen alles Angefangene aufraeumen — sonst bliebe eine halb
  // gesetzte Zone im Hintergrund haengen.
  if (!editMode) closeEditor();
  el('cpMapCanvas')?.classList.toggle('cp-editing', editMode);
  dirty = true;
}

function activeHighlight() {
  if (!hoverIds.size) return highlight;
  const set = new Set(highlight);
  for (const id of hoverIds) set.add(id);
  return set;
}

function updateMapStat() {
  const s = el('cpMapStat');
  if (!s) return;
  const alive = players.filter((p) => !p.isDead).length;
  if (showHeat) { s.textContent = `${alive} online · Heatmap (nur Ansammlungen ab 4)`; return; }
  if (!showAll) { s.textContent = `${alive} online`; return; }
  // Bewusst nur die Spielerzahl. Der frühere Zusatz zu verdeckten Namen bzw.
  // zur Zoomschwelle war Information über die Darstellung, nicht über den
  // Server — der Regler daneben sagt ohnehin, ab wann Namen erscheinen.
  s.textContent = `${alive} online`;
  s.title = '';
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
    if (showTrails) pushTrail(players); else if (trails.size) trails.clear();
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

  let downX = 0, downY = 0;
  cv.addEventListener('mousedown', (e) => {
    downX = e.clientX; downY = e.clientY;
    hideTip();
    // Zonen-Bearbeitung hat Vorrang vor allem anderen: Anfasser ziehen den
    // Eckpunkt, ein Griff INNERHALB der Flaeche verschiebt die ganze Zone.
    const ez = editingZone(), en = editingEncounter(), et = editingTeleport();
    if ((ez || en || et) && !e.ctrlKey && !e.metaKey) {
      const r0 = cv.getBoundingClientRect();
      const hx = e.clientX - r0.left, hy = e.clientY - r0.top;
      const pts = ez ? ez.points : (en ? encounterHandles(en) : [et]);
      const idx = handleAt(pts, hx, hy);
      if (idx >= 0) {
        geomDrag = { index: idx, kind: ez ? 'zone' : (en ? 'encounter' : 'teleport') };
        e.preventDefault();
        return;
      }
      // Geister-Punkt auf einer Kantenmitte: wird beim Anfassen zu einem echten
      // Eckpunkt, den man in derselben Bewegung weiterzieht. Einfuegen und
      // Positionieren in EINEM Zug — das ist der Grund fuer diese Loesung statt
      // eines "Punkt hinzufuegen"-Menuepunkts.
      if (ez) {
        const mid = handleAt(zoneMidpoints(ez.points), hx, hy);
        if (mid >= 0) {
          const w1 = screenToWorld(hx, hy);
          const ni = insertZonePoint(mid, w1.x, w1.y);
          if (ni >= 0) { geomDrag = { index: ni, kind: 'zone' }; dirty = true; e.preventDefault(); return; }
        }
      }
      if (en) {
        const mid = handleAt(encounterMidpoints(en), hx, hy);
        if (mid >= 0) {
          const w1 = screenToWorld(hx, hy);
          const ni = insertPatrolPoint(mid, w1.x, w1.y);
          if (ni >= 0) { geomDrag = { index: ni, kind: 'encounter' }; dirty = true; e.preventDefault(); return; }
        }
      }
      // Nur Zonen haben eine Flaeche, die sich als Ganzes greifen laesst.
      if (ez) {
        const w0 = screenToWorld(hx, hy);
        if (pointInZone(ez, w0.x, w0.y)) {
          geomDrag = { index: -1, kind: 'zone', from: w0, orig: ez.points.map((p) => ({ ...p })) };
          e.preventDefault();
          return;
        }
      }
    }
    // Strg (bzw. Cmd) + Ziehen spannt ein Auswahl-Rechteck auf statt die Karte
    // zu verschieben. Beides gleichzeitig ginge nicht — man kann nur eines
    // sinnvoll auf die linke Taste legen.
    if (e.ctrlKey || e.metaKey) {
      const r = cv.getBoundingClientRect();
      marquee = { x0: e.clientX - r.left, y0: e.clientY - r.top, x1: e.clientX - r.left, y1: e.clientY - r.top, add: e.shiftKey };
      drawMarquee();
      e.preventDefault();
      return;
    }
    dragging = true; lastX = e.clientX; lastY = e.clientY;
  });
  // Klick statt Ziehen: nur wenn sich der Zeiger kaum bewegt hat. Sonst waehlt
  // jedes Verschieben der Karte versehentlich Spieler aus.
  cv.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey) return;   // gehoert zur Rechteck-Auswahl
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return;
    const r = cv.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    // Im Platzierungs-Modus liefert der Klick Koordinaten, statt Spieler
    // auszuwaehlen — sonst waere beides nicht auseinanderzuhalten.
    // Route eines bestehenden Encounters zeichnen: jeder Klick haengt an.
    if (isDrawingPatrol()) {
      const w2 = screenToWorld(sx, sy);
      appendPatrolPoint(w2.x, w2.y);
      dirty = true;
      return;
    }
    if (isPlacing()) {
      const w = screenToWorld(sx, sy);
      const pts = placingPoints();
      // Klick auf den Startpunkt schliesst das Polygon, statt einen Punkt
      // uebereinander zu setzen.
      if (placingKind() === 'zone' && pts.length >= 3 && handleAt([pts[0]], sx, sy) === 0) {
        const b = el('zSave');
        if (b && !b.disabled) b.click();
        return;
      }
      addPlacementPoint(w.x, w.y);
      return;
    }
    const c = hitAt(sx, sy);
    if (!c) return;
    selectFromMap(c.items.map((it) => it.p.steamId), e.shiftKey);
  });

  // Rechtsklick bearbeitet das Objekt darunter (Admin-only).
  cv.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!editMode || !can(perms, 'world.write')) return;
    const r = cv.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    // Rechtsklick auf einen Eckpunkt der bearbeiteten Zone entfernt ihn.
    const ez = editingZone(), en = editingEncounter();
    if (ez) {
      const vi = handleAt(ez.points, sx, sy);
      if (vi >= 0) {
        if (removeZonePoint(vi)) { dirty = true; }
        else toast('Eine Zone braucht mindestens 3 Eckpunkte.', 'error');
        return;
      }
    }
    if (en) {
      const vi = handleAt(encounterHandles(en), sx, sy);
      if (vi >= 0) {
        if (removePatrolPoint(vi)) dirty = true;
        else toast('Der Spawn bleibt — er ist der Startpunkt.', 'error');
        return;
      }
    }
    const hit = objectAt(sx, sy);
    if (hit) openEdit(hit.kind, hit.obj);
  });
  cv.addEventListener('mouseleave', () => { hideTip(); if (hoverIds.size) { hoverIds = new Set(); dirty = true; } });
  cv.addEventListener('mousemove', (e) => {
    if (dragging) return;
    const r = cv.getBoundingClientRect();
    // Gummiband: beim Zeichnen die Linie vom letzten Punkt zum Zeiger zeigen,
    // damit man sieht, wohin der naechste Klick setzt.
    if (isPlacing()) {
      placeCursor = screenToWorld(e.clientX - r.left, e.clientY - r.top);
      dirty = true;
      return;
    }
    const c = hitAt(e.clientX - r.left, e.clientY - r.top);
    if (c) showTip(c, e.clientX - r.left, e.clientY - r.top); else hideTip();
    // Nur neu zeichnen, wenn sich die Menge wirklich geaendert hat — sonst
    // laeuft bei jeder Mausbewegung ein voller Frame.
    const next = c ? c.items.map((it) => it.p.steamId) : [];
    if (next.length !== hoverIds.size || next.some((id) => !hoverIds.has(id))) {
      hoverIds = new Set(next);
      dirty = true;
    }
  });
  window.addEventListener('mouseup', () => {
    if (geomDrag) { geomDrag = null; dirty = true; return; }
    if (marquee) { finishMarquee(); return; }
    dragging = false;
  });
  window.addEventListener('mousemove', (e) => {
    if (geomDrag) {
      const r0 = cv.getBoundingClientRect();
      const w0 = screenToWorld(e.clientX - r0.left, e.clientY - r0.top);
      if (geomDrag.kind === 'teleport') {
        setTeleportPos(w0.x, w0.y);
        dirty = true;
        return;
      }
      if (geomDrag.kind === 'encounter') {
        const en2 = editingEncounter();
        if (!en2) { geomDrag = null; return; }
        // Index 0 ist der Spawn, alles danach sind Patrouillenpunkte —
        // dieselbe Reihenfolge wie in encounterHandles().
        if (geomDrag.index === 0) {
          setEncounterGeom({ ...(en2.spawn || {}), x: w0.x, y: w0.y }, en2.patrol);
        } else {
          const pi = geomDrag.index - 1;
          setEncounterGeom(en2.spawn, (en2.patrol || []).map((p, i) => (i === pi ? { ...p, x: w0.x, y: w0.y } : p)));
        }
        dirty = true;
        return;
      }
      const ez = editingZone();
      if (!ez) { geomDrag = null; return; }
      if (geomDrag.index >= 0) {
        setZonePoints(ez.points.map((p, i) => (i === geomDrag.index ? { ...p, x: w0.x, y: w0.y } : p)));
      } else {
        // Ganze Zone: alle Punkte um dieselbe Strecke versetzen. Bezug ist der
        // Originalstand beim Anfassen, nicht der letzte Frame — sonst
        // summieren sich Rundungsfehler ueber den Zug hinweg auf.
        const dx = w0.x - geomDrag.from.x, dy = w0.y - geomDrag.from.y;
        setZonePoints(geomDrag.orig.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })));
      }
      dirty = true;
      return;
    }
    if (marquee) {
      const r = cv.getBoundingClientRect();
      marquee.x1 = e.clientX - r.left;
      marquee.y1 = e.clientY - r.top;
      drawMarquee();
      return;
    }
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

// Bildschirm- -> Weltkoordinaten (fuer das Setzen neuer Objekte).
function screenToWorld(sx, sy) {
  const sc = totalScale();
  return normToWorld(((sx - panX) / sc) / MAP_SIZE, ((sy - panY) / sc) / MAP_SIZE);
}

// Welches Karten-Objekt liegt unter dem Zeiger? Reihenfolge = Prioritaet:
// Punkt-Objekte vor Flaechen, sonst traefe man immer die darunterliegende Zone.
function objectAt(sx, sy) {
  const sc = totalScale();
  const toScr = (wx, wy) => {
    const n = worldToNorm(wx, wy);
    return { x: n.nx * MAP_SIZE * sc + panX, y: n.ny * MAP_SIZE * sc + panY };
  };
  // Ausgeblendete Ebenen sind nicht bearbeitbar. Sonst oeffnet ein Rechtsklick
  // einen Editor fuer etwas, das gar nicht zu sehen ist — man wuesste nicht,
  // was man da bearbeitet.
  // Gegen den WIRKSAMEN Stand pruefen: wird gerade gezogen, zaehlt die Kopie,
  // nicht der gespeicherte Punkt.
  const et = editingTeleport(), en0 = editingEncounter();
  if (showTp) for (const t0 of teleports) {
    const t = (et && t0.id === et.id) ? et : t0;
    const p = toScr(t.x, t.y);
    if (Math.hypot(p.x - sx, p.y - sy) <= 14) return { kind: 'teleport', obj: t0 };
  }
  if (showAi) for (const enc0 of encounters) {
    const enc = (en0 && enc0.id === en0.id) ? en0 : enc0;
    if (!enc.spawn || (enc.spawn.x === 0 && enc.spawn.y === 0)) continue;
    const p = toScr(enc.spawn.x, enc.spawn.y);
    if (Math.hypot(p.x - sx, p.y - sy) <= 14) return { kind: 'encounter', obj: enc0 };
  }
  const w = screenToWorld(sx, sy);
  // zoneObjectAt statt zoneAt: letzteres liefert nur einen ANZEIGENAMEN als
  // String. Damit hatte der Editor nie id, type oder points — der Typ stand
  // deshalb immer auf dem ersten Eintrag (pvp), und ein Loeschen haette jede
  // Zone ohne id mitgenommen.
  const z = zoneObjectAt(w.x, w.y);
  // Auch hier: eine ausgeblendete Zonenebene ist nicht bearbeitbar.
  if (z && isZoneLayerVisible(z.type)) return { kind: 'zone', obj: z };
  return null;
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

// Rangfolge fuer die Sortierung: Admin, dann Team, dann alle uebrigen.
function rankOrder(p) { return p.admin ? 0 : (p.team ? 1 : 2); }
function rankClass(p) { return p.admin ? ' cp-tip-admin' : (p.team ? ' cp-tip-team' : ''); }

function showTip(c, sx, sy) {
  const tip = el('cpMapTip');
  if (!tip) return;
  // Erst nach Rang, innerhalb des Rangs alphabetisch — so steht der Admin einer
  // Ansammlung immer oben und man muss nicht suchen.
  const items = [...c.items].map((it) => it.p).sort((a, b) =>
    rankOrder(a) - rankOrder(b)
    || (a.label1 || a.name || '').localeCompare(b.label1 || b.name || '', 'de'));
  const sub = items.length === 1 ? (items[0].label2 || '') : `${items.length} Spieler`;
  tip.innerHTML = `<div class="cp-tip-head">${escapeHtml(sub)}</div>`
    + items.slice(0, 20).map((p) =>
        `<div class="cp-tip-row${rankClass(p)}">${escapeHtml(p.label1 || p.name || p.steamId)}</div>`).join('')
    + (items.length > 20 ? `<div class="cp-tip-more">und ${items.length - 20} weitere…</div>` : '');
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
const editorCtx = {
  api,
  toast,
  redraw: () => { dirty = true; },
  reloadZones: () => loadZones(),
  reloadTeleports: () => loadTeleports(),
  reloadEncounters: () => loadEncounters(),
};

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
    + (can(perms, 'map.showAll') ? tgl('data-marker', 'trail', '', 'Spuren', showTrails, showHeat) : '')
    + (can(perms, 'map.showAll') ? tgl('data-marker', 'heat', '', 'Heatmap', showHeat, false) : '')
    + `</div>`;
  // Marker-Farbtupfer per Klasse (die Zonen tragen ihre Farbe inline)
  for (const [k, cls] of [['tp', 'cp-leg-tp'], ['ai', 'cp-leg-ai'], ['players', 'cp-leg-player'], ['trail', 'cp-leg-trail'], ['heat', 'cp-leg-heat']]) {
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
      else if (k === 'trail') {
        showTrails = on;
        localStorage.setItem('bf-cp-trail', on ? '1' : '0');
        if (!on) trails.clear();
      }
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

// ── Updates ────────────────────────────────────────────────────────────────
// Der Feed liegt im eigenen Backend (/overlay, Kanal "companion"). Die
// Versionsnummer stammt aus derselben package.json wie das Overlay — beide Apps
// tragen damit zwangslaeufig dieselbe Version.
function initUpdates() {
  const st = el('cpUpdStatus'), btn = el('cpUpdBtn');
  if (!st || !btn) return;
  const set = (t) => { st.textContent = t; };

  btn.onclick = () => { set('Suche nach Updates…'); window.bf.updateCheck(); };
  window.bf.onUpdateNone(() => set('Aktuell — kein Update verfügbar.'));
  window.bf.onUpdateAvailable((v) => {
    set(`Version ${v} verfügbar.`);
    btn.textContent = 'Herunterladen';
    btn.onclick = () => { set('Lädt…'); window.bf.updateDownload(); };
  });
  window.bf.onUpdateProgress((p) => set(`Lädt… ${p}%`));
  window.bf.onUpdateReady((v) => {
    set(`Version ${v} bereit.`);
    btn.textContent = 'Neu starten & installieren';
    btn.onclick = () => window.bf.updateInstall();
  });
  window.bf.onUpdateError((m) => set('Update fehlgeschlagen: ' + m));
}

// Release-Notes kommen aus derselben Datei wie beim Overlay — die Apps laufen
// zusammen und teilen sich eine Version, also auch die Notizen.
async function loadReleaseNotes() {
  const box = el('cpNotes');
  if (!box) return;
  try {
    const r = await fetch(`${config.tokenBase}/overlay/releases.json`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const list = await r.json();
    const rel = (Array.isArray(list) ? list : list.releases || []).slice(0, 8);
    const installed = (el('cpVersion')?.textContent || '').trim();
    box.innerHTML = rel.length
      ? rel.map((v) => {
          // Version UND Titel zeigen — der Titel allein sagt nicht, welcher
          // Stand gemeint ist, und genau danach sucht man hier.
          const ist = v.version && v.version === installed;
          return `<div class="cp-rel">`
            + `<div class="cp-rel-head"><span><span class="cp-rel-ver">${escapeHtml(v.version || '')}</span>`
            + `${v.title ? ' ' + escapeHtml(v.title) : ''}</span>`
            + `<span class="cp-rel-date">${ist ? 'installiert' : escapeHtml(v.date || '')}</span></div>`
            + `<div class="cp-rel-body">${notesToHtml(v.notes || '')}</div></div>`;
        }).join('')
      : '<div class="cp-muted">Keine Einträge.</div>';
  } catch (e) {
    box.innerHTML = `<div class="cp-muted">Release-Notes nicht abrufbar (${escapeHtml(e.message)}).</div>`;
  }
}

// Minimaler Markdown-Ersatz: Listenpunkte und Absaetze. Bewusst KEIN
// HTML-Durchreichen — die Notizen kommen zwar aus dem eigenen Backend, aber
// escapen kostet nichts und schliesst die Lücke ganz.
function notesToHtml(md) {
  // Erst escapen, DANN das bisschen Markup erzeugen — nie andersherum.
  const inline = (t) => escapeHtml(t).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return String(md).replace(/\r/g, '').split('\n').map((line) => {
    const t = line.trim();
    if (!t) return '';
    if (/^#{1,6}\s+/.test(t)) return `<div class="cp-rel-h">${inline(t.replace(/^#{1,6}\s+/, ''))}</div>`;
    if (/^[-*]\s+/.test(t)) return `<div class="cp-rel-li">${inline(t.replace(/^[-*]\s+/, ''))}</div>`;
    return `<div>${inline(t)}</div>`;
  }).join('');
}

// ── Navigation ─────────────────────────────────────────────────────────────
function navTo(view) {
  // Polls haengen am offenen Panel — beim Wegnavigieren abstellen.
  if (view !== 'server') stopServer();
  if (view !== 'support') stopSupport();
  currentView = view;
  document.querySelectorAll('.cp-nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.cp-view').forEach((s) => { s.hidden = s.dataset.view !== view; });
  // Beim Betreten der Karte sofort nachladen, statt bis zum naechsten
  // Intervall zu warten. Und den Bearbeiten-Modus IMMER aus: er ist ein
  // bewusster Griff, kein Zustand, in den man versehentlich zurueckkehrt.
  if (view === 'map') {
    setEditMode(false);
    dirty = true;
    refreshMapObjects();
  }
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
  initEditor(editorCtx);
  window.bf.getVersion().then((v) => { el('cpVersion').textContent = v; });
  initUpdates();
  loadReleaseNotes();
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
  { const ra = el('cpRaidAtlas'); if (ra) ra.onclick = () => window.bf.openExternal('https://raidatlas.app/'); }

  // Bearbeiten-Modus und Erstellen nur fuer Admins — dieselbe Bedingung wie
  // Welt-Aenderungen.
  {
    const mayEdit = can(perms, 'world.write');
    const em = el('cpEditMode'), cb = el('cpCreateBtn');
    if (em) {
      em.hidden = !mayEdit;
      em.onclick = () => setEditMode(!editMode);
    }
    if (cb) cb.onclick = () => openCreateMenu();
    setEditMode(false);
  }

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
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (isDrawingPatrol()) { stopDrawingPatrol(); dirty = true; return; }
    if (isPlacing()) cancelPlacing();
  });
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

  setInterval(refreshMapObjects, 15000);
  setInterval(loadUserDir, 5 * 60 * 1000);
  requestAnimationFrame(frame);
}

boot().catch((e) => showGate('Startfehler: ' + e.message, false));
